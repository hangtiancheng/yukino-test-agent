/**
 * Rule-mode test case generator (pure rules, zero LLM).
 *
 * Four case families:
 * - positive: fill every required field with valid values -> submit -> expect
 *   the success copy
 * - negative: leave one required field empty -> submit -> expect its required
 *   hint
 * - boundary: fields with size/pattern/max/min constraints -> out-of-range
 *   value -> expect the validation hint
 * - state: one case per verified transition -> BFS-advance to the `from`
 *   state, then fire the trigger
 *
 * structured_steps contract:
 *   { order, type: ui_action|input|state_assert|capture, action, target,
 *     uiSelector: { type, value }, expected, inputValue }
 */
import { bfsPaths } from "#/server/lib/analyzer/state-machine";
import {
  isCompoundExpected,
  quotedAnchors,
} from "#/server/lib/generation/quality-gate";

import type {
  BackendResult,
  FormField,
  FrontendResult,
  GeneratedCase,
  Page,
  StateMachineSpec,
  StructuredStep,
  TestPointDraft,
} from "#/lib/types";

export type PointInput = TestPointDraft & { id?: string };

/** Field name -> valid sample value (heuristic; generic fallback below). */
const FIELD_SAMPLE: Record<string, string> = {
  receivername: "John Doe",
  receiver: "John Doe",
  name: "John Doe",
  username: "john_doe",
  phone: "15550100123",
  mobile: "15550100123",
  address: "1 Test Avenue, Springfield",
  amount: "100.00",
  price: "100.00",
  money: "100.00",
  remark: "Automated test remark",
  orderno: "ORD123456",
  order_no: "ORD123456",
  email: "test@example.com",
};

/** Entity/module name -> human label (heuristic). */
const MODULE_LABEL: Record<string, string> = {
  Order: "Order",
  OrderStatus: "Order",
  User: "User",
  Product: "Product",
  Pay: "Payment",
  Goods: "Product",
};

/** Trigger action -> operation success copy (assertion anchor; must match
 * the real copy on the system under test). */
const TRIGGER_SUCCESS: Record<string, string> = {
  Pay: "Payment successful",
  Ship: "Shipment successful",
  Complete: "Order completed",
  Cancel: "Order cancelled",
  Refund: "Refund successful",
  "Confirm Receipt": "Receipt confirmed",
};

const POINT_TYPE: Record<string, string> = {
  functional: "positive",
  negative: "negative",
  boundary: "boundary",
  state: "state",
  api: "positive",
  permission: "negative",
};

const SUCCESS_HINTS = [
  "success",
  "succeed",
  "created",
  "submitted",
  "saved",
  "allowed",
  "accepted",
  "passes",
  "can be",
];
const ERROR_HINTS = [
  "cannot",
  "can't",
  "fail",
  "error",
  "invalid",
  "exceed",
  "must not",
  "empty",
  "required",
  "incorrect",
  "not allowed",
  "rejected",
  "denied",
  "out of range",
];
/** When these appear in the same clause, "success/pass" is negation or a
 * precondition — not a positive expectation. */
const NEGATED_SUCCESS_WORDS = [
  "cannot",
  "can't",
  "fail",
  "not allowed",
  "forbidden",
  "must not",
  "unable",
  "rejected",
  "denied",
  "error",
  "without",
];

export function newCase(partial: Partial<GeneratedCase>): GeneratedCase {
  return {
    title: "",
    module: "",
    type: "positive",
    priority: "P1",
    preconditions: [],
    steps: [],
    expectedResults: [],
    structuredSteps: [],
    testData: {},
    coverageRefs: { endpointIds: [], transitionIds: [], ruleIds: [] },
    source: "rule",
    confidence: 1,
    testPointId: null,
    ...partial,
  };
}

function moduleName(backend: BackendResult): string {
  for (const entity of backend.entities) {
    if (entity.name in MODULE_LABEL) return MODULE_LABEL[entity.name];
  }
  for (const entity of backend.entities) return entity.name;
  return "Business Module";
}

function stateModule(smName: string): string {
  const base = smName.replace(/(Status|State)$/, "");
  return MODULE_LABEL[base] ?? base;
}

function requiredFieldNames(backend: BackendResult): Set<string> {
  const names = new Set<string>();
  for (const entity of backend.entities) {
    for (const c of entity.fieldConstraints) {
      if (["notblank", "notnull", "notempty", "required"].includes(c.rule)) {
        names.add(c.field);
      }
    }
  }
  return names;
}

function isRequired(field: FormField, requiredNames: Set<string>): boolean {
  return (
    field.required ||
    requiredNames.has(field.prop) ||
    requiredNames.has(field.label)
  );
}

function step(
  order: number,
  type: string,
  action: string,
  target: string,
  selectorType: string,
  selectorValue: string,
  expected = "",
  inputValue = "",
): StructuredStep {
  return {
    order,
    type: type,
    action,
    target,
    uiSelector: { type: selectorType, value: selectorValue },
    expected,
    inputValue,
  };
}

function sampleValue(fieldName: string): string {
  const key = (fieldName || "").toLowerCase().replace(/-/g, "_");
  return FIELD_SAMPLE[key] ?? "test data";
}

function successText(frontend: FrontendResult): string {
  for (const t of frontend.uiTexts) {
    if (t.toLowerCase().includes("success")) return t;
  }
  return "Operation successful";
}

function findFormPages(frontend: FrontendResult): [Page, FormField[]][] {
  const out: [Page, FormField[]][] = [];
  for (const page of frontend.pages) {
    const fields = page.forms.flatMap((form) => form.fields);
    if (fields.length > 0) out.push([page, fields]);
  }
  return out;
}

function openStep(
  route: string,
  pageName: string,
  order: number,
): StructuredStep {
  return step(
    order,
    "ui_action",
    `Open the ${pageName} page`,
    pageName,
    "route",
    route || "/",
  );
}

function fillStep(
  field: FormField,
  order: number,
  value: string,
): StructuredStep {
  const selType = field.placeholder ? "placeholder" : "label";
  const selValue = field.placeholder || field.label;
  const label = field.label || field.prop;
  return step(
    order,
    "input",
    `Enter ${label}`,
    label,
    selType,
    selValue,
    "",
    value,
  );
}

function submitStep(order: number, submitText = "Submit"): StructuredStep {
  return step(
    order,
    "ui_action",
    `Click ${submitText}`,
    submitText,
    "text",
    submitText,
  );
}

function assertStep(order: number, expected: string): StructuredStep {
  // Quoted anchor: assertion layer 2 requires a visible-copy anchor
  const anchor = `"${expected}"`;
  return step(
    order,
    "state_assert",
    `Verify ${expected}`,
    "",
    "text",
    anchor,
    anchor,
  );
}

function expectsSuccess(text: string): boolean {
  for (const clause of (text || "").split(/[;；.]/)) {
    const lower = clause.toLowerCase();
    if (!SUCCESS_HINTS.some((w) => lower.includes(w))) continue;
    if (NEGATED_SUCCESS_WORDS.some((w) => lower.includes(w))) continue;
    return true;
  }
  return false;
}

/** Collapse a single expectation into one assertable copy; compound
 * expectations (multiple scenarios/results) return ''. */
function atomicExpected(text: string): string {
  const raw = (text || "").trim();
  if (!raw || isCompoundExpected(raw)) return "";
  const anchors = quotedAnchors(raw);
  if (anchors.length === 1) return anchors[0];
  return raw.replace(/^["“]+|["”]+$/g, "").trim();
}

/** Last-resort: when a compound expectation must keep one anchor, take the
 * last one (usually the error hint). */
function fallbackAnchor(text: string): string {
  const anchors = quotedAnchors(text);
  if (anchors.length > 0) return anchors[anchors.length - 1];
  return (text || "")
    .trim()
    .split(/[;；]/)[0]
    .trim()
    .replace(/^["“]+|["”]+$/g, "");
}

function assertExpected(order: number, text: string): StructuredStep {
  // One assertion keeps exactly one anchor to avoid nested quotes confusing
  // the runner's copy extraction.
  const anchorText = atomicExpected(text) || fallbackAnchor(text);
  const anchor = anchorText ? `"${anchorText}"` : "";
  return step(
    order,
    "state_assert",
    `Verify ${anchor}`,
    "",
    "text",
    anchor,
    anchor,
  );
}

// ---------- Project-level generation (backward compatible) ----------

function genPositive(
  backend: BackendResult,
  frontend: FrontendResult,
): GeneratedCase[] {
  const cases: GeneratedCase[] = [];
  const success = successText(frontend);
  for (const [page, fields] of findFormPages(frontend)) {
    const requiredNames = requiredFieldNames(backend);
    const required = fields.filter((f) => isRequired(f, requiredNames));
    // Decision: forms without required fields (e.g. search boxes) get no
    // positive case — "submit" semantics do not apply.
    if (required.length === 0) continue;
    let order = 1;
    const steps = [openStep(page.route, page.name, order)];
    order += 1;
    const testData: Record<string, string> = {};
    for (const f of required) {
      const val = sampleValue(f.prop || f.label);
      steps.push(fillStep(f, order, val));
      testData[f.prop || f.label] = val;
      order += 1;
    }
    steps.push(submitStep(order));
    order += 1;
    steps.push(assertStep(order, success));

    cases.push(
      newCase({
        title: `${moduleName(backend)}: submit valid information successfully`,
        module: moduleName(backend),
        type: "positive",
        priority: "P0",
        preconditions: [`The ${page.name} page is open`],
        steps: [
          `Open the ${page.name} page`,
          "Fill in all required fields",
          "Click Submit",
        ],
        expectedResults: [success],
        structuredSteps: steps,
        testData,
      }),
    );
  }
  return cases;
}

function genNegative(
  backend: BackendResult,
  frontend: FrontendResult,
): GeneratedCase[] {
  const cases: GeneratedCase[] = [];
  for (const [page, fields] of findFormPages(frontend)) {
    const requiredNames = requiredFieldNames(backend);
    const required = fields.filter((f) => isRequired(f, requiredNames));
    for (const f of required) {
      const label = f.label || f.prop;
      let order = 1;
      const steps = [openStep(page.route, page.name, order)];
      order += 1;
      const testData: Record<string, string> = {};
      // Fill the other required fields; leave only the current one empty
      for (const other of required) {
        if (other === f) continue;
        const val = sampleValue(other.prop || other.label);
        steps.push(fillStep(other, order, val));
        testData[other.prop || other.label] = val;
        order += 1;
      }
      steps.push(submitStep(order));
      order += 1;
      const expect = `${label} cannot be empty`;
      steps.push(assertStep(order, expect));

      cases.push(
        newCase({
          title: `${moduleName(backend)}: ${label} (${f.prop || label}) empty fails validation`,
          module: moduleName(backend),
          type: "negative",
          priority: "P1",
          preconditions: [`The ${page.name} page is open`],
          steps: [
            `Open the ${page.name} page`,
            `Leave ${label} empty, fill the other required fields`,
            "Click Submit",
          ],
          expectedResults: [expect],
          structuredSteps: steps,
          testData,
        }),
      );
    }
  }
  return cases;
}

/** Boundary cases driven by backend entity constraints. */
function genBoundaryWithConstraints(
  backend: BackendResult,
  frontend: FrontendResult,
): GeneratedCase[] {
  const cases: GeneratedCase[] = [];
  // prop -> constraints (backend entity field names ≈ frontend prop names);
  // dedupe same field + same rule (DTOs often repeat entity constraints).
  const constraints = new Map<string, { rule: string; value: unknown }[]>();
  for (const entity of backend.entities) {
    for (const c of entity.fieldConstraints) {
      const existing = constraints.get(c.field) ?? [];
      if (!existing.some((x) => x.rule === c.rule)) {
        existing.push({ rule: c.rule, value: c.value });
      }
      constraints.set(c.field, existing);
    }
  }

  const requiredNames = requiredFieldNames(backend);
  for (const [page, fields] of findFormPages(frontend)) {
    for (const f of fields) {
      const label = f.label || f.prop;
      const cs = constraints.get(f.prop) || constraints.get(f.label) || [];
      for (const c of cs) {
        let boundVal: string | null = null;
        let expect: string | null = null;
        if (c.rule === "size" && typeof c.value === "number") {
          boundVal = "x".repeat(c.value + 1);
          expect = `${label} cannot exceed ${c.value} characters`;
        } else if (c.rule === "pattern" && c.value) {
          boundVal = "123";
          expect = `${label} format is invalid`;
        } else if ((c.rule === "max" || c.rule === "min") && c.value != null) {
          const num = Number(c.value);
          boundVal = c.rule === "max" ? String(num + 1) : String(num - 1);
          expect = `${label} is out of range`;
        } else {
          continue;
        }

        let order = 1;
        const steps = [openStep(page.route, page.name, order)];
        order += 1;
        for (const other of fields) {
          if (other === f) continue;
          if (isRequired(other, requiredNames)) {
            steps.push(
              fillStep(other, order, sampleValue(other.prop || other.label)),
            );
            order += 1;
          }
        }
        steps.push(fillStep(f, order, boundVal));
        order += 1;
        steps.push(submitStep(order));
        order += 1;
        steps.push(assertStep(order, expect));

        cases.push(
          newCase({
            title: `${moduleName(backend)}: ${label} (${f.prop || label}) boundary fails validation`,
            module: moduleName(backend),
            type: "boundary",
            priority: "P1",
            preconditions: [`The ${page.name} page is open`],
            steps: [
              `Open the ${page.name} page`,
              `Enter an out-of-range value in ${label}`,
              "Click Submit",
            ],
            expectedResults: [expect],
            structuredSteps: steps,
            testData: { [f.prop || label]: boundVal },
          }),
        );
      }
    }
  }
  return cases;
}

function genState(
  machines: StateMachineSpec[],
  paths: Record<string, string[]>,
  frontend: FrontendResult,
): GeneratedCase[] {
  const cases: GeneratedCase[] = [];
  let listRoute = "";
  for (const page of frontend.pages) {
    if ((page.route || "").toLowerCase().includes("list")) {
      listRoute = page.route;
      break;
    }
  }

  for (const sm of machines) {
    const module = stateModule(sm.name || "");
    const states = sm.states || [];
    const transitions = sm.transitions || [];
    const initial = states[0]?.name ?? "";
    const labelMap = new Map(states.map((s) => [s.name, s.label || s.name]));
    // from→to -> trigger lookup (pre-advance uses real button copy)
    const triggerMap = new Map(
      transitions.map((t) => [`${t.from}|${t.to}`, t.trigger || ""]),
    );
    for (const t of transitions) {
      if (!t.verified) continue;
      const trigger = t.trigger || "";
      // BFS pre-advance path (to the `from` state)
      const advance =
        t.from !== initial ? (paths[t.from] ?? [t.from]) : [t.from];
      const preActions: string[] = [];
      for (let i = 0; i < advance.length - 1; i++) {
        const act = triggerMap.get(`${advance[i]}|${advance[i + 1]}`) || "";
        if (act) preActions.push(act);
      }

      let order = 1;
      const steps: StructuredStep[] = [];
      if (listRoute) {
        steps.push(
          step(
            order,
            "ui_action",
            "Open the order list",
            "order list",
            "route",
            listRoute,
          ),
        );
        order += 1;
      }
      for (const act of preActions) {
        steps.push(step(order, "ui_action", act, act, "text", act));
        order += 1;
      }
      steps.push(
        step(
          order,
          "ui_action",
          `Perform ${trigger}`,
          trigger,
          "text",
          trigger,
        ),
      );
      order += 1;
      // Assert the operation success copy (absent from seed data; only a
      // successful operation shows it -> no false green)
      const success = TRIGGER_SUCCESS[trigger] ?? `${trigger} successful`;
      steps.push(assertStep(order, success));

      const fromLabel = labelMap.get(t.from) ?? t.from;
      const toLabel = labelMap.get(t.to) ?? t.to;
      cases.push(
        newCase({
          title: `${module}: ${trigger} (${fromLabel} → ${toLabel})`,
          module,
          type: "state",
          priority: "P0",
          preconditions: [`An order in state ${fromLabel} exists`],
          steps: [
            `Find an order in state ${fromLabel}`,
            `Perform ${trigger}`,
            `Verify the state becomes ${toLabel}`,
          ],
          expectedResults: [success],
          structuredSteps: steps,
          coverageRefs: {
            endpointIds: [],
            transitionIds: [t.id || ""],
            ruleIds: [],
          },
        }),
      );
    }
  }
  return cases;
}

export function generateRuleCases(
  backend: BackendResult,
  frontend: FrontendResult,
  machines: StateMachineSpec[],
): GeneratedCase[] {
  const cases: GeneratedCase[] = [];
  cases.push(...genPositive(backend, frontend));
  cases.push(...genNegative(backend, frontend));
  cases.push(...genBoundaryWithConstraints(backend, frontend));
  // Each state machine gets its own BFS shortest advance paths
  for (const sm of machines) {
    const states = sm.states || [];
    const transitions = sm.transitions || [];
    if (states.length === 0 || transitions.length === 0) continue;
    const paths = bfsPaths(states, transitions, states[0].name);
    cases.push(...genState([sm], paths, frontend));
  }
  return cases;
}

// ---------- Per-test-point generation ----------

function pageForPoint(
  point: PointInput,
  frontend: FrontendResult,
): Page | null {
  if (!frontend) return null;
  const route = (point.pageRoute || "").trim();
  if (route) {
    for (const page of frontend.pages) {
      if (page.route === route) return page;
    }
  }
  const text = `${point.title || ""} ${point.description || ""}`;
  for (const page of frontend.pages) {
    if (page.name && text.includes(page.name)) return page;
    const key = (page.route || "").replace(/^\/+|\/+$/g, "");
    if (key && text.includes(key)) return page;
  }
  const formPages = frontend.pages.filter((page) =>
    page.forms.some((form) => form.fields.length > 0),
  );
  return formPages[0] ?? frontend.pages[0] ?? null;
}

function pageFields(page: Page | null): FormField[] {
  if (!page) return [];
  return page.forms.flatMap((form) => form.fields);
}

function pickFields(point: PointInput, page: Page | null): FormField[] {
  const fields = pageFields(page);
  const wanted = (point.fields || []).map(String);
  if (wanted.length === 0) return fields;
  const picked = fields.filter(
    (f) => wanted.includes(f.prop) || wanted.includes(f.label),
  );
  if (picked.length > 0) {
    // Keep page order so steps match the visual form order
    return fields.filter((f) => picked.includes(f));
  }
  return fields;
}

function pointModule(
  _point: PointInput,
  page: Page | null,
  backend: BackendResult,
): string {
  if (page && page.name) return page.name;
  return moduleName(backend);
}

function pointExpected(point: PointInput, fallback: string): string {
  return atomicExpected(String(point.expected || "")) || fallback;
}

function boundaryExpect(
  point: PointInput,
  opts: { valid: boolean; success: string; fallback: string },
): string {
  const raw = String(point.expected || "").trim();
  const atomic = atomicExpected(raw);
  const lower = raw.toLowerCase();
  if (atomic) {
    // A single expectation is only adopted when its semantics match the
    // current scenario; mixed success/failure copy falls back per scenario.
    const hasError = ERROR_HINTS.some((w) => lower.includes(w));
    if (
      (opts.valid && expectsSuccess(raw) && !hasError) ||
      (!opts.valid && hasError && !expectsSuccess(raw))
    ) {
      return atomic;
    }
    return opts.valid ? opts.success : opts.fallback;
  }
  const hints = opts.valid ? SUCCESS_HINTS : ERROR_HINTS;
  for (const clause of raw.split(/[;；.]/)) {
    const clauseLower = clause.toLowerCase();
    if (!clause.trim()) continue;
    if (opts.valid && !expectsSuccess(clause)) continue;
    // An out-of-range scenario must not be misled by a success clause
    if (
      !opts.valid &&
      (expectsSuccess(clause) || !hints.some((w) => clauseLower.includes(w)))
    ) {
      continue;
    }
    const anchors = quotedAnchors(clause);
    if (anchors.length > 0) return anchors[0];
  }
  return opts.valid ? opts.success : opts.fallback;
}

/** Bind a template case to its test point: title/priority/source/assertion
 * follow the point. */
function finishPointCase(
  kase: GeneratedCase,
  point: PointInput,
  page: Page | null,
  backend: BackendResult,
): GeneratedCase {
  let baseTitle = point.title || kase.title;
  // Keep the (field) suffix when one point yields multiple cases, so titles
  // stay distinct for dedupe.
  const suffix = /\s\(([^()]{1,40})\)$/.exec(kase.title);
  if (suffix && !baseTitle.includes(suffix[0])) {
    baseTitle = `${baseTitle}${suffix[0]}`;
  }
  kase.title = baseTitle.slice(0, 255);
  kase.priority = point.priority || kase.priority;
  kase.module = pointModule(point, page, backend);
  kase.testPointId = point.id ?? null;
  kase.coverageRefs = {
    ...(kase.coverageRefs || {
      endpointIds: [],
      transitionIds: [],
      ruleIds: [],
    }),
    testPointIds: point.id ? [point.id] : [],
  };
  if (point.expected) {
    const expected = atomicExpected(String(point.expected));
    // Compound expectations must not override the template's already-split
    // single-scenario assertions (e.g. 20 chars OK / 21 chars error).
    if (expected) {
      kase.expectedResults = [expected];
      const last = kase.structuredSteps[kase.structuredSteps.length - 1];
      if (last && last.type === "state_assert") {
        kase.structuredSteps[kase.structuredSteps.length - 1] = assertExpected(
          last.order || kase.structuredSteps.length,
          expected,
        );
      }
    }
  }
  kase.steps = kase.structuredSteps
    .map((s) => s.action || "")
    .filter(Boolean)
    .slice(0, 8);
  return kase;
}

/** Fallback case when no page matches: keeps the point traceable in the case
 * list for manual completion. */
function genericPointCase(
  point: PointInput,
  backend: BackendResult,
  frontend: FrontendResult,
  reason: string,
): GeneratedCase {
  const page = pageForPoint(point, frontend);
  const route =
    (point.pageRoute || (page ? page.route : "") || "/").trim() || "/";
  const expected = pointExpected(point, point.title || "Operation successful");
  const steps = [
    step(1, "ui_action", `Open page ${route}`, route, "route", route),
    assertExpected(2, expected),
  ];
  return newCase({
    title: (point.title || "Test point").slice(0, 255),
    module: pointModule(point, page, backend),
    type: POINT_TYPE[String(point.category || "functional")] ?? "positive",
    priority: point.priority || "P1",
    preconditions: [`Requirement test point: ${reason}`],
    steps: steps.map((s) => s.action),
    expectedResults: [expected],
    structuredSteps: steps,
    coverageRefs: {
      endpointIds: [],
      transitionIds: [],
      ruleIds: [],
      testPointIds: point.id ? [point.id] : [],
    },
    confidence: 0.5,
    testPointId: point.id ?? null,
  });
}

/** Words that mark a list-page filter/query point rather than a create form. */
const LIST_FILTER_WORDS = [
  "filter",
  "query",
  "search",
  "reset",
  "keyword",
  "status",
  "amount",
  "minimum",
  "maximum",
  "min",
  "max",
  "sort",
];

function isListPage(page: Page | null): boolean {
  return !!page && /list/i.test(page.route || "");
}

function isStatsPage(page: Page | null): boolean {
  return !!page && /(statistic|stats|dashboard)/i.test(page.route || "");
}

/**
 * List and statistics pages have no create form, so a test point that maps to
 * one must never become a fill-and-submit case (there is nothing to submit, or
 * the submit would hit the wrong endpoint). Instead the case opens the page and
 * asserts the visible copy the point describes.
 *
 * - stats page  -> metric/copy check
 * - list page   -> filter/query/reset when the point reads like a filter,
 *                  otherwise a plain list smoke check
 * - bulk action -> resolve the list page and smoke its entry point
 */
function listStatsPointCase(
  point: PointInput,
  page: Page,
  backend: BackendResult,
  opts: { kind: "stats" | "filter" | "list" | "bulk" },
): GeneratedCase {
  const label =
    opts.kind === "stats"
      ? "page metric check"
      : opts.kind === "filter"
        ? "list filter"
        : opts.kind === "bulk"
          ? "bulk action entry smoke"
          : "list smoke";
  const confidence = opts.kind === "list" ? 0.5 : 0.6;
  const expected = pointExpected(
    point,
    page.name || "the page content renders",
  );
  const steps: StructuredStep[] = [openStep(page.route, page.name, 1)];
  let order = 2;
  const testData: Record<string, string> = {};
  if (opts.kind === "filter") {
    // Fill the page's filter fields (when the analyzer found any) and trigger
    // the query; never fabricate a create-form submit. With no detected filter
    // fields the case degrades to a plain open-and-assert smoke check.
    const filterFields = pageFields(page).slice(0, 6);
    if (filterFields.length > 0) {
      for (const f of filterFields) {
        const val = sampleValue(f.prop || f.label);
        steps.push(fillStep(f, order, val));
        testData[f.prop || f.label] = val;
        order += 1;
      }
      const isReset = /reset/i.test(
        `${point.title || ""} ${point.description || ""}`,
      );
      steps.push(submitStep(order, isReset ? "Reset" : "Search"));
      order += 1;
    }
  }
  steps.push(assertExpected(order, expected));
  return newCase({
    title: `${(point.title || page.name || "Page check").slice(0, 240)} (${label})`,
    module: pointModule(point, page, backend),
    type: POINT_TYPE[String(point.category || "functional")] ?? "positive",
    priority: point.priority || "P1",
    preconditions: [`The ${page.name} page is open`],
    steps: steps.map((st) => st.action),
    expectedResults: [expected],
    structuredSteps: steps,
    testData,
    coverageRefs: {
      endpointIds: [],
      transitionIds: [],
      ruleIds: [],
      testPointIds: point.id ? [point.id] : [],
    },
    source: "rule",
    confidence,
    testPointId: point.id ?? null,
  });
}

function stateCasesForPoints(
  machines: StateMachineSpec[],
  frontend: FrontendResult,
): [StateMachineSpec, GeneratedCase][] {
  const out: [StateMachineSpec, GeneratedCase][] = [];
  for (const sm of machines) {
    const states = sm.states || [];
    const transitions = sm.transitions || [];
    if (states.length === 0 || transitions.length === 0) continue;
    const paths = bfsPaths(states, transitions, states[0].name);
    for (const kase of genState([sm], paths, frontend)) out.push([sm, kase]);
  }
  return out;
}

/** Collect the multi-word state labels across machines, longest first, so they
 * can be stripped from a point's text before trigger matching. This mirrors the
 * legacy STATUS_LABELS guard: a label such as "Pending payment" embeds the word
 * "payment", which would otherwise let the trigger "Pay" match and fabricate a
 * payment case for a point that merely references the pending-payment state.
 *
 * Only multi-word labels are stripped. Single-word labels ("Cancelled",
 * "Completed", "Shipped", ...) double as the English action participle ("orders
 * can be cancelled"), so removing them would erase legitimate trigger matches —
 * unlike the Chinese labels ("已取消" vs the bare verb "取消"), which are
 * morphologically distinct from their triggers. */
function collectStateLabels(machines: StateMachineSpec[]): string[] {
  const labels = new Set<string>();
  for (const sm of machines) {
    for (const st of sm.states || []) {
      if (st.label && /\s/.test(st.label)) labels.add(st.label);
    }
  }
  return [...labels].sort((a, b) => b.length - a.length);
}

/** Case-insensitively remove every state label from `text`, longest first. */
function stripStateLabels(text: string, labels: string[]): string {
  let cleaned = text;
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(escaped, "gi"), "");
  }
  return cleaned;
}

/** Generate cases per test point: functional/negative/boundary/state with
 * parameters grounded in code facts. */
export function generateRuleCasesForPoints(
  points: PointInput[],
  backend: BackendResult,
  frontend: FrontendResult,
  machines: StateMachineSpec[],
): GeneratedCase[] {
  if (points.length === 0) return [];
  const requiredNames = requiredFieldNames(backend);
  const success = successText(frontend);
  const stateCases = stateCasesForPoints(machines, frontend);
  const stateLabels = collectStateLabels(machines);
  const cases: GeneratedCase[] = [];

  for (const point of points) {
    const category = String(point.category || "functional");
    const page = pageForPoint(point, frontend);
    const fields = pickFields(point, page);
    const allFields = pageFields(page);
    const text = `${point.title || ""} ${point.description || ""}`;
    // Fields explicitly mentioned in the point title win (e.g. "phone format
    // invalid" -> only target phone)
    const mentioned = fields.filter(
      (f) =>
        (f.label && text.includes(f.label)) ||
        (f.prop && text.includes(f.prop)),
    );

    const pointText = `${point.title || ""} ${point.description || ""} ${point.expected || ""}`;
    const lowerPointText = pointText.toLowerCase();
    const endpoint = String(point.endpoint || "");

    // ---- Statistics page: verify stable metrics/copy, never a form submit ----
    if (page && isStatsPage(page)) {
      cases.push(listStatsPointCase(point, page, backend, { kind: "stats" }));
      continue;
    }

    // ---- Bulk action (e.g. batch cancel): smoke the list-page entry; do not
    // fabricate row-selection or API-injection steps ----
    const isBulk =
      /batch|bulk/i.test(endpoint) ||
      /\b(batch|bulk)\b|select (the )?rows|checkbox/i.test(lowerPointText);
    if (isBulk) {
      const listPage =
        page && isListPage(page)
          ? page
          : (frontend.pages.find((pg) => isListPage(pg) && pg.route) ?? null);
      if (listPage) {
        cases.push(
          listStatsPointCase(point, listPage, backend, { kind: "bulk" }),
        );
        continue;
      }
    }

    // ---- List page: filter/query/reset or smoke, never a create-form submit ----
    if (page && isListPage(page)) {
      const isFilter =
        LIST_FILTER_WORDS.some((w) => lowerPointText.includes(w)) &&
        (endpoint === "" ||
          /^get\b/i.test(endpoint) ||
          /reset/i.test(lowerPointText));
      cases.push(
        listStatsPointCase(point, page, backend, {
          kind: isFilter ? "filter" : "list",
        }),
      );
      continue;
    }

    // ---- State flow: reuse BFS state cases ----
    // A point may name several transitions ("supports pay, ship and cancel"),
    // so emit one executable case per named transition. Each cloned case keeps
    // its own transition-specific success assertion (Payment/Shipment/...),
    // which is why the point's single `expected` is deliberately not applied
    // here — overriding it would assert the wrong copy for the other actions.
    if (category === "state" && stateCases.length > 0) {
      const matched: GeneratedCase[] = [];
      const seenTitles = new Set<string>();
      // Strip multi-word status labels first so a state copy in the point
      // text (e.g. "Pending payment") cannot be mistaken for a trigger.
      const triggerText = stripStateLabels(text, stateLabels);
      for (const [, sc] of stateCases) {
        // Template title format: "<Module>: <Trigger> (<from> → <to>)"
        const titleTrigger = /:\s*([^(]+?)\s*\(/.exec(sc.title)?.[1]?.trim();
        if (!titleTrigger || seenTitles.has(sc.title)) continue;
        const escaped = titleTrigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Word-start match so inflected forms ("shipped", "shipment",
        // "cancelled", "payment") still select their transition; the
        // quality gate dedupes clones shared by several points.
        if (!new RegExp(`\\b${escaped}`, "i").test(triggerText)) continue;
        seenTitles.add(sc.title);
        matched.push(sc);
      }
      if (matched.length > 0) {
        for (const sc of matched) {
          const clone = structuredClone(sc);
          clone.testPointId = point.id ?? null;
          clone.priority = point.priority || clone.priority;
          clone.coverageRefs = {
            ...(clone.coverageRefs || {
              endpointIds: [],
              transitionIds: [],
              ruleIds: [],
            }),
            testPointIds: point.id ? [point.id] : [],
          };
          cases.push(clone);
        }
        continue;
      }
    }

    // ---- Negative: leave the point's field empty ----
    if (category === "negative" && page) {
      const base = mentioned.length > 0 ? mentioned : fields;
      const targets =
        base.filter((f) => isRequired(f, requiredNames)).length > 0
          ? base.filter((f) => isRequired(f, requiredNames))
          : mentioned.length > 0
            ? mentioned
            : base.slice(0, 1);
      let made = false;
      // Format/invalid-value negatives: type an invalid value instead of
      // leaving the field empty
      const lowerText = text.toLowerCase();
      const invalidValue = ["format", "invalid", "incorrect", "malformed"].some(
        (w) => lowerText.includes(w),
      )
        ? "123"
        : "";
      for (const f of targets.slice(0, 2)) {
        const label = f.label || f.prop;
        let order = 1;
        const steps = [openStep(page.route, page.name, order)];
        order += 1;
        const testData: Record<string, string> = {};
        // Fill the other required fields so only the target triggers the error
        for (const other of allFields) {
          if (other === f) continue;
          if (isRequired(other, requiredNames) || allFields.length <= 3) {
            const val = sampleValue(other.prop || other.label);
            steps.push(fillStep(other, order, val));
            testData[other.prop || other.label] = val;
            order += 1;
          }
        }
        if (invalidValue) {
          steps.push(fillStep(f, order, invalidValue));
          testData[f.prop || label] = invalidValue;
          order += 1;
        }
        steps.push(submitStep(order));
        order += 1;
        const expect = pointExpected(
          point,
          invalidValue
            ? `${label} format is invalid`
            : `${label} cannot be empty`,
        );
        steps.push(assertExpected(order, expect));
        const kase = newCase({
          title: (point.title || `${label} empty validation`).slice(0, 255),
          module: pointModule(point, page, backend),
          type: "negative",
          priority: point.priority || "P1",
          preconditions: [`The ${page.name} page is open`],
          steps: steps.map((s) => s.action),
          expectedResults: [expect],
          structuredSteps: steps,
          testData,
          testPointId: point.id ?? null,
        });
        if (targets.length > 1) {
          kase.title = `${kase.title} (${label})`.slice(0, 255);
        }
        cases.push(finishPointCase(kase, point, page, backend));
        made = true;
      }
      if (made) continue;
    }

    // ---- Boundary: split valid boundary and out-of-range into two cases ----
    if (category === "boundary" && page && fields.length > 0) {
      const constraintMap = new Map<
        string,
        { rule: string; value: unknown }[]
      >();
      for (const entity of backend.entities) {
        for (const c of entity.fieldConstraints) {
          if (
            ["size", "pattern", "max", "min"].includes(c.rule) &&
            c.value != null
          ) {
            const list = constraintMap.get(c.field) ?? [];
            list.push({ rule: c.rule, value: c.value });
            constraintMap.set(c.field, list);
          }
        }
      }
      let preferred = fields.filter(
        (f) => constraintMap.has(f.prop) || constraintMap.has(f.label),
      );
      const preferredMentioned = preferred.filter((f) => mentioned.includes(f));
      if (preferredMentioned.length > 0) preferred = preferredMentioned;
      const rawExpect = String(point.expected || "");
      // Compound boundary points (valid + out-of-range) split into two;
      // single-sided points emit only one case.
      const wantsValid = expectsSuccess(rawExpect);
      const lowerExpect = rawExpect.toLowerCase();
      const wantsInvalid =
        ERROR_HINTS.some((w) => lowerExpect.includes(w)) || !wantsValid;
      let made = false;
      for (const f of preferred.slice(0, 2)) {
        const cons =
          constraintMap.get(f.prop) || constraintMap.get(f.label) || [];
        if (cons.length === 0) continue;
        const c = cons[0];
        const label = f.label || f.prop;
        const multiTarget = preferred.length > 1;
        const suffix = (variant: string): string =>
          multiTarget ? ` (${label} ${variant})` : ` (${variant})`;

        let scenarios: [string, string, string][] = [];
        let defaultError = "";
        if (c.rule === "size") {
          const limit = Number(c.value);
          defaultError = `${label} cannot exceed ${limit} characters`;
          scenarios = [
            ["valid", "a".repeat(limit), suffix(`${limit} characters, valid`)],
            [
              "invalid",
              "a".repeat(limit + 1),
              suffix(`${limit + 1} characters, too long`),
            ],
          ];
        } else if (c.rule === "pattern") {
          defaultError = `${label} format is invalid`;
          scenarios = [["invalid", "123", suffix("invalid format")]];
          // Only emit the valid-format case when a known sample satisfies the
          // pattern; never fabricate a doomed positive.
          const sampleKey = (f.prop || label || "")
            .toLowerCase()
            .replace(/-/g, "_");
          if (sampleKey in FIELD_SAMPLE) {
            scenarios.unshift([
              "valid",
              FIELD_SAMPLE[sampleKey],
              suffix("valid format"),
            ]);
          }
        } else if (c.rule === "max") {
          const limit = Number(c.value);
          defaultError = `${label} is out of range`;
          scenarios = [
            ["valid", String(limit), suffix(`at upper limit ${limit}`)],
            ["invalid", String(limit + 1), suffix("above upper limit")],
          ];
        } else {
          // min
          const limit = Number(c.value);
          defaultError = `${label} is out of range`;
          scenarios = [
            ["valid", String(limit), suffix(`at lower limit ${limit}`)],
            ["invalid", String(limit - 1), suffix("below lower limit")],
          ];
        }

        for (const [kind, value, scenarioSuffix] of scenarios) {
          if (kind === "valid" && !wantsValid) continue;
          if (kind === "invalid" && !wantsInvalid) continue;
          const expect = boundaryExpect(point, {
            valid: kind === "valid",
            success,
            fallback: defaultError,
          });
          let order = 1;
          const steps = [openStep(page.route, page.name, order)];
          order += 1;
          const testData: Record<string, string> = {};
          // Fill the other required fields: the valid boundary must really
          // submit, and the invalid one must only fail on the target field.
          for (const other of allFields) {
            if (other === f) continue;
            if (isRequired(other, requiredNames)) {
              const val = sampleValue(other.prop || other.label);
              steps.push(fillStep(other, order, val));
              testData[other.prop || other.label] = val;
              order += 1;
            }
          }
          steps.push(fillStep(f, order, value));
          testData[f.prop || label] = value;
          order += 1;
          steps.push(submitStep(order));
          order += 1;
          steps.push(assertExpected(order, expect));
          let title = point.title || `${label} boundary validation`;
          if (scenarios.length > 1) {
            title = `${title.slice(0, 255 - scenarioSuffix.length)}${scenarioSuffix}`;
          }
          const kase = newCase({
            title: title.slice(0, 255),
            module: pointModule(point, page, backend),
            type: "boundary",
            priority: point.priority || "P1",
            preconditions: [`The ${page.name} page is open`],
            steps: steps.map((s) => s.action),
            expectedResults: [expect],
            structuredSteps: steps,
            testData,
            testPointId: point.id ?? null,
          });
          cases.push(finishPointCase(kase, point, page, backend));
          made = true;
        }
      }
      if (made) continue;
    }

    // ---- Positive / api / permission: fill concrete params and submit ----
    if (page) {
      // All required fields must be filled, otherwise the positive/valid
      // boundary case cannot really submit.
      let fillFields = allFields.filter(
        (f) => isRequired(f, requiredNames) || fields.includes(f),
      );
      if (fillFields.length === 0) fillFields = fields;
      const expect = pointExpected(point, success);
      let order = 1;
      const steps = [openStep(page.route, page.name, order)];
      order += 1;
      const testData: Record<string, string> = {};
      for (const f of fillFields.slice(0, 8)) {
        const val = sampleValue(f.prop || f.label);
        steps.push(fillStep(f, order, val));
        testData[f.prop || f.label] = val;
        order += 1;
      }
      if (fillFields.length > 0) {
        steps.push(submitStep(order));
        order += 1;
      }
      steps.push(assertExpected(order, expect));
      const kase = newCase({
        title: (point.title || `${page.name} functional verification`).slice(
          0,
          255,
        ),
        module: pointModule(point, page, backend),
        type: POINT_TYPE[category] ?? "positive",
        priority: point.priority || "P1",
        preconditions: [`The ${page.name} page is open`],
        steps: steps.map((s) => s.action),
        expectedResults: [expect],
        structuredSteps: steps,
        testData,
        testPointId: point.id ?? null,
      });
      cases.push(finishPointCase(kase, point, page, backend));
      continue;
    }

    cases.push(
      genericPointCase(
        point,
        backend,
        frontend,
        "no matching page found; steps need manual completion",
      ),
    );
  }
  return cases;
}
