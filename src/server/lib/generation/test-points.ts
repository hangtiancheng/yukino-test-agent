/**
 * Agent 1: requirement test point extraction.
 *
 * Boundary:
 * - Input: requirement text + code facts; output: structurally validated
 *   test points.
 * - Persistence, threading, and fallback decisions stay in the requirement
 *   service so the existing "parse requirement version" behavior is
 *   unchanged.
 *
 * LLM first; when the LLM is unavailable or returns nothing, deterministic
 * rule extraction takes over.
 */
import { testPointsPrompt } from "./prompts";

import type { LlmClient } from "#/server/lib/llm";

import type {
  BackendResult,
  FrontendResult,
  Page,
  StateMachineSpec,
  TestPointDraft,
} from "#/lib/types";

const CATEGORIES = new Set([
  "functional",
  "negative",
  "boundary",
  "state",
  "api",
  "permission",
]);
const PRIORITIES = new Set(["P0", "P1", "P2"]);

export interface PointInput extends TestPointDraft {
  id?: string;
}

/** Code facts digest fed to the LLM prompt. */
export function factsForPrompt(
  backend: BackendResult | null,
  frontend: FrontendResult | null,
  machines: StateMachineSpec[],
): Record<string, unknown> {
  const pages: Record<string, unknown>[] = [];
  if (frontend) {
    for (const page of frontend.pages) {
      const fields = page.forms.flatMap((form) =>
        form.fields.map((f) => ({
          label: f.label,
          prop: f.prop,
          type: f.type,
          required: f.required,
          placeholder: f.placeholder,
          rules: f.rules,
        })),
      );
      pages.push({ name: page.name, route: page.route, fields });
    }
  }
  const endpoints = backend
    ? backend.endpoints.slice(0, 60).map((e) => ({
        method: e.method,
        path: e.path,
        controller: e.controller,
      }))
    : [];
  return {
    pages,
    endpoints,
    uiTexts: frontend ? frontend.uiTexts.slice(0, 40) : [],
    stateMachines: machines.map((m) => ({
      name: m.name,
      states: (m.states || []).map((s) => s.label || s.name),
      transitions: (m.transitions || []).map(
        (t) => `${t.from} -> ${t.to} (${t.trigger})`,
      ),
    })),
  };
}

/** Accept dict/list outputs and trim fields; mirrors the original service. */
export function normalizePoints(raw: unknown, source: string): PointInput[] {
  let list: unknown = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const dict = raw as Record<string, unknown>;
    list = dict.testPoints || dict.points || dict.data || [];
  }
  if (!Array.isArray(list)) return [];
  const out: PointInput[] = [];
  const seen = new Set<string>();
  for (const rc of list.slice(0, 40)) {
    if (!rc || typeof rc !== "object") continue;
    const item = rc as Record<string, unknown>;
    const title = String(item.title || "").trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const cat = String(item.category || "functional")
      .trim()
      .toLowerCase();
    const pri = String(item.priority || "P1")
      .trim()
      .toUpperCase();
    let fields = item.fields;
    if (!Array.isArray(fields)) fields = fields ? [String(fields)] : [];
    let confidence = Number(item.confidence);
    if (!Number.isFinite(confidence)) {
      confidence = source === "llm" ? 0.85 : 0.7;
    }
    out.push({
      title: title.slice(0, 255),
      category: CATEGORIES.has(cat) ? cat : "functional",
      priority: PRIORITIES.has(pri) ? pri : "P1",
      description: String(item.description || "").slice(0, 2000),
      pageRoute: String(item.pageRoute || item.page_route || "").slice(0, 255),
      endpoint: String(item.endpoint || "").slice(0, 255),
      fields: (fields as unknown[])
        .map((f) => String(f).slice(0, 80))
        .slice(0, 20),
      expected: String(item.expected || "").slice(0, 1000),
      source,
      confidence: Math.min(Math.max(confidence, 0), 1),
    });
  }
  return out;
}

/** Structural validation; invalid entries are dropped, never persisted. */
export function validatePoints(points: PointInput[]): PointInput[] {
  return points.filter(
    (point) =>
      typeof point.title === "string" &&
      point.title.length > 0 &&
      point.title.length <= 255 &&
      CATEGORIES.has(String(point.category)) &&
      PRIORITIES.has(String(point.priority)) &&
      Array.isArray(point.fields) &&
      Number.isFinite(point.confidence),
  );
}

// Static page structure / fixed counts are not business test points:
//   - "the new-order page displays 5 form fields"
//   - "the list page shows 4 seed orders by default"
// Such counts drift with the page and its data; they belong to business
// scenarios and runtime baselines instead.
const STATIC_STRUCTURE_RE =
  /(?:displays?|shows?|contains?|includes?|lists?|renders?|has|have)\s+\d+\s+(?:form\s+|input\s+)?(?:fields?|inputs?|boxes?|buttons?|options?|columns?|rows?|orders?|records?|items?|entries?)/i;
const BARE_FIELD_COUNT_RE =
  /\d+\s+(?:form\s+|input\s+)?(?:fields?|inputs?|boxes?|buttons?|options?)/i;
const BARE_STATUS_LABELS = new Set([
  "pending payment",
  "awaiting payment",
  "unpaid",
  "paid",
  "shipped",
  "completed",
  "done",
  "cancelled",
  "canceled",
  "refunded",
  "pay",
  "ship",
  "complete",
  "cancel",
  "refund",
  "query",
  "search",
  "reset",
  "submit",
  "save",
  "new order",
  "create order",
  "add order",
  "back to list",
  "back",
  "return",
  "confirm",
  "delete",
  "edit",
  "view",
  "details",
]);
const STRUCTURAL_TITLE_WORDS = [
  "first row",
  "top row",
  "sort",
  "sorting",
  "sorted",
  "sequence",
  "ordering",
  "position",
  "ranked",
  "ranks",
  "action column",
  "actions column",
  "operation column",
  "button",
  "display",
  "displays",
  "show",
  "shows",
];

function stripQuoted(value: string): string {
  return value
    .trim()
    .replace(/^[\s"'`「」『』“”‘’]+/, "")
    .replace(/[\s"'`「」『』“”‘’]+$/, "")
    .trim();
}

export function isStaticStructurePoint(point: PointInput): boolean {
  const text = `${point.title || ""} ${point.description || ""}`;
  if (STATIC_STRUCTURE_RE.test(text) || BARE_FIELD_COUNT_RE.test(text)) {
    return true;
  }
  const titleLower = String(point.title || "").toLowerCase();
  const expected = stripQuoted(String(point.expected || "")).toLowerCase();
  return (
    STRUCTURAL_TITLE_WORDS.some((word) => titleLower.includes(word)) &&
    BARE_STATUS_LABELS.has(expected)
  );
}

export function filterStaticStructurePoints(
  points: PointInput[],
): PointInput[] {
  return points.filter((point) => !isStaticStructurePoint(point));
}

/** Extract test points via LLM; the caller falls back to rules on failure. */
export async function extractPointsLlm(
  client: LlmClient,
  input: {
    requirementVersion: string;
    requirementName: string;
    content: string;
    facts: Record<string, unknown>;
  },
): Promise<PointInput[]> {
  const prompt = testPointsPrompt({
    requirementVersion: input.requirementVersion,
    requirementName: input.requirementName,
    requirementContent: input.content,
    factsJson: JSON.stringify(input.facts),
  });
  const raw = await client.chatJson(
    [{ role: "user", content: prompt }],
    8192,
    true,
  );
  return filterStaticStructurePoints(
    validatePoints(normalizePoints(raw, "llm")),
  );
}

// ---------- Rule fallback ----------

const ACTION_WORDS = [
  "support",
  "can ",
  "could",
  "able to",
  "shall",
  "should",
  "must",
  "need",
  "forbid",
  "must not",
  "cannot",
  "validate",
  "validation",
  "verify",
  "display",
  "show",
  "submit",
  "save",
  "add",
  "create",
  "update",
  "edit",
  "modify",
  "delete",
  "remove",
  "query",
  "search",
  "filter",
  "login",
  "sign in",
  "register",
  "pay",
  "ship",
  "cancel",
  "refund",
  "approve",
  "import",
  "export",
  "upload",
  "download",
  "navigate",
  "redirect",
  "return",
  "calculate",
  "deduct",
];
const NEGATIVE_WORDS = [
  "cannot be empty",
  "required",
  "empty",
  "not allowed",
  "forbidden",
  "fail",
  "failure",
  "error",
  "invalid",
  "illegal",
  "duplicate",
  "format",
  "incorrect",
  "does not match",
  "mismatch",
  "exceed",
  "missing",
];
const BOUNDARY_WORDS = [
  "exceed",
  "no more than",
  "at most",
  "at least",
  "length",
  "maximum",
  "minimum",
  "upper limit",
  "lower limit",
  "range",
  "greater than",
  "less than",
  "characters",
  "digits",
];
const STATE_WORDS = [
  "status",
  "state",
  "transition",
  "paid",
  "pending",
  "shipped",
  "completed",
  "cancelled",
  "canceled",
  "refund",
  "pay",
  "ship",
  "deliver",
];
const IGNORE_LINE_PREFIX = [
  "table of contents",
  "revision",
  "version history",
  "document notes",
  "background",
  "glossary",
  "reference",
  "changelog",
  "todo",
];
const TRANSITION_WORDS = [
  "pay",
  "ship",
  "cancel",
  "refund",
  "complete",
  "confirm receipt",
  "becomes",
  "transition",
];
const ROUTE_TOKENS = new Set([
  "order",
  "orders",
  "create",
  "add",
  "new",
  "list",
  "index",
  "detail",
  "edit",
  "update",
  "pay",
  "ship",
  "cancel",
  "refund",
  "login",
  "user",
  "product",
  "goods",
  "search",
  "query",
]);

function cleanLine(line: string): string {
  let s = line.trim();
  s = s.replace(/^#{1,6}\s*/, "");
  s = s.replace(/^[-*+]\s+/, "");
  s = s.replace(/^\d+[.)]\s*/, "");
  s = s.replace(/^\[[ xX]\]\s*/, "");
  s = s.replaceAll("**", "").replaceAll("`", "").trim();
  return s;
}

function candidateLines(text: string, limit = 18): string[] {
  const out: string[] = [];
  for (const raw of (text || "").split("\n")) {
    // Headings only group content; they are not test points
    if (raw.trim().startsWith("#")) continue;
    const s = cleanLine(raw);
    if (s.length < 6 || s.length > 160) continue;
    const lower = s.toLowerCase();
    if (IGNORE_LINE_PREFIX.some((prefix) => lower.startsWith(prefix))) continue;
    const allWords = [
      ...ACTION_WORDS,
      ...NEGATIVE_WORDS,
      ...BOUNDARY_WORDS,
      ...STATE_WORDS,
    ];
    if (!allWords.some((w) => lower.includes(w))) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function pageTokens(page: Page): Set<string> {
  const words = `${page.name} ${page.route}`.match(/[A-Za-z]+/g) || [];
  return new Set(
    words.map((w) => w.toLowerCase()).filter((w) => ROUTE_TOKENS.has(w)),
  );
}

function matchPage(
  line: string,
  frontend: FrontendResult | null,
): [Page | null, Page["forms"][number]["fields"]] {
  if (!frontend) return [null, []];
  const lower = line.toLowerCase();
  // List/search/filter descriptions prefer the list page
  if (["list", "search", "query", "filter"].some((w) => lower.includes(w))) {
    for (const page of frontend.pages) {
      if ((page.route || "").toLowerCase().includes("list")) {
        return [page, page.forms.flatMap((form) => form.fields)];
      }
    }
  }
  let best: Page | null = null;
  let bestFields: Page["forms"][number]["fields"] = [];
  let bestScore = 0;
  for (const page of frontend.pages) {
    const fields = page.forms.flatMap((form) => form.fields);
    let score = 0;
    if (page.name && line.includes(page.name)) score += 3;
    const routeKey = (page.route || "").replace(/^\/+|\/+$/g, "");
    if (routeKey && line.includes(routeKey)) score += 3;
    for (const token of pageTokens(page)) {
      if (lower.includes(token)) score += 1;
    }
    if (score > bestScore) {
      best = page;
      bestFields = fields;
      bestScore = score;
    }
  }
  if (best && bestScore > 0) return [best, bestFields];
  return [null, []];
}

function successText(frontend: FrontendResult | null): string {
  if (frontend) {
    for (const t of frontend.uiTexts) {
      if (t.toLowerCase().includes("success")) return t;
    }
  }
  return "Operation successful";
}

/** Lines negating the action ("cannot be cancelled") describe a forbidden
 * transition, not one to execute; they must not become state points. */
const NEGATED_ACTION_RE =
  /\b(?:cannot|can't|must\s+not|should\s+not|never|forbidden|not\s+allowed)\b/i;

function ruleCategory(line: string, triggers: Set<string>): string {
  const lower = line.toLowerCase();
  if (BOUNDARY_WORDS.some((w) => lower.includes(w))) return "boundary";
  if (NEGATIVE_WORDS.some((w) => lower.includes(w))) return "negative";
  // A line naming a real state-machine trigger (Pay/Ship/Cancel/...) is a
  // state-flow point even without an explicit "status"/"state" word. Ground
  // this in the extracted transitions rather than keywords alone.
  // Word-start matching (no trailing boundary) so inflected forms
  // ("shipped", "shipment", "cancelled") still select their transition;
  // the quality gate dedupes clones shared by several lines.
  if (!NEGATED_ACTION_RE.test(line)) {
    for (const trigger of triggers) {
      const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}`, "i").test(line)) return "state";
    }
  }
  // "filter by status" only mentions the status column, not a transition
  if (
    TRANSITION_WORDS.some((w) => lower.includes(w)) &&
    ["status", "state", "transition", "becomes"].some((w) => lower.includes(w))
  ) {
    return "state";
  }
  return "functional";
}

export function extractPointsRule(
  content: string,
  backend: BackendResult | null,
  frontend: FrontendResult | null,
  machines: StateMachineSpec[],
): PointInput[] {
  const points: PointInput[] = [];
  const seen = new Set<string>();
  const triggers = new Set<string>();
  for (const machine of machines) {
    for (const transition of machine.transitions || []) {
      const trigger = (transition.trigger || "").trim().toLowerCase();
      if (trigger) triggers.add(trigger);
    }
  }

  const add = (input: {
    title: string;
    category: string;
    priority: string;
    description?: string;
    pageRoute?: string;
    endpoint?: string;
    fields?: string[];
    expected?: string;
    confidence?: number;
  }): void => {
    const title = input.title.trim().slice(0, 255);
    if (!title || seen.has(title)) return;
    seen.add(title);
    points.push({
      title,
      category: CATEGORIES.has(input.category) ? input.category : "functional",
      priority: PRIORITIES.has(input.priority) ? input.priority : "P1",
      description: (input.description || "").slice(0, 2000),
      pageRoute: (input.pageRoute || "").slice(0, 255),
      endpoint: (input.endpoint || "").slice(0, 255),
      fields: (input.fields || []).slice(0, 20),
      expected: (input.expected || "").slice(0, 1000),
      source: "rule",
      confidence: input.confidence ?? 0.7,
    });
  };

  // 1) Requirement lines -> test points
  for (const line of candidateLines(content || "")) {
    const cat = ruleCategory(line, triggers);
    let [page, fields] = matchPage(line, frontend);
    // State transitions usually happen on the list page (Pay/Ship buttons);
    // attach to the list page when nothing matched.
    if (cat === "state" && page === null && frontend) {
      page =
        frontend.pages.find((p) =>
          (p.route || "").toLowerCase().includes("list"),
        ) ?? null;
      fields = page ? page.forms.flatMap((form) => form.fields) : [];
    }
    const lower = line.toLowerCase();
    const pri =
      (cat === "functional" || cat === "state") &&
      ["submit", "pay", "ship", "refund", "create", "login"].some((w) =>
        lower.includes(w),
      )
        ? "P0"
        : "P1";
    // Copy explicitly quoted in the requirement wins as the assertion anchor
    const quoted = /["“]([^"”]{2,60})["”]/.exec(line);
    let expected: string;
    if (quoted) {
      expected = quoted[1]!;
    } else {
      expected =
        cat === "functional" || cat === "state" ? successText(frontend) : "";
    }
    add({
      title: line.slice(0, 80),
      category: cat,
      priority: pri,
      description: line,
      pageRoute: page ? page.route : "",
      fields: fields.map((f) => f.prop || f.label),
      expected,
    });
  }

  // 2) Code-facts fallback: only serve pages mentioned by this iteration's
  // requirement; fall back to everything only when the PRD yielded nothing.
  const prdCount = points.length;
  const hasStatePoint = points.some((p) => p.category === "state");
  const coveredRoutes = new Set(points.map((p) => p.pageRoute).filter(Boolean));
  const usedText = points
    .map((p) => `${p.title} ${p.description}`)
    .join(" ")
    .toLowerCase();

  if (frontend) {
    for (const page of frontend.pages) {
      if (!coveredRoutes.has(page.route)) continue;
      const fields = page.forms.flatMap((form) => form.fields);
      if (fields.length === 0) continue;
      const required = fields.filter((f) => f.required);
      const pageHasFunctional = points.some(
        (p) => p.category === "functional" && p.pageRoute === page.route,
      );
      if (!pageHasFunctional) {
        add({
          title: `${page.name}: submit valid information successfully`,
          category: "functional",
          priority: "P0",
          description: `${page.name} (${page.route}) form happy path`,
          pageRoute: page.route,
          fields: fields.map((f) => f.prop || f.label),
          expected: successText(frontend),
        });
      }
      for (const f of required.slice(0, 4)) {
        const label = f.label || f.prop;
        if (usedText.includes(label.toLowerCase())) continue;
        add({
          title: `${page.name}: ${label} empty validation`,
          category: "negative",
          priority: "P1",
          description: `${label} is a required field`,
          pageRoute: page.route,
          fields: [f.prop || label],
          expected: `${label} cannot be empty`,
        });
      }
    }
  }
  if (backend && prdCount === 0) {
    const constraintsByField = new Map<
      string,
      { rule: string; value: unknown }[]
    >();
    for (const entity of backend.entities) {
      for (const c of entity.fieldConstraints) {
        if (["size", "pattern", "max", "min"].includes(c.rule)) {
          const list = constraintsByField.get(c.field) ?? [];
          list.push({ rule: c.rule, value: c.value });
          constraintsByField.set(c.field, list);
        } else if (
          ["notblank", "notnull", "notempty", "required"].includes(c.rule)
        ) {
          if (!constraintsByField.has(c.field))
            constraintsByField.set(c.field, []);
        }
      }
    }
    let count = 0;
    for (const [fieldName, constraints] of constraintsByField) {
      if (count >= 10) break;
      count += 1;
      if (usedText.includes(fieldName.toLowerCase())) continue;
      for (const c of constraints.slice(0, 1)) {
        add({
          title: `${fieldName}: boundary value validation`,
          category: "boundary",
          priority: "P1",
          description: `${fieldName} constraint ${c.rule}=${String(c.value)}`,
          fields: [fieldName],
          expected: `${fieldName} format is invalid`,
        });
      }
    }
  }
  for (const sm of machines) {
    if (prdCount > 0 && !hasStatePoint) break;
    for (const t of sm.transitions || []) {
      if (!t.verified) continue;
      if (t.trigger && usedText.includes(t.trigger.toLowerCase())) continue;
      add({
        title: `${sm.name}: ${t.trigger} (${t.from} → ${t.to})`,
        category: "state",
        priority: "P0",
        description: `State transitions from ${t.from} to ${t.to}`,
        expected: `${t.trigger} successful`,
      });
    }
  }
  return points.slice(0, 40);
}
