/**
 * Vue frontend static analysis (pure rules, zero LLM).
 *
 * Key pitfalls handled:
 * - Router parsing locates `path:` first, then walks left to the opening
 *   brace and uses balanced-brace extraction (never a `[^{}]*` regex)
 * - The `<el-form` regex uses a `(?![-\w])` guard so `<el-form-item>` is
 *   not mistaken for a form
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

const EL_FORM_RE = /<el-form(?![-\w])/g;
const EL_FORM_ITEM_RE = /<el-form-item(?![-\w])/g;
const PROP_RE = /\bprop\s*=\s*["']([^"']+)["']/;
const LABEL_RE = /\blabel\s*=\s*["']([^"']+)["']/;
const PLACEHOLDER_RE = /\bplaceholder\s*=\s*["']([^"']+)["']/;
const REQUIRED_RE = /\brequired\b|:required\s*=\s*["']?true["']?/;
const RULES_RE = /:rules\s*=\s*["']?([^"'>]+)["']?/;
const MESSAGE_RE =
  /ElMessage(?:Box)?\.(?:success|error|warning|info)\s*\(\s*["']([^"']+)["']/g;

export function emptyFrontend(): FrontendResult {
  return {
    language: "vue",
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

function firstMatch(re: RegExp, text: string): string | null {
  const m = re.exec(text);
  return m ? m[1] : null;
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
  component: string;
  name: string;
}

export function parseRouter(text: string): RawRoute[] {
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
    const cm = /component\s*:\s*([^\n,}]+)/.exec(block);
    const nm = /\bname\s*:\s*["']([^"']+)["']/.exec(block);
    if (pm) {
      routes.push({
        path: pm[1],
        component: cm ? cm[1].trim() : "",
        name: nm ? nm[1] : "",
      });
    }
    idx = brace + block.length;
  }
  return routes;
}

/** From `<el-form` to its matching `</el-form>` (ignoring `<el-form-item>`). */
function extractFormBlock(text: string, formStart: number): string {
  let openCount = 0;
  let i = formStart;
  const tagRe = /<\/?el-form(?![-\w])/g;
  while (i < text.length) {
    const tag = searchFrom(tagRe, text, i);
    if (!tag || tag.index !== i) {
      // advance to next candidate
      if (!tag) break;
      i = tag.index;
      continue;
    }
    if (tag[0].startsWith("</")) {
      openCount -= 1;
      if (openCount === 0) {
        const end = text.indexOf(">", i) + 1;
        return text.slice(formStart, end);
      }
    } else {
      openCount += 1;
    }
    i += tag[0].length;
  }
  return text.slice(formStart);
}

function pageNameFromComponent(component: string): string {
  const m = /([^/]+)\.vue/.exec(component);
  if (m) return m[1];
  const n = /['"]?([A-Za-z0-9_]+)['"]?/.exec(component);
  return n ? n[1] : "Page";
}

function pageNameFromFile(rel: string): string {
  return path.basename(rel, path.extname(rel));
}

export function parseVueFile(file: string, rel: string): FrontendResult {
  const text = readFileSafe(file);
  const result = emptyFrontend();
  const base = path.basename(file);

  // Routes: only router/index.js or router.js
  if (
    (base === "index.js" || base === "router.js") &&
    rel.replaceAll("\\", "/").includes("router")
  ) {
    for (const route of parseRouter(text)) {
      const pageName = route.name || pageNameFromComponent(route.component);
      result.pages.push({
        name: pageName,
        route: route.path,
        file: rel,
        forms: [],
      });
    }
  }

  // Forms & fields: .vue files
  if (base.endsWith(".vue")) {
    const pageName = pageNameFromFile(rel);
    const page: Page = { name: pageName, route: "", file: rel, forms: [] };
    let pos = 0;
    for (;;) {
      const m = searchFrom(EL_FORM_RE, text, pos);
      if (!m) break;
      const block = extractFormBlock(text, m.index);
      const form: Form = { fields: [] };
      // Parse each <el-form-item> segment
      let itemPos = 0;
      for (;;) {
        const im = searchFrom(EL_FORM_ITEM_RE, block, itemPos);
        if (!im) break;
        const next = searchFrom(
          EL_FORM_ITEM_RE,
          block,
          im.index + im[0].length,
        );
        const seg = block.slice(im.index, next ? next.index : block.length);
        const rulesRaw = firstMatch(RULES_RE, seg);
        const field: FormField = {
          label: firstMatch(LABEL_RE, seg) || "",
          prop: firstMatch(PROP_RE, seg) || "",
          type: "input",
          required: REQUIRED_RE.test(seg),
          placeholder: firstMatch(PLACEHOLDER_RE, seg) || "",
          rules: rulesRaw ? rulesRaw.split(",") : [],
        };
        if (seg.includes("<el-input") && seg.includes("textarea")) {
          field.type = "textarea";
        } else if (seg.includes("<el-select")) {
          field.type = "select";
        } else if (seg.includes("<el-switch")) {
          field.type = "switch";
        }
        // Skip empty form-items (e.g. pure button rows)
        if (field.prop || field.label) form.fields.push(field);
        itemPos = im.index + im[0].length;
      }
      page.forms.push(form);
      pos = m.index + m[0].length;
    }
    // Every .vue file is a page (forms may be empty, e.g. list pages)
    result.pages.push(page);

    // Selectors inferred from placeholder/label
    for (const form of page.forms) {
      for (const field of form.fields) {
        if (field.placeholder) {
          const selector: PageSelector = {
            type: "placeholder",
            value: field.placeholder,
            page: page.name,
          };
          result.selectors.push(selector);
        } else if (field.label) {
          const selector: PageSelector = {
            type: "label",
            value: field.label,
            page: page.name,
          };
          result.selectors.push(selector);
        }
      }
    }

    // UI texts: ElMessage / ElMessageBox
    MESSAGE_RE.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = MESSAGE_RE.exec(text)) !== null) {
      result.uiTexts.push(mm[1]);
    }
  }

  result.uiTexts = [...new Set(result.uiTexts)];
  return result;
}

export function analyzeFrontend(
  vueJsFiles: string[],
  root: string,
): FrontendResult {
  const merged = emptyFrontend();
  const routerFiles = vueJsFiles.filter((file) => {
    const base = path.basename(file);
    return base === "index.js" || base === "router.js";
  });
  const pageFiles = vueJsFiles.filter((file) => file.endsWith(".vue"));

  // Router files only build the page_name -> route map; real pages (with
  // forms) come from .vue parsing.
  const routeMap = new Map<string, string>();
  for (const file of routerFiles) {
    const one = parseVueFile(file, path.relative(root, file));
    for (const page of one.pages) routeMap.set(page.name, page.route);
  }

  for (const file of pageFiles) {
    const one = parseVueFile(file, path.relative(root, file));
    for (const page of one.pages) {
      if (!page.route && routeMap.has(page.name)) {
        page.route = routeMap.get(page.name)!;
      }
    }
    merged.pages.push(...one.pages);
    merged.selectors.push(...one.selectors);
    merged.uiTexts.push(...one.uiTexts);
  }

  // Dedupe pages by (file, name)
  const dedup = new Map<string, Page>();
  for (const page of merged.pages) dedup.set(`${page.file}|${page.name}`, page);
  merged.pages = [...dedup.values()];
  merged.uiTexts = [...new Set(merged.uiTexts)];
  return merged;
}
