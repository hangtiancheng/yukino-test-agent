/**
 * Shared domain types for the Yukino test agent.
 *
 * These mirror the structured contracts used across the pipeline:
 * static analysis facts -> test points -> structured test cases ->
 * browser execution -> AI review -> coverage & reports.
 */

// ---------- Structured step contract ----------

export type UiSelectorType =
  | "route"
  | "placeholder"
  | "text"
  | "label"
  | "role"
  | "testid"
  | "css"
  | "xpath";

export interface UiSelector {
  type: UiSelectorType | string;
  value: string;
}

export type StepType = "ui_action" | "input" | "state_assert" | "capture";

export interface StructuredStep {
  order: number;
  type: StepType | string;
  action: string;
  target: string;
  uiSelector?: UiSelector;
  expected?: string;
  inputValue?: string;
  /** capture step: runtime variable name, e.g. `base_count` */
  variable?: string;
  /** capture step: regex with one capture group applied to the page body text */
  pattern?: string;
}

export interface CoverageRefs {
  endpointIds: string[];
  transitionIds: string[];
  ruleIds: string[];
  testPointIds?: string[];
}

// ---------- Static analysis facts ----------

/** A single controller-method parameter extracted by the analyzer. */
export interface EndpointParam {
  name: string;
  type: string;
  /** request_body / path_variable / request_param / unknown. */
  source: string;
  required: boolean;
  constraints: string[];
  /** Non-primitive parameter type name (candidate DTO), else ''. */
  dtoType?: string;
}

export interface Endpoint {
  id: string;
  method: string;
  path: string;
  controller: string;
  methodName: string;
  file: string;
  line: number;
  /** Method parameters (old analyses without them default to empty). */
  params?: EndpointParam[];
  /** Security annotations such as @PreAuthorize("hasRole('ADMIN')"). */
  auth?: string[];
}

export interface FieldConstraint {
  field: string;
  rule: string;
  value?: unknown;
}

export interface EntityField {
  name: string;
  type: string;
}

export interface Entity {
  name: string;
  file: string;
  fields: EntityField[];
  fieldConstraints: FieldConstraint[];
}

export interface EnumValue {
  name: string;
  label: string;
}

export interface EnumDef {
  name: string;
  values: EnumValue[];
}

export interface BusinessRule {
  id: string;
  description: string;
  guard: string;
  file: string;
  line: number;
}

export interface BackendResult {
  language: string;
  endpoints: Endpoint[];
  entities: Entity[];
  enums: EnumDef[];
  businessRules: BusinessRule[];
  uiTexts: string[];
}

export interface FormField {
  label: string;
  prop: string;
  type: string;
  required: boolean;
  placeholder: string;
  rules: string[];
}

export interface Form {
  fields: FormField[];
}

export interface Page {
  name: string;
  route: string;
  file: string;
  forms: Form[];
}

export interface PageSelector {
  type: string;
  value: string;
  page: string;
}

export interface FrontendResult {
  language: string;
  pages: Page[];
  selectors: PageSelector[];
  uiTexts: string[];
  components: unknown[];
}

export interface StateMachineState {
  name: string;
  label: string;
}

export interface StateMachineTransition {
  id: string;
  from: string;
  to: string;
  trigger: string;
  verified: boolean;
  evidence: string[];
  guard: string;
  /** filled in by the coverage matrix */
  planned?: boolean;
  plannedCaseIds?: string[];
  executed?: boolean;
}

export interface StateMachineSpec {
  id?: string;
  name: string;
  states: StateMachineState[];
  transitions: StateMachineTransition[];
  confidence: number;
}

// ---------- Test points & cases ----------

export type TestPointCategory =
  "functional" | "negative" | "boundary" | "state" | "api" | "permission";

export type CasePriority = "P0" | "P1" | "P2";
export type CaseType = "positive" | "negative" | "boundary" | "state";
export type CaseSource = "rule" | "ai" | "manual" | "import";

export interface TestPointDraft {
  title: string;
  category: TestPointCategory | string;
  priority: CasePriority | string;
  description: string;
  pageRoute: string;
  endpoint: string;
  fields: string[];
  expected: string;
  source: "llm" | "rule" | string;
  confidence: number;
}

export interface TestPoint extends TestPointDraft {
  id: string;
  requirementId: string;
  seq: number;
}

/** In-memory representation of a generated case before persistence. */
export interface GeneratedCase {
  title: string;
  module: string;
  type: CaseType | string;
  priority: CasePriority | string;
  preconditions: string[];
  steps: string[];
  expectedResults: string[];
  structuredSteps: StructuredStep[];
  testData: Record<string, string>;
  coverageRefs: CoverageRefs;
  source: CaseSource | string;
  confidence: number;
  qualityScore?: number;
  lintIssues?: string[];
  testPointId?: string | null;
}

export type ExecutionStatusCode =
  | "not_run"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "needs_review"
  | "cancelled";

export type ReviewVerdict = "ok" | "suspect" | "unavailable";

export type ErrorCategory =
  | "SELECTOR_NOT_FOUND"
  | "ASSERT_FAILED"
  | "NAVIGATION_FAILED"
  | "TIMEOUT"
  | "CASE_INVALID"
  | "ENV_ERROR";

export type FailureCategory =
  | "product_defect"
  | "test_script_issue"
  | "test_data_issue"
  | "environment_issue"
  | "unknown"
  | "none";

export type WorkflowStatus =
  "pending" | "running" | "completed" | "partial" | "failed" | "cancelled";

export type WorkflowStageName =
  | "code_analysis"
  | "test_points"
  | "case_generation"
  | "case_review"
  | "execution"
  | "result_analysis"
  | "report";

export type StageStatus =
  "pending" | "running" | "completed" | "failed" | "skipped";

export type ReviewStatus = "pending" | "pass" | "revise" | "reject";
export type AutomationStatus = "automated" | "manual" | "blocked";

// ---------- Execution evidence ----------

export interface ExecutionStepRecord {
  stepIndex: number;
  stepType: string;
  action: string;
  target: string;
  selectorUsed: string | null;
  result: "passed" | "failed" | "skipped" | string;
  screenshotBefore: string | null;
  screenshotAfter: string | null;
  error: string | null;
  /** Verifiable per-step evidence (input length/hash/match/preview). */
  evidence?: Record<string, unknown>;
  durationMs?: number;
}

export interface RunnerResult {
  status: ExecutionStatusCode;
  errorCategory: ErrorCategory | string | null;
  errorMessage: string | null;
  videoPath: string | null;
  passedSteps: number;
  totalSteps: number;
  steps: ExecutionStepRecord[];
}

export interface ReviewIssue {
  imageIndex: number;
  stepIndex: number | null;
  label: string | null;
  screenshot: string | null;
  bbox: [number, number, number, number] | null;
  problem: string;
}

export interface ImageReview {
  imageIndex: number;
  stepIndex: number | null;
  label: string | null;
  screenshot: string | null;
  verdict: "ok" | "suspect" | string | null;
  analysis: string | null;
  bbox: [number, number, number, number] | null;
}

// ---------- LLM profiles ----------

export type LlmKind = "text" | "vision";

export interface LlmProfileDict {
  id: string;
  name: string;
  kind: LlmKind;
  apiKey: string;
  apiKeyConfigured: boolean;
  baseUrl: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

// ---------- Jobs ----------

export type JobStatus = "pending" | "running" | "completed" | "failed";

export interface JobState {
  id: string;
  kind: string;
  status: JobStatus;
  message: string;
  current: number;
  total: number;
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
