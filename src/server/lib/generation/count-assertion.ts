/**
 * Rewrite fixed-total assertions into runtime baseline assertions.
 *
 * Problem: with persisted test data the list total is not a fixed 4/5.
 * Asserting "total of 5 items" inevitably fails on a dirty environment. The correct
 * approach reads a baseline before the operation, then asserts "baseline + 1".
 *
 * This module only handles clearly structured, safely derivable scenarios:
 * - the case contains a create/add action
 * - a list route can be found in expectations or page facts
 * - there is exactly one "total/count N items" assertion
 * Anything else is left untouched (or dropped) for review/human handling,
 * avoiding steps that look dynamic but cannot execute.
 */
import { quotedAnchors } from "./quality-gate";

import type { StructuredStep } from "#/lib/types";

const COUNT_PATTERNS: RegExp[] = [
  /\b(?:total(?:\s+count)?|count|number)\s+(?:of\s+)?(\d+)\s+(?:items?|rows?|entries?|records?|orders?|products?)\b/i,
  /\b(?:total|count|number)\s+(?:becomes?|became|is|equals?|should\s+be)\s+(\d+)\b/i,
  /\b(\d+)\s+(?:items?|rows?|entries?|records?|orders?|products?)\s+in\s+total\b/i,
];
const NUMBER_RE = /\d+/;
const CREATE_WORDS = ["submit", "create", "add", "save", "new"];
const ROUTE_RE = /\/[A-Za-z0-9_\-/]+/;

interface CountClauseMatch {
  full: string;
  numberStart: number;
  numberEnd: number;
}

function matchCountClause(text: string): CountClauseMatch | null {
  for (const pattern of COUNT_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    const numRel = m[0].indexOf(m[1]);
    return {
      full: m[0],
      numberStart: m.index + numRel,
      numberEnd: m.index + numRel + m[1].length,
    };
  }
  return null;
}

/** Turn a phrase into a whitespace-tolerant regex fragment. */
function flexible(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
}

/** Capture pattern from an anchor like `total of 5 items`. */
export function countPattern(anchor: string): string {
  const match = NUMBER_RE.exec(anchor || "");
  if (!match) return "(\\d+)";
  const prefix = (anchor.slice(0, match.index) || "").trim();
  const suffix = (anchor.slice(match.index + match[0].length) || "").trim();
  const pattern = `${flexible(prefix)}\\s*(\\d+)\\s*${flexible(suffix)}`.trim();
  return pattern || "(\\d+)";
}

function listRoute(
  kase: { expectedResults?: string[]; steps?: string[] },
  listRoutes: string[],
): string {
  // Return the only determinable list route; when several candidates exist,
  // return '' so a runtime baseline is never built on the wrong page.
  const text = [...(kase.expectedResults || []), ...(kase.steps || [])].join(
    " ",
  );
  const explicit = new Set<string>();
  const globalRouteRe = new RegExp(ROUTE_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = globalRouteRe.exec(text)) !== null) {
    if (match[0].toLowerCase().includes("list")) explicit.add(match[0]);
  }
  if (explicit.size === 1) return [...explicit][0];
  if (explicit.size > 1) return "";
  const candidates = new Set(
    listRoutes.filter((route) => route && route.toLowerCase().includes("list")),
  );
  return candidates.size === 1 ? [...candidates][0] : "";
}

function hasCreateAction(
  steps: StructuredStep[],
  beforeIndex: number,
): boolean {
  for (const step of steps.slice(0, beforeIndex)) {
    if (step.type !== "ui_action") continue;
    const text = `${step.action || ""} ${step.target || ""}`.toLowerCase();
    if (CREATE_WORDS.some((word) => text.includes(word))) return true;
  }
  return false;
}

function rewriteExpectedText(text: string): string {
  const m = matchCountClause(text || "");
  if (!m) return text;
  return text.replace(
    m.full,
    "the total increases by 1 item compared to before the operation",
  );
}

export interface CountNormalization {
  changed: boolean;
  drop?: boolean;
  notes: string[];
}

interface CaseProxy {
  structuredSteps: StructuredStep[];
  expectedResults: string[];
  steps: string[];
  preconditions: string[];
}

/** Mutates the case proxy in place; returns changed/drop notes. */
export function normalizeCaseCounts(
  kase: CaseProxy,
  listRoutes: string[] | null,
): CountNormalization {
  const steps = kase.structuredSteps || [];
  const countSteps: { index: number; expected: string; anchor: string }[] = [];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (step.type !== "state_assert") continue;
    const rawExpected = String(step.expected || "");
    if (rawExpected.includes("${")) continue;
    for (const anchor of quotedAnchors(rawExpected)) {
      if (matchCountClause(anchor)) {
        countSteps.push({ index, expected: rawExpected, anchor });
        break;
      }
    }
  }
  if (countSteps.length !== 1) {
    return {
      changed: false,
      drop: countSteps.length > 0,
      notes:
        countSteps.length > 0
          ? [
              "Multiple fixed-total assertions; cannot safely convert to a runtime baseline",
            ]
          : [],
    };
  }
  const { index, anchor } = countSteps[0];
  if (!hasCreateAction(steps, index)) {
    return {
      changed: false,
      drop: true,
      notes: [
        "Fixed-total assertion has no create/add action to establish a baseline; unstable on shared data. Use a unique row identifier or isolated data instead.",
      ],
    };
  }
  const route = listRoute(kase, listRoutes || []);
  if (!route) {
    return {
      changed: false,
      drop: true,
      notes: [
        "Fixed-total assertion detected but no list route found; cannot establish a runtime baseline.",
      ],
    };
  }

  const pattern = countPattern(anchor);
  const variable = "base_count";
  const captureStep: StructuredStep = {
    order: 0,
    type: "capture",
    action: "Read the current list total as the baseline",
    target: "list total",
    uiSelector: { type: "text", value: "" },
    expected: "",
    inputValue: "",
    variable,
    pattern,
  };
  const routeStep: StructuredStep = {
    order: 0,
    type: "ui_action",
    action: "Open the list to read the pre-operation total",
    target: "list",
    uiSelector: { type: "route", value: route },
    expected: "",
    inputValue: "",
  };

  const firstSelector = steps[0]?.uiSelector;
  let insertAt = 1;
  if (
    steps.length > 0 &&
    firstSelector?.type === "route" &&
    firstSelector.value === route
  ) {
    insertAt = 1;
  } else {
    steps.unshift(routeStep);
    insertAt = 1;
  }
  steps.splice(insertAt, 0, captureStep);
  steps.forEach((step, i) => {
    step.order = i + 1;
  });

  const dynamic = (text: string): string => {
    const m = matchCountClause(text);
    if (!m) return text;
    return `${text.slice(0, m.numberStart)}\${base_count+1}${text.slice(m.numberEnd)}`;
  };

  // `index` referred to the pre-insert position; relocate the count
  // assertion by content after insertion.
  const targetStep = steps.find(
    (step) =>
      step.type === "state_assert" &&
      matchCountClause(String(step.expected || "")) !== null &&
      !String(step.expected || "").includes("${"),
  );
  if (!targetStep) {
    return {
      changed: false,
      notes: ["Failed to relocate the fixed-count assertion; not rewritten"],
    };
  }
  targetStep.expected = dynamic(String(targetStep.expected || ""));
  if (targetStep.uiSelector && targetStep.uiSelector.value) {
    targetStep.uiSelector.value = dynamic(targetStep.uiSelector.value);
  }

  kase.expectedResults = (kase.expectedResults || []).map((item) =>
    rewriteExpectedText(String(item)),
  );
  const note =
    'Reads the list total before the operation as a runtime baseline; the total is asserted as "baseline + 1" instead of a fixed seed count';
  if (!kase.preconditions.includes(note)) kase.preconditions.push(note);
  kase.steps = steps.map((step) => String(step.action || "")).filter(Boolean);
  return {
    changed: true,
    notes: [
      'Fixed-total assertion converted to a runtime baseline: capture the current total, then assert "baseline + 1"',
    ],
  };
}
