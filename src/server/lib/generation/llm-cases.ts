/**
 * Agent 2: executable test case generation via LLM (batched per test point).
 *
 * Responsibilities:
 * - Build the prompt, call the LLM, converge the response into case dicts.
 * - Semantic validation (test point id must match, single input + single
 *   assertion, required fields, selector facts) lives here and in the
 *   quality gate — one standard, not two.
 * - A failed batch only degrades that batch to rule generation.
 */
import {
  isCompoundExpected,
  quotedAnchors,
  stepsHaveMultipleInputs,
} from "./quality-gate";
import { newCase } from "./rule-cases";
import { testCasesByPointPrompt } from "./prompts";

import { asTextList } from "#/server/lib/text-list";

import type { LlmClient } from "#/server/lib/llm";

import type {
  BackendResult,
  FrontendResult,
  GeneratedCase,
  StateMachineSpec,
  StructuredStep,
} from "#/lib/types";
import type { PointInput } from "./test-points";

const ALLOWED_SELECTOR_TYPES = new Set([
  "route",
  "placeholder",
  "text",
  "label",
  "role",
  "testid",
]);

function asCaseList(raw: unknown): Record<string, unknown>[] {
  let value: unknown = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const dict = raw as Record<string, unknown>;
    value = dict.testCases || dict.cases || dict.data || [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object",
  );
}

/** Normalize LLM steps: restrict types, fill order/uiSelector, drop invalid. */
export function normalizeSteps(rawSteps: unknown): StructuredStep[] {
  const out: StructuredStep[] = [];
  if (!Array.isArray(rawSteps)) return out;
  for (const s of rawSteps.slice(0, 12)) {
    if (!s || typeof s !== "object") continue;
    const item = s as Record<string, unknown>;
    const stepType = item.type;
    if (
      !["ui_action", "input", "state_assert", "capture"].includes(
        String(stepType),
      )
    ) {
      continue;
    }
    const sel =
      item.uiSelector && typeof item.uiSelector === "object"
        ? (item.uiSelector as Record<string, unknown>)
        : {};
    out.push({
      order: out.length + 1,
      type: String(stepType),
      action: String(item.action || "").slice(0, 255),
      target: String(item.target || "").slice(0, 255),
      uiSelector: {
        type: String(sel.type || "text").slice(0, 20),
        value: String(sel.value || "").slice(0, 500),
      },
      expected: String(item.expected || "").slice(0, 500),
      inputValue: String(item.inputValue || item.input_value || "").slice(
        0,
        500,
      ),
      variable: String(item.variable || "").slice(0, 60),
      pattern: String(item.pattern || "").slice(0, 300),
    });
  }
  return out;
}

export interface CaseFacts {
  pages: Record<string, unknown>[];
  fieldConstraints: Record<string, unknown>[];
  selectors: { type: string; value: string }[];
  uiTexts: string[];
  endpoints: { method: string; path: string }[];
  stateMachines: Record<string, unknown>[];
}

/** Backend validation annotations are the reliable source for required/size
 * (Vue rules often live in <script>, invisible to the frontend parser). */
export function buildCaseFacts(
  backend: BackendResult,
  frontend: FrontendResult,
  machines: StateMachineSpec[],
): CaseFacts {
  const requiredNames = new Set<string>();
  for (const entity of backend.entities) {
    for (const c of entity.fieldConstraints) {
      if (["notblank", "notnull", "notempty", "required"].includes(c.rule)) {
        requiredNames.add(c.field);
      }
    }
  }
  return {
    pages: frontend.pages.map((page) => ({
      name: page.name,
      route: page.route,
      fields: page.forms.flatMap((form) =>
        form.fields.map((f) => ({
          label: f.label,
          prop: f.prop,
          type: f.type,
          required: Boolean(
            f.required ||
            requiredNames.has(f.prop) ||
            requiredNames.has(f.label),
          ),
          placeholder: f.placeholder,
        })),
      ),
    })),
    fieldConstraints: backend.entities
      .flatMap((entity) =>
        entity.fieldConstraints.map((c) => ({
          field: c.field,
          rule: c.rule,
          value: c.value,
        })),
      )
      .filter((c) =>
        [
          "notblank",
          "notnull",
          "notempty",
          "required",
          "size",
          "pattern",
          "max",
          "min",
        ].includes(c.rule),
      )
      .slice(0, 120),
    selectors: frontend.selectors
      .map((s) => ({ type: s.type, value: s.value }))
      .slice(0, 80),
    uiTexts: frontend.uiTexts.slice(0, 40),
    endpoints: backend.endpoints
      .map((e) => ({ method: e.method, path: e.path }))
      .slice(0, 60),
    stateMachines: machines.map((m) => ({
      name: m.name,
      states: m.states || [],
      transitions: (m.transitions || []).map((t) => ({
        from: t.from,
        to: t.to,
        trigger: t.trigger,
        verified: t.verified,
      })),
    })),
  };
}

export interface RequirementRef {
  version: string;
  name: string;
}

export interface LlmGenerationEvents {
  onEvent?: (event: {
    type: "progress" | "fallback";
    message: string;
    current: number;
    total: number;
    reason?: string;
  }) => void;
  /** Mutable; the callee records why it fell back to rule generation. */
  runInfo?: { fallbackReason?: string; fallbackAt?: number };
}

/**
 * Generate cases per test point via LLM in small batches (5 points each).
 * Returned cases carry testPointId; invalid LLM output for a point lets the
 * caller fall back to rule generation for that point only.
 */
export async function generateLlmCasesForPoints(
  client: LlmClient,
  requirement: RequirementRef,
  points: PointInput[],
  backend: BackendResult,
  frontend: FrontendResult,
  machines: StateMachineSpec[],
  events: LlmGenerationEvents = {},
): Promise<GeneratedCase[]> {
  const facts = buildCaseFacts(backend, frontend, machines);
  const pointById = new Map(points.map((p) => [p.id, p]));
  const cases: GeneratedCase[] = [];
  const batchSize = 5;

  for (let start = 0; start < points.length; start += batchSize) {
    const batch = points.slice(start, start + batchSize);
    const batchIds = new Set(batch.map((p) => p.id));
    const payload = batch.map((p) => ({
      testPointId: p.id,
      title: p.title,
      category: p.category,
      priority: p.priority,
      description: p.description,
      pageRoute: p.pageRoute,
      endpoint: p.endpoint,
      fields: p.fields,
      expected: p.expected,
    }));
    const prompt = testCasesByPointPrompt({
      requirementVersion: requirement.version,
      requirementName: requirement.name,
      pointsJson: JSON.stringify(payload),
      factsJson: JSON.stringify(facts),
    });

    let rawList: Record<string, unknown>[];
    try {
      const raw = await client.chatJson(
        [{ role: "user", content: prompt }],
        16384,
        true,
      );
      rawList = asCaseList(raw);
    } catch (error) {
      // A reasoning model can burn the whole budget on hidden reasoning and
      // never emit JSON. Continuing to request later batches would just keep
      // the page spinning, so stop the LLM here and let the caller rule-fill
      // the remaining points.
      const reason = `LLM returned no usable result (test points ${start + 1}-${start + batch.length}): ${error instanceof Error ? error.message : String(error)}`;
      if (events.runInfo) {
        events.runInfo.fallbackReason = reason;
        events.runInfo.fallbackAt = start;
      }
      events.onEvent?.({
        type: "fallback",
        message:
          "LLM returned no usable result; remaining test points fall back to rules",
        reason,
        current: start,
        total: points.length,
      });
      break;
    }

    for (const rc of rawList) {
      const tpId = String(rc.testPointId || "");
      if (!batchIds.has(tpId)) continue;
      const point = pointById.get(tpId);
      if (!point) continue;
      // When the test point itself describes two scenarios (20 chars OK +
      // 21 chars error), the LLM tends to pick one or merge them; hand the
      // point to the rule generator so both cases are produced.
      if (isCompoundExpected(String(point.expected || ""))) continue;

      let steps = normalizeSteps(rc.structuredSteps);
      if (steps.length === 0) continue;
      if (
        steps.some(
          (s) => !ALLOWED_SELECTOR_TYPES.has(String(s.uiSelector?.type || "")),
        )
      ) {
        // css/xpath and other unverifiable locators -> rule generation
        continue;
      }
      if (
        steps.some(
          (s) =>
            s.type === "state_assert" &&
            quotedAnchors(String(s.expected || "")).length !== 1,
        )
      ) {
        continue;
      }
      // The runner depends on first-step navigation; add it from the test
      // point's page route when the LLM omitted it.
      const firstIsRoute = steps[0]?.uiSelector?.type === "route";
      if (!firstIsRoute) {
        const route = point.pageRoute || "/";
        steps = [
          {
            order: 1,
            type: "ui_action",
            action: `Open page ${route}`,
            target: route,
            uiSelector: { type: "route", value: route },
            expected: "",
            inputValue: "",
          },
          ...steps,
        ];
        steps.forEach((s, i) => {
          s.order = i + 1;
        });
      }
      let expected = asTextList(rc.expectedResults);
      if (expected.length === 0) {
        expected = [point.expected || point.title];
      }
      // Compound expectations cannot be satisfied by a single execution:
      // skip the LLM case and let the rule fallback split the point.
      if (expected.some((x) => isCompoundExpected(x))) continue;
      const compoundAssert = steps.some(
        (s) =>
          s.type === "state_assert" &&
          [s.expected, s.uiSelector?.value].some((raw) =>
            isCompoundExpected(String(raw || "")),
          ),
      );
      if (compoundAssert) continue;
      if (stepsHaveMultipleInputs(steps)) continue;

      const refs =
        rc.coverageRefs && typeof rc.coverageRefs === "object"
          ? (rc.coverageRefs as Record<string, unknown>)
          : {};
      const asIds = (value: unknown): string[] =>
        Array.isArray(value) ? value.map((v) => String(v)) : [];
      cases.push(
        newCase({
          title: String(rc.title || point.title).slice(0, 255),
          module: String(rc.module || point.title).slice(0, 120),
          type: String(rc.type || "positive"),
          priority: String(rc.priority || point.priority),
          preconditions: [
            `Requirement version: ${requirement.version} ${requirement.name}`,
          ],
          steps: steps
            .map((s) => s.action)
            .filter(Boolean)
            .slice(0, 10),
          expectedResults: expected.slice(0, 5),
          structuredSteps: steps,
          testData:
            rc.testData && typeof rc.testData === "object"
              ? (rc.testData as Record<string, string>)
              : {},
          coverageRefs: {
            endpointIds: asIds(refs.endpointIds),
            transitionIds: asIds(refs.transitionIds),
            ruleIds: asIds(refs.ruleIds),
            testPointIds: [tpId],
          },
          source: "ai",
          confidence: 0.85,
          testPointId: tpId,
        }),
      );
    }
    events.onEvent?.({
      type: "progress",
      message: `LLM processed ${Math.min(start + batchSize, points.length)}/${points.length} test points`,
      current: Math.min(start + batchSize, points.length),
      total: points.length,
    });
  }
  return cases;
}

/** Project-level LLM generation (optional enhancement; caller degrades). */
export async function generateProjectCasesLlm(
  client: LlmClient,
  backend: BackendResult,
  frontend: FrontendResult,
  machines: StateMachineSpec[],
): Promise<GeneratedCase[]> {
  const promptFacts = {
    endpoints: backend.endpoints.map((e) => ({
      method: e.method,
      path: e.path,
    })),
    entities: backend.entities.map((e) => ({
      name: e.name,
      fields: e.fields.map((f) => f.name),
    })),
    enums: backend.enums.map((e) => ({
      name: e.name,
      values: e.values.map((v) => v.name),
    })),
    uiTexts: backend.uiTexts,
    pages: frontend.pages.map((p) => ({
      name: p.name,
      route: p.route,
      fields: p.forms.flatMap((form) => form.fields.map((f) => f.label)),
    })),
    selectors: frontend.selectors.map((s) => ({
      type: s.type,
      value: s.value,
    })),
    stateMachines: machines,
  };
  const prompt = `You are a UI test automation expert. Based on the code facts of the system under test, generate directly executable structured test cases.

Code facts (JSON; only reference routes/fields/selectors/copy that exist there):
${JSON.stringify(promptFacts)}

Output only a JSON object {"testCases": [...]} where each element has:
{"title": "...", "module": "...", "type": "positive|negative|boundary|state", "priority": "P0|P1|P2", "expectedResults": ["one observable result anchored in double quotes"], "testData": {"field": "value"}, "structuredSteps": [{"order":1,"type":"ui_action|input|state_assert","action":"...","target":"...","uiSelector":{"type":"route|placeholder|text|label|role|testid","value":"..."},"expected":"","inputValue":""}]}

Hard requirements: the first step opens a page (route); uiSelector values must exist in the facts; each state_assert expected contains exactly one double-quoted anchor; at most 8 steps per case; no css/xpath; no API or database assertions. expectedResults must be complete readable expectation sentences (trigger + observable result), never a bare status label or button name; for list position/sorting use a concrete order number or unique field as evidence. Never hardcode list totals ("total of 5 items"); to verify a count change, capture the current value then assert with \${base_count+1}, or assert a unique row identifier.`;
  const raw = await client.chatJson(
    [{ role: "user", content: prompt }],
    16384,
    true,
  );
  const out: GeneratedCase[] = [];
  for (const rc of asCaseList(raw)) {
    try {
      out.push(
        newCase({
          title: String(rc.title || "Untitled case"),
          module: String(rc.module || "Business"),
          type: String(rc.type || "positive"),
          priority: String(rc.priority || "P1"),
          expectedResults: asTextList(rc.expectedResults),
          structuredSteps: normalizeSteps(rc.structuredSteps),
          testData:
            rc.testData && typeof rc.testData === "object"
              ? (rc.testData as Record<string, string>)
              : {},
          coverageRefs: {
            endpointIds: [],
            transitionIds: [],
            ruleIds: [],
          },
          source: "ai",
          confidence: 0.8,
        }),
      );
    } catch {
      continue;
    }
  }
  return out;
}
