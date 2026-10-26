/**
 * Go backend static analysis (pure rules, zero LLM).
 *
 * Targets yukino_http services
 * (github.com/hangtiancheng/yukino.go/libs/yukino_http):
 * - Endpoints: group prefixes from `api := app.Router("/prefix")` plus
 *   route registrations `api.Post("/path", h.Method)`; `:param` segments
 *   are normalized to `{param}` so paths stay language-agnostic
 * - Entities: exported struct fields; field names come from json tags
 * - Constraints: guard shapes in entity methods —
 *   `== ""` -> required, `len(x) > N` -> size, `!re.MatchString(x)` -> pattern
 * - Business rules: the remaining if-guard + error-literal pairs
 *   (errors.New / fmt.Errorf / ctx.Throw)
 * - Every error literal is also collected as UI text
 */
import path from "node:path";

import { readFileSafe } from "./scanner";

import type {
  BackendResult,
  BusinessRule,
  Entity,
  EntityField,
  EnumDef,
  EnumValue,
} from "#/lib/types";

const ROUTER_GROUP_RE = /(\w+)\s*:?=\s*(\w+)\.Router\(\s*"([^"]*)"\s*\)/;
const ROUTE_RE =
  /(\w+)\.(Get|Post|Put|Delete|Patch|Head|Options)\(\s*"([^"]*)"\s*,\s*(?:\w+\.)?(\w+)\s*\)/;
const STRUCT_RE = /^type\s+(\w+)\s+struct\s*\{/;
const STRING_TYPE_RE = /^type\s+(\w+)\s+string\b/;
const CONST_LINE_RE = /^\s*(\w+)\s+(\w+)\s*=\s*"([^"]+)"\s*(?:\/\/.*)?$/;
const SINGLE_CONST_RE = /^const\s+(\w+)\s+(\w+)\s*=\s*"([^"]+)"\s*(?:\/\/.*)?$/;
const LABEL_MAP_RE = /var\s+\w+\s*=\s*map\[(\w+)\]string\s*\{/;
const LABEL_ENTRY_RE = /^\s*(\w+)\s*:\s*"([^"]+)"\s*,?\s*(?:\/\/.*)?$/;
const REGEXP_VAR_RE =
  /var\s+(\w+)\s*=\s*regexp\.MustCompile\(\s*[`"']([^`"']+)[`"']\s*\)/;
const FUNC_RE = /^func\s+(?:\(\s*\w+\s+\*?([\w.[\]]+)\s*\)\s*)?(\w+)\s*\(/;
const IF_RE = /^\s*(?:}\s*else\s+)?if\s+(.+?)\s*\{\s*(?:\/\/.*)?$/;
const ERROR_LITERAL_RE =
  /(?:errors\.New|fmt\.Errorf)\(\s*"([^"]*)"|\.Throw\(\s*[\w.]+\s*,\s*"([^"]*)"/;
const STRUCT_FIELD_RE =
  /^\s*([A-Z]\w*)\s+([^\s`]+)\s*(?:`([^`]*)`)?\s*(?:\/\/.*)?$/;
const JSON_TAG_RE = /\bjson:"([^",]+)/;
const FIELD_REF_RE = /\b[a-z_]\w*\.([A-Z]\w*)/;
const SIZE_GUARD_RE = /len\(\s*\w+\.([A-Z]\w*)\s*\)\s*>\s*(\d+)/;
const PATTERN_GUARD_RE = /!\s*(\w+)\.MatchString\(\s*\w+\.([A-Z]\w*)/;

const VERB_MAP: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Delete: "DELETE",
  Patch: "PATCH",
  Head: "HEAD",
  Options: "OPTIONS",
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

export interface GoEnumFacts {
  enums: EnumDef[];
  /** Go const identifier -> enum value name (e.g. StatusPaid -> PAID). */
  identToValue: Map<string, string>;
}

interface StructFacts {
  entity: Entity;
  /** Go field name -> json tag name (falls back to the Go name). */
  jsonNames: Map<string, string>;
  receiverTypes: Set<string>;
}

function emptyBackend(): BackendResult {
  return {
    language: "go",
    endpoints: [],
    entities: [],
    enums: [],
    businessRules: [],
    uiTexts: [],
  };
}

function dedupeKeepOrder(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function joinPath(prefix: string | null, segment: string | null): string {
  const right = (segment || "").replace(/^\/+|\/+$/g, "");
  if (prefix) {
    const left = prefix.replace(/^\/+|\/+$/g, "");
    return `/${left}/${right}`.replace(/\/+$/, "") || "/";
  }
  return `/${right}`.replace(/\/+$/, "") || "/";
}

/** yukino_http trie params (`:id`, `*rest`) -> language-agnostic `{id}`. */
function normalizeParams(segment: string): string {
  return segment.replace(/:([A-Za-z_]\w*)/g, "{$1}");
}

/** String enum types, const values, and label maps across all files. */
export function collectGoEnums(files: string[]): GoEnumFacts {
  const stringTypes = new Set<string>();
  // type name -> ordered [{ ident, value }]
  const constValues = new Map<string, { ident: string; value: string }[]>();
  // type name -> ident -> label
  const labelMaps = new Map<string, Map<string, string>>();

  // Pass 1: string enum types may be declared in any file.
  for (const file of files) {
    const lines = readFileSafe(file).split("\n");
    for (const ln of lines) {
      const tm = STRING_TYPE_RE.exec(ln);
      if (tm) stringTypes.add(tm[1]);
    }
  }

  // Pass 2: const values and label maps reference those types.
  for (const file of files) {
    const lines = readFileSafe(file).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const single = SINGLE_CONST_RE.exec(lines[i]);
      if (single && stringTypes.has(single[2])) {
        const list = constValues.get(single[2]) ?? [];
        list.push({ ident: single[1], value: single[3] });
        constValues.set(single[2], list);
      }
      if (/^const\s*\(/.test(lines[i])) {
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s*\)/.test(lines[j])) break;
          const cm = CONST_LINE_RE.exec(lines[j]);
          if (cm && stringTypes.has(cm[2])) {
            const list = constValues.get(cm[2]) ?? [];
            list.push({ ident: cm[1], value: cm[3] });
            constValues.set(cm[2], list);
          }
        }
      }
      const lm = LABEL_MAP_RE.exec(lines[i]);
      if (lm && stringTypes.has(lm[1])) {
        const entries = labelMaps.get(lm[1]) ?? new Map<string, string>();
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s*\}/.test(lines[j])) break;
          const em = LABEL_ENTRY_RE.exec(lines[j]);
          if (em) entries.set(em[1], em[2]);
        }
        labelMaps.set(lm[1], entries);
      }
    }
  }

  const enums: EnumDef[] = [];
  const identToValue = new Map<string, string>();
  for (const [typeName, values] of constValues) {
    if (values.length === 0) continue;
    const labels = labelMaps.get(typeName) ?? new Map<string, string>();
    const enumDef: EnumDef = { name: typeName, values: [] };
    for (const { ident, value } of values) {
      const label = labels.get(ident);
      const enumValue: EnumValue = { name: value, label: label ?? value };
      enumDef.values.push(enumValue);
      identToValue.set(ident, value);
    }
    enums.push(enumDef);
  }
  return { enums, identToValue };
}

/** Exported struct declarations -> entities with json-tag field names. */
function collectGoStructs(file: string, rel: string): Map<string, StructFacts> {
  const out = new Map<string, StructFacts>();
  const lines = readFileSafe(file).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const sm = STRUCT_RE.exec(lines[i]);
    if (!sm) continue;
    const name = sm[1];
    if (NON_ENTITY_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
    const entity: Entity = {
      name,
      file: rel,
      fields: [],
      fieldConstraints: [],
    };
    const jsonNames = new Map<string, string>();
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*\}/.test(lines[j])) break;
      const fm = STRUCT_FIELD_RE.exec(lines[j]);
      if (!fm) continue;
      const goName = fm[1];
      const tag = fm[3] || "";
      const jsonMatch = JSON_TAG_RE.exec(tag);
      const fieldName = jsonMatch ? jsonMatch[1] : goName;
      jsonNames.set(goName, fieldName);
      const field: EntityField = { name: fieldName, type: fm[2] };
      entity.fields.push(field);
    }
    if (entity.fields.length > 0) {
      out.set(name, {
        entity,
        jsonNames,
        receiverTypes: new Set([name, `*${name}`]),
      });
    }
  }
  return out;
}

interface Emission {
  message: string;
  line: number;
  guard: string | null;
}

/**
 * Per-function walk: every error literal plus its nearest if-guard.
 * Guard lookup stays inside the enclosing func (max 15 lines up).
 */
function collectEmissions(lines: string[]): Emission[] {
  const out: Emission[] = [];
  let funcStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (FUNC_RE.test(lines[i])) funcStart = i;
    const em = ERROR_LITERAL_RE.exec(lines[i]);
    if (!em) continue;
    const message = em[1] ?? em[2] ?? "";
    let guard: string | null = null;
    for (let j = i - 1; j > Math.max(i - 15, funcStart - 1); j--) {
      const gm = IF_RE.exec(lines[j]);
      if (gm) {
        guard = gm[1].trim();
        break;
      }
    }
    out.push({ message, line: i + 1, guard });
  }
  return out;
}

function parseGoFile(
  file: string,
  rel: string,
  structs: Map<string, StructFacts>,
  regexpVars: Map<string, string>,
): BackendResult {
  const result = emptyBackend();
  const lines = readFileSafe(file).split("\n");

  // 1) Endpoints: group prefixes first, then route registrations.
  const groups = new Map<string, string>();
  let controller = "";
  for (let i = 0; i < lines.length; i++) {
    const fm = FUNC_RE.exec(lines[i]);
    if (fm && fm[1]) controller = fm[1];
    const gm = ROUTER_GROUP_RE.exec(lines[i]);
    if (gm) {
      const base = groups.get(gm[2]);
      groups.set(gm[1], joinPath(base ?? null, gm[3]));
    }
    const rm = ROUTE_RE.exec(lines[i]);
    if (rm) {
      const prefix = groups.get(rm[1]) ?? (rm[1] === "app" ? "" : null);
      result.endpoints.push({
        id: "",
        method: VERB_MAP[rm[2]] ?? rm[2].toUpperCase(),
        path: normalizeParams(joinPath(prefix, rm[3])),
        controller,
        methodName: rm[4],
        file: rel,
        line: i + 1,
      });
    }
  }

  // 2) Error literals -> constraints (entity methods) or business rules.
  const funcOwner = (lineIdx: number): StructFacts | null => {
    for (let j = lineIdx; j >= 0; j--) {
      const fm = FUNC_RE.exec(lines[j]);
      if (fm) {
        if (!fm[1]) return null;
        return structs.get(fm[1].replace(/^\*/, "")) ?? null;
      }
    }
    return null;
  };

  let ruleIdx = 0;
  for (const emission of collectEmissions(lines)) {
    const message = emission.message;
    if (message) result.uiTexts.push(message);

    let classified = false;
    const owner = emission.guard ? funcOwner(emission.line - 1) : null;
    if (owner && emission.guard) {
      const guard = emission.guard;
      // A guard may reference helpers before the entity field
      // (strings.TrimSpace(o.X), re.MatchString(o.X)); pick the first
      // reference that maps to a known struct field.
      let fieldName: string | null = null;
      const refRe = new RegExp(FIELD_REF_RE.source, "g");
      let refMatch: RegExpExecArray | null;
      while ((refMatch = refRe.exec(guard)) !== null) {
        const mapped = owner.jsonNames.get(refMatch[1]);
        if (mapped) {
          fieldName = mapped;
          break;
        }
      }
      if (fieldName) {
        const sizeMatch = SIZE_GUARD_RE.exec(guard);
        const patternMatch = PATTERN_GUARD_RE.exec(guard);
        if (/==\s*""/.test(guard)) {
          owner.entity.fieldConstraints.push({
            field: fieldName,
            rule: "required",
          });
          classified = true;
        } else if (sizeMatch) {
          owner.entity.fieldConstraints.push({
            field: owner.jsonNames.get(sizeMatch[1]) ?? fieldName,
            rule: "size",
            value: Number(sizeMatch[2]),
          });
          classified = true;
        } else if (patternMatch) {
          const source = regexpVars.get(patternMatch[1]) ?? null;
          owner.entity.fieldConstraints.push({
            field: owner.jsonNames.get(patternMatch[2]) ?? fieldName,
            rule: "pattern",
            value: source ?? undefined,
          });
          classified = true;
        }
      }
    }

    if (!classified && emission.guard) {
      ruleIdx += 1;
      const rule: BusinessRule = {
        id: `br-${ruleIdx}`,
        description: message,
        guard: emission.guard,
        file: rel,
        line: emission.line,
      };
      result.businessRules.push(rule);
    }
  }

  result.uiTexts = dedupeKeepOrder(result.uiTexts);
  return result;
}

/** Merge per-file results; endpoint/rule ids are globally sequential. */
export function analyzeGoBackend(
  goFiles: string[],
  root: string,
): BackendResult {
  const merged = emptyBackend();

  // Pass 1: cross-file facts (structs, enums, regexp vars) so constraint
  // classification works even when Validate() lives apart from the struct.
  const allStructs = new Map<string, StructFacts>();
  const regexpVars = new Map<string, string>();
  for (const file of goFiles) {
    const rel = path.relative(root, file);
    for (const [name, facts] of collectGoStructs(file, rel)) {
      allStructs.set(name, facts);
    }
    for (const ln of readFileSafe(file).split("\n")) {
      const rm = REGEXP_VAR_RE.exec(ln);
      if (rm) regexpVars.set(rm[1], rm[2]);
    }
  }
  merged.enums = collectGoEnums(goFiles).enums;

  // Pass 2: endpoints, constraints, business rules, UI texts.
  let epCounter = 0;
  let brCounter = 0;
  for (const file of goFiles) {
    const rel = path.relative(root, file);
    const one = parseGoFile(file, rel, allStructs, regexpVars);
    for (const ep of one.endpoints) {
      epCounter += 1;
      merged.endpoints.push({ ...ep, id: `ep-${epCounter}` });
    }
    for (const br of one.businessRules) {
      brCounter += 1;
      merged.businessRules.push({ ...br, id: `br-${brCounter}` });
    }
    merged.uiTexts.push(...one.uiTexts);
  }

  // Entities keep declaration order across files; dedupe constraints that
  // repeat the same field + rule (e.g. DTO mirroring the entity).
  for (const facts of allStructs.values()) {
    const seen = new Set<string>();
    facts.entity.fieldConstraints = facts.entity.fieldConstraints.filter(
      (c) => {
        const key = `${c.field}|${c.rule}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    );
    merged.entities.push(facts.entity);
  }

  merged.uiTexts = dedupeKeepOrder(merged.uiTexts);
  return merged;
}
