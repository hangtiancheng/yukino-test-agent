/**
 * Drizzle schema (PostgreSQL).
 *
 * Conventions:
 * - Primary keys are 32-char uuid hex strings generated in the service layer,
 *   except test_cases (`TC-000001`) and execution_records (`EX-xxxxxxxx`),
 *   which use human-readable ids.
 * - Structured payloads use jsonb columns typed with the shared domain types.
 */
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import type {
  BackendResult,
  CoverageRefs,
  ExecutionStatusCode,
  FrontendResult,
  LlmKind,
  StateMachineState,
  StateMachineTransition,
  StructuredStep,
} from "#/lib/types";

// ---------- Projects & analysis ----------

export const projects = pgTable("projects", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  description: text("description"),
  /** local_path | git */
  sourceType: varchar("source_type", { length: 20 })
    .notNull()
    .default("local_path"),
  sourcePath: text("source_path"),
  gitUrl: varchar("git_url", { length: 500 }),
  gitBranch: varchar("git_branch", { length: 120 }),
  /** e.g. {"backend":"java-spring","frontend":"vue"} */
  techStack: jsonb("tech_stack").$type<Record<string, string | null>>(),
  prdContent: text("prd_content"),
  targetUrl: text("target_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const codeAnalyses = pgTable(
  "code_analyses",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    projectId: varchar("project_id", { length: 36 }).notNull(),
    /** pending | running | success | failed */
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    backendResult: jsonb("backend_result").$type<BackendResult>(),
    frontendResult: jsonb("frontend_result").$type<FrontendResult>(),
    warnings: jsonb("warnings").$type<string[]>(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("ix_code_analyses_project").on(table.projectId)],
);

export const stateMachines = pgTable(
  "state_machines",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    projectId: varchar("project_id", { length: 36 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    states: jsonb("states").$type<StateMachineState[]>(),
    transitions: jsonb("transitions").$type<StateMachineTransition[]>(),
    confidence: real("confidence").notNull().default(0),
  },
  (table) => [index("ix_state_machines_project").on(table.projectId)],
);

// ---------- Requirements & test points ----------

export const requirements = pgTable(
  "requirements",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    projectId: varchar("project_id", { length: 36 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    version: varchar("version", { length: 40 }).notNull().default("V1.0"),
    content: text("content"),
    sourceFile: varchar("source_file", { length: 255 }),
    /** draft | analyzing | ready | failed */
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("ix_requirements_project").on(table.projectId, table.createdAt),
  ],
);

export const testPoints = pgTable(
  "test_points",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    requirementId: varchar("requirement_id", { length: 36 }).notNull(),
    projectId: varchar("project_id", { length: 36 }).notNull(),
    seq: integer("seq").notNull().default(0),
    title: varchar("title", { length: 255 }).notNull(),
    /** functional | negative | boundary | state | api | permission */
    category: varchar("category", { length: 20 })
      .notNull()
      .default("functional"),
    priority: varchar("priority", { length: 10 }).notNull().default("P1"),
    description: text("description"),
    pageRoute: varchar("page_route", { length: 255 }),
    endpoint: varchar("endpoint", { length: 255 }),
    fields: jsonb("fields").$type<string[]>(),
    expected: text("expected"),
    /** llm | rule */
    source: varchar("source", { length: 20 }).notNull().default("rule"),
    confidence: real("confidence").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("ix_test_points_requirement").on(table.requirementId, table.seq),
    index("ix_test_points_project").on(table.projectId),
  ],
);

// ---------- Test cases ----------

export const testCases = pgTable(
  "test_cases",
  {
    /** TC-{6-digit sequence}, assigned by the service layer */
    id: varchar("id", { length: 20 }).primaryKey(),
    projectSeq: integer("project_seq").notNull(),
    projectId: varchar("project_id", { length: 36 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    module: varchar("module", { length: 120 }).notNull().default(""),
    /** positive | negative | boundary | state */
    type: varchar("type", { length: 20 }).notNull().default("positive"),
    priority: varchar("priority", { length: 10 }).notNull().default("P1"),
    preconditions: jsonb("preconditions").$type<string[]>(),
    steps: jsonb("steps").$type<string[]>(),
    expectedResults: jsonb("expected_results").$type<string[]>(),
    structuredSteps: jsonb("structured_steps").$type<StructuredStep[]>(),
    testData: jsonb("test_data").$type<Record<string, string>>(),
    coverageRefs: jsonb("coverage_refs").$type<CoverageRefs>(),
    /** rule | ai | manual | import */
    source: varchar("source", { length: 20 }).notNull().default("rule"),
    confidence: real("confidence").notNull().default(1),
    qualityScore: integer("quality_score").notNull().default(100),
    lintIssues: jsonb("lint_issues").$type<string[]>(),
    executionStatus: varchar("execution_status", { length: 20 })
      .notNull()
      .default("not_run"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("ix_test_cases_project").on(table.projectId),
    index("ix_test_cases_project_seq").on(table.projectId, table.projectSeq),
  ],
);

export const testCaseVersions = pgTable(
  "test_case_versions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    testCaseId: varchar("test_case_id", { length: 20 }).notNull(),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    changeNote: varchar("change_note", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("ix_case_versions_case").on(table.testCaseId)],
);

export const requirementCases = pgTable(
  "requirement_cases",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    requirementId: varchar("requirement_id", { length: 36 }).notNull(),
    testCaseId: varchar("test_case_id", { length: 20 }).notNull(),
    testPointId: varchar("test_point_id", { length: 36 }),
  },
  (table) => [
    index("ix_requirement_cases_req").on(table.requirementId),
    index("ix_requirement_cases_case").on(table.testCaseId),
  ],
);

// ---------- Executions & AI review ----------

export const executionRecords = pgTable(
  "execution_records",
  {
    /** EX-{uuid8} */
    id: varchar("id", { length: 20 }).primaryKey(),
    projectId: varchar("project_id", { length: 36 }).notNull(),
    testCaseId: varchar("test_case_id", { length: 20 }).notNull(),
    /** Denormalized title so history stays readable after case deletion */
    testCaseTitle: varchar("test_case_title", { length: 255 }).notNull(),
    /** Full case snapshot captured at execution time (mandatory) */
    testCaseSnapshot: jsonb("test_case_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    batchId: varchar("batch_id", { length: 36 }),
    status: varchar("status", { length: 20 }).notNull().default("running"),
    /** programmatic | agent */
    mode: varchar("mode", { length: 20 }).notNull().default("programmatic"),
    targetUrl: text("target_url"),
    startTime: timestamp("start_time", { withTimezone: true }).defaultNow(),
    endTime: timestamp("end_time", { withTimezone: true }),
    durationMs: integer("duration_ms").notNull().default(0),
    errorCategory: varchar("error_category", { length: 40 }),
    errorMessage: text("error_message"),
    videoPath: varchar("video_path", { length: 500 }),
    passedSteps: integer("passed_steps").notNull().default(0),
    totalSteps: integer("total_steps").notNull().default(0),
  },
  (table) => [
    index("ix_executions_project").on(table.projectId),
    index("ix_executions_case").on(table.testCaseId),
    index("ix_executions_batch").on(table.batchId),
  ],
);

export const executionRequirements = pgTable(
  "execution_requirements",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    executionId: varchar("execution_id", { length: 20 }).notNull(),
    projectId: varchar("project_id", { length: 36 }).notNull(),
    requirementId: varchar("requirement_id", { length: 36 }),
    requirementVersion: varchar("requirement_version", { length: 40 }),
    requirementName: varchar("requirement_name", { length: 120 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("ux_execution_requirements_exec").on(table.executionId),
    index("ix_execution_requirements_project").on(table.projectId),
    index("ix_execution_requirements_req").on(table.requirementId),
  ],
);

export const executionReviews = pgTable(
  "execution_reviews",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    executionId: varchar("execution_id", { length: 20 }).notNull(),
    /** ok | suspect | unavailable */
    verdict: varchar("verdict", { length: 20 }).notNull(),
    reason: text("reason"),
    model: varchar("model", { length: 100 }),
    imageCount: integer("image_count").notNull().default(0),
    /** llm | manual */
    reviewer: varchar("reviewer", { length: 20 }),
    reviewerNote: text("reviewer_note"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [uniqueIndex("ux_execution_reviews_exec").on(table.executionId)],
);

export const executionReviewImages = pgTable(
  "execution_review_images",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    reviewId: varchar("review_id", { length: 36 }).notNull(),
    executionId: varchar("execution_id", { length: 20 }).notNull(),
    imageIndex: integer("image_index").notNull().default(0),
    stepIndex: integer("step_index"),
    label: varchar("label", { length: 255 }),
    screenshot: varchar("screenshot", { length: 500 }),
    verdict: varchar("verdict", { length: 20 }),
    analysis: text("analysis"),
    bbox: jsonb("bbox").$type<[number, number, number, number]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("ix_review_images_review").on(table.reviewId),
    index("ix_review_images_exec").on(table.executionId),
  ],
);

export const executionReviewIssues = pgTable(
  "execution_review_issues",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    reviewId: varchar("review_id", { length: 36 }).notNull(),
    executionId: varchar("execution_id", { length: 20 }).notNull(),
    imageIndex: integer("image_index").notNull().default(0),
    stepIndex: integer("step_index"),
    label: varchar("label", { length: 255 }),
    screenshot: varchar("screenshot", { length: 500 }),
    bbox: jsonb("bbox").$type<[number, number, number, number]>(),
    problem: text("problem"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("ix_review_issues_review").on(table.reviewId),
    index("ix_review_issues_exec").on(table.executionId),
  ],
);

export const executionSteps = pgTable(
  "execution_steps",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    executionId: varchar("execution_id", { length: 20 }).notNull(),
    stepIndex: integer("step_index").notNull(),
    action: varchar("action", { length: 255 }).notNull().default(""),
    target: varchar("target", { length: 255 }).notNull().default(""),
    stepType: varchar("step_type", { length: 20 })
      .notNull()
      .default("ui_action"),
    selectorUsed: varchar("selector_used", { length: 500 }),
    /** passed | failed | skipped */
    result: varchar("result", { length: 20 }).notNull().default("passed"),
    screenshotBefore: varchar("screenshot_before", { length: 500 }),
    screenshotAfter: varchar("screenshot_after", { length: 500 }),
    error: text("error"),
    durationMs: integer("duration_ms").notNull().default(0),
  },
  (table) => [index("ix_execution_steps_exec").on(table.executionId)],
);

// ---------- LLM profiles ----------

export const llmProfiles = pgTable(
  "llm_profiles",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull().default("text"),
    apiKey: text("api_key"),
    baseUrl: varchar("base_url", { length: 500 }),
    model: varchar("model", { length: 120 }),
    enabled: boolean("enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("ix_llm_profiles_kind").on(table.kind, table.enabled)],
);

// ---------- Multi-agent workflow (pipeline) ----------

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    projectId: varchar("project_id", { length: 36 }).notNull(),
    requirementId: varchar("requirement_id", { length: 36 }),
    /** Frozen version info so history stays readable after renames/deletes */
    requirementVersion: varchar("requirement_version", { length: 40 }),
    requirementName: varchar("requirement_name", { length: 120 }),
    /** pending | running | completed | partial | failed | cancelled */
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    currentStage: varchar("current_stage", { length: 30 }),
    /** rule | llm | auto */
    mode: varchar("mode", { length: 20 }).notNull().default("auto"),
    config: jsonb("config").$type<Record<string, unknown>>(),
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("ix_workflow_runs_project").on(table.projectId, table.createdAt),
    index("ix_workflow_runs_requirement").on(table.requirementId),
  ],
);

export const workflowStages = pgTable(
  "workflow_stages",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    runId: varchar("run_id", { length: 36 }).notNull(),
    stage: varchar("stage", { length: 30 }).notNull(),
    /** pending | running | completed | failed | skipped */
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    attempt: integer("attempt").notNull().default(1),
    inputSummary: text("input_summary"),
    outputSummary: text("output_summary"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    model: varchar("model", { length: 100 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("ix_workflow_stages_run").on(table.runId, table.stage)],
);

export const workflowCases = pgTable(
  "workflow_cases",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    runId: varchar("run_id", { length: 36 }).notNull(),
    caseId: varchar("case_id", { length: 20 }).notNull(),
    testPointId: varchar("test_point_id", { length: 36 }),
    position: integer("position").notNull().default(0),
    /** automated | manual | blocked */
    automationStatus: varchar("automation_status", { length: 20 })
      .notNull()
      .default("manual"),
    /** pending | pass | revise | reject */
    reviewStatus: varchar("review_status", { length: 20 })
      .notNull()
      .default("pending"),
    revisionCount: integer("revision_count").notNull().default(0),
    qualityScore: integer("quality_score").notNull().default(0),
    firstReviewId: varchar("first_review_id", { length: 36 }),
    finalReviewId: varchar("final_review_id", { length: 36 }),
    executionId: varchar("execution_id", { length: 20 }),
    analysisId: varchar("analysis_id", { length: 36 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("ix_workflow_cases_run").on(table.runId, table.position),
    index("ix_workflow_cases_case").on(table.caseId),
    index("ix_workflow_cases_exec").on(table.executionId),
  ],
);

export const workflowCaseReviews = pgTable(
  "workflow_case_reviews",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    runId: varchar("run_id", { length: 36 }).notNull(),
    caseId: varchar("case_id", { length: 20 }).notNull(),
    round: integer("round").notNull().default(1),
    reviewStatus: varchar("review_status", { length: 20 }).notNull(),
    qualityScore: integer("quality_score").notNull().default(0),
    issues: jsonb("issues").$type<
      {
        severity: string;
        field: string;
        problem: string;
        suggestion?: string;
        evidence?: string;
      }[]
    >(),
    missingCoverage: jsonb("missing_coverage").$type<unknown[]>(),
    suggestions: jsonb("suggestions").$type<string[]>(),
    deterministicIssues: jsonb("deterministic_issues").$type<string[]>(),
    /** llm | deterministic | mixed */
    source: varchar("source", { length: 20 })
      .notNull()
      .default("deterministic"),
    model: varchar("model", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("ix_workflow_reviews_run_case").on(
      table.runId,
      table.caseId,
      table.round,
    ),
  ],
);

export const workflowResultAnalyses = pgTable(
  "workflow_result_analyses",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    runId: varchar("run_id", { length: 36 }).notNull(),
    executionId: varchar("execution_id", { length: 20 }).notNull(),
    caseId: varchar("case_id", { length: 20 }).notNull(),
    /** Objective execution status snapshot; the original record is never modified */
    executionStatus: varchar("execution_status", { length: 20 }).notNull(),
    failureCategory: varchar("failure_category", { length: 30 })
      .notNull()
      .default("unknown"),
    failureReason: text("failure_reason"),
    evidence: jsonb("evidence").$type<string[]>(),
    confidence: doublePrecision("confidence").notNull().default(0),
    recommendedAction: text("recommended_action"),
    needsHumanReview: boolean("needs_human_review").notNull().default(true),
    /** llm | rule */
    source: varchar("source", { length: 20 }).notNull().default("rule"),
    model: varchar("model", { length: 100 }),
    rawResponse: jsonb("raw_response").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("ix_workflow_analyses_run").on(table.runId),
    index("ix_workflow_analyses_exec").on(table.executionId),
    index("ix_workflow_analyses_case").on(table.caseId),
  ],
);

// ---------- Concurrency-safe id sequences ----------

/**
 * Cross-process monotonic sequences (TC ids, per-project seq). A row lock on
 * the sequence row inside the saving transaction replaces the racy
 * max(id)+1 scan that could hand the same primary key to two workers.
 */
export const idSequences = pgTable("id_sequences", {
  name: varchar("name", { length: 50 }).primaryKey(),
  value: integer("value").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// ---------- Generation history (version snapshots) ----------

/**
 * One archived case-generation run per row: mode, profile, kept/dropped
 * counts, fallback reason, and a lightweight per-case snapshot so the UI can
 * offer a version dropdown and inspect past generations read-only. Live cases
 * still follow the original replace semantics; this table never mutates them.
 */
export const caseGenerations = pgTable(
  "case_generations",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    projectId: varchar("project_id", { length: 36 }).notNull(),
    requirementId: varchar("requirement_id", { length: 36 }),
    /** auto | rule | llm | legacy (back-filled archive) */
    mode: varchar("mode", { length: 20 }).notNull().default("rule"),
    profileId: varchar("profile_id", { length: 36 }),
    caseCount: integer("case_count").notNull().default(0),
    /** Stats: mode, requestedMode, fallback, fallbackReason, counts, byType. */
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    /** Lightweight case snapshots (id/title/module/type/priority/source/score/expected). */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("ix_case_generations_requirement").on(
      table.requirementId,
      table.createdAt,
    ),
    index("ix_case_generations_project").on(table.projectId, table.createdAt),
  ],
);

// ---------- Incremental requirement analysis ----------

/**
 * Immutable endpoint/rule/transition snapshot frozen per requirement version.
 * Code analysis is project-level "latest facts"; incremental comparison must
 * read the snapshot captured at the time, so a later re-analysis can never
 * silently rewrite the baseline.
 */
export const requirementSnapshots = pgTable(
  "requirement_snapshots",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    projectId: varchar("project_id", { length: 36 }).notNull(),
    requirementId: varchar("requirement_id", { length: 36 }).notNull(),
    analysisId: varchar("analysis_id", { length: 36 }),
    baselineRequirementId: varchar("baseline_requirement_id", { length: 36 }),
    /** code_analysis | manual */
    source: varchar("source", { length: 20 })
      .notNull()
      .default("code_analysis"),
    /** Normalized endpoints with expanded params, auth, and related rules. */
    endpoints: jsonb("endpoints").$type<Record<string, unknown>[]>(),
    rules: jsonb("rules").$type<Record<string, unknown>[]>(),
    stateTransitions:
      jsonb("state_transitions").$type<Record<string, unknown>[]>(),
    /** Shared security-config digest (hash + signals). */
    security: jsonb("security").$type<Record<string, unknown>>(),
    warnings: jsonb("warnings").$type<unknown[]>(),
    fingerprint: varchar("fingerprint", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("ix_requirement_snapshots_req").on(
      table.requirementId,
      table.createdAt,
    ),
    index("ix_requirement_snapshots_project").on(
      table.projectId,
      table.createdAt,
    ),
  ],
);

/** One incremental change analysis/generation run. */
export const requirementChangeRuns = pgTable(
  "requirement_change_runs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    projectId: varchar("project_id", { length: 36 }).notNull(),
    requirementId: varchar("requirement_id", { length: 36 }).notNull(),
    baselineRequirementId: varchar("baseline_requirement_id", {
      length: 36,
    }).notNull(),
    baselineSnapshotId: varchar("baseline_snapshot_id", { length: 36 }),
    currentSnapshotId: varchar("current_snapshot_id", { length: 36 }),
    /** analyzing | review | generating | completed | failed */
    status: varchar("status", { length: 20 }).notNull().default("analyzing"),
    mode: varchar("mode", { length: 20 }).notNull().default("auto"),
    profileId: varchar("profile_id", { length: 36 }),
    /** Endpoint/rule/case-change/regression statistics. */
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("ix_change_runs_requirement").on(
      table.requirementId,
      table.createdAt,
    ),
    index("ix_change_runs_baseline").on(table.baselineRequirementId),
  ],
);

/** One structured change between two requirement snapshots. */
export const requirementChanges = pgTable(
  "requirement_changes",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    runId: varchar("run_id", { length: 36 }).notNull(),
    projectId: varchar("project_id", { length: 36 }).notNull(),
    requirementId: varchar("requirement_id", { length: 36 }).notNull(),
    baselineRequirementId: varchar("baseline_requirement_id", {
      length: 36,
    }).notNull(),
    /** endpoint | business_rule | state_transition | permission | conflict */
    entityType: varchar("entity_type", { length: 30 }).notNull(),
    /** added | modified | deleted | unchanged | uncertain */
    changeType: varchar("change_type", { length: 20 }).notNull(),
    matchKey: varchar("match_key", { length: 255 }).notNull().default(""),
    oldRef: varchar("old_ref", { length: 80 }),
    newRef: varchar("new_ref", { length: 80 }),
    oldData: jsonb("old_data").$type<unknown>(),
    newData: jsonb("new_data").$type<unknown>(),
    reason: text("reason"),
    confidence: real("confidence").notNull().default(0),
    requiresConfirmation: boolean("requires_confirmation")
      .notNull()
      .default(false),
    /** auto | pending | confirmed | rejected */
    reviewStatus: varchar("review_status", { length: 20 })
      .notNull()
      .default("auto"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("ix_requirement_changes_run").on(table.runId, table.changeType),
    index("ix_requirement_changes_key").on(
      table.runId,
      table.entityType,
      table.matchKey,
    ),
  ],
);

/**
 * Where each baseline case goes in an incremental run:
 * created / updated / reused / pending_delete / missing, plus regression
 * recommendations. The dedupe key makes repeated generation idempotent.
 */
export const requirementCaseChanges = pgTable(
  "requirement_case_changes",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    runId: varchar("run_id", { length: 36 }).notNull(),
    projectId: varchar("project_id", { length: 36 }).notNull(),
    requirementId: varchar("requirement_id", { length: 36 }).notNull(),
    baselineRequirementId: varchar("baseline_requirement_id", {
      length: 36,
    }).notNull(),
    changeId: varchar("change_id", { length: 36 }),
    /** Phase-2 target case; null for `missing`. */
    testCaseId: varchar("test_case_id", { length: 20 }),
    /** Phase-1 historical case (updated/reused/pending_delete/regression). */
    baselineCaseId: varchar("baseline_case_id", { length: 20 }),
    /** created | updated | reused | pending_delete | missing */
    action: varchar("action", { length: 20 }).notNull(),
    /** direct | indirect | none */
    regressionImpact: varchar("regression_impact", { length: 20 })
      .notNull()
      .default("none"),
    regressionReason: text("regression_reason"),
    /** suggested | accepted | rejected */
    regressionStatus: varchar("regression_status", { length: 20 })
      .notNull()
      .default("suggested"),
    confidence: real("confidence").notNull().default(0),
    /** Cross-run idempotency key: reuse:{caseId} / update:{caseId}:{sig} / gen:{endpoint}:{sig}. */
    dedupeKey: varchar("dedupe_key", { length: 255 }).notNull(),
    /** pending | auto | confirmed | rejected */
    reviewStatus: varchar("review_status", { length: 20 })
      .notNull()
      .default("auto"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("ix_requirement_case_changes_run").on(table.runId, table.action),
    index("ix_requirement_case_changes_target").on(
      table.requirementId,
      table.dedupeKey,
    ),
    index("ix_requirement_case_changes_baseline").on(table.baselineCaseId),
    uniqueIndex("uq_requirement_case_changes_dedupe").on(
      table.runId,
      table.dedupeKey,
    ),
  ],
);

export type ExecutionStatusColumn = ExecutionStatusCode;
export type LlmKindColumn = LlmKind;
