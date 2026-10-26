/**
 * Lit + @yukino.js/lit-jsx frontend static analysis (pure rules, zero LLM).
 *
 * Key pitfalls handled:
 * - Route parsing locates `path:` first, then walks left to the opening
 *   brace and uses balanced-brace extraction (never a `[^{}]*` regex)
 * - Field tags are any elements carrying a label="..." attribute inside a
 *   <form> block; attributes may span multiple lines, and quoted attribute
 *   values may contain `>`
 * - Pages come from view modules (files under a views/ directory); the
 *   router module only maps page name -> route
 */
import path from "node:path";

import { readFileSafe } from "./scanner";

import type {
  Form,
  FormField,
  FrontendResult,
  Page,
  PageSelector,
} from "#/lib/types";

const TOAST_RE =
  /(?:showToast|toast\.(?:success|error|warning|info))\s*\(\s*["']([^"']+)["']/g;
const FORM_TAG_RE = /<\/?form(?=[\s/>])[^>]*>/g;
/** `<tag attrs>` where attrs may span lines and hold quoted `>` chars. */
const ELEMENT_RE = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^<>])*?)(\/?)>/g;
const LABEL_ATTR_RE = /\blabel\s*=\s*["']([^"']+)["']/;
const PROP_ATTR_RE = /\b(?:prop|name)\s*=\s*["']([^"']+)["']/;
const PLACEHOLDER_ATTR_RE = /\bplaceholder\s*=\s*["']([^"']+)["']/;
const REQUIRED_ATTR_RE = /\brequired\b(?!\s*=\s*["']?(?:false|\{false\}))/;
const TYPE_ATTR_RE = /\btype\s*=\s*["']([^"']+)["']/;

export function emptyLitFrontend(): FrontendResult {
  return {
    language: "lit",
    pages: [],
    selectors: [],
    uiTexts: [],
    components: [],
  };
}

function searchFrom(
  re: RegExp,
  text: string,
  pos: number,
): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(text);
}

/** Balanced-brace slice starting at `start` (which points at `{`). */
function balancedBrace(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

interface RawRoute {
  path: string;
  name: string;
}

/** Route table entries: `{ path: '/x', element: <SomePage /> }`. */
export function parseLitRouter(text: string): RawRoute[] {
  const routes: RawRoute[] = [];
  let idx = 0;
  for (;;) {
    const m = searchFrom(/path\s*:/g, text, idx);
    if (!m) break;
    const pathPos = m.index;
    const brace = text.lastIndexOf("{", pathPos);
    if (brace === -1) {
      idx = pathPos + m[0].length;
      continue;
    }
    const block = balancedBrace(text, brace);
    const pm = /path\s*:\s*["']([^"']+)["']/.exec(block);
    const nm = /\bname\s*:\s*["']([^"']+)["']/.exec(block);
    const em =
      /element\s*:\s*<([A-Za-z][\w-]*)/.exec(block) ||
      /element\s*:\s*([A-Z]\w*)/.exec(block) ||
      /component\s*:\s*<?([A-Z]\w*)/.exec(block);
    if (pm && em) {
      routes.push({ path: pm[1], name: nm ? nm[1] : em[1] });
    }
    idx = brace + block.length;
  }
  return routes;
}

/** From `<form` to its matching `</form>` (forms do not nest). */
function extractFormBlock(text: string, formStart: number): string {
  let openCount = 0;
  let i = formStart;
  while (i < text.length) {
    const tag = searchFrom(FORM_TAG_RE, text, i);
    if (!tag) break;
    if (tag[0].startsWith("</")) {
      openCount -= 1;
      if (openCount === 0)
        return text.slice(formStart, tag.index + tag[0].length);
    } else if (!tag[0].endsWith("/>")) {
      openCount += 1;
    }
    i = tag.index + tag[0].length;
  }
  return text.slice(formStart);
}

function fieldType(tag: string, attrs: string): string {
  const typeAttr = TYPE_ATTR_RE.exec(attrs);
  const hint = `${tag} ${typeAttr ? typeAttr[1] : ""}`.toLowerCase();
  if (hint.includes("textarea")) return "textarea";
  if (hint.includes("select")) return "select";
  if (hint.includes("switch")) return "switch";
  return "input";
}

/** Elements carrying a label attribute inside a markup block -> fields. */
function parseFields(block: string): FormField[] {
  const fields: FormField[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(ELEMENT_RE.source, "g");
  while ((m = re.exec(block)) !== null) {
    const [, tag, attrs] = m;
    const labelMatch = LABEL_ATTR_RE.exec(attrs);
    if (!labelMatch) continue;
    const placeholder = PLACEHOLDER_ATTR_RE.exec(attrs);
    const prop = PROP_ATTR_RE.exec(attrs);
    fields.push({
      label: labelMatch[1],
      prop: prop ? prop[1] : "",
      type: fieldType(tag, attrs),
      required: REQUIRED_ATTR_RE.test(attrs),
      placeholder: placeholder ? placeholder[1] : "",
      rules: [],
    });
  }
  return fields;
}

function isViewFile(rel: string): boolean {
  const posix = rel.replaceAll("\\", "/");
  return posix.includes("views/") && /\.(tsx|jsx|ts|js)$/.test(posix);
}

function isRouterFile(rel: string): boolean {
  const posix = rel.replaceAll("\\", "/");
  const base = path.basename(posix);
  return (
    /^router\.(tsx|jsx|ts|js)$/.test(base) ||
    (posix.includes("router/") && /^index\.(tsx|jsx|ts|js)$/.test(base))
  );
}

export function parseLitFile(file: string, rel: string): FrontendResult {
  const text = readFileSafe(file);
  const result = emptyLitFrontend();

  if (isRouterFile(rel)) {
    for (const route of parseLitRouter(text)) {
      result.pages.push({
        name: route.name,
        route: route.path,
        file: rel,
        forms: [],
      });
    }
  }

  if (isViewFile(rel)) {
    const pageName = path.basename(rel, path.extname(rel));
    const page: Page = { name: pageName, route: "", file: rel, forms: [] };
    let pos = 0;
    for (;;) {
      const m = searchFrom(/<form(?=[\s/>])[^>]*>/g, text, pos);
      if (!m) break;
      const block = extractFormBlock(text, m.index);
      const form: Form = { fields: parseFields(block) };
      page.forms.push(form);
      pos = m.index + block.length;
    }
    result.pages.push(page);

    for (const form of page.forms) {
      for (const field of form.fields) {
        const selector: PageSelector | null = field.placeholder
          ? { type: "placeholder", value: field.placeholder, page: page.name }
          : field.label
            ? { type: "label", value: field.label, page: page.name }
            : null;
        if (selector) result.selectors.push(selector);
      }
    }
  }

  let tm: RegExpExecArray | null;
  const toastRe = new RegExp(TOAST_RE.source, "g");
  while ((tm = toastRe.exec(text)) !== null) {
    result.uiTexts.push(tm[1]);
  }

  result.uiTexts = [...new Set(result.uiTexts)];
  return result;
}

export function analyzeLitFrontend(
  litFiles: string[],
  root: string,
): FrontendResult {
  const merged = emptyLitFrontend();

  // Router files only build the page_name -> route map; real pages (with
  // forms) come from view modules.
  const routeMap = new Map<string, string>();
  for (const file of litFiles) {
    const rel = path.relative(root, file);
    if (!isRouterFile(rel)) continue;
    for (const page of parseLitFile(file, rel).pages) {
      routeMap.set(page.name, page.route);
    }
  }

  for (const file of litFiles) {
    const rel = path.relative(root, file);
    const one = parseLitFile(file, rel);
    for (const page of one.pages) {
      if (!page.route && routeMap.has(page.name)) {
        page.route = routeMap.get(page.name)!;
      }
      // Router-derived placeholder pages are replaced by the real view page.
      if (!isViewFile(rel)) continue;
      merged.pages.push(page);
    }
    merged.selectors.push(...one.selectors);
    merged.uiTexts.push(...one.uiTexts);
  }

  // A routed page without a view module still counts (route-only page).
  for (const [name, route] of routeMap) {
    if (!merged.pages.some((p) => p.name === name)) {
      merged.pages.push({ name, route, file: "", forms: [] });
    }
  }

  const dedup = new Map<string, Page>();
  for (const page of merged.pages) dedup.set(`${page.file}|${page.name}`, page);
  merged.pages = [...dedup.values()];
  merged.uiTexts = [...new Set(merged.uiTexts)];
  return merged;
}
