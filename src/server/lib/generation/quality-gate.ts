/**
 * Three quality gates (all rules, zero LLM).
 *
 * Gate 0  One scenario per case: compound expectations (multiple quoted
 *         anchors, nested anchors, semicolon-joined results) or two different
 *         values typed into the same field are dropped outright. A case may
 *         only verify one input scenario, otherwise evidence keeps just the
 *         last input (false failures / false passes).
 * Gate 1  UiLanguageLinter: blocks API-style descriptions, abstract actions
 *         without a uiSelector, and unverifiable visual assertions.
 * Gate 2  Scoring: start at 100; -8 per lint issue (capped at -40); -10 per
 *         step missing a uiSelector; -10 when coverageRefs are all empty;
 *         -10 when steps > 15. Empty expectedResults is a hard drop;
 *         score < 40 is dropped.
 * Gate 3  Dedupe: normalized similarity of title + all steps + expectations
 *         > 0.95 counts as duplicate; the higher qualityScore wins. Legal vs
 *         boundary cases split from the same test point have different
 *         expectations and are never deduped against each other.
 *
 * Anchor convention: expected texts quote visible page copy with double
 * quotes, e.g. expect "Order created successfully".
 */
import type { GeneratedCase, StructuredStep } from "#/lib/types";

/** API-style description keywords (any hit is a lint issue). */
const FORBIDDEN_API_WORDS = [
  "call api",
  "call the api",
  "invoke api",
  "send request",
  "http request",
  "rest api",
  "curl",
  "postman",
  "check database",
  "verify database",
  "query database",
  "check return value",
  "api_call",
];

/** Unverifiable visual assertion keywords. */
const VAGUE_ASSERT_WORDS = [
  "displays normally",
  "looks normal",
  "page is normal",
  "as expected",
  "looks correct",
  "no problem",
  "works fine",
];

/**
 * Visible-copy anchors in expectations. Straight and curly double quotes are
 * accepted; the runner uses the same convention.
 */
const QUOTE_ANCHOR_RE = /["“]([^"”]+)["”]/g;
const COMPOUND_SEPARATOR_RE = /[;；]/;

export function quotedAnchors(text: string | null | undefined): string[] {
  const out: string[] = [];
  const re = new RegExp(QUOTE_ANCHOR_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || "")) !== null) {
    const anchor = m[1].trim();
    if (anchor) out.push(anchor);
  }
  return out;
}

/**
 * Whether an expectation describes multiple scenarios / observable results.
 *
 * Compound when any of:
 * - two or more quoted anchors
 * - an anchor that itself contains a quote (nested; the runner would only
 *   slice out half a sentence)
 * - a semicolon split where every part is a full sentence (>= 4 chars)
 */
export function isCompoundExpected(text: string | null | undefined): boolean {
  const raw = (text || "").trim();
  if (!raw) return false;
  const anchors = quotedAnchors(raw);
  if (anchors.length >= 2) return true;
  if (anchors.some((a) => /["“”]/.test(a))) return true;
  const parts = raw
    .split(COMPOUND_SEPARATOR_RE)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length >= 2 && parts.every((p) => p.length >= 4);
}

export function caseHasCompoundExpected(kase: {
  expectedResults: string[];
  structuredSteps: StructuredStep[];
}): boolean {
  if ((kase.expectedResults || []).some((exp) => isCompoundExpected(exp))) {
    return true;
  }
  for (const step of kase.structuredSteps || []) {
    if (step.type !== "state_assert") continue;
    for (const raw of [step.expected, step.uiSelector?.value]) {
      if (isCompoundExpected(String(raw || ""))) return true;
    }
  }
  return false;
}

/**
 * The same field filled with two different values -> one case verifying two
 * input scenarios. Both assertions might pass individually, but on failure
 * the culprit is ambiguous and evidence only keeps the last input.
 */
export function stepsHaveMultipleInputs(
  steps: StructuredStep[] | null | undefined,
): boolean {
  const seen = new Map<string, string>();
  for (const step of steps || []) {
    if (step.type !== "input") continue;
    const key = String(step.uiSelector?.value || step.target || "").trim();
    const value = String(step.inputValue || "").trim();
    if (!key || !value) continue;
    if (seen.has(key) && seen.get(key) !== value) return true;
    seen.set(key, value);
  }
  return false;
}

export function caseHasMultipleInputs(kase: {
  structuredSteps: StructuredStep[];
}): boolean {
  return stepsHaveMultipleInputs(kase.structuredSteps);
}

export interface GateResult {
  generated: number;
  kept: GeneratedCase[];
  dropped: number;
  dropReasons: Record<string, number>;
}

export function lintCase(kase: GeneratedCase): string[] {
  const issues: string[] = [];
  for (const step of kase.structuredSteps) {
    const action = step.action || "";
    const target = step.target || "";
    const text = `${action} ${target}`.toLowerCase();
    if (FORBIDDEN_API_WORDS.some((w) => text.includes(w))) {
      issues.push(`API-style description: ${action}`);
    }
    const sel = step.uiSelector;
    if (
      (step.type === "ui_action" || step.type === "input") &&
      !(sel && sel.value)
    ) {
      issues.push(`Missing uiSelector: ${action}`);
    }
    if (step.type === "capture") {
      if (!String(step.variable || "").trim()) {
        issues.push(`capture step missing variable: ${action}`);
      }
      if (!String(step.pattern || "").trim()) {
        issues.push(`capture step missing pattern: ${action}`);
      }
    }
  }
  for (const exp of kase.expectedResults) {
    const lower = exp.toLowerCase();
    if (VAGUE_ASSERT_WORDS.some((w) => lower.includes(w))) {
      issues.push(`Unverifiable assertion: ${exp}`);
      break;
    }
  }
  return issues;
}

/** Gate 2: score 0..100. */
export function scoreCase(
  kase: {
    structuredSteps: StructuredStep[];
    coverageRefs?: {
      endpointIds?: string[];
      transitionIds?: string[];
      ruleIds?: string[];
    } | null;
  },
  lintIssues: string[],
): number {
  let score = 100;
  score -= Math.min(8 * lintIssues.length, 40);
  for (const step of kase.structuredSteps) {
    const sel = step.uiSelector;
    if (
      (step.type === "ui_action" || step.type === "input") &&
      !(sel && sel.value)
    ) {
      score -= 10;
    }
  }
  const refs = kase.coverageRefs || {
    endpointIds: [],
    transitionIds: [],
    ruleIds: [],
  };
  const hasRefs = [refs.endpointIds, refs.transitionIds, refs.ruleIds].some(
    (list) => (list || []).length > 0,
  );
  if (!hasRefs) score -= 10;
  if (kase.structuredSteps.length > 15) score -= 10;
  return Math.max(score, 0);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

/**
 * Dedupe fingerprint: title + all steps (inputs/assertions included) +
 * expected results. Title + first step alone would falsely merge cases like
 * "20 chars valid" vs "21 chars too long" split from the same point.
 */
function scenarioText(kase: GeneratedCase): string {
  const steps = kase.structuredSteps
    .map(
      (s) =>
        `${s.action || ""}${s.target || ""}${s.inputValue || ""}${s.expected || ""}${s.variable || ""}${s.pattern || ""}`,
    )
    .join("");
  return normalizeText(
    `${kase.title}${steps}${(kase.expectedResults || []).join("|")}`,
  );
}

/**
 * Similarity ratio in [0,1], mirroring difflib.SequenceMatcher.ratio closely
 * enough for dedupe: 2 * LCS / total length.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  // LCS via dynamic programming with a rolling row.
  let prev = new Uint32Array(b.length + 1);
  let curr = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1] + 1
          : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const lcs = prev[b.length];
  return (2 * lcs) / (a.length + b.length);
}

function sameExpected(a: GeneratedCase, b: GeneratedCase): boolean {
  return (
    normalizeText((a.expectedResults || []).join("|")) ===
    normalizeText((b.expectedResults || []).join("|"))
  );
}

function isDuplicate(kase: GeneratedCase, existing: GeneratedCase): boolean {
  // Legal/boundary cases split from the same test point: titles are highly
  // similar but expectations differ — two legitimate cases.
  if (
    kase.testPointId &&
    kase.testPointId === existing.testPointId &&
    !sameExpected(kase, existing)
  ) {
    return false;
  }
  return similarity(scenarioText(kase), scenarioText(existing)) > 0.95;
}

/** Three gates: linter -> scoring -> dedupe. Kept cases get lintIssues/qualityScore. */
export function runQualityGate(cases: GeneratedCase[]): GateResult {
  const dropReasons: Record<string, number> = {
    no_expected: 0,
    compound_expected: 0,
    multiple_inputs: 0,
    low_score: 0,
    duplicate: 0,
  };
  const scored: GeneratedCase[] = [];

  for (const kase of cases) {
    if (!kase.expectedResults || kase.expectedResults.length === 0) {
      dropReasons.no_expected += 1;
      continue;
    }
    if (caseHasCompoundExpected(kase)) {
      dropReasons.compound_expected += 1;
      continue;
    }
    if (caseHasMultipleInputs(kase)) {
      dropReasons.multiple_inputs += 1;
      continue;
    }
    kase.lintIssues = lintCase(kase);
    kase.qualityScore = scoreCase(kase, kase.lintIssues);
    if (kase.qualityScore < 40) {
      dropReasons.low_score += 1;
      continue;
    }
    scored.push(kase);
  }

  // Dedupe: keep the higher qualityScore.
  // Threshold 0.95 (not 0.85): rule-generated cases of the same type differ
  // only by field name; 0.85 would kill legitimate distinct cases like
  // "receiver empty" vs "phone empty". 0.95 only removes near-identical ones.
  const kept: GeneratedCase[] = [];
  const ordered = [...scored].sort(
    (a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0),
  );
  for (const kase of ordered) {
    if (kept.some((existing) => isDuplicate(kase, existing))) {
      dropReasons.duplicate += 1;
    } else {
      kept.push(kase);
    }
  }

  return {
    generated: cases.length,
    kept,
    dropped: cases.length - kept.length,
    dropReasons,
  };
}
