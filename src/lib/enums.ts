/**
 * Execution-domain enums with English display metadata.
 *
 * The database stores stable English codes; the UI and reports render
 * label/description/tone from this single source of truth.
 */

export type Tone = "info" | "primary" | "success" | "danger" | "warning";

export interface EnumMeta {
  label: string;
  tone: Tone;
  description: string;
}

export const CASE_EXECUTION_STATUS_META: Record<string, EnumMeta> = {
  not_run: {
    label: "Not Run",
    tone: "info",
    description: "The case has no execution records yet.",
  },
  running: {
    label: "Running",
    tone: "primary",
    description:
      "The case is executing in a real browser; no final verdict yet.",
  },
  passed: {
    label: "Passed",
    tone: "success",
    description:
      "All deterministic checks passed, or evidence was confirmed by AI/human review.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    description:
      "A definite error occurred, or human review confirmed the result did not meet expectations.",
  },
  skipped: {
    label: "Skipped",
    tone: "warning",
    description:
      "Some steps could not be verified; there is not enough evidence to pass or fail.",
  },
  needs_review: {
    label: "Needs Review",
    tone: "warning",
    description:
      "Insufficient evidence, a suspicious AI verdict, or review unavailable; human confirmation required.",
  },
  cancelled: {
    label: "Cancelled",
    tone: "info",
    description:
      "The user aborted the execution; it must not be treated as a pass.",
  },
};

export const EXECUTION_RECORD_STATUS_META: Record<string, EnumMeta> =
  Object.fromEntries(
    Object.entries(CASE_EXECUTION_STATUS_META).filter(
      ([key]) => key !== "not_run",
    ),
  );

export const AI_REVIEW_VERDICT_META: Record<string, EnumMeta> = {
  ok: {
    label: "Evidence Supports Expectation",
    tone: "success",
    description:
      "Key screenshots and step records clearly support the expected result; never overrides a deterministic execution failure.",
  },
  suspect: {
    label: "Suspected Anomaly",
    tone: "danger",
    description:
      "Screenshots show anomalies, contradict expectations, or are insufficient as evidence.",
  },
  unavailable: {
    label: "Review Unavailable",
    tone: "info",
    description:
      "The vision model is not configured, the call failed, the response was invalid, or no screenshots were available.",
  },
};

export const ERROR_CATEGORY_META: Record<string, EnumMeta> = {
  SELECTOR_NOT_FOUND: {
    label: "Element Not Found",
    tone: "warning",
    description:
      "The runner tried the full selector and text fallback chain but could not locate an actionable element.",
  },
  ASSERT_FAILED: {
    label: "Assertion Failed",
    tone: "danger",
    description:
      "The page URL or quoted text anchors did not satisfy the expected result.",
  },
  NAVIGATION_FAILED: {
    label: "Navigation Failed",
    tone: "danger",
    description:
      "The page could not be opened, or the target returned 4xx/5xx.",
  },
  TIMEOUT: {
    label: "Step Timeout",
    tone: "warning",
    description: "A page action or wait exceeded the default runner timeout.",
  },
  CASE_INVALID: {
    label: "Invalid Case",
    tone: "warning",
    description:
      "The case is missing structured steps, input values, selectors, or other fields required for execution.",
  },
  ENV_ERROR: {
    label: "Environment Error",
    tone: "info",
    description:
      "Browser launch failure, driver error, or another non-business execution environment problem.",
  },
};

export const FAILURE_CATEGORY_META: Record<string, EnumMeta> = {
  product_defect: {
    label: "Product Defect",
    tone: "danger",
    description:
      "Concrete evidence shows the page behavior violates the requirement or observable expectation.",
  },
  test_script_issue: {
    label: "Test Script Issue",
    tone: "warning",
    description:
      "The case steps, selectors, assertions, or input approach are themselves flawed.",
  },
  test_data_issue: {
    label: "Test Data Issue",
    tone: "warning",
    description:
      "Test data violated business constraints, while script and product behavior are unproven faulty.",
  },
  environment_issue: {
    label: "Environment Issue",
    tone: "info",
    description:
      "Target unreachable, browser launch failure, network problems, timeouts, or other non-business causes.",
  },
  unknown: {
    label: "Unknown",
    tone: "info",
    description:
      "Evidence is insufficient, or multiple causes cannot be distinguished; human review required.",
  },
  none: {
    label: "None",
    tone: "success",
    description: "The execution passed with no anomaly evidence.",
  },
};

export const CASE_TYPE_META: Record<string, EnumMeta> = {
  positive: {
    label: "Positive",
    tone: "success",
    description: "Happy-path case with all valid inputs.",
  },
  negative: {
    label: "Negative",
    tone: "danger",
    description: "Invalid or missing input that must be rejected.",
  },
  boundary: {
    label: "Boundary",
    tone: "warning",
    description: "Values at or beyond constraint boundaries.",
  },
  state: {
    label: "State Flow",
    tone: "primary",
    description: "Drives a verified state-machine transition.",
  },
};

export const CASE_SOURCE_META: Record<string, EnumMeta> = {
  rule: {
    label: "Rule",
    tone: "info",
    description: "Generated deterministically from code facts.",
  },
  ai: {
    label: "AI",
    tone: "primary",
    description: "Generated by the LLM and validated against code facts.",
  },
  manual: {
    label: "Manual",
    tone: "info",
    description: "Created or edited by a human.",
  },
  import: {
    label: "Import",
    tone: "info",
    description: "Imported from CSV.",
  },
};

export const REQUIREMENT_STATUS_META: Record<string, EnumMeta> = {
  draft: {
    label: "Draft",
    tone: "info",
    description: "Waiting to be parsed into test points.",
  },
  analyzing: {
    label: "Analyzing",
    tone: "primary",
    description: "Test point extraction is in progress.",
  },
  ready: {
    label: "Ready",
    tone: "success",
    description: "Test points have been extracted.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    description: "Test point extraction failed.",
  },
};

export const ANALYSIS_STATUS_META: Record<string, EnumMeta> = {
  pending: { label: "Pending", tone: "info", description: "Queued." },
  running: {
    label: "Running",
    tone: "primary",
    description: "Static analysis is in progress.",
  },
  success: {
    label: "Success",
    tone: "success",
    description: "Analysis completed with results.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    description: "Analysis failed; see the error message.",
  },
};

export const WORKFLOW_STATUS_META: Record<string, EnumMeta> = {
  pending: {
    label: "Pending",
    tone: "info",
    description: "Run created, not started.",
  },
  running: {
    label: "Running",
    tone: "primary",
    description: "Pipeline is executing.",
  },
  completed: {
    label: "Completed",
    tone: "success",
    description: "All stages finished successfully.",
  },
  partial: {
    label: "Partial",
    tone: "warning",
    description: "Some stages failed but usable output was produced.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    description: "A hard failure stopped the pipeline.",
  },
  cancelled: {
    label: "Cancelled",
    tone: "info",
    description: "The run was cancelled or interrupted by a server restart.",
  },
};

export const STAGE_STATUS_META: Record<string, EnumMeta> = {
  pending: { label: "Pending", tone: "info", description: "Not started." },
  running: { label: "Running", tone: "primary", description: "In progress." },
  completed: { label: "Completed", tone: "success", description: "Finished." },
  failed: { label: "Failed", tone: "danger", description: "Stage error." },
  skipped: { label: "Skipped", tone: "info", description: "Not executed." },
};

export const REVIEW_STATUS_META: Record<string, EnumMeta> = {
  pending: { label: "Pending", tone: "info", description: "Not reviewed yet." },
  pass: {
    label: "Pass",
    tone: "success",
    description: "Approved for automated execution.",
  },
  revise: {
    label: "Revise",
    tone: "warning",
    description: "Fixable problems found; a repair round is required.",
  },
  reject: {
    label: "Reject",
    tone: "danger",
    description: "Blocking problems; the case will not be executed.",
  },
};

export const PRIORITY_META: Record<string, EnumMeta> = {
  P0: { label: "P0", tone: "danger", description: "Core flow, must pass." },
  P1: { label: "P1", tone: "warning", description: "Important scenario." },
  P2: { label: "P2", tone: "info", description: "Nice to have." },
};

export const STAGE_LABELS: Record<string, string> = {
  code_analysis: "Code Analysis",
  test_points: "Test Points",
  case_generation: "Case Generation",
  case_review: "Case Review",
  execution: "Execution",
  result_analysis: "Result Analysis",
  report: "Report",
};

export function meta(
  mapping: Record<string, EnumMeta | undefined>,
  code: string | null | undefined,
): EnumMeta & { code: string | null } {
  const item = mapping[code ?? ""];
  return {
    code: code ?? null,
    label: item?.label ?? code ?? "Uncategorized",
    tone: item?.tone ?? "info",
    description: item?.description ?? "",
  };
}
