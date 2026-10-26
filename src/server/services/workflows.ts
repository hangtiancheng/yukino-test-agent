/**
 * Multi-agent test workflow orchestrator (the pipeline).
 *
 * Closed loop:
 *   requirement version -> test points (agent 1) -> cases (agent 2)
 *   -> independent review/revision (agent 3)
 *   -> execution of approved automatable cases (Playwright engine)
 *   -> evidence-driven result analysis (agent 4) -> summary report.
 *
 * Design principles:
 * - The pipeline only adds run/stage/review/analysis records; it never
 *   replaces existing tables or APIs.
 * - Every stage is persisted. When a stage fails, prior artifacts are kept
 *   and later stages are marked skipped — data is never silently dropped.
 * - Review revises at most `maxRevisions` rounds; a case that still fails is
 *   rejected and never executed.
 * - Result analysis writes only its own table and never overwrites
 *   execution_records.status.
 */
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { db } from "#/db";
import type { requirements } from "#/db/schema";
import {
  codeAnalyses,
  executionRecords,
  executionSteps,
  requirementCases,
  testCases,
  testPoints,
  workflowCaseReviews,
  workflowCases,
  workflowResultAnalyses,
  workflowRuns,
  workflowStages,
} from "#/db/schema";
import {
  EXECUTION_RECORD_STATUS_META,
  FAILURE_CATEGORY_META,
  STAGE_LABELS,
  WORKFLOW_STATUS_META,
  meta,
} from "#/lib/enums";
import { resolveCoverageRefs } from "#/server/lib/coverage";
import { normalizeCaseCounts } from "#/server/lib/generation/count-assertion";
import {
  caseRepairPrompt,
  caseReviewWorkflowPrompt,
  resultAnalysisPrompt,
} from "#/server/lib/generation/prompts";
import {
  caseHasCompoundExpected,
  caseHasMultipleInputs,
  quotedAnchors,
  scoreCase,
} from "#/server/lib/generation/quality-gate";
import { createJob, runJob } from "#/server/lib/jobs";
import { LlmUnavailableError } from "#/server/lib/llm";
import { asTextList } from "#/server/lib/text-list";
import { getLatestAnalysis, runAnalysis } from "#/server/services/analysis";
import { runCaseExecution, getExecution } from "#/server/services/executions";
import { generateCases } from "#/server/services/generation";
import {
  getGenerationContext,
  getProjectOr404,
  uuid,
} from "#/server/services/projects";
import {
  getRequirementOr404,
  parsePoints,
  savePoints,
} from "#/server/services/requirements";
import { BizError, getTextClient } from "#/server/services/settings";
import {
  caseToDict,
  casesForRequirement,
  getCaseOr404,
  updateCase,
} from "#/server/services/testcases";

import type { LlmClient } from "#/server/lib/llm";
import type { GenerationResult } from "#/server/services/generation";
import type {
  CaseDict,
  CaseUpdateInput,
  TestCaseRow,
} from "#/server/services/testcases";
import type {
  BackendResult,
  FailureCategory,
  FrontendResult,
  Page,
  StateMachineSpec,
  StructuredStep,
} from "#/lib/types";

// ---------- Constants & row types ----------

export const STAGES = [
  "code_analysis",
  "test_points",
  "case_generation",
  "case_review",
  "execution",
  "result_analysis",
  "report",
] as const;

export type StageName = (typeof STAGES)[number];

type RunRow = typeof workflowRuns.$inferSelect;
type StageRow = typeof workflowStages.$inferSelect;
type WorkflowCaseRow = typeof workflowCases.$inferSelect;
type ReviewRow = typeof workflowCaseReviews.$inferSelect;
type AnalysisRow = typeof workflowResultAnalyses.$inferSelect;
type TestPointRow = typeof testPoints.$inferSelect;
type RequirementRow = typeof requirements.$inferSelect;

export interface ReviewIssueDict {
  severity: string;
  field: string;
  problem: string;
  suggestion?: string;
  evidence?: string;
}

export interface WorkflowConfig {
  requirementId: string;
  mode: "auto" | "rule" | "llm";
  autoExecute: boolean;
  maxRevisions: number;
  maxCases: number;
  reuseExistingCases: boolean;
  reanalyzePoints: boolean;
  targetUrl: string | null;
  testPointLlmProfileId: string | null;
  caseLlmProfileId: string | null;
  analyzeCode: boolean;
  reanalyzeCode: boolean;
  reviewEnabled: boolean;
  analyzeEnabled: boolean;
}

export interface WorkflowCreateInput {
  requirementId: string;
  mode?: "auto" | "rule" | "llm";
  autoExecute?: boolean;
  maxRevisions?: number;
  maxCases?: number;
  reuseExistingCases?: boolean;
  reanalyzePoints?: boolean;
  targetUrl?: string | null;
  testPointLlmProfileId?: string | null;
  caseLlmProfileId?: string | null;
  analyzeCode?: boolean;
  reanalyzeCode?: boolean;
  reviewEnabled?: boolean;
  analyzeEnabled?: boolean;
}

interface StageResult {
  status: "completed" | "failed" | "skipped";
  [key: string]: unknown;
}

type StageHandler = (
  run: RunRow,
  config: WorkflowConfig,
) => Promise<StageResult>;

// ---------- Dict shapes ----------

export interface StageDict {
  id: string;
  stage: string;
  label: string;
  status: string;
  attempt: number;
  inputSummary: string | null;
  outputSummary: string | null;
  payload: Record<string, unknown>;
  errorMessage: string | null;
  model: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number;
}

export interface RunDict {
  id: string;
  projectId: string;
  requirementId: string | null;
  requirementVersion: string | null;
  requirementName: string | null;
  status: string;
  statusLabel: string;
  currentStage: string | null;
  currentStageLabel: string | null;
  mode: string;
  config: Record<string, unknown>;
  summary: Record<string, unknown>;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
  reportUrl: string;
}

export interface WorkflowReviewDict {
  id: string;
  round: number;
  reviewStatus: string;
  qualityScore: number;
  issues: ReviewIssueDict[];
  missingCoverage: unknown[];
  suggestions: string[];
  deterministicIssues: string[];
  source: string;
  model: string | null;
  createdAt: string | null;
}

export interface AnalysisDict {
  id: string;
  executionId: string;
  caseId: string;
  executionStatus: string;
  failureCategory: string;
  failureCategoryLabel: string;
  failureReason: string | null;
  evidence: string[];
  confidence: number;
  recommendedAction: string | null;
  needsHumanReview: boolean;
  source: string;
  model: string | null;
  createdAt: string | null;
}

export interface WorkflowCaseDict {
  id: string;
  caseId: string;
  title: string;
  type: string;
  priority: string;
  source: string;
  position: number;
  testPointId: string | null;
  automationStatus: string;
  reviewStatus: string;
  revisionCount: number;
  qualityScore: number;
  firstReview: WorkflowReviewDict | null;
  finalReview: WorkflowReviewDict | null;
  reviews: WorkflowReviewDict[];
  execution: {
    id: string;
    status: string;
    statusLabel: string;
    errorCategory: string | null;
    errorMessage: string | null;
    durationMs: number;
    startedAt: string | null;
  } | null;
  analysis: AnalysisDict | null;
}

export interface RunDetailDict extends RunDict {
  stages: StageDict[];
  cases: WorkflowCaseDict[];
}

// ---------- Small helpers ----------

function counts(values: (string | null | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) {
    const key = value || "unknown";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function compact(value: unknown, limit: number): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function elapsedMs(start: Date | null): number {
  if (!start) return 0;
  return Math.max(0, Date.now() - start.getTime());
}

function requireRequirementId(run: RunRow): string {
  if (!run.requirementId) {
    throw new BizError(40406, "Workflow run has no requirement version");
  }
  return run.requirementId;
}

async function getRunRow(runId: string): Promise<RunRow | null> {
  const rows = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId));
  return rows[0] ?? null;
}

async function getCaseRowOrNull(cid: string): Promise<TestCaseRow | null> {
  const rows = await db.select().from(testCases).where(eq(testCases.id, cid));
  return (rows[0] as TestCaseRow | undefined) ?? null;
}

// ---------- Serialization ----------

function stageToDict(row: StageRow): StageDict {
  return {
    id: row.id,
    stage: row.stage,
    label: STAGE_LABELS[row.stage] ?? row.stage,
    status: row.status,
    attempt: row.attempt,
    inputSummary: row.inputSummary,
    outputSummary: row.outputSummary,
    payload: row.payload ?? {},
    errorMessage: row.errorMessage,
    model: row.model,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
  };
}

function runToDict(row: RunRow): RunDict {
  const statusMeta = meta(WORKFLOW_STATUS_META, row.status);
  return {
    id: row.id,
    projectId: row.projectId,
    requirementId: row.requirementId,
    requirementVersion: row.requirementVersion,
    requirementName: row.requirementName,
    status: row.status,
    statusLabel: statusMeta.label,
    currentStage: row.currentStage,
    currentStageLabel: row.currentStage
      ? (STAGE_LABELS[row.currentStage] ?? row.currentStage)
      : null,
    mode: row.mode,
    config: row.config ?? {},
    summary: row.summary ?? {},
    errorMessage: row.errorMessage,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt?.toISOString() ?? null,
    reportUrl: `/api/report/project/${row.projectId}?workflowRunId=${row.id}`,
  };
}

function reviewToDict(row: ReviewRow): WorkflowReviewDict {
  return {
    id: row.id,
    round: row.round,
    reviewStatus: row.reviewStatus,
    qualityScore: row.qualityScore,
    issues: row.issues ?? [],
    missingCoverage: row.missingCoverage ?? [],
    suggestions: row.suggestions ?? [],
    deterministicIssues: row.deterministicIssues ?? [],
    source: row.source,
    model: row.model,
    createdAt: row.createdAt?.toISOString() ?? null,
  };
}

function analysisToDict(row: AnalysisRow): AnalysisDict {
  return {
    id: row.id,
    executionId: row.executionId,
    caseId: row.caseId,
    executionStatus: row.executionStatus,
    failureCategory: row.failureCategory,
    failureCategoryLabel: meta(FAILURE_CATEGORY_META, row.failureCategory)
      .label,
    failureReason: row.failureReason,
    evidence: row.evidence ?? [],
    confidence: row.confidence,
    recommendedAction: row.recommendedAction,
    needsHumanReview: row.needsHumanReview,
    source: row.source,
    model: row.model,
    createdAt: row.createdAt?.toISOString() ?? null,
  };
}

// ---------- Stage lifecycle ----------

async function beginStage(
  runId: string,
  stageName: StageName,
  inputSummary: string,
): Promise<StageRow> {
  let rows = await db
    .select()
    .from(workflowStages)
    .where(
      and(eq(workflowStages.runId, runId), eq(workflowStages.stage, stageName)),
    );
  let row = rows[0];
  if (!row) {
    await db.insert(workflowStages).values({
      id: uuid(),
      runId,
      stage: stageName,
      status: "pending",
      attempt: 1,
    });
    rows = await db
      .select()
      .from(workflowStages)
      .where(
        and(
          eq(workflowStages.runId, runId),
          eq(workflowStages.stage, stageName),
        ),
      );
    row = rows[0]!;
  }
  const attempt = row.status === "running" ? row.attempt + 1 : row.attempt;
  await db
    .update(workflowStages)
    .set({
      status: "running",
      attempt,
      inputSummary: inputSummary.slice(0, 2000),
      outputSummary: null,
      payload: null,
      errorMessage: null,
      model: null,
      startedAt: new Date(),
      finishedAt: null,
      durationMs: 0,
    })
    .where(eq(workflowStages.id, row.id));
  await db
    .update(workflowRuns)
    .set({ currentStage: stageName })
    .where(eq(workflowRuns.id, runId));
  const fresh = await db
    .select()
    .from(workflowStages)
    .where(eq(workflowStages.id, row.id));
  return fresh[0];
}

async function endStage(
  stage: StageRow,
  status: string,
  outputSummary: string,
  payload?: Record<string, unknown> | null,
  error?: string | null,
  model?: string | null,
): Promise<void> {
  await db
    .update(workflowStages)
    .set({
      status,
      outputSummary: (outputSummary || "").slice(0, 2000),
      payload: payload ?? null,
      errorMessage: (error || "").slice(0, 4000) || null,
      model: (model || "").slice(0, 100) || null,
      finishedAt: new Date(),
      durationMs: elapsedMs(stage.startedAt),
    })
    .where(eq(workflowStages.id, stage.id));
}

async function markRemainingSkipped(
  runId: string,
  reason: string,
): Promise<void> {
  const stages = await db
    .select()
    .from(workflowStages)
    .where(
      and(
        eq(workflowStages.runId, runId),
        inArray(workflowStages.status, ["pending", "running"]),
      ),
    )
    .orderBy(asc(workflowStages.createdAt));
  for (const stage of stages) {
    await db
      .update(workflowStages)
      .set({
        status: "skipped",
        outputSummary: reason.slice(0, 2000),
        finishedAt: new Date(),
        durationMs: elapsedMs(stage.startedAt),
      })
      .where(eq(workflowStages.id, stage.id));
  }
}

async function persistStageFailure(
  runId: string,
  stageName: StageName | null,
  error: string,
): Promise<void> {
  try {
    const stages = stageName
      ? await db
          .select()
          .from(workflowStages)
          .where(
            and(
              eq(workflowStages.runId, runId),
              eq(workflowStages.stage, stageName),
            ),
          )
      : await db
          .select()
          .from(workflowStages)
          .where(
            and(
              eq(workflowStages.runId, runId),
              eq(workflowStages.status, "running"),
            ),
          );
    const stage = stages[0];
    if (stage && stage.status === "running") {
      await db
        .update(workflowStages)
        .set({
          status: "failed",
          errorMessage: error.slice(0, 4000),
          finishedAt: new Date(),
          durationMs: elapsedMs(stage.startedAt),
        })
        .where(eq(workflowStages.id, stage.id));
    }
    await db
      .update(workflowRuns)
      .set({
        errorMessage: (error || "Workflow execution failed").slice(0, 4000),
      })
      .where(eq(workflowRuns.id, runId));
  } catch {
    // best-effort persistence
  }
}

async function hasCompletedWork(runId: string): Promise<boolean> {
  const stages = await db
    .select({ stage: workflowStages.stage })
    .from(workflowStages)
    .where(
      and(
        eq(workflowStages.runId, runId),
        eq(workflowStages.status, "completed"),
      ),
    );
  return stages.some((s) => s.stage !== "report");
}

// ---------- Orchestration ----------

export async function createRun(
  pid: string,
  input: WorkflowCreateInput,
): Promise<{ run: RunDict; jobId: string }> {
  await getProjectOr404(pid);
  const req = await getRequirementOr404(input.requirementId);
  if (req.projectId !== pid) {
    throw new BizError(
      40406,
      `Requirement version not found: ${input.requirementId}`,
    );
  }
  if (!(req.content || "").trim()) {
    throw new BizError(
      40014,
      "Requirement content is empty; fill it in or upload a document first",
    );
  }
  const config: WorkflowConfig = {
    requirementId: req.id,
    mode: input.mode ?? "auto",
    autoExecute: input.autoExecute ?? true,
    maxRevisions: Math.max(0, Math.min(2, Math.trunc(input.maxRevisions ?? 2))),
    maxCases: Math.max(1, Math.min(100, Math.trunc(input.maxCases ?? 20))),
    reuseExistingCases: input.reuseExistingCases ?? true,
    reanalyzePoints: input.reanalyzePoints ?? false,
    targetUrl: input.targetUrl || null,
    testPointLlmProfileId: input.testPointLlmProfileId || null,
    caseLlmProfileId: input.caseLlmProfileId || null,
    analyzeCode: input.analyzeCode ?? true,
    reanalyzeCode: input.reanalyzeCode ?? false,
    reviewEnabled: input.reviewEnabled ?? true,
    analyzeEnabled: input.analyzeEnabled ?? true,
  };
  const runId = uuid();
  await db.insert(workflowRuns).values({
    id: runId,
    projectId: pid,
    requirementId: req.id,
    requirementVersion: req.version,
    requirementName: req.name,
    status: "pending",
    currentStage: "test_points",
    mode: config.mode,
    config: config as unknown as Record<string, unknown>,
  });
  await db.insert(workflowStages).values(
    STAGES.map((stage) => ({
      id: uuid(),
      runId,
      stage,
      status: "pending",
      attempt: 1,
    })),
  );
  const job = createJob("workflow", STAGES.length);
  runJob(job.id, async (report) => {
    await runWorkflow(runId, report);
    return { runId };
  });
  const run = await getRunRow(runId);
  return { run: runToDict(run!), jobId: job.id };
}

async function runWorkflow(
  runId: string,
  report: (
    message: string,
    current?: number,
    total?: number,
  ) => void = () => {},
): Promise<void> {
  const initial = await getRunRow(runId);
  if (!initial) return;
  const config = (initial.config ?? {}) as unknown as WorkflowConfig;
  await db
    .update(workflowRuns)
    .set({ status: "running", startedAt: new Date(), errorMessage: null })
    .where(eq(workflowRuns.id, runId));

  const handlers: [StageName, StageHandler][] = [
    ["code_analysis", stageCodeAnalysis],
    ["test_points", stageTestPoints],
    ["case_generation", stageCaseGeneration],
    ["case_review", stageCaseReview],
    ["execution", stageExecution],
    ["result_analysis", stageResultAnalysis],
  ];
  let hardFailure = false;
  let hadFailure = false;
  let index = 0;
  for (const [stageName, handler] of handlers) {
    index += 1;
    if (hardFailure) continue;
    report(`${STAGE_LABELS[stageName]}…`, index, STAGES.length);
    try {
      const fresh = await getRunRow(runId);
      if (!fresh) return;
      const result = await handler(fresh, config);
      if (result.status === "failed") {
        hadFailure = true;
        if (
          stageName === "code_analysis" ||
          stageName === "test_points" ||
          stageName === "case_generation"
        ) {
          hardFailure = true;
        }
      } else if (result.partial) {
        // A stage that completed with partial failures still degrades the run.
        hadFailure = true;
      }
    } catch (error) {
      const message = `${STAGE_LABELS[stageName]} failed: ${error instanceof Error ? error.message : String(error)}`;
      await persistStageFailure(runId, stageName, message);
      hardFailure = true;
      hadFailure = true;
    }
  }

  if (hardFailure) {
    await markRemainingSkipped(
      runId,
      "Skipped because an earlier stage failed",
    );
  }

  // Always produce a report so even failures leave a readable artifact.
  report(`${STAGE_LABELS.report}…`, STAGES.length, STAGES.length);
  try {
    const fresh = await getRunRow(runId);
    if (fresh) await stageReport(fresh, config);
  } catch (error) {
    await persistStageFailure(
      runId,
      "report",
      `Report generation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    hadFailure = true;
  }

  const finalRun = await getRunRow(runId);
  if (!finalRun) return;
  const summary = await buildSummary(finalRun);
  let status: string;
  if (hadFailure || hardFailure) {
    status =
      !hardFailure || (await hasCompletedWork(runId)) ? "partial" : "failed";
  } else {
    status = "completed";
  }
  await db
    .update(workflowRuns)
    .set({
      status,
      currentStage: null,
      finishedAt: new Date(),
      summary: summary,
    })
    .where(eq(workflowRuns.id, runId));
}

// ---------- Stage 0: code analysis ----------

async function waitForAnalysisRow(
  analysisId: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db
      .select({ status: codeAnalyses.status })
      .from(codeAnalyses)
      .where(eq(codeAnalyses.id, analysisId));
    const row = rows[0];
    if (!row || row.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function analysisPayload(pid: string): Promise<Record<string, unknown>> {
  const latest = await getLatestAnalysis(pid);
  return {
    analysisId: latest?.id ?? null,
    status: latest?.status ?? "none",
    endpoints: latest?.backendResult?.endpoints?.length ?? 0,
    pages: latest?.frontendResult?.pages?.length ?? 0,
    selectors: latest?.frontendResult?.selectors?.length ?? 0,
    stateMachines: latest?.stateMachines?.length ?? 0,
    uiTexts:
      (latest?.frontendResult?.uiTexts?.length ?? 0) +
      (latest?.backendResult?.uiTexts?.length ?? 0),
    warnings: latest?.warnings ?? [],
    errorMessage: latest?.errorMessage ?? null,
  };
}

async function stageCodeAnalysis(
  run: RunRow,
  config: WorkflowConfig,
): Promise<StageResult> {
  const project = await getProjectOr404(run.projectId);
  const stage = await beginStage(
    run.id,
    "code_analysis",
    "Static source analysis providing page/field/endpoint facts for points and cases",
  );
  if (!config.analyzeCode) {
    await endStage(stage, "skipped", "Automatic code analysis is disabled", {
      analyzeCode: false,
    });
    return { status: "skipped" };
  }
  let latest = await getLatestAnalysis(run.projectId);
  if (latest && latest.status === "running") {
    await waitForAnalysisRow(latest.id);
    latest = await getLatestAnalysis(run.projectId);
  }
  if (latest && latest.status === "success" && !config.reanalyzeCode) {
    const payload = await analysisPayload(run.projectId);
    await endStage(
      stage,
      "skipped",
      `Reusing existing analysis: ${payload.endpoints} endpoints / ${payload.pages} pages`,
      payload,
    );
    return { status: "skipped", ...payload };
  }
  if (project.sourceType !== "local_path" || !project.sourcePath) {
    const payload = {
      errorMessage: "Only local_path projects can be analyzed",
    };
    await endStage(
      stage,
      "failed",
      "Code analysis did not run",
      payload,
      "Only local_path projects are supported; set sourcePath in project settings first",
    );
    return { status: "failed", ...payload };
  }
  const analysisId = uuid();
  await db.insert(codeAnalyses).values({
    id: analysisId,
    projectId: run.projectId,
    status: "running",
  });
  await runAnalysis(run.projectId, analysisId, () => {});
  const payload = await analysisPayload(run.projectId);
  payload.analysisId = analysisId;
  const fresh = await getLatestAnalysis(run.projectId);
  if (!fresh || fresh.status !== "success") {
    const error = fresh?.errorMessage || "Code analysis did not complete";
    await endStage(stage, "failed", "Code analysis failed", payload, error);
    return { status: "failed", ...payload };
  }
  await endStage(
    stage,
    "completed",
    `Code analysis complete: ${payload.endpoints} endpoints / ${payload.pages} pages / ${payload.stateMachines} state machines`,
    payload,
  );
  return { status: "completed", ...payload };
}

// ---------- Stage 1: test points ----------

async function stageTestPoints(
  run: RunRow,
  config: WorkflowConfig,
): Promise<StageResult> {
  const req = await getRequirementOr404(requireRequirementId(run));
  const existing = await db
    .select({ id: testPoints.id })
    .from(testPoints)
    .where(eq(testPoints.requirementId, req.id));
  const stage = await beginStage(
    run.id,
    "test_points",
    `Requirement ${req.version} ${req.name}; ${existing.length} existing points; mode ${config.mode}`,
  );
  if (existing.length > 0 && !config.reanalyzePoints) {
    const summary = { testPointCount: existing.length, reused: true };
    await endStage(
      stage,
      "skipped",
      `Reusing ${existing.length} existing test points`,
      summary,
    );
    return { status: "skipped", ...summary };
  }
  const points = await parsePoints(
    req,
    config.mode,
    config.testPointLlmProfileId,
  );
  if (points.length === 0) {
    await endStage(
      stage,
      "failed",
      "No test points parsed",
      { testPointCount: 0 },
      "The requirement document yields no executable test points",
    );
    return { status: "failed", testPointCount: 0 };
  }
  await savePoints(req, points);
  const byCategory: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const point of points) {
    const category = String(point.category);
    const source = String(point.source || "rule");
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    bySource[source] = (bySource[source] ?? 0) + 1;
  }
  const payload = {
    testPointCount: points.length,
    reused: false,
    byCategory,
    bySource,
  };
  await endStage(
    stage,
    "completed",
    `Generated ${points.length} test points`,
    payload,
  );
  return { status: "completed", ...payload };
}

// ---------- Stage 2: case generation ----------

function automationStatusOf(row: TestCaseRow): string {
  if (row.source === "manual" || row.source === "import") return "manual";
  const steps = row.structuredSteps ?? [];
  return steps.length > 0 ? "automated" : "blocked";
}

async function stageCaseGeneration(
  run: RunRow,
  config: WorkflowConfig,
): Promise<StageResult> {
  const req = await getRequirementOr404(requireRequirementId(run));
  const existing = await casesForRequirement(req.id);
  const maxCases = config.maxCases;
  const stage = await beginStage(
    run.id,
    "case_generation",
    `Mode ${config.mode}; ${existing.length} existing cases; cap ${maxCases}`,
  );
  const reused = config.reuseExistingCases && !config.reanalyzePoints;
  const payload: Record<string, unknown> = { reused, maxCases };
  let pairs: { row: TestCaseRow; mapping: { testPointId: string | null } }[];
  let generation: GenerationResult | null = null;
  if (reused && existing.length > 0) {
    pairs = existing.slice(0, maxCases);
    payload.caseCount = pairs.length;
    payload.generation = null;
  } else {
    generation = await generateCases(run.projectId, {
      mode: config.mode,
      requirementId: req.id,
      profileId: config.caseLlmProfileId,
    });
    pairs = (await casesForRequirement(req.id)).slice(0, maxCases);
    payload.caseCount = pairs.length;
    payload.generation = generation;
    payload.dropped = generation.dropped;
    payload.dropReasons = generation.dropReasons;
    if (pairs.length === 0) {
      payload.byAutomation = {};
      await endStage(
        stage,
        "failed",
        "No usable cases generated",
        payload,
        "Quality gate rejected everything, or neither LLM nor rules produced cases",
      );
      return { status: "failed", ...payload };
    }
  }
  const existingWcs = await db
    .select()
    .from(workflowCases)
    .where(eq(workflowCases.runId, run.id));
  const wcByCase = new Map(existingWcs.map((wc) => [wc.caseId, wc]));
  let position = 0;
  for (const { row, mapping } of pairs) {
    position += 1;
    const automation = automationStatusOf(row);
    const wc = wcByCase.get(row.id);
    if (!wc) {
      await db.insert(workflowCases).values({
        id: uuid(),
        runId: run.id,
        caseId: row.id,
        testPointId: mapping.testPointId,
        position,
        automationStatus: automation,
        reviewStatus: "pending",
        qualityScore: row.qualityScore || 0,
      });
    } else {
      await db
        .update(workflowCases)
        .set({
          position,
          testPointId: mapping.testPointId,
          automationStatus: automation,
        })
        .where(eq(workflowCases.id, wc.id));
    }
  }
  const allWcs = await db
    .select()
    .from(workflowCases)
    .where(eq(workflowCases.runId, run.id));
  payload.byAutomation = counts(allWcs.map((wc) => wc.automationStatus));
  const status = reused && existing.length > 0 ? "skipped" : "completed";
  if (status === "skipped") {
    await endStage(
      stage,
      status,
      `Reusing ${pairs.length} existing cases`,
      payload,
    );
  } else {
    await endStage(
      stage,
      status,
      `Generated and kept ${pairs.length} cases (dropped ${String(payload.dropped ?? 0)})`,
      payload,
    );
  }
  void generation;
  return { status, ...payload };
}

// ---------- Source facts & deterministic validation ----------

export interface SourceFactsResult {
  facts: Record<string, unknown>;
  backend: BackendResult;
  frontend: FrontendResult;
  machines: StateMachineSpec[];
}

export async function sourceFacts(
  pid: string,
  requirement: RequirementRow | null,
  point: TestPointRow | null,
): Promise<SourceFactsResult> {
  const ctx = await getGenerationContext(pid);
  const machines = ctx.machines as unknown as StateMachineSpec[];
  const facts: Record<string, unknown> = {
    requirement: {
      version: requirement?.version ?? "",
      name: requirement?.name ?? "",
      excerpt: (requirement?.content || "").slice(0, 12000),
    },
    testPoint: point
      ? {
          id: point.id,
          title: point.title,
          category: point.category,
          priority: point.priority,
          description: point.description || "",
          pageRoute: point.pageRoute || "",
          endpoint: point.endpoint || "",
          fields: point.fields ?? [],
          expected: point.expected || "",
        }
      : {},
    pages: ctx.frontend.pages,
    selectors: ctx.frontend.selectors,
    uiTexts: ctx.frontend.uiTexts,
    endpoints: ctx.backend.endpoints,
    entities: ctx.backend.entities,
    businessRules: ctx.backend.businessRules,
    enums: ctx.backend.enums,
    stateMachines: machines,
  };
  return { facts, backend: ctx.backend, frontend: ctx.frontend, machines };
}

function countCaptureGroups(pattern: string): number {
  let count = 0;
  let escaped = false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "[") {
      inClass = !inClass;
      continue;
    }
    if (inClass) continue;
    if (ch === "(") {
      const rest = pattern.slice(i + 1);
      const nonCapturing =
        rest.startsWith("?:") ||
        rest.startsWith("?=") ||
        rest.startsWith("?!") ||
        rest.startsWith("?<=") ||
        rest.startsWith("?<!");
      if (!nonCapturing) count += 1;
    }
  }
  return count;
}

function validateCase(
  caseDict: CaseDict,
  frontend: FrontendResult,
  requirementText: string,
  point: TestPointRow | null,
): string[] {
  const errors: string[] = [];
  const steps = caseDict.structuredSteps || [];
  if (steps.length === 0) return ["Structured steps cannot be empty"];

  const first = steps[0];
  const firstSelector = first.uiSelector ?? { type: "", value: "" };
  if (first.type !== "ui_action" || firstSelector.type !== "route") {
    errors.push("The first step must be ui_action + route");
  }

  const pageRoutes = new Set(
    (frontend.pages || [])
      .map((p) => String(p.route || "").trim())
      .filter(Boolean),
  );
  const placeholders = new Set<string>();
  const labels = new Set<string>();
  const fieldKeys = new Set<string>();
  for (const page of frontend.pages || []) {
    for (const form of page.forms || []) {
      for (const field of form.fields || []) {
        if (field.placeholder)
          placeholders.add(String(field.placeholder).trim());
        if (field.label) labels.add(String(field.label).trim());
        if (field.prop) fieldKeys.add(String(field.prop).trim());
        if (field.label) fieldKeys.add(String(field.label).trim());
      }
    }
  }
  const selectorValues = new Set(
    (frontend.selectors || [])
      .map((s) => String(s.value || "").trim())
      .filter(Boolean),
  );
  const uiTexts = (frontend.uiTexts || []).map((t) => String(t));
  const pointText = point
    ? [point.title, point.description || "", point.expected || ""].join(" ")
    : "";
  const textCorpus = [
    ...uiTexts,
    requirementText,
    pointText,
    ...selectorValues,
  ].join("\n");

  if (
    firstSelector.type === "route" &&
    firstSelector.value &&
    !pageRoutes.has(firstSelector.value)
  ) {
    errors.push(`Start route does not exist: ${firstSelector.value}`);
  }

  const anchors: string[] = [];
  steps.forEach((step, idx) => {
    const i = idx + 1;
    const selector = step.uiSelector ?? { type: "", value: "" };
    const selectorType = String(selector.type);
    const selectorValue = String(selector.value || "").trim();
    if (
      !["ui_action", "input", "state_assert", "capture"].includes(
        String(step.type),
      )
    ) {
      errors.push(`Step ${i} has invalid type: ${step.type}`);
      return;
    }
    if (
      (step.type === "ui_action" || step.type === "input") &&
      !selectorValue
    ) {
      errors.push(`Step ${i} is missing uiSelector.value`);
    }
    if (step.type === "input" && !String(step.inputValue || "").trim()) {
      errors.push(`Step ${i} is missing inputValue`);
    }
    if (step.type === "capture") {
      const variable = String(step.variable || "").trim();
      const pattern = String(step.pattern || "").trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
        errors.push(`Step ${i} capture is missing a valid variable`);
      }
      if (!pattern) {
        errors.push(`Step ${i} capture is missing pattern`);
      } else {
        try {
          new RegExp(pattern);
          if (countCaptureGroups(pattern) < 1) {
            errors.push(
              `Step ${i} capture pattern must contain a capture group`,
            );
          }
        } catch (error) {
          errors.push(
            `Step ${i} capture pattern is invalid: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    if (step.type === "state_assert") {
      const expected = String(step.expected || "").trim();
      if (!expected) errors.push(`Step ${i} is missing assertion expected`);
      anchors.push(...quotedAnchors(expected));
    }
    if (step.type !== "state_assert" && step.type !== "capture") {
      if (
        selectorType === "route" &&
        selectorValue &&
        !pageRoutes.has(selectorValue)
      ) {
        errors.push(`Step ${i} route does not exist: ${selectorValue}`);
      }
      if (selectorType === "placeholder" && !placeholders.has(selectorValue)) {
        errors.push(
          `Step ${i} placeholder is not in the source facts: ${selectorValue}`,
        );
      }
      if (selectorType === "label" && !labels.has(selectorValue)) {
        errors.push(
          `Step ${i} label is not in the source facts: ${selectorValue}`,
        );
      }
      if (
        selectorType === "text" &&
        selectorValue &&
        !textCorpus.includes(selectorValue)
      ) {
        errors.push(
          `Step ${i} button copy is not in the source/requirement facts: ${selectorValue}`,
        );
      }
      if (
        ["role", "testid", "css", "xpath"].includes(selectorType) &&
        !selectorValues.has(selectorValue)
      ) {
        errors.push(
          `Step ${i} selector is not in the source facts: ${selectorValue}`,
        );
      }
    }
  });

  const stepAnchors: string[] = [];
  steps.forEach((step, idx) => {
    if (step.type !== "state_assert") return;
    const i = idx + 1;
    const anchorsForStep = quotedAnchors(String(step.expected || ""));
    if (anchorsForStep.length === 0) {
      errors.push(`Step ${i} is missing a quoted copy anchor`);
    }
    stepAnchors.push(...anchorsForStep);
  });
  if (anchors.length === 0) errors.push("No observable quoted copy anchors");
  for (const anchor of stepAnchors.length > 0 ? stepAnchors : anchors) {
    if (anchor.includes("${")) continue;
    if (!textCorpus.includes(anchor)) {
      errors.push(
        `Assertion anchor is not in the source/requirement facts: ${anchor}`,
      );
    }
  }

  // Runtime variables must be defined by an earlier capture step; otherwise
  // the failure would only surface at execution time.
  const availableVars = new Set<string>();
  steps.forEach((step, idx) => {
    const i = idx + 1;
    if (step.type === "capture") {
      const variable = String(step.variable || "").trim();
      if (variable && /^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
        if (availableVars.has(variable)) {
          errors.push(`Step ${i} redefines variable: ${variable}`);
        }
        availableVars.add(variable);
      }
      return;
    }
    for (const field of ["expected", "inputValue"] as const) {
      const raw = String(step[field] || "");
      const varRe = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:[+-]\d+)?\}/g;
      let match: RegExpExecArray | null;
      while ((match = varRe.exec(raw)) !== null) {
        if (!availableVars.has(match[1])) {
          errors.push(`Step ${i} uses an uncaptured variable: ${match[1]}`);
        }
      }
    }
  });

  const testData = caseDict.testData || {};
  for (const key of Object.keys(testData)) {
    const normalizedKey = String(key).trim();
    if (
      normalizedKey &&
      !fieldKeys.has(normalizedKey) &&
      !textCorpus.includes(normalizedKey)
    ) {
      errors.push(
        `testData field is not in the source/requirement facts: ${normalizedKey}`,
      );
    }
  }
  return errors;
}

function missingRequiredFields(
  caseDict: CaseDict,
  facts: Record<string, unknown>,
): string[] {
  // State cases drive the list page (Pay/Ship/Cancel buttons); they never
  // submit the create form, so required form fields do not apply.
  if (String(caseDict.type || "") === "state") return [];
  const steps = caseDict.structuredSteps || [];
  const corpusParts: string[] = [];
  for (const step of steps) {
    if (step.type !== "input") continue;
    const selector = step.uiSelector?.value || "";
    corpusParts.push(`${selector} ${step.target || ""} ${step.action || ""}`);
  }
  const corpus = corpusParts.join(" ");
  // Negative cases deliberately leave the tested field empty; its label or
  // prop is named by the title/expectation ("Receiver name cannot be empty").
  const isNegative = String(caseDict.type || "") === "negative";
  const intentText = isNegative
    ? `${caseDict.title || ""} ${(caseDict.expectedResults || []).join(" ")}`.toLowerCase()
    : "";
  const missing: string[] = [];
  const pages = (facts.pages || []) as Page[];
  for (const page of pages) {
    for (const form of page.forms || []) {
      for (const field of form.fields || []) {
        if (!field.required) continue;
        const tokens = [field.placeholder, field.label, field.prop];
        if (
          isNegative &&
          tokens.some((t) => t && intentText.includes(String(t).toLowerCase()))
        ) {
          continue;
        }
        if (!tokens.some((t) => t && corpus.includes(String(t)))) {
          missing.push(
            String(
              field.label ||
                field.prop ||
                field.placeholder ||
                "required field",
            ),
          );
        }
      }
    }
  }
  return missing;
}

export interface DeterministicReview {
  blocking: string[];
  fixable: string[];
  warnings: string[];
  qualityScore: number;
  issues: string[];
}

export function deterministicReview(
  caseDict: CaseDict,
  facts: Record<string, unknown>,
  frontend: FrontendResult,
  requirementText: string,
  point: TestPointRow | null,
): DeterministicReview {
  const blocking: string[] = [];
  const fixable: string[] = [];
  const warnings: string[] = [];
  const steps = caseDict.structuredSteps || [];
  if (steps.length === 0) {
    blocking.push("No structured steps; cannot execute automatically");
  }
  if (!caseDict.expectedResults || caseDict.expectedResults.length === 0) {
    blocking.push("Missing expected results; cannot decide pass/fail");
  }
  if (caseHasCompoundExpected(caseDict)) {
    blocking.push(
      "Compound expectation: one case asserts multiple inputs/results; split it",
    );
  }
  if (caseHasMultipleInputs(caseDict)) {
    blocking.push(
      "Same field filled with different values: one case verifies multiple input scenarios; split it",
    );
  }
  const advisoryMarkers = [
    "button copy is not in the source/requirement facts",
    "Assertion anchor is not in the source/requirement facts",
    "testData field is not in the source/requirement facts",
  ];
  for (const err of validateCase(caseDict, frontend, requirementText, point)) {
    const bucket = advisoryMarkers.some((m) => err.includes(m))
      ? warnings
      : fixable;
    if (!bucket.includes(err) && !blocking.includes(err)) bucket.push(err);
  }
  for (const label of missingRequiredFields(caseDict, facts)) {
    const message = `Required field not filled: ${label}`;
    if (!fixable.includes(message)) fixable.push(message);
  }
  const allIssues = [...blocking, ...fixable, ...warnings];
  let score = scoreCase(caseDict, allIssues);
  if (blocking.length > 0) score = Math.min(score, 30);
  return {
    blocking,
    fixable,
    warnings,
    qualityScore: score,
    issues: allIssues,
  };
}

function issuesForReview(
  blocking: string[],
  fixable: string[],
  warnings: string[] | null,
  llmIssues: ReviewIssueDict[],
): ReviewIssueDict[] {
  const issues: ReviewIssueDict[] = [];
  const seen = new Set<string>();
  for (const problem of blocking) {
    if (seen.has(problem)) continue;
    seen.add(problem);
    issues.push({
      severity: "blocker",
      field: "structuredSteps",
      problem,
      suggestion:
        "Split into single-point single-scenario cases, or repair into executable steps and re-review",
      evidence: "deterministic check",
    });
  }
  for (const problem of fixable) {
    if (seen.has(problem)) continue;
    seen.add(problem);
    issues.push({
      severity: "warning",
      field: "structuredSteps",
      problem,
      suggestion:
        "Fill required fields, real selectors, and observable assertions, then re-review",
      evidence: "deterministic check",
    });
  }
  for (const problem of warnings || []) {
    if (seen.has(problem)) continue;
    seen.add(problem);
    issues.push({
      severity: "info",
      field: "structuredSteps",
      problem,
      suggestion:
        "Confirm the real page copy at runtime; if source facts are missing, run code analysis",
      evidence: "deterministic check (non-blocking)",
    });
  }
  for (const item of llmIssues || []) {
    const problem = String(item.problem || "").trim();
    if (!problem || seen.has(problem)) continue;
    seen.add(problem);
    issues.push(item);
  }
  return issues.slice(0, 20);
}

function llmDeduction(issues: ReviewIssueDict[]): number {
  let deduction = 0;
  for (const item of issues) {
    deduction +=
      item.severity === "blocker" ? 25 : item.severity === "warning" ? 8 : 2;
  }
  return deduction;
}

function composeReviewStatus(
  blocking: string[],
  fixable: string[],
  llmStatus: string | null,
  canRepair: boolean,
): string {
  if (blocking.length > 0) return "reject";
  if (llmStatus === "reject") return canRepair ? "revise" : "reject";
  if (fixable.length > 0 || llmStatus === "revise") {
    return canRepair ? "revise" : "reject";
  }
  return "pass";
}

async function recordReview(
  run: RunRow,
  wc: WorkflowCaseRow,
  roundNo: number,
  status: string,
  score: number,
  issues: ReviewIssueDict[],
  missingCoverage: unknown[],
  suggestions: string[],
  deterministicIssues: string[],
  source: string,
  model: string,
): Promise<void> {
  const clampedScore = Math.max(0, Math.min(100, Math.trunc(score)));
  const id = uuid();
  await db.insert(workflowCaseReviews).values({
    id,
    runId: run.id,
    caseId: wc.caseId,
    round: roundNo,
    reviewStatus: status,
    qualityScore: clampedScore,
    issues,
    missingCoverage,
    suggestions,
    deterministicIssues,
    source,
    model: model || null,
  });
  const currentWc = (
    await db.select().from(workflowCases).where(eq(workflowCases.id, wc.id))
  )[0];
  const patch: Record<string, unknown> = {
    reviewStatus: status,
    qualityScore: clampedScore,
    finalReviewId: id,
  };
  if (currentWc && currentWc.firstReviewId === null) patch.firstReviewId = id;
  await db.update(workflowCases).set(patch).where(eq(workflowCases.id, wc.id));
}

// ---------- LLM workflow review & repair ----------

export interface LlmWorkflowReview {
  reviewStatus: string;
  issues: ReviewIssueDict[];
  missingCoverage: string[];
  suggestions: string[];
}

const STATUS_ALIASES: Record<string, string> = {
  ok: "pass",
  suspect: "revise",
  fail: "reject",
  passed: "pass",
  revised: "revise",
  rejected: "reject",
};

function buildFacts(facts: Record<string, unknown>): Record<string, unknown> {
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    requirement: facts.requirement || {},
    testPoint: facts.testPoint || {},
    pages: arr(facts.pages),
    selectors: arr(facts.selectors).slice(0, 100),
    uiTexts: arr(facts.uiTexts).slice(0, 80),
    endpoints: arr(facts.endpoints).slice(0, 80),
    entities: arr(facts.entities).slice(0, 30),
    businessRules: arr(facts.businessRules).slice(0, 60),
    enums: arr(facts.enums).slice(0, 20),
    stateMachines: arr(facts.stateMachines),
  };
}

function parseIssues(rawIssues: unknown): ReviewIssueDict[] {
  const issues: ReviewIssueDict[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(rawIssues) ? rawIssues : [];
  for (const item of list.slice(0, 12)) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const problem = compact(obj.problem, 1000);
    if (!problem) continue;
    let severity = String(obj.severity || "warning").toLowerCase();
    if (!["blocker", "warning", "info"].includes(severity))
      severity = "warning";
    const key = `${severity}:${problem}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({
      severity,
      field: compact(obj.field, 60) || "case",
      problem,
      suggestion: compact(obj.suggestion, 1000),
      evidence: compact(obj.evidence, 500),
    });
  }
  return issues;
}

function parseWorkflowReview(data: unknown): LlmWorkflowReview {
  if (typeof data !== "object" || data === null) {
    throw new LlmUnavailableError(
      "AI case review returned an invalid structure",
    );
  }
  const obj = data as Record<string, unknown>;
  const rawStatus = String(obj.review_status || obj.verdict || "")
    .trim()
    .toLowerCase();
  let status = STATUS_ALIASES[rawStatus] ?? rawStatus;
  if (!["pass", "revise", "reject"].includes(status)) status = "revise";
  const issues = parseIssues(obj.issues);
  if (
    status === "pass" &&
    issues.some((i) => i.severity === "blocker" || i.severity === "warning")
  ) {
    status = "revise";
  }
  if ((status === "revise" || status === "reject") && issues.length === 0) {
    issues.push({
      severity: status === "revise" ? "warning" : "blocker",
      field: "case",
      problem: String(
        obj.summary || obj.reason || "AI believes the case needs adjustment",
      ),
      suggestion: "Repair per the review feedback and re-review",
      evidence: "",
    });
  }
  const missing = Array.isArray(obj.missing_coverage)
    ? obj.missing_coverage
    : [];
  const suggestions = Array.isArray(obj.suggestions) ? obj.suggestions : [];
  return {
    reviewStatus: status,
    issues,
    missingCoverage: missing
      .map((m) => compact(m, 300))
      .filter(Boolean)
      .slice(0, 10),
    suggestions: suggestions
      .map((s) => compact(s, 500))
      .filter(Boolean)
      .slice(0, 10),
  };
}

export async function llmWorkflowReview(
  client: LlmClient,
  caseDict: CaseDict,
  facts: Record<string, unknown>,
  deterministicIssues: string[],
  deterministicBlocking: string[],
  qualityScore: number,
): Promise<LlmWorkflowReview> {
  const payload = {
    case: caseDict,
    requirementAndSourceFacts: buildFacts(facts),
    deterministicIssues,
    deterministicBlockingIssues: deterministicBlocking,
    deterministicQualityScore: qualityScore,
  };
  const prompt = caseReviewWorkflowPrompt(JSON.stringify(payload, null, 2));
  const data = await client.chatJson(
    [{ role: "user", content: prompt }],
    4096,
    true,
  );
  return parseWorkflowReview(data);
}

function normalizeRepairSteps(rawSteps: unknown): StructuredStep[] {
  if (!Array.isArray(rawSteps)) {
    throw new BizError(40026, "AI repair structuredSteps must be an array");
  }
  const steps: StructuredStep[] = [];
  for (const item of rawSteps.slice(0, 15)) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const stepType = String(obj.type || "").trim();
    if (!["ui_action", "input", "state_assert", "capture"].includes(stepType))
      continue;
    const selector = (
      typeof obj.uiSelector === "object" && obj.uiSelector !== null
        ? obj.uiSelector
        : {}
    ) as Record<string, unknown>;
    steps.push({
      order: steps.length + 1,
      type: stepType,
      action: compact(obj.action, 255),
      target: compact(obj.target, 255),
      uiSelector: {
        type: compact(selector.type, 30),
        value: compact(selector.value, 500),
      },
      expected: compact(obj.expected, 500),
      inputValue: compact(obj.inputValue, 500),
      variable: compact(obj.variable, 60),
      pattern: compact(obj.pattern, 300),
    });
  }
  if (steps.length === 0) {
    throw new BizError(40026, "AI repair produced no valid structured steps");
  }
  return steps;
}

interface NormalizedPatch {
  title?: string;
  module?: string;
  type?: string;
  priority?: string;
  preconditions?: string[];
  expectedResults?: string[];
  testData?: Record<string, string>;
  structuredSteps?: StructuredStep[];
}

function normalizePatch(patch: Record<string, unknown>): NormalizedPatch {
  const out: NormalizedPatch = {};
  if ("title" in patch) {
    const value = compact(patch.title, 255);
    if (!value) throw new BizError(40026, "AI repair title cannot be empty");
    out.title = value;
  }
  if ("module" in patch) out.module = compact(patch.module, 120);
  if ("type" in patch) {
    const value = compact(patch.type, 20);
    if (!["positive", "negative", "boundary", "state"].includes(value)) {
      throw new BizError(40026, `Invalid case type: ${value}`);
    }
    out.type = value;
  }
  if ("priority" in patch) {
    const value = compact(patch.priority, 10);
    if (!["P0", "P1", "P2"].includes(value)) {
      throw new BizError(40026, `Invalid priority: ${value}`);
    }
    out.priority = value;
  }
  if ("preconditions" in patch) {
    if (!Array.isArray(patch.preconditions)) {
      throw new BizError(40026, "preconditions must be an array");
    }
    out.preconditions = patch.preconditions
      .map((p) => compact(p, 500))
      .filter(Boolean);
  }
  if ("expectedResults" in patch) {
    // Accept a single string too: the model sometimes serialises the array.
    // asTextList keeps a string whole instead of iterating it char-by-char.
    let rawExpected = patch.expectedResults;
    if (typeof rawExpected === "string") rawExpected = asTextList(rawExpected);
    if (!Array.isArray(rawExpected)) {
      throw new BizError(40026, "expectedResults must be an array");
    }
    const list = rawExpected.map((p) => compact(p, 500)).filter(Boolean);
    if (list.length === 0)
      throw new BizError(40026, "expectedResults cannot be empty");
    out.expectedResults = list;
  }
  if ("testData" in patch) {
    if (typeof patch.testData !== "object" || patch.testData === null) {
      throw new BizError(40026, "testData must be an object");
    }
    out.testData = patch.testData as Record<string, string>;
  }
  if ("structuredSteps" in patch) {
    out.structuredSteps = normalizeRepairSteps(patch.structuredSteps);
  }
  return out;
}

export async function repairCase(
  pid: string,
  cid: string,
  issues: ReviewIssueDict[],
  client: LlmClient,
  facts: Record<string, unknown>,
  frontend: FrontendResult,
  point: TestPointRow | null,
): Promise<string> {
  const tc = await getCaseOr404(cid);
  const caseDict = caseToDict(tc);
  const cleanIssues = issues
    .slice(0, 12)
    .map((item) => ({
      severity: compact(item.severity, 20) || "warning",
      field: compact(item.field, 60) || "case",
      problem: compact(item.problem, 1000),
      suggestion: compact(item.suggestion, 1000),
      evidence: compact(item.evidence, 500),
    }))
    .filter((item) => item.problem);

  if (!client.available()) {
    throw new BizError(
      40022,
      "No LLM API key configured; cannot run AI repair",
    );
  }
  const repairPayload = {
    case: {
      ...caseDict,
      requirement: facts.requirement || {},
      testPoint: facts.testPoint || {},
    },
    requirementAndSourceFacts: buildFacts(facts),
    issues: cleanIssues,
  };
  const prompt = caseRepairPrompt(JSON.stringify(repairPayload, null, 2));
  let summary = "";
  let rawPatch: Record<string, unknown>;
  try {
    const data = await client.chatJson(
      [{ role: "user", content: prompt }],
      4096,
      true,
    );
    const obj = (data ?? {}) as Record<string, unknown>;
    summary = String(obj.summary || "");
    rawPatch = (obj.patch ?? {}) as Record<string, unknown>;
  } catch (error) {
    throw new BizError(
      40027,
      `AI repair failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const patch = normalizePatch(rawPatch);
  const merged = {
    ...caseDict,
    structuredSteps: patch.structuredSteps ?? caseDict.structuredSteps,
    testData: patch.testData ?? caseDict.testData,
    expectedResults: patch.expectedResults ?? caseDict.expectedResults,
  };
  const requirementText = String(
    (facts.requirement as Record<string, unknown> | undefined)?.excerpt || "",
  );
  const errors = validateCase(merged, frontend, requirementText, point);
  if (errors.length > 0) {
    throw new BizError(
      40028,
      `AI patch failed source-fact validation: ${errors.slice(0, 6).join("; ")}`,
    );
  }
  const ctx = await getGenerationContext(pid);
  const pointDict = point
    ? {
        title: point.title,
        category: point.category,
        description: point.description || "",
        pageRoute: point.pageRoute || "",
        endpoint: point.endpoint || "",
        expected: point.expected || "",
        fields: point.fields ?? [],
      }
    : null;
  const resolvedRefs = resolveCoverageRefs(
    {
      title: merged.title,
      module: merged.module,
      coverageRefs: merged.coverageRefs || {
        endpointIds: [],
        transitionIds: [],
        ruleIds: [],
      },
      steps: merged.steps,
      structuredSteps: merged.structuredSteps,
      testData: merged.testData,
    },
    ctx.backend,
    ctx.machines as unknown as StateMachineSpec[],
    pointDict,
  );
  const updateInput: CaseUpdateInput = {
    coverageRefs: resolvedRefs,
    executionStatus: "not_run",
    changeNote: `AI repair: ${summary}`,
  };
  if (patch.title !== undefined) updateInput.title = patch.title;
  if (patch.module !== undefined) updateInput.module = patch.module;
  if (patch.type !== undefined) updateInput.type = patch.type;
  if (patch.priority !== undefined) updateInput.priority = patch.priority;
  if (patch.preconditions !== undefined)
    updateInput.preconditions = patch.preconditions;
  if (patch.expectedResults !== undefined) {
    updateInput.expectedResults = patch.expectedResults;
  }
  if (patch.testData !== undefined) updateInput.testData = patch.testData;
  if (patch.structuredSteps !== undefined) {
    updateInput.structuredSteps = patch.structuredSteps;
    updateInput.steps = patch.structuredSteps
      .map((s) => s.action)
      .filter(Boolean);
  }
  if (tc.source === "rule" || tc.source === "ai" || tc.source === "import") {
    updateInput.source = "ai";
  }
  await updateCase(cid, updateInput);
  return summary;
}

// ---------- Stage 3: case review ----------

async function stageCaseReview(
  run: RunRow,
  config: WorkflowConfig,
): Promise<StageResult> {
  const requirement = await getRequirementOr404(requireRequirementId(run));
  const stage = await beginStage(
    run.id,
    "case_review",
    `Review cases from run #${run.id.slice(0, 8)}; at most ${config.maxRevisions} revision rounds`,
  );
  const wcs = await db
    .select()
    .from(workflowCases)
    .where(eq(workflowCases.runId, run.id))
    .orderBy(asc(workflowCases.position));

  if (!config.reviewEnabled) {
    await endStage(
      stage,
      "skipped",
      "Case review is disabled by configuration",
      { reviewEnabled: false },
    );
    for (const wc of wcs) {
      if (wc.finalReviewId === null) {
        await recordReview(
          run,
          wc,
          1,
          "revise",
          wc.qualityScore || 0,
          [
            {
              severity: "warning",
              field: "case",
              problem: "Review disabled by configuration; not reviewed",
              suggestion: "Enable reviewEnabled to run review",
              evidence: "configuration",
            },
          ],
          [],
          ["Review disabled by configuration"],
          [],
          "deterministic",
          "",
        );
      }
    }
    return { status: "skipped" };
  }

  const client = await getTextClient();
  const maxRevisions = config.maxRevisions;
  const factsCache = new Map<string, SourceFactsResult>();
  const tally = {
    pass: 0,
    revise: 0,
    reject: 0,
    manual: 0,
    revisions: 0,
    errors: 0,
  };

  for (const wcInitial of wcs) {
    let wc = wcInitial;
    try {
      const tc = await getCaseRowOrNull(wc.caseId);
      if (!tc) {
        await recordReview(
          run,
          wc,
          1,
          "reject",
          0,
          [
            {
              severity: "blocker",
              field: "case",
              problem: "Case no longer exists",
              suggestion: "Regenerate cases",
              evidence: "database",
            },
          ],
          [],
          [],
          ["Case no longer exists"],
          "deterministic",
          "",
        );
        tally.reject += 1;
        continue;
      }
      const mapping = (
        await db
          .select()
          .from(requirementCases)
          .where(eq(requirementCases.testCaseId, tc.id))
      )[0];
      const point = mapping?.testPointId
        ? ((
            await db
              .select()
              .from(testPoints)
              .where(eq(testPoints.id, mapping.testPointId))
          )[0] ?? null)
        : null;
      const cacheKey = `${requirement.id}:${point?.id ?? ""}`;
      if (!factsCache.has(cacheKey)) {
        factsCache.set(
          cacheKey,
          await sourceFacts(run.projectId, requirement, point),
        );
      }
      const { facts, frontend } = factsCache.get(cacheKey)!;

      if (wc.automationStatus === "manual") {
        await recordReview(
          run,
          wc,
          1,
          "pass",
          tc.qualityScore || 100,
          [],
          [],
          ["Manual case; not executed automatically"],
          [],
          "deterministic",
          "",
        );
        await db
          .update(workflowCases)
          .set({ reviewStatus: "pass", automationStatus: "manual" })
          .where(eq(workflowCases.id, wc.id));
        tally.manual += 1;
        continue;
      }
      if (wc.automationStatus === "blocked") {
        await recordReview(
          run,
          wc,
          1,
          "reject",
          0,
          [
            {
              severity: "blocker",
              field: "structuredSteps",
              problem: "No structured steps; cannot execute automatically",
              suggestion: "Add executable steps or mark as a manual case",
              evidence: "case snapshot",
            },
          ],
          [],
          [],
          ["No structured steps"],
          "deterministic",
          "",
        );
        await db
          .update(workflowCases)
          .set({ reviewStatus: "reject", automationStatus: "blocked" })
          .where(eq(workflowCases.id, wc.id));
        tally.reject += 1;
        continue;
      }

      let revisions = 0;
      let roundNo = 0;
      let repairError = "";
      let fallbackPass = false;
      let countDropped = false;
      let countNotes: string[] = [];
      const listRoutes = (frontend.pages || [])
        .map((p) => String(p.route || ""))
        .filter(Boolean);
      let currentCase = tc;

      while (true) {
        roundNo += 1;
        let caseDict = caseToDict(currentCase);
        const transformed = normalizeCaseCounts(caseDict, listRoutes);
        if (transformed.drop) {
          const note = (transformed.notes || []).join("; ");
          await recordReview(
            run,
            wc,
            1,
            "reject",
            0,
            [
              {
                severity: "blocker",
                field: "expectedResults",
                problem: note || "Fixed-total assertion cannot be made stable",
                suggestion:
                  "Assert a unique row identifier or use isolated data",
                evidence: "count assertion normalization",
              },
            ],
            [],
            [],
            [note],
            "deterministic",
            "",
          );
          await db
            .update(workflowCases)
            .set({ reviewStatus: "reject", automationStatus: "blocked" })
            .where(eq(workflowCases.id, wc.id));
          countDropped = true;
          tally.reject += 1;
          break;
        }
        if (transformed.changed) {
          try {
            await updateCase(wc.caseId, {
              structuredSteps: caseDict.structuredSteps,
              expectedResults: caseDict.expectedResults,
              steps: caseDict.steps,
              preconditions: caseDict.preconditions,
              changeNote: "Converted fixed-total assertion to runtime baseline",
            });
            currentCase = await getCaseOr404(wc.caseId);
            countNotes = transformed.notes;
          } catch {
            currentCase = await getCaseOr404(wc.caseId);
          }
          caseDict = caseToDict(currentCase);
        }

        const requirementText = String(
          (facts.requirement as Record<string, unknown> | undefined)?.excerpt ||
            "",
        );
        const deterministic = deterministicReview(
          caseDict,
          facts,
          frontend,
          requirementText,
          point,
        );
        let llmReview: LlmWorkflowReview | null = null;
        let llmNote = "";
        if (client.available() && deterministic.blocking.length === 0) {
          try {
            llmReview = await llmWorkflowReview(
              client,
              caseDict,
              facts,
              deterministic.issues,
              deterministic.blocking,
              deterministic.qualityScore,
            );
          } catch (error) {
            llmNote = `AI review unavailable: ${error instanceof Error ? error.message : String(error)}`;
          }
        } else if (!client.available()) {
          llmNote = "No LLM configured; using deterministic checks only";
        }

        const canRepair = revisions < maxRevisions && client.available();
        const llmStatus = llmReview?.reviewStatus ?? null;
        const status = composeReviewStatus(
          deterministic.blocking,
          deterministic.fixable,
          llmStatus,
          canRepair,
        );
        const llmIssues = llmReview?.issues ?? [];
        const issues = issuesForReview(
          deterministic.blocking,
          deterministic.fixable,
          deterministic.warnings,
          llmIssues,
        );
        let score = Math.max(
          0,
          deterministic.qualityScore - llmDeduction(llmIssues),
        );
        if (deterministic.blocking.length > 0) score = Math.min(score, 30);
        const suggestions = [...countNotes, ...(llmReview?.suggestions ?? [])];
        if (llmNote) suggestions.push(llmNote);
        const source = llmReview ? "mixed" : "deterministic";
        await recordReview(
          run,
          wc,
          roundNo,
          status,
          score,
          issues,
          llmReview?.missingCoverage ?? [],
          suggestions,
          deterministic.issues,
          source,
          llmReview ? client.model : "",
        );

        if (status !== "revise") break;
        if (revisions >= maxRevisions) break;
        if (!client.available()) break;

        const repairIssues = issuesForReview(
          deterministic.blocking,
          deterministic.fixable,
          [],
          llmIssues,
        );
        revisions += 1;
        try {
          await repairCase(
            run.projectId,
            wc.caseId,
            repairIssues,
            client,
            facts,
            frontend,
            point,
          );
          currentCase = await getCaseOr404(wc.caseId);
        } catch (error) {
          repairError = error instanceof Error ? error.message : String(error);
          if (
            deterministic.blocking.length === 0 &&
            deterministic.fixable.length === 0 &&
            llmStatus === "revise"
          ) {
            roundNo += 1;
            const note = `AI repair patch failed source-fact validation; keeping the original case and continuing: ${repairError}`;
            await recordReview(
              run,
              wc,
              roundNo,
              "pass",
              deterministic.qualityScore,
              [
                {
                  severity: "info",
                  field: "case",
                  problem: note,
                  suggestion:
                    "The original case passed deterministic checks; judge with execution results",
                  evidence: "workflow repair fallback",
                },
              ],
              [],
              [note],
              [],
              "deterministic",
              "",
            );
            fallbackPass = true;
          }
          break;
        }
      }

      await db
        .update(workflowCases)
        .set({ revisionCount: revisions })
        .where(eq(workflowCases.id, wc.id));
      tally.revisions += revisions;
      if (countDropped) continue;

      wc = (
        await db.select().from(workflowCases).where(eq(workflowCases.id, wc.id))
      )[0]!;
      if (!fallbackPass && wc.reviewStatus === "revise") {
        roundNo += 1;
        const reason =
          repairError ||
          (revisions >= maxRevisions
            ? `Reached max revision rounds (${maxRevisions}) without passing review`
            : "AI review/repair unavailable; unresolved issues remain");
        await recordReview(
          run,
          wc,
          roundNo,
          "reject",
          Math.min(wc.qualityScore, 40),
          [
            {
              severity: "blocker",
              field: "case",
              problem: reason,
              suggestion: "Inspect manually, then regenerate or repair by hand",
              evidence: "workflow review convergence rule",
            },
          ],
          [],
          [reason],
          [reason],
          "deterministic",
          "",
        );
        wc = (
          await db
            .select()
            .from(workflowCases)
            .where(eq(workflowCases.id, wc.id))
        )[0]!;
      }
      if (wc.reviewStatus === "pass") {
        await db
          .update(workflowCases)
          .set({ automationStatus: "automated" })
          .where(eq(workflowCases.id, wc.id));
        tally.pass += 1;
      } else {
        await db
          .update(workflowCases)
          .set({ automationStatus: "blocked" })
          .where(eq(workflowCases.id, wc.id));
        tally.reject += 1;
      }
    } catch (error) {
      tally.errors += 1;
      tally.reject += 1;
      const message = error instanceof Error ? error.message : String(error);
      try {
        await recordReview(
          run,
          wc,
          1,
          "reject",
          0,
          [
            {
              severity: "blocker",
              field: "case",
              problem: `Review error: ${message}`,
              suggestion: "Inspect the case and LLM configuration",
              evidence: "workflow error",
            },
          ],
          [],
          [],
          [`Review error: ${message}`],
          "deterministic",
          "",
        );
        await db
          .update(workflowCases)
          .set({ automationStatus: "blocked" })
          .where(eq(workflowCases.id, wc.id));
      } catch {
        // ignore
      }
    }
  }

  const finalWcs = await db
    .select()
    .from(workflowCases)
    .where(eq(workflowCases.runId, run.id));
  const passedScores = finalWcs
    .filter((w) => w.reviewStatus === "pass")
    .map((w) => w.qualityScore);
  const avgQuality =
    passedScores.length > 0
      ? Math.round(
          (passedScores.reduce((a, b) => a + b, 0) / passedScores.length) * 10,
        ) / 10
      : 0;
  const payload = {
    ...tally,
    avgQuality,
    maxRevisions,
    llmAvailable: client.available(),
  };
  await endStage(
    stage,
    "completed",
    `Reviewed ${finalWcs.length}: pass ${tally.pass}, reject ${tally.reject}, manual ${tally.manual}, ${tally.revisions} revision rounds`,
    payload,
    null,
    client.available() ? client.model : null,
  );
  return { status: "completed", ...payload };
}

// ---------- Stage 4: execution ----------

async function stageExecution(
  run: RunRow,
  config: WorkflowConfig,
): Promise<StageResult> {
  const stage = await beginStage(
    run.id,
    "execution",
    "Execute reviewed and automatable cases",
  );
  if (!config.autoExecute) {
    await endStage(
      stage,
      "skipped",
      "Automatic execution is disabled by configuration",
      { autoExecute: false },
    );
    return { status: "skipped" };
  }
  const approved = await db
    .select()
    .from(workflowCases)
    .where(
      and(
        eq(workflowCases.runId, run.id),
        eq(workflowCases.reviewStatus, "pass"),
        eq(workflowCases.automationStatus, "automated"),
      ),
    )
    .orderBy(asc(workflowCases.position));
  if (approved.length === 0) {
    await endStage(stage, "skipped", "No reviewed and automatable cases", {
      approved: 0,
    });
    return { status: "skipped", approved: 0 };
  }
  const executed: Record<string, unknown>[] = [];
  const errors: { caseId: string; error: string }[] = [];
  for (const wc of approved) {
    try {
      const result = await runCaseExecution(run.projectId, wc.caseId, {
        targetUrl: config.targetUrl,
      });
      await db
        .update(workflowCases)
        .set({ executionId: result.id })
        .where(eq(workflowCases.id, wc.id));
      const record = (
        await db
          .select()
          .from(executionRecords)
          .where(eq(executionRecords.id, result.id))
      )[0];
      executed.push({
        caseId: wc.caseId,
        executionId: result.id,
        status: result.status,
        durationMs: record?.durationMs ?? 0,
      });
    } catch (error) {
      errors.push({
        caseId: wc.caseId,
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          1000,
        ),
      });
    }
  }
  const payload = {
    approved: approved.length,
    executed: executed.length,
    failedToStart: errors.length,
    partial: errors.length > 0 && executed.length > 0,
    errors,
    byStatus: counts(executed.map((e) => String(e.status))),
    executions: executed,
  };
  if (executed.length === 0 && errors.length > 0) {
    await endStage(
      stage,
      "failed",
      `Execution did not start: all ${errors.length} cases failed`,
      payload,
      errors[0].error,
    );
    return { status: "failed", ...payload };
  }
  await endStage(
    stage,
    "completed",
    `Executed ${executed.length}/${approved.length}; ${errors.length} failed to start` +
      (errors.length > 0 ? " (partial failure)" : ""),
    payload,
  );
  return { status: "completed", ...payload };
}

// ---------- Stage 5: result analysis ----------

async function buildEvidence(
  wc: WorkflowCaseRow,
  requirement: RequirementRow | null,
): Promise<Record<string, unknown>> {
  const record = wc.executionId
    ? ((
        await db
          .select()
          .from(executionRecords)
          .where(eq(executionRecords.id, wc.executionId))
      )[0] ?? null)
    : null;
  const tc = (
    await db.select().from(testCases).where(eq(testCases.id, wc.caseId))
  )[0] as TestCaseRow | undefined;
  const snapshot = (record?.testCaseSnapshot ??
    (tc ? caseToDict(tc) : {})) as Record<string, unknown>;
  let steps: Record<string, unknown>[] = [];
  if (record) {
    const stepRows = await db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.executionId, record.id))
      .orderBy(asc(executionSteps.stepIndex));
    steps = stepRows.slice(0, 20).map((row) => ({
      index: row.stepIndex,
      type: row.stepType,
      action: row.action,
      target: row.target,
      result: row.result,
      selectorUsed: row.selectorUsed,
      error: row.error,
      screenshotBefore: row.screenshotBefore,
      screenshotAfter: row.screenshotAfter,
    }));
  }
  let vision: Record<string, unknown> = {};
  if (record) {
    const execDict = await getExecution(record.id);
    const review = execDict.review;
    if (review) {
      vision = {
        verdict: review.verdict,
        reason: review.reason,
        issues: (review.issues || []).slice(0, 8),
        imageReviews: (review.imageReviews || []).slice(0, 8),
      };
    }
  }
  const point = wc.testPointId
    ? ((
        await db
          .select()
          .from(testPoints)
          .where(eq(testPoints.id, wc.testPointId))
      )[0] ?? null)
    : null;
  return {
    caseId: wc.caseId,
    caseTitle: snapshot.title || record?.testCaseTitle || "",
    caseType: snapshot.type,
    expectedResults: snapshot.expectedResults || [],
    executionStatus: record?.status ?? "unknown",
    errorCategory: record?.errorCategory ?? null,
    errorMessage: record?.errorMessage ?? null,
    targetUrl: record?.targetUrl ?? null,
    durationMs: record?.durationMs ?? 0,
    passedSteps: record?.passedSteps ?? 0,
    totalSteps: record?.totalSteps ?? 0,
    steps,
    visionReview: vision,
    testPoint: point
      ? {
          id: point.id,
          title: point.title,
          category: point.category,
          expected: point.expected || "",
        }
      : { id: null, title: "", category: "", expected: "" },
    requirement: {
      version: requirement?.version || "",
      name: requirement?.name || "",
      excerpt: (requirement?.content || "").slice(0, 4000),
    },
  };
}

interface AnalysisResult {
  failureCategory: FailureCategory;
  failureReason: string;
  evidence: string[];
  confidence: number;
  recommendedAction: string;
  needsHumanReview: boolean;
  source: "llm" | "rule";
  model: string;
}

const VALID_CATEGORIES = [
  "product_defect",
  "test_script_issue",
  "test_data_issue",
  "environment_issue",
  "unknown",
  "none",
];
const DEFECT_CATEGORIES = new Set([
  "product_defect",
  "test_script_issue",
  "test_data_issue",
  "environment_issue",
]);
const ACTION_BY_CATEGORY: Record<string, string> = {
  product_defect:
    "Keep the failure screenshots and steps as defect evidence; file a defect with the expected/actual difference.",
  test_script_issue:
    "Check and repair the case steps, selectors, assertions, or input approach, then re-execute.",
  test_data_issue:
    "Adjust the test data to satisfy the page/API constraints and add the corresponding negative test points.",
  environment_issue:
    "Confirm the target service, browser, and network are available, then re-execute; retry once if needed.",
  unknown:
    "Manually review the failed steps, screenshots, and video, then classify with more evidence.",
  none: "No action needed.",
};
const REASON_BY_CATEGORY: Record<string, string> = {
  product_defect: "Evidence shows page behavior violating expectations",
  test_script_issue:
    "The problem points to the case itself (steps/selectors/assertions)",
  test_data_issue:
    "The problem points to test data violating business constraints",
  environment_issue:
    "The problem points to the execution environment, not business behavior",
  unknown:
    "Insufficient evidence or multiple coexisting causes; cannot reliably classify",
  none: "Execution passed with no anomaly evidence",
};

function parseFailureAnalysis(raw: unknown): AnalysisResult {
  if (typeof raw !== "object" || raw === null) {
    throw new LlmUnavailableError("Invalid result analysis structure");
  }
  const obj = raw as Record<string, unknown>;
  const category = String(obj.failure_category || "unknown");
  const failureCategory = (
    VALID_CATEGORIES.includes(category) ? category : "unknown"
  ) as FailureCategory;
  const evidence = Array.isArray(obj.evidence)
    ? obj.evidence
        .map((e) => String(e))
        .filter(Boolean)
        .slice(0, 20)
    : [];
  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  return {
    failureCategory,
    failureReason: String(obj.failure_reason || "").slice(0, 2000),
    evidence,
    confidence,
    recommendedAction: String(obj.recommended_action || "").slice(0, 1000),
    needsHumanReview: obj.needs_human_review !== false,
    source: "rule",
    model: "",
  };
}

function buildRuleEvidence(evidence: Record<string, unknown>): string[] {
  const items: string[] = [];
  const steps = (Array.isArray(evidence.steps) ? evidence.steps : []) as Record<
    string,
    unknown
  >[];
  for (const step of steps.slice(0, 20)) {
    const parts = [
      `step ${step.index}`,
      `type=${step.type}`,
      `result=${step.result}`,
    ];
    if (step.action) parts.push(`action=${step.action}`);
    if (step.selectorUsed) parts.push(`selector=${step.selectorUsed}`);
    if (step.error) parts.push(`error=${step.error}`);
    items.push(parts.join("; "));
  }
  const review = (evidence.visionReview || {}) as Record<string, unknown>;
  if (review && Object.keys(review).length > 0) {
    items.push(
      `screenshot review verdict=${review.verdict || "none"}; reason=${review.reason || "none"}`,
    );
    const issues = (
      Array.isArray(review.issues) ? review.issues : []
    ) as Record<string, unknown>[];
    for (const issue of issues.slice(0, 5)) {
      if (issue.problem)
        items.push(`screenshot review issue: ${issue.problem}`);
    }
  }
  if (evidence.errorCategory) {
    items.push(
      `error code ${evidence.errorCategory}: ${evidence.errorMessage || "no error text"}`,
    );
  }
  return items.slice(0, 12);
}

function ruleAnalysis(evidence: Record<string, unknown>): AnalysisResult {
  const status = String(evidence.executionStatus || "unknown");
  const categoryCode = String(evidence.errorCategory || "");
  const review = (evidence.visionReview || {}) as Record<string, unknown>;
  const reviewVerdict = String(review.verdict || "");
  const evidenceItems = buildRuleEvidence(evidence);
  const steps = (Array.isArray(evidence.steps) ? evidence.steps : []) as Record<
    string,
    unknown
  >[];
  const failedSteps = steps.filter((s) => s.result === "failed");
  const failedText = failedSteps
    .map((s) => `${s.error || ""} ${s.selectorUsed || ""} ${s.action || ""}`)
    .join(" ")
    .toLowerCase();
  const scriptMarkers = [
    "locator",
    "not an <input",
    "element not found",
    "input not found",
    "strict mode violation",
    "selector",
    "placeholder",
    "waiting for element",
  ];
  const envMarkers = [
    "net::",
    "err_connection",
    "err_name",
    "connection refused",
    "browser",
    "dns",
  ];
  const looksLikeScriptError =
    scriptMarkers.some((m) => failedText.includes(m)) &&
    !envMarkers.some((m) => failedText.includes(m));
  const base = { source: "rule" as const, model: "" };
  const ev = (fallback: string[]) =>
    evidenceItems.length > 0 ? evidenceItems : fallback;

  if (status === "passed" || status === "cancelled") {
    if (status === "cancelled") {
      return {
        ...base,
        failureCategory: "none",
        failureReason:
          "Execution was cancelled; no analyzable failure evidence.",
        evidence: ["execution status=cancelled"],
        confidence: 1,
        recommendedAction: ACTION_BY_CATEGORY.none,
        needsHumanReview: false,
      };
    }
    if (reviewVerdict === "suspect") {
      return {
        ...base,
        failureCategory: "unknown",
        failureReason:
          "All deterministic steps passed, but screenshot review found suspicions; human confirmation needed.",
        evidence: ev(["execution status=passed", "screenshot review=suspect"]),
        confidence: 0.4,
        recommendedAction: ACTION_BY_CATEGORY.unknown,
        needsHumanReview: true,
      };
    }
    return {
      ...base,
      failureCategory: "none",
      failureReason: "Execution status is passed with no anomaly evidence.",
      evidence: ["execution status=passed"],
      confidence: 0.9,
      recommendedAction: ACTION_BY_CATEGORY.none,
      needsHumanReview: false,
    };
  }
  if (
    looksLikeScriptError &&
    ["ENV_ERROR", "SELECTOR_NOT_FOUND", "TIMEOUT"].includes(categoryCode)
  ) {
    return {
      ...base,
      failureCategory: "test_script_issue",
      failureReason:
        "The failure occurred during element location/input (the executor error text points to a locator/element type mismatch); more likely a case selector or test data issue than environment unavailability.",
      evidence: ev([`error code ${categoryCode}`]),
      confidence: 0.7,
      recommendedAction: ACTION_BY_CATEGORY.test_script_issue,
      needsHumanReview: true,
    };
  }
  if (categoryCode === "CASE_INVALID") {
    return {
      ...base,
      failureCategory: "test_script_issue",
      failureReason:
        "The executor deemed the case invalid (missing structured steps, input values, or selectors); a case-side problem.",
      evidence: ev(["error code CASE_INVALID"]),
      confidence: 0.95,
      recommendedAction: ACTION_BY_CATEGORY.test_script_issue,
      needsHumanReview: false,
    };
  }
  if (categoryCode === "ENV_ERROR") {
    return {
      ...base,
      failureCategory: "environment_issue",
      failureReason:
        "The executor reported an environment error (browser/driver/network); not a business assertion result.",
      evidence: ev(["error code ENV_ERROR"]),
      confidence: 0.85,
      recommendedAction: ACTION_BY_CATEGORY.environment_issue,
      needsHumanReview: false,
    };
  }
  if (categoryCode === "NAVIGATION_FAILED") {
    return {
      ...base,
      failureCategory: "environment_issue",
      failureReason:
        "The page could not open or the target returned an error; investigate environment/service first rather than declaring a product defect.",
      evidence: ev(["error code NAVIGATION_FAILED"]),
      confidence: 0.7,
      recommendedAction: ACTION_BY_CATEGORY.environment_issue,
      needsHumanReview: true,
    };
  }
  if (categoryCode === "TIMEOUT") {
    return {
      ...base,
      failureCategory: "environment_issue",
      failureReason:
        "A step timed out; possibly a slow environment, unresponsive service, or abnormal page behavior. Evidence is insufficient to call it a product defect.",
      evidence: ev(["error code TIMEOUT"]),
      confidence: 0.45,
      recommendedAction: ACTION_BY_CATEGORY.environment_issue,
      needsHumanReview: true,
    };
  }
  if (categoryCode === "SELECTOR_NOT_FOUND") {
    return {
      ...base,
      failureCategory: "test_script_issue",
      failureReason:
        "The executor could not find the element specified by the case; check the selector/page structure first.",
      evidence: ev(["error code SELECTOR_NOT_FOUND"]),
      confidence: 0.55,
      recommendedAction: ACTION_BY_CATEGORY.test_script_issue,
      needsHumanReview: true,
    };
  }
  if (categoryCode === "ASSERT_FAILED") {
    return {
      ...base,
      failureCategory: "unknown",
      failureReason:
        "The assertion did not match the expected copy; could be a product defect or a wrong selector/assertion. Evidence is insufficient to classify directly.",
      evidence: ev(["error code ASSERT_FAILED"]),
      confidence: 0.35,
      recommendedAction: ACTION_BY_CATEGORY.unknown,
      needsHumanReview: true,
    };
  }
  return {
    ...base,
    failureCategory: "unknown",
    failureReason: "Insufficient evidence to determine the failure cause.",
    evidence: evidenceItems.slice(0, 6),
    confidence: evidenceItems.length > 0 ? 0.2 : 0,
    recommendedAction: ACTION_BY_CATEGORY.unknown,
    needsHumanReview: true,
  };
}

function hasGroundedEvidence(
  items: string[],
  evidence: Record<string, unknown>,
): boolean {
  if (items.length === 0) return false;
  const steps = (Array.isArray(evidence.steps) ? evidence.steps : []) as Record<
    string,
    unknown
  >[];
  const stepIndexes = steps.map((s) => String(s.index));
  const errorCode = String(evidence.errorCategory || "");
  const texts = (
    Array.isArray(evidence.expectedResults) ? evidence.expectedResults : []
  ).map((x) => String(x));
  const review = (evidence.visionReview || {}) as Record<string, unknown>;
  for (const item of items) {
    const text = String(item);
    if (stepIndexes.some((idx) => text.includes(`step ${idx}`))) return true;
    if (errorCode && text.includes(errorCode)) return true;
    if (review.verdict && text.includes(String(review.verdict))) return true;
    if (texts.some((t) => t && text.includes(t))) return true;
  }
  return false;
}

function guardAnalysis(
  result: AnalysisResult,
  evidence: Record<string, unknown>,
): AnalysisResult {
  const status = String(evidence.executionStatus || "unknown");
  let category: string = result.failureCategory;
  if (!VALID_CATEGORIES.includes(category)) category = "unknown";
  let items = result.evidence.filter((e) => String(e).trim()).slice(0, 20);
  const review = (evidence.visionReview || {}) as Record<string, unknown>;
  let failureReason = result.failureReason;

  if (status === "cancelled") category = "none";
  else if (status === "passed") {
    category = String(review.verdict || "") === "suspect" ? "unknown" : "none";
  } else if (category === "none") category = "unknown";

  if (
    DEFECT_CATEGORIES.has(category) &&
    !hasGroundedEvidence(items, evidence)
  ) {
    category = "unknown";
    items = [
      ...items,
      "Evidence did not cite a concrete step/error code/screenshot verdict; degraded to unknown",
    ];
    failureReason =
      "The original classification lacked verifiable execution evidence; degraded to unknown.";
  }

  let confidence = Math.max(0, Math.min(1, result.confidence));
  if (category === "unknown") confidence = Math.min(confidence, 0.5);
  if (items.length === 0) confidence = Math.min(confidence, 0.3);

  let needsReview = result.needsHumanReview;
  if (category === "product_defect" || category === "unknown")
    needsReview = true;
  if (category === "none" && (status === "passed" || status === "cancelled")) {
    needsReview = false;
  }

  return {
    failureCategory: category as FailureCategory,
    failureReason: (failureReason || REASON_BY_CATEGORY[category] || "").slice(
      0,
      2000,
    ),
    evidence: items.slice(0, 10),
    confidence: Math.round(confidence * 1000) / 1000,
    recommendedAction: (
      result.recommendedAction ||
      ACTION_BY_CATEGORY[category] ||
      ""
    ).slice(0, 1000),
    needsHumanReview: needsReview,
    source: result.source,
    model: result.model,
  };
}

async function analyzeResult(
  client: LlmClient,
  evidence: Record<string, unknown>,
): Promise<AnalysisResult> {
  if (client.available()) {
    try {
      const prompt = resultAnalysisPrompt(JSON.stringify(evidence, null, 2));
      const raw = await client.chatJson(
        [{ role: "user", content: prompt }],
        2048,
        true,
      );
      const parsed = parseFailureAnalysis(raw);
      parsed.source = "llm";
      parsed.model = client.model;
      return guardAnalysis(parsed, evidence);
    } catch {
      // degrade to rules below
    }
  }
  return guardAnalysis(ruleAnalysis(evidence), evidence);
}

async function stageResultAnalysis(
  run: RunRow,
  config: WorkflowConfig,
): Promise<StageResult> {
  const stage = await beginStage(
    run.id,
    "result_analysis",
    "Analyze failure causes from steps/screenshot review/error codes",
  );
  if (!config.analyzeEnabled) {
    await endStage(
      stage,
      "skipped",
      "Result analysis is disabled by configuration",
      { analyzeEnabled: false },
    );
    return { status: "skipped" };
  }
  const requirement = await getRequirementOr404(requireRequirementId(run));
  const analyzedCases = await db
    .select()
    .from(workflowCases)
    .where(
      and(
        eq(workflowCases.runId, run.id),
        isNotNull(workflowCases.executionId),
      ),
    )
    .orderBy(asc(workflowCases.position));
  if (analyzedCases.length === 0) {
    await endStage(stage, "skipped", "No execution records to analyze", {
      analyzed: 0,
    });
    return { status: "skipped", analyzed: 0 };
  }
  const client = await getTextClient();
  let rows = 0;
  let errors = 0;
  const byCategory: Record<string, number> = {};
  const sources: Record<string, number> = {};
  for (const wc of analyzedCases) {
    try {
      const evidence = await buildEvidence(wc, requirement);
      const result = await analyzeResult(client, evidence);
      const id = uuid();
      await db.insert(workflowResultAnalyses).values({
        id,
        runId: run.id,
        executionId: wc.executionId!,
        caseId: wc.caseId,
        executionStatus: String(evidence.executionStatus || "unknown"),
        failureCategory: result.failureCategory,
        failureReason: result.failureReason,
        evidence: result.evidence,
        confidence: result.confidence,
        recommendedAction: result.recommendedAction,
        needsHumanReview: result.needsHumanReview,
        source: result.source,
        model: result.model || null,
        rawResponse: evidence,
      });
      await db
        .update(workflowCases)
        .set({ analysisId: id })
        .where(eq(workflowCases.id, wc.id));
      rows += 1;
      byCategory[result.failureCategory] =
        (byCategory[result.failureCategory] ?? 0) + 1;
      sources[result.source] = (sources[result.source] ?? 0) + 1;
    } catch (error) {
      rows += 1;
      errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      try {
        const id = uuid();
        await db.insert(workflowResultAnalyses).values({
          id,
          runId: run.id,
          executionId: wc.executionId || "",
          caseId: wc.caseId,
          executionStatus: "unknown",
          failureCategory: "unknown",
          failureReason:
            `Analysis error; no reliable conclusion: ${message}`.slice(0, 2000),
          evidence: [
            `Analysis error: ${error instanceof Error ? error.name : "Error"}`,
          ],
          confidence: 0,
          recommendedAction:
            "Manually review the execution record and screenshots, then classify",
          needsHumanReview: true,
          source: "rule",
          model: null,
        });
        await db
          .update(workflowCases)
          .set({ analysisId: id })
          .where(eq(workflowCases.id, wc.id));
        byCategory.unknown = (byCategory.unknown ?? 0) + 1;
        sources.rule = (sources.rule ?? 0) + 1;
      } catch {
        // ignore
      }
    }
  }
  const payload = {
    analyzed: rows,
    errors,
    byCategory,
    bySource: sources,
    llmAvailable: client.available(),
  };
  const categoryText =
    Object.entries(byCategory)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ") || "none";
  await endStage(
    stage,
    "completed",
    `Analyzed ${rows} execution results; categories: ${categoryText}`,
    payload,
    null,
    client.available() ? client.model : null,
  );
  return { status: "completed", ...payload };
}

// ---------- Stage 6: report ----------

async function buildSummary(run: RunRow): Promise<Record<string, unknown>> {
  const stages = await db
    .select()
    .from(workflowStages)
    .where(eq(workflowStages.runId, run.id));
  const wcs = await db
    .select()
    .from(workflowCases)
    .where(eq(workflowCases.runId, run.id));
  const reviews = await db
    .select({ id: workflowCaseReviews.id })
    .from(workflowCaseReviews)
    .where(eq(workflowCaseReviews.runId, run.id));
  const analyses = await db
    .select()
    .from(workflowResultAnalyses)
    .where(eq(workflowResultAnalyses.runId, run.id));
  const executionIds = wcs
    .map((wc) => wc.executionId)
    .filter((x): x is string => Boolean(x));
  const executions =
    executionIds.length > 0
      ? await db
          .select()
          .from(executionRecords)
          .where(inArray(executionRecords.id, executionIds))
      : [];
  const points = run.requirementId
    ? await db
        .select({ id: testPoints.id })
        .from(testPoints)
        .where(eq(testPoints.requirementId, run.requirementId))
    : [];
  const scores = wcs
    .filter((wc) => wc.reviewStatus === "pass")
    .map((wc) => wc.qualityScore);
  const codeStage = stages.find((s) => s.stage === "code_analysis");
  const stageStatuses: Record<string, string> = {};
  for (const s of stages) stageStatuses[s.stage] = s.status;
  const executionStage = stages.find((s) => s.stage === "execution");
  const execErrors =
    ((executionStage?.payload as Record<string, unknown> | null)?.errors as
      unknown[] | undefined) ?? [];
  return {
    stageStatuses,
    codeAnalysis: codeStage?.payload ?? {},
    testPoints: points.length,
    cases: wcs.length,
    automation: counts(wcs.map((wc) => wc.automationStatus)),
    review: counts(wcs.map((wc) => wc.reviewStatus)),
    reviews: reviews.length,
    revisions: wcs.reduce((acc, wc) => acc + wc.revisionCount, 0),
    avgQuality:
      scores.length > 0
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) /
          10
        : 0,
    executions: executions.length,
    executionStatuses: counts(executions.map((e) => e.status)),
    analysis: counts(analyses.map((a) => a.failureCategory)),
    analysisSources: counts(analyses.map((a) => a.source)),
    errors: {
      stages: stages.filter((s) => s.status === "failed").map((s) => s.stage),
      executionStart: execErrors.length,
    },
  };
}

async function stageReport(
  run: RunRow,
  _config: WorkflowConfig,
): Promise<StageResult> {
  const stage = await beginStage(
    run.id,
    "report",
    "Summarize all stages and produce the report entry",
  );
  await endStage(stage, "completed", "Workflow report generated", {});
  const summary = await buildSummary(run);
  await db
    .update(workflowStages)
    .set({
      payload: { ...summary, reportUrl: `/pipeline/${run.id}` },
    })
    .where(eq(workflowStages.id, stage.id));
  return { status: "completed", ...summary };
}

// ---------- Queries ----------

export async function listRuns(pid: string, limit = 20): Promise<RunDict[]> {
  await getProjectOr404(pid);
  const runs = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.projectId, pid))
    .orderBy(desc(workflowRuns.createdAt))
    .limit(Math.max(1, Math.min(100, limit)));
  return runs.map(runToDict);
}

export async function getRunOr404(runId: string): Promise<RunRow> {
  const run = await getRunRow(runId);
  if (!run) throw new BizError(40407, `Workflow run not found: ${runId}`);
  return run;
}

export async function getRunDetail(runId: string): Promise<RunDetailDict> {
  const run = await getRunOr404(runId);
  const stages = await db
    .select()
    .from(workflowStages)
    .where(eq(workflowStages.runId, run.id));
  const stageOrder = new Map<string, number>(
    STAGES.map((name, index) => [name, index]),
  );
  stages.sort(
    (a, b) =>
      (stageOrder.get(a.stage) ?? 999) - (stageOrder.get(b.stage) ?? 999),
  );
  const wcs = await db
    .select()
    .from(workflowCases)
    .where(eq(workflowCases.runId, run.id))
    .orderBy(asc(workflowCases.position));
  const cases: WorkflowCaseDict[] = [];
  for (const wc of wcs) {
    const tc = (
      await db.select().from(testCases).where(eq(testCases.id, wc.caseId))
    )[0] as TestCaseRow | undefined;
    const reviews = await db
      .select()
      .from(workflowCaseReviews)
      .where(
        and(
          eq(workflowCaseReviews.runId, run.id),
          eq(workflowCaseReviews.caseId, wc.caseId),
        ),
      )
      .orderBy(asc(workflowCaseReviews.round));
    const analysis = wc.analysisId
      ? ((
          await db
            .select()
            .from(workflowResultAnalyses)
            .where(eq(workflowResultAnalyses.id, wc.analysisId))
        )[0] ?? null)
      : null;
    const record = wc.executionId
      ? ((
          await db
            .select()
            .from(executionRecords)
            .where(eq(executionRecords.id, wc.executionId))
        )[0] ?? null)
      : null;
    cases.push({
      id: wc.id,
      caseId: wc.caseId,
      title: tc?.title ?? record?.testCaseTitle ?? "Case deleted",
      type: tc?.type ?? "",
      priority: tc?.priority ?? "",
      source: tc?.source ?? "",
      position: wc.position,
      testPointId: wc.testPointId,
      automationStatus: wc.automationStatus,
      reviewStatus: wc.reviewStatus,
      revisionCount: wc.revisionCount,
      qualityScore: wc.qualityScore,
      firstReview: reviews[0] ? reviewToDict(reviews[0]) : null,
      finalReview:
        reviews.length > 0 ? reviewToDict(reviews[reviews.length - 1]) : null,
      reviews: reviews.map(reviewToDict),
      execution: record
        ? {
            id: record.id,
            status: record.status,
            statusLabel: meta(EXECUTION_RECORD_STATUS_META, record.status)
              .label,
            errorCategory: record.errorCategory,
            errorMessage: record.errorMessage,
            durationMs: record.durationMs,
            startedAt: record.startTime?.toISOString() ?? null,
          }
        : null,
      analysis: analysis ? analysisToDict(analysis) : null,
    });
  }
  return { ...runToDict(run), stages: stages.map(stageToDict), cases };
}

function lastActivityForRun(
  run: RunRow,
  stagesByRun: Map<
    string,
    { startedAt: Date | null; finishedAt: Date | null }[]
  >,
): Date | null {
  const candidates: (Date | null)[] = [run.startedAt, run.createdAt];
  for (const stage of stagesByRun.get(run.id) ?? []) {
    candidates.push(stage.startedAt, stage.finishedAt);
  }
  const values = candidates.filter((v): v is Date => v !== null);
  if (values.length === 0) return null;
  return values.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
}

/**
 * After a server restart, in-memory jobs are lost; mark long-idle
 * pending/running runs as failed so the UI never shows a phantom "running"
 * pipeline. Only runs with no recent activity are reclaimed: when several
 * workers boot at once, killing every "running" row would murder a live
 * pipeline owned by another worker. There is no heartbeat column, so the
 * newest run/stage started_at/finished_at acts as the activity marker.
 */
export async function recoverInterruptedRuns(
  staleSeconds = 7200,
): Promise<number> {
  const runs = await db
    .select()
    .from(workflowRuns)
    .where(inArray(workflowRuns.status, ["pending", "running"]));
  const now = new Date();
  const cutoff = new Date(
    now.getTime() - Math.max(0, Math.floor(staleSeconds)) * 1000,
  );
  let count = 0;
  if (runs.length > 0) {
    const stages = await db
      .select({
        runId: workflowStages.runId,
        startedAt: workflowStages.startedAt,
        finishedAt: workflowStages.finishedAt,
      })
      .from(workflowStages)
      .where(
        inArray(
          workflowStages.runId,
          runs.map((r) => r.id),
        ),
      );
    const stagesByRun = new Map<
      string,
      { startedAt: Date | null; finishedAt: Date | null }[]
    >();
    for (const stage of stages) {
      const list = stagesByRun.get(stage.runId) ?? [];
      list.push({ startedAt: stage.startedAt, finishedAt: stage.finishedAt });
      stagesByRun.set(stage.runId, list);
    }
    // A run with no datable activity is left alone rather than force-failed.
    const staleRuns = runs.filter((run) => {
      const last = lastActivityForRun(run, stagesByRun) ?? now;
      return last.getTime() <= cutoff.getTime();
    });
    for (const run of staleRuns) {
      await db
        .update(workflowRuns)
        .set({
          status: "failed",
          currentStage: null,
          errorMessage: "Interrupted by server restart; re-run the pipeline",
          finishedAt: new Date(),
        })
        .where(eq(workflowRuns.id, run.id));
      const runningStages = await db
        .select()
        .from(workflowStages)
        .where(
          and(
            eq(workflowStages.runId, run.id),
            inArray(workflowStages.status, ["pending", "running"]),
          ),
        );
      for (const stage of runningStages) {
        if (stage.status === "running") {
          await db
            .update(workflowStages)
            .set({
              status: "failed",
              errorMessage: "Interrupted by server restart",
              finishedAt: new Date(),
              durationMs: elapsedMs(stage.startedAt),
            })
            .where(eq(workflowStages.id, stage.id));
        } else {
          await db
            .update(workflowStages)
            .set({
              status: "skipped",
              outputSummary: "Not executed; interrupted by server restart",
              finishedAt: new Date(),
            })
            .where(eq(workflowStages.id, stage.id));
        }
      }
      count += 1;
    }
  }
  // Clean up historical inconsistencies: stages still stuck in
  // running/pending although their parent run already finished.
  const staleStages = await db
    .select()
    .from(workflowStages)
    .where(inArray(workflowStages.status, ["pending", "running"]));
  for (const stage of staleStages) {
    const parents = await db
      .select({ status: workflowRuns.status })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, stage.runId));
    const parent = parents[0];
    if (!parent || parent.status === "pending" || parent.status === "running") {
      continue;
    }
    await db
      .update(workflowStages)
      .set({
        status: stage.status === "running" ? "failed" : "skipped",
        errorMessage:
          stage.errorMessage ||
          "Run already finished; stage state corrected automatically",
        finishedAt: new Date(),
        durationMs: elapsedMs(stage.startedAt),
      })
      .where(eq(workflowStages.id, stage.id));
  }
  return count;
}
