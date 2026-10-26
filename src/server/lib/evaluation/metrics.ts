/**
 * Evaluation metrics (pure functions; no DB/model access, easy to unit test
 * and recompute).
 *
 * Experiment A — case-quality metrics: required-field completeness, test-point
 * coverage, duplicate rate, verifiable-expectation rate, key-scenario omission
 * rate, deterministic quality score, human quality score. Every ratio returns
 * `null` when it has no denominator; callers must never treat `null` as 0 or
 * fabricate an improvement.
 *
 * Experiment B — failure-classification metrics: accuracy, macro-F1, per-class
 * P/R/F1, unknown-detection rate, no-evidence conclusion rate, human agreement.
 *
 * Ported from the legacy `app/evaluation/metrics.py` offline harness. Anchor
 * convention follows the rest of this project: visible page copy is quoted with
 * straight or curly double quotes.
 */

/** Visible-copy anchors: straight and curly double quotes. */
const QUOTE_ANCHOR_RE = /["“]([^"”]+)["”]/g;

/** Unverifiable visual-assertion keywords (English). */
const VAGUE_ASSERT_WORDS = [
  "displays normally",
  "looks normal",
  "page is normal",
  "as expected",
  "looks correct",
  "no problem",
  "works fine",
  "functions normally",
];

export interface MetricStep {
  type?: string;
  action?: string;
  target?: string;
  inputValue?: string;
  expected?: string;
  uiSelector?: { type?: string; value?: string } | null;
}

export interface MetricCase {
  id?: string;
  title?: string;
  type?: string;
  testPointId?: string | null;
  qualityScore?: number | null;
  expectedResults?: string[] | null;
  structuredSteps?: MetricStep[] | null;
  coverageRefs?: { testPointIds?: string[] | null } | null;
}

export interface MetricPoint {
  id?: string;
  title?: string;
  category?: string;
}

/** { route: [[label, prop, placeholder], ...] } */
export type RequiredByRoute = Record<string, string[][]>;

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return (
    Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1e4) / 1e4
  );
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function routeOf(kase: MetricCase): string {
  for (const step of kase.structuredSteps || []) {
    const selector = step.uiSelector || {};
    if (selector.type === "route" && selector.value)
      return String(selector.value);
    if (step.type === "ui_action" && selector.type === "route") {
      return String(selector.value || "");
    }
  }
  return "";
}

function inputCorpus(kase: MetricCase): string {
  const parts: string[] = [];
  for (const step of kase.structuredSteps || []) {
    if (step.type !== "input") continue;
    const selector = (step.uiSelector || {}).value || "";
    parts.push(`${selector} ${step.target || ""} ${step.action || ""}`);
  }
  return parts.join(" ");
}

/**
 * Average fill-ratio of "all required fields on the current page" per case.
 * A field counts as filled when any of its synonyms appears in an input step's
 * selector/target/action. Returns null when no case is decidable; a case whose
 * page has no required fields scores 1.0.
 */
export function requiredFieldCompleteness(
  cases: MetricCase[],
  requiredByRoute: RequiredByRoute,
): number | null {
  const scores: number[] = [];
  for (const kase of cases) {
    const required = requiredByRoute[routeOf(kase)] || [];
    if (required.length === 0) {
      scores.push(1);
      continue;
    }
    const corpus = inputCorpus(kase);
    const filled = required.filter((tokens) =>
      tokens.some((token) => token && corpus.includes(String(token))),
    ).length;
    scores.push(filled / required.length);
  }
  return mean(scores);
}

/** Numerator/denominator so the completeness rate is auditable. */
export function requiredFieldCompletenessCount(
  cases: MetricCase[],
  requiredByRoute: RequiredByRoute,
): { filled: number; required: number } {
  let filledTotal = 0;
  let requiredTotal = 0;
  for (const kase of cases) {
    const required = requiredByRoute[routeOf(kase)] || [];
    if (required.length === 0) continue;
    requiredTotal += required.length;
    const corpus = inputCorpus(kase);
    filledTotal += required.filter((tokens) =>
      tokens.some((token) => token && corpus.includes(String(token))),
    ).length;
  }
  return { filled: filledTotal, required: requiredTotal };
}

export function pointCoverage(
  cases: MetricCase[],
  pointIds: string[],
): number | null {
  if (pointIds.length === 0) return null;
  const wanted = new Set(pointIds);
  const covered = new Set<string>();
  for (const kase of cases) {
    const tp = kase.testPointId;
    if (tp && wanted.has(String(tp))) covered.add(String(tp));
    for (const item of kase.coverageRefs?.testPointIds || []) {
      if (wanted.has(String(item))) covered.add(String(item));
    }
  }
  return round4(covered.size / wanted.size);
}

/**
 * Duplicate rate = (caseCount - distinct scenario count) / caseCount.
 * Fingerprint matches the quality gate: title + all steps + expectations.
 */
export function duplicateRate(cases: MetricCase[]): number | null {
  if (cases.length === 0) return null;
  const seen = new Set<string>();
  let duplicates = 0;
  for (const kase of cases) {
    const steps = (kase.structuredSteps || [])
      .map((s) =>
        ["action", "target", "inputValue", "expected"]
          .map((key) => String((s as Record<string, unknown>)[key] || ""))
          .join(""),
      )
      .join("");
    const fingerprint =
      `${kase.title || ""}${steps}${(kase.expectedResults || []).join("|")}`
        .replace(/\s+/g, "")
        .toLowerCase();
    if (seen.has(fingerprint)) duplicates += 1;
    else seen.add(fingerprint);
  }
  return round4(duplicates / cases.length);
}

function anchorsOf(kase: MetricCase): string[] {
  const texts: string[] = [...(kase.expectedResults || [])];
  for (const step of kase.structuredSteps || []) {
    if (step.type === "state_assert") texts.push(String(step.expected || ""));
  }
  const anchors: string[] = [];
  const re = new RegExp(QUOTE_ANCHOR_RE.source, "g");
  for (const text of texts) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(text))) !== null) anchors.push(m[1]);
  }
  // expectedResults and state_assert often carry the same anchor; count unique
  // visible copy.
  return [...new Set(anchors.map((a) => a.trim()).filter(Boolean))];
}

export function verifiableExpectationRate(cases: MetricCase[]): number | null {
  if (cases.length === 0) return null;
  let good = 0;
  for (const kase of cases) {
    const texts = [
      ...(kase.expectedResults || []),
      ...(kase.structuredSteps || [])
        .filter((s) => s.type === "state_assert")
        .map((s) => String(s.expected || "")),
    ].join(" ");
    const anchors = anchorsOf(kase);
    const lower = texts.toLowerCase();
    if (
      anchors.length === 1 &&
      !VAGUE_ASSERT_WORDS.some((w) => lower.includes(w))
    ) {
      good += 1;
    }
  }
  return round4(good / cases.length);
}

/** Share of key scenarios (negative/boundary/state) with no covering case. */
export function keyScenarioOmission(
  cases: MetricCase[],
  points: MetricPoint[],
): { rate: number | null; missing: string[]; total: number } {
  const keyPoints = points.filter((p) =>
    ["negative", "boundary", "state"].includes(String(p.category || "")),
  );
  if (keyPoints.length === 0) return { rate: null, missing: [], total: 0 };
  const covered = new Set<string>();
  for (const kase of cases) {
    if (kase.testPointId) covered.add(String(kase.testPointId));
    for (const item of kase.coverageRefs?.testPointIds || []) {
      covered.add(String(item));
    }
  }
  const missing = keyPoints
    .filter((p) => !covered.has(String(p.id)))
    .map((p) => p.title || p.id || "");
  return {
    rate: round4(missing.length / keyPoints.length),
    missing,
    total: keyPoints.length,
  };
}

export function qualityScoreSummary(cases: MetricCase[]): {
  mean: number | null;
  min: number | null;
  max: number | null;
  count: number;
} {
  const scores = cases
    .map((c) => c.qualityScore)
    .filter((s): s is number => typeof s === "number" && Number.isFinite(s));
  return {
    mean: mean(scores.map((s) => Number(s))),
    min: scores.length > 0 ? Math.min(...scores) : null,
    max: scores.length > 0 ? Math.max(...scores) : null,
    count: scores.length,
  };
}

export function humanQualityScore(
  cases: MetricCase[],
  scoresByCase: Record<string, number> | null,
): number | null {
  if (!scoresByCase) return null;
  const values = cases
    .filter((c) => c.id && c.id in scoresByCase)
    .map((c) => Number(scoresByCase[c.id as string]));
  return mean(values);
}

export interface CaseSetEvaluation {
  caseCount: number;
  testPointCount: number;
  requiredFieldCompleteness: number | null;
  requiredFieldDetail: { filled: number; required: number };
  requiredFieldCases: number;
  requiredFieldScope: "positive_cases" | "all_cases";
  pointCoverage: number | null;
  duplicateRate: number | null;
  verifiableExpectationRate: number | null;
  keyScenarioOmissionRate: number | null;
  keyScenarioMissing: string[];
  qualityScore: ReturnType<typeof qualityScoreSummary>;
  humanQualityScore: number | null;
}

export function evaluateCaseSet(
  cases: MetricCase[],
  points: MetricPoint[],
  requiredByRoute: RequiredByRoute,
  humanScores: Record<string, number> | null = null,
): CaseSetEvaluation {
  const omission = keyScenarioOmission(cases, points);
  // Negative/boundary cases deliberately leave the tested field empty, so
  // required-field completeness is only meaningful for positive cases.
  const positiveCases = cases.filter(
    (c) => String(c.type || "").toLowerCase() === "positive",
  );
  const requiredCases = positiveCases.length > 0 ? positiveCases : cases;
  return {
    caseCount: cases.length,
    testPointCount: points.length,
    requiredFieldCompleteness: requiredFieldCompleteness(
      requiredCases,
      requiredByRoute,
    ),
    requiredFieldDetail: requiredFieldCompletenessCount(
      requiredCases,
      requiredByRoute,
    ),
    requiredFieldCases: requiredCases.length,
    requiredFieldScope:
      positiveCases.length > 0 ? "positive_cases" : "all_cases",
    pointCoverage: pointCoverage(
      cases,
      points.map((p) => String(p.id)),
    ),
    duplicateRate: duplicateRate(cases),
    verifiableExpectationRate: verifiableExpectationRate(cases),
    keyScenarioOmissionRate: omission.rate,
    keyScenarioMissing: omission.missing,
    qualityScore: qualityScoreSummary(cases),
    humanQualityScore: humanQualityScore(cases, humanScores),
  };
}

export interface MetricComparison {
  baseline: number;
  proposed: number;
  diff: number;
  percent: number | null;
  direction: "lower_is_better" | "higher_is_better";
}

/** Per-metric absolute diff and percent; percent is null when baseline is 0. */
export function compareMetrics(
  baseline: Record<string, unknown>,
  proposed: Record<string, unknown>,
  lowerIsBetter: Set<string> = new Set([
    "duplicateRate",
    "keyScenarioOmissionRate",
  ]),
): Record<string, MetricComparison> {
  const out: Record<string, MetricComparison> = {};
  for (const [key, base] of Object.entries(baseline)) {
    if (typeof base !== "number" || !Number.isFinite(base)) continue;
    const current = proposed[key];
    if (typeof current !== "number" || !Number.isFinite(current)) continue;
    const diff = round4(current - base);
    out[key] = {
      baseline: base,
      proposed: current,
      diff,
      percent: base ? Math.round((diff / base) * 100 * 100) / 100 : null,
      direction: lowerIsBetter.has(key)
        ? "lower_is_better"
        : "higher_is_better",
    };
  }
  return out;
}

// ---------- Experiment B: failure classification ----------

export interface ClassificationMetrics {
  samples: number;
  accuracy: number | null;
  macroF1: number | null;
  perClass: Record<
    string,
    {
      precision: number | null;
      recall: number | null;
      f1: number | null;
      support: number;
      predicted: number;
    }
  >;
  labels: string[];
}

/** pairs = [[gold, pred]]; per-class P/R/F1 + accuracy + macro-F1. */
export function classificationMetrics(
  pairs: [string, string][],
  labels?: string[],
): ClassificationMetrics {
  if (pairs.length === 0) {
    return {
      samples: 0,
      accuracy: null,
      macroF1: null,
      perClass: {},
      labels: labels || [],
    };
  }
  const labelSet =
    labels ||
    [...new Set([...pairs.map((p) => p[0]), ...pairs.map((p) => p[1])])].sort();
  const perClass: ClassificationMetrics["perClass"] = {};
  for (const label of labelSet) {
    const tp = pairs.filter(([g, p]) => g === label && p === label).length;
    const fp = pairs.filter(([g, p]) => g !== label && p === label).length;
    const fn = pairs.filter(([g, p]) => g === label && p !== label).length;
    const support = pairs.filter(([g]) => g === label).length;
    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    const f1 =
      precision !== null && recall !== null && precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : null;
    perClass[label] = {
      precision: precision !== null ? round4(precision) : null,
      recall: recall !== null ? round4(recall) : null,
      f1: f1 !== null ? round4(f1) : null,
      support,
      predicted: tp + fp,
    };
  }
  const accuracy = pairs.filter(([g, p]) => g === p).length / pairs.length;
  const macroClasses = Object.values(perClass)
    .filter((item) => item.support > 0 && item.f1 !== null)
    .map((item) => item.f1 as number);
  return {
    samples: pairs.length,
    accuracy: round4(accuracy),
    macroF1:
      macroClasses.length > 0
        ? round4(macroClasses.reduce((a, b) => a + b, 0) / macroClasses.length)
        : null,
    perClass,
    labels: labelSet,
  };
}

export function unknownDetectionRate(
  pairs: [string, string][],
  unknownLabel = "unknown",
): number | null {
  const support = pairs.filter(([g]) => g === unknownLabel).length;
  if (support === 0) return null;
  const hit = pairs.filter(
    ([g, p]) => g === unknownLabel && p === unknownLabel,
  ).length;
  return round4(hit / support);
}

export interface EvidenceRecord {
  pred: string;
  no_evidence?: boolean;
  human?: string;
}

/** Share of no-evidence samples given a definite (non unknown/none) label. */
export function noEvidenceConclusionRate(
  records: EvidenceRecord[],
): number | null {
  const noEvidence = records.filter((r) => r.no_evidence);
  if (noEvidence.length === 0) return null;
  const overclaim = noEvidence.filter(
    (r) => !["unknown", "none"].includes(r.pred),
  ).length;
  return round4(overclaim / noEvidence.length);
}

export function humanAgreement(records: EvidenceRecord[]): number | null {
  const judged = records.filter((r) => r.human);
  if (judged.length === 0) return null;
  const agree = judged.filter((r) => r.pred === r.human).length;
  return round4(agree / judged.length);
}

export function categoryDistribution(
  values: unknown[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) {
    const key = String(value);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}
