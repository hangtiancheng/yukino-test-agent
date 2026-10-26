/**
 * Spring Boot backend static analysis (pure rules, zero LLM).
 *
 * Key pitfalls handled:
 * - A class-level @RequestMapping is only a path prefix, never an endpoint
 * - Every endpoint carries file + line evidence
 */
import path from "node:path";

import { readFileSafe } from "./scanner";

import type {
  BackendResult,
  BusinessRule,
  EndpointParam,
  Entity,
  EntityField,
  EnumDef,
  EnumValue,
} from "#/lib/types";

const METHOD_MAPPING_RE =
  /@(Get|Post|Put|Delete|Patch)Mapping\s*(?:\(([^)]*)\))?/;
const CLASS_MAPPING_RE = /@RequestMapping\s*\(([^)]*)\)/;
const CLASS_DECL_RE = /\b(class|interface|enum)\s+(\w+)/;
const METHOD_DECL_RE =
  /\b(public|private|protected)\s+[A-Za-z_<>,.[\]\s]+\s+(\w+)\s*\(/;
const FIELD_DECL_RE = /\bprivate\s+([A-Za-z_<>,[\].\s]+?)\s+(\w+)\s*;/;
const THROW_RE = /throw\s+new\s+\w+\s*\(\s*"([^"]*)"\s*\)/;
const IF_GUARD_RE = /\bif\s*\(([^{}]*)\)\s*(?:\{|throw)/;
const AUTH_ANNOTATION_RE =
  /@(PreAuthorize|Secured|RolesAllowed|PermitAll|DenyAll)\s*(\([^)]*\))?/g;
const PARAM_ANNOTATION_RE = /@(\w+)\s*(?:\(([^)]*)\))?/g;
const PARAM_CONSTRAINT_NAMES = new Set([
  "notblank",
  "notnull",
  "notempty",
  "size",
  "max",
  "min",
  "pattern",
  "email",
  "decimalmin",
  "decimalmax",
  "digits",
  "positive",
  "positiveorzero",
  "negative",
  "negativeorzero",
  "length",
]);
const SIMPLE_PARAM_TYPES = new Set([
  "string",
  "int",
  "integer",
  "long",
  "short",
  "byte",
  "float",
  "double",
  "boolean",
  "char",
  "bigdecimal",
  "biginteger",
  "date",
  "localdate",
  "localdatetime",
  "list",
  "set",
  "map",
  "object",
]);
const CONSTRAINT_RE =
  /@(NotBlank|NotNull|NotEmpty|Size|Max|Min|Pattern|Email|DecimalMin|DecimalMax|Digits|Positive|PositiveOrZero|Negative|Length)\s*(?:\(\s*([^)]*)\s*\))?/;
/** First quoted literal in an enum constructor call -> human-readable label. */
const QUOTED_RE = /["']([^"']+)["']/;
const MESSAGE_RE = /message\s*=\s*"([^"]*)"/;

const VERB_MAP: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Delete: "DELETE",
  Patch: "PATCH",
};

const NON_ENTITY_SUFFIXES = [
  "Controller",
  "Service",
  "ServiceImpl",
  "Repository",
  "Config",
  "Application",
  "Handler",
  "Exception",
  "Response",
];

function emptyBackend(): BackendResult {
  return {
    language: "java-spring",
    endpoints: [],
    entities: [],
    enums: [],
    businessRules: [],
    uiTexts: [],
  };
}

function extractPathValue(annotationArgs: string | undefined): string | null {
  if (!annotationArgs) return null;
  const direct = annotationArgs.match(/"([^"]+)"/);
  if (direct) return direct[1];
  const named = annotationArgs.match(/\b(?:value|path)\s*=\s*"([^"]+)"/);
  if (named) return named[1];
  return null;
}

function joinPath(prefix: string | null, segment: string | null): string {
  const right = (segment || "").replace(/^\/+|\/+$/g, "");
  if (prefix) {
    const left = prefix.replace(/^\/+|\/+$/g, "");
    return `/${left}/${right}`.replace(/\/+$/, "") || "/";
  }
  return `/${right}`.replace(/\/+$/, "") || "/";
}

function dedupeKeepOrder(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Join the method declaration (up to 12 lines) and return the text inside the parameter parentheses. */
function methodSignature(lines: string[], start: number): string {
  const text = lines.slice(start, start + 12).join(" ");
  const openIdx = text.indexOf("(");
  if (openIdx < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let idx = openIdx; idx < text.length; idx++) {
    const ch = text[idx];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(openIdx + 1, idx);
    }
  }
  return text.slice(openIdx + 1);
}

/** Split parameters on top-level commas, ignoring commas inside generics, annotation arguments, and strings. */
function splitParams(text: string): string[] {
  const out: string[] = [];
  const buf: string[] = [];
  let paren = 0;
  let angle = 0;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      buf.push(ch);
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      buf.push(ch);
    } else if (ch === "(") {
      paren += 1;
      buf.push(ch);
    } else if (ch === ")") {
      paren = Math.max(0, paren - 1);
      buf.push(ch);
    } else if (ch === "<") {
      angle += 1;
      buf.push(ch);
    } else if (ch === ">") {
      angle = Math.max(0, angle - 1);
      buf.push(ch);
    } else if (ch === "," && paren === 0 && angle === 0) {
      const item = buf.join("").trim();
      if (item) out.push(item);
      buf.length = 0;
    } else {
      buf.push(ch);
    }
  }
  const item = buf.join("").trim();
  if (item) out.push(item);
  return out;
}

/** Parse a declaration's parameter list into structured parameter facts. */
function parseMethodParams(signature: string): EndpointParam[] {
  const params: EndpointParam[] = [];
  for (const raw of splitParams(signature)) {
    const annotations: [string, string][] = [];
    for (const m of raw.matchAll(PARAM_ANNOTATION_RE)) {
      annotations.push([m[1], m[2] ?? ""]);
    }
    const annNames = new Map(
      annotations.map(([name, args]) => [name.toLowerCase(), args]),
    );
    const cleaned = raw.replace(PARAM_ANNOTATION_RE, " ");
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) continue;
    const paramType = (tokens[tokens.length - 2] ?? "").split("<")[0].trim();
    const paramName = tokens[tokens.length - 1] ?? "";
    if (!paramName || !paramType) continue;
    let source: string;
    if (annNames.has("requestbody")) source = "request_body";
    else if (annNames.has("pathvariable")) source = "path_variable";
    else if (annNames.has("requestparam")) source = "request_param";
    else source = "unknown";
    const argsText = [...annNames.values()]
      .join(" ")
      .replace(/\s+/g, "")
      .toLowerCase();
    const required =
      source === "request_body" ||
      source === "path_variable" ||
      annNames.has("notblank") ||
      annNames.has("notnull") ||
      annNames.has("notempty") ||
      (source === "request_param" && !argsText.includes("required=false"));
    const constraints: string[] = [];
    for (const [name, args] of annotations) {
      if (PARAM_CONSTRAINT_NAMES.has(name.toLowerCase())) {
        constraints.push(args ? `${name}(${args})` : name);
      }
    }
    params.push({
      name: paramName,
      type: paramType,
      source,
      required,
      constraints,
      dtoType:
        /^[A-Z]/.test(paramType) &&
        !SIMPLE_PARAM_TYPES.has(paramType.toLowerCase())
          ? paramType
          : "",
    });
  }
  return params;
}

/** Collect security annotations between the mapping annotation and the method declaration. */
function methodAuth(
  lines: string[],
  mappingIdx: number,
  methodIdx: number,
): string[] {
  const auth: string[] = [];
  for (
    let idx = Math.max(0, mappingIdx - 3);
    idx < Math.min(lines.length, methodIdx + 1);
    idx++
  ) {
    for (const m of lines[idx].matchAll(AUTH_ANNOTATION_RE)) {
      const text = `@${m[1]}${m[2] ?? ""}`;
      if (!auth.includes(text)) auth.push(text);
    }
  }
  return auth;
}

export function parseJavaFile(file: string, rel: string): BackendResult {
  const result = emptyBackend();
  const lines = readFileSafe(file)
    .split("\n")
    .map((ln) => ln.replace(/\n$/, ""));

  // 1) Class-level @RequestMapping prefix (nearest one above the class decl)
  let classPrefix: string | null = null;
  let className: string | null = null;
  let classKind: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = CLASS_DECL_RE.exec(lines[i]);
    if (m) {
      classKind = m[1]!;
      className = m[2]!;
      for (let j = i - 1; j > Math.max(i - 20, -1); j--) {
        const cm = CLASS_MAPPING_RE.exec(lines[j]);
        if (cm) {
          classPrefix = extractPathValue(cm[1]);
          break;
        }
      }
      break;
    }
  }

  // 2) Endpoints: method-level mapping annotations + method name
  let epIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const mm = METHOD_MAPPING_RE.exec(lines[i]);
    if (!mm) continue;
    const verb = VERB_MAP[mm[1]] ?? "GET";
    const segment = mm[2] ? extractPathValue(mm[2]) : "";
    let methodName: string | null = null;
    let methodIdx = i;
    for (let j = i; j < Math.min(i + 5, lines.length); j++) {
      const dm = METHOD_DECL_RE.exec(lines[j]);
      if (dm) {
        methodName = dm[2]!;
        methodIdx = j;
        break;
      }
    }
    if (!methodName) continue;
    epIdx += 1;
    result.endpoints.push({
      id: `ep-${epIdx}`,
      method: verb,
      path: joinPath(classPrefix, segment),
      controller: className || "",
      methodName,
      file: rel,
      line: i + 1,
      params: parseMethodParams(methodSignature(lines, methodIdx)),
      auth: methodAuth(lines, i, methodIdx),
    });
  }

  // 3) Entities: only `class` (not interface/enum), excluding non-data models
  if (
    classKind === "class" &&
    className &&
    /^[A-Z]/.test(className) &&
    !NON_ENTITY_SUFFIXES.some((suffix) => className.endsWith(suffix))
  ) {
    const entity: Entity = {
      name: className,
      file: rel,
      fields: [],
      fieldConstraints: [],
    };
    // Constraints accumulate: a field may carry several annotations
    // (@NotBlank + @Size); they bind to the next field declaration.
    let pending: { rule: string; value: unknown }[] = [];
    for (const ln of lines) {
      const cm = CONSTRAINT_RE.exec(ln);
      if (cm) {
        const rule = cm[1].toLowerCase();
        const args = cm[2] || "";
        let value: unknown = null;
        if (rule === "size") {
          const mx = args.match(/max\s*=\s*(\d+)/);
          value = mx ? Number(mx[1]) : null;
        } else if (rule === "max" || rule === "min") {
          const m = args.match(/\b(?:max|min)\s*=\s*(\d+)/);
          value = m ? Number(m[1]) : null;
        } else {
          const m = args.match(/"([^"]+)"/);
          value = m ? m[1] : null;
        }
        pending.push({ rule, value });
        continue;
      }

      const fm = FIELD_DECL_RE.exec(ln);
      if (fm) {
        const field: EntityField = {
          name: fm[2],
          type: fm[1].trim(),
        };
        entity.fields.push(field);
        for (const { rule, value } of pending) {
          entity.fieldConstraints.push({
            field: field.name,
            rule,
            value: value ?? undefined,
          });
        }
        pending = [];
        continue;
      }

      // Only method/class declarations clear pending (avoid cross-field
      // leakage); unknown annotations/comments/blank lines do not.
      if (METHOD_DECL_RE.test(ln) || CLASS_DECL_RE.test(ln)) {
        pending = [];
      }
    }
    if (entity.fields.length > 0) result.entities.push(entity);
  }

  // 4) Enums
  if (classKind === "enum" && className) {
    const enumDef: EnumDef = { name: className, values: [] };
    // \b avoids matching the constructor name (OrderStatus(...)): enum
    // constants are ALL_CAPS tokens.
    const constRe = /^\s*([A-Z][A-Z0-9_]*)\b\s*(?:\(([^)]*)\))?[,;]?/;
    for (const ln of lines) {
      const m = constRe.exec(ln);
      const trimmed = ln.trim();
      if (
        m &&
        !["package", "import", "//", "enum", "}", "public"].some((prefix) =>
          trimmed.startsWith(prefix),
        )
      ) {
        const name = m[1];
        const args = m[2] || "";
        const labelMatch = QUOTED_RE.exec(args);
        const value: EnumValue = {
          name,
          label: labelMatch ? labelMatch[1] : name,
        };
        enumDef.values.push(value);
      }
    }
    if (enumDef.values.length > 0) result.enums.push(enumDef);
  }

  // 5) Business rules: if(...) throw new X("message")
  let ruleIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const tm = THROW_RE.exec(lines[i]);
    if (!tm) continue;
    const message = tm[1];
    // Nearest if-guard within the same method (look back up to 15 lines)
    let guard: string | null = null;
    for (let j = i - 1; j > Math.max(i - 15, -1); j--) {
      const gm = IF_GUARD_RE.exec(lines[j]);
      if (gm) {
        guard = gm[1].trim();
        break;
      }
    }
    if (guard === null) continue;
    ruleIdx += 1;
    const rule: BusinessRule = {
      id: `br-${ruleIdx}`,
      description: message,
      guard,
      file: rel,
      line: i + 1,
    };
    result.businessRules.push(rule);
    if (message) result.uiTexts.push(message);
  }

  // 6) Extra UI texts: validation messages declared on constraint annotations
  for (const ln of lines) {
    const m = MESSAGE_RE.exec(ln);
    if (m && m[1].trim()) result.uiTexts.push(m[1]);
  }

  result.uiTexts = dedupeKeepOrder(result.uiTexts);
  return result;
}

/** Merge per-file results; endpoint/rule ids are globally sequential. */
export function analyzeBackend(
  javaFiles: string[],
  root: string,
): BackendResult {
  const merged = emptyBackend();
  let epCounter = 0;
  let brCounter = 0;
  for (const file of javaFiles) {
    const rel = path.relative(root, file);
    const one = parseJavaFile(file, rel);
    for (const ep of one.endpoints) {
      epCounter += 1;
      merged.endpoints.push({ ...ep, id: `ep-${epCounter}` });
    }
    for (const br of one.businessRules) {
      brCounter += 1;
      merged.businessRules.push({ ...br, id: `br-${brCounter}` });
    }
    merged.entities.push(...one.entities);
    merged.enums.push(...one.enums);
    merged.uiTexts.push(...one.uiTexts);
  }
  merged.uiTexts = dedupeKeepOrder(merged.uiTexts);
  return merged;
}
