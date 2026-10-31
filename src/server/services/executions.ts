/**
 * Execution service: single (job), batch (sequential job), review flows.
 *
 * Status decision rules:
 * - The deterministic execution verdict wins: AI review can confirm a pass or
 *   escalate to human review, but never turn a definite failed/cancelled into
 *   passed.
 * - Only when the raw execution has no definite failure may an AI `ok`
 *   upgrade a skipped (missing text anchor) result.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import { db } from "#/db";
import {
  executionRecords,
  executionRequirements,
  executionReviewImages,
  executionReviewIssues,
  executionReviews,
  executionSteps,
  requirementCases,
  requirements,
  testCases,
} from "#/db/schema";
import {
  AI_REVIEW_VERDICT_META,
  CASE_EXECUTION_STATUS_META,
  ERROR_CATEGORY_META,
  meta,
} from "#/lib/enums";
import { serverEnv } from "#/server/env";
import { toFileUrl } from "#/server/lib/files";
import { createJob, getJob, runJob, updateJob } from "#/server/lib/jobs";
import { executeCase } from "#/server/lib/execution/runner";
import {
  reviewExecution,
  VERDICT_OK,
  VERDICT_SUSPECT,
  VERDICT_UNAVAILABLE,
  visionEnabled,
} from "#/server/lib/execution/vision-review";
import { BizError } from "#/server/services/settings";
import { getProjectOr404, inList, uuid } from "#/server/services/projects";
import { caseToDict, getCaseOr404 } from "#/server/services/testcases";

import type {
  ExecutionStepRecord,
  ImageReview,
  ReviewIssue,
  ReviewVerdict,
} from "#/lib/types";

export type ExecutionRow = typeof executionRecords.$inferSelect;

/** batchId -> cancel flag (in-memory) */
const cancelFlags = new Map<string, boolean>();

function newExecutionId(): string {
  return `EX-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/**
 * Probe the target URL before executing. On failure no browser is launched
 * and no running record is created, so an unreachable target never produces
 * fake executions with empty screenshots.
 */
export async function ensureTargetReachable(targetUrl: string): Promise<void> {
  const url = (targetUrl || "").trim();
  if (!url) {
    throw new BizError(40029, "Target URL is empty; cannot execute");
  }
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      redirect: "follow",
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new BizError(
      40029,
      timedOut
        ? `Target URL is not reachable (connection timed out): ${url}. Start the service under test first`
        : `Target URL is not reachable: ${url}. Check that the service is running`,
    );
  }
  if (response.status >= 400) {
    throw new BizError(
      40029,
      `Target URL returned HTTP ${response.status}; case execution did not start: ${url}`,
    );
  }
}

function resolveTargetUrl(
  override: string | null | undefined,
  projectTarget: string | null | undefined,
): string {
  return (override || projectTarget || serverEnv.targetUrlDefault).replace(
    /\/+$/,
    "",
  );
}

/** Recover the deterministic execution verdict from step results; used when
 * re-reviewing so the AI verdict is applied to the raw outcome. */
function originalStatusFromSteps(
  steps: ExecutionStepRecord[],
  fallback: string,
): string {
  const results = steps.map((step) => step.result);
  if (results.some((result) => result === "failed")) return "failed";
  if (results.some((result) => result === "skipped")) return "skipped";
  if (results.length > 0 && results.every((result) => result === "passed")) {
    return "passed";
  }
  return ["failed", "cancelled", "passed", "skipped"].includes(fallback)
    ? fallback
    : "needs_review";
}

function decideStatus(
  originalStatus: string,
  verdict: ReviewVerdict | string,
): string {
  if (originalStatus === "failed" || originalStatus === "cancelled") {
    return originalStatus;
  }
  if (originalStatus === "passed") {
    return verdict === VERDICT_OK ? "passed" : "needs_review";
  }
  if (originalStatus === "skipped") {
    if (verdict === VERDICT_OK) return "passed";
    if (verdict === VERDICT_SUSPECT || verdict === VERDICT_UNAVAILABLE) {
      return "needs_review";
    }
  }
  return "needs_review";
}

async function requirementForCase(cid: string) {
  const mappings = await db
    .select()
    .from(requirementCases)
    .where(eq(requirementCases.testCaseId, cid));
  const mapping = mappings[0];
  if (!mapping) return null;
  const rows = await db
    .select()
    .from(requirements)
    .where(eq(requirements.id, mapping.requirementId));
  return rows[0] ?? null;
}

export interface PersistedExecution {
  id: string;
  status: string;
  passedSteps: number;
  totalSteps: number;
}

/**
 * Execute one case end-to-end: run the browser, persist record/steps/
 * requirement snapshot, run AI review, decide the final status.
 */
export async function runCaseExecution(
  projectId: string,
  caseId: string,
  opts: {
    mode?: string;
    targetUrl?: string | null;
    batchId?: string | null;
  } = {},
): Promise<PersistedExecution> {
  const project = await getProjectOr404(projectId);
  const caseRow = await getCaseOr404(caseId);
  const caseDict = caseToDict(caseRow);
  const targetUrl = resolveTargetUrl(opts.targetUrl, project.targetUrl);

  // Probe before creating the running record so an unreachable target never
  // leaves a phantom "running" execution behind.
  await ensureTargetReachable(targetUrl);

  const executionId = newExecutionId();
  const snapshot = caseDict as unknown as Record<string, unknown>;
  const totalSteps = (caseDict.structuredSteps || []).length;
  await db.insert(executionRecords).values({
    id: executionId,
    projectId,
    testCaseId: caseId,
    testCaseTitle: caseDict.title,
    testCaseSnapshot: snapshot,
    batchId: opts.batchId ?? null,
    status: "running",
    mode: opts.mode ?? "programmatic",
    targetUrl,
    totalSteps,
  });
  await db
    .update(testCases)
    .set({ executionStatus: "running", updatedAt: new Date() })
    .where(eq(testCases.id, caseId));

  // Freeze the requirement version snapshot (1:1)
  const requirement = await requirementForCase(caseId);
  await db.insert(executionRequirements).values({
    id: uuid(),
    executionId,
    projectId,
    requirementId: requirement?.id ?? null,
    requirementVersion: requirement?.version ?? null,
    requirementName: requirement?.name ?? null,
  });

  const startedAt = Date.now();
  try {
    const outDir = `${serverEnv.outputDir}/${executionId}`;
    const result = await executeCase(
      { id: executionId, structuredSteps: caseDict.structuredSteps || [] },
      targetUrl,
      outDir,
    );
    const durationMs = Date.now() - startedAt;

    // Persist steps
    for (const step of result.steps) {
      await db.insert(executionSteps).values({
        id: uuid(),
        executionId,
        stepIndex: step.stepIndex,
        action: step.action,
        target: step.target,
        stepType: step.stepType,
        selectorUsed: step.selectorUsed,
        result: step.result,
        screenshotBefore: step.screenshotBefore,
        screenshotAfter: step.screenshotAfter,
        error: step.error,
        evidence: step.evidence ?? {},
        durationMs: step.durationMs ?? 0,
      });
    }

    // AI screenshot review (only when a vision model is available). A review
    // failure must never overwrite the deterministic verdict: an execution
    // that already passed in the browser stays passed (legacy P1-9), so the
    // review runs in its own guard instead of the outer execution try/catch.
    let finalStatus: string = result.status;
    try {
      const review = await reviewExecution(
        { title: caseDict.title, expectedResults: caseDict.expectedResults },
        result.steps,
        targetUrl,
      );
      if (review) {
        await persistReview(executionId, review);
        finalStatus = decideStatus(result.status, review.verdict);
      }
    } catch (reviewError) {
      console.error(
        `[executions] AI review failed for ${executionId}; keeping deterministic status ${result.status}`,
        reviewError,
      );
      finalStatus = result.status;
    }

    // Backfill the record error message from the first failed step so the
    // detail page shows the concrete failure reason.
    let errorMessage = result.errorMessage;
    if (!errorMessage) {
      const failedStep = result.steps.find(
        (step) => step.result === "failed" && step.error,
      );
      errorMessage = failedStep?.error ?? null;
    }

    await db
      .update(executionRecords)
      .set({
        status: finalStatus,
        endTime: new Date(),
        durationMs,
        errorCategory: result.errorCategory,
        errorMessage,
        videoPath: result.videoPath,
        passedSteps: result.passedSteps,
        totalSteps: result.totalSteps,
      })
      .where(eq(executionRecords.id, executionId));
    await db
      .update(testCases)
      .set({ executionStatus: finalStatus, updatedAt: new Date() })
      .where(eq(testCases.id, caseId));

    return {
      id: executionId,
      status: finalStatus,
      passedSteps: result.passedSteps,
      totalSteps: result.totalSteps,
    };
  } catch (error) {
    // The running record already exists: compensate it into a terminal
    // state instead of leaving a phantom "running" execution behind.
    console.error(
      `[executions] execution interrupted ${executionId} case=${caseId}`,
      error,
    );
    await markExecutionInterrupted(executionId, caseId, error);
    return { id: executionId, status: "failed", passedSteps: 0, totalSteps };
  }
}

/** Best-effort terminal state for an execution whose pipeline threw. */
async function markExecutionInterrupted(
  executionId: string,
  caseId: string,
  error: unknown,
): Promise<void> {
  const message = `Execution interrupted by an exception: ${
    error instanceof Error ? error.message : String(error)
  }`.slice(0, 2000);
  try {
    await db
      .update(executionRecords)
      .set({
        status: "failed",
        errorCategory: "ENV_ERROR",
        errorMessage: message,
        endTime: new Date(),
      })
      .where(eq(executionRecords.id, executionId));
    await db
      .update(testCases)
      .set({ executionStatus: "failed", updatedAt: new Date() })
      .where(
        and(eq(testCases.id, caseId), eq(testCases.executionStatus, "running")),
      );
  } catch (compensationError) {
    console.error(
      `[executions] failed to compensate ${executionId}`,
      compensationError,
    );
  }
}

export async function persistReview(
  executionId: string,
  review: {
    verdict: ReviewVerdict;
    reason: string;
    model: string;
    imageCount: number;
    imageReviews: ImageReview[];
    issues: ReviewIssue[];
    reviewer?: string;
    reviewerNote?: string;
  },
): Promise<void> {
  // Replace any previous LLM review (1:1)
  const existing = await db
    .select({ id: executionReviews.id })
    .from(executionReviews)
    .where(eq(executionReviews.executionId, executionId));
  for (const row of existing) {
    await db
      .delete(executionReviewImages)
      .where(eq(executionReviewImages.reviewId, row.id));
    await db
      .delete(executionReviewIssues)
      .where(eq(executionReviewIssues.reviewId, row.id));
  }
  await db
    .delete(executionReviews)
    .where(eq(executionReviews.executionId, executionId));

  const reviewId = uuid();
  await db.insert(executionReviews).values({
    id: reviewId,
    executionId,
    verdict: review.verdict,
    reason: review.reason,
    model: review.model,
    imageCount: review.imageCount,
    reviewer: review.reviewer ?? "llm",
    reviewerNote: review.reviewerNote ?? null,
    reviewedAt: new Date(),
  });
  for (const image of review.imageReviews) {
    await db.insert(executionReviewImages).values({
      id: uuid(),
      reviewId,
      executionId,
      imageIndex: image.imageIndex,
      stepIndex: image.stepIndex,
      label: image.label,
      screenshot: image.screenshot,
      verdict: image.verdict ?? null,
      analysis: image.analysis,
      bbox: image.bbox,
    });
  }
  for (const issue of review.issues) {
    await db.insert(executionReviewIssues).values({
      id: uuid(),
      reviewId,
      executionId,
      imageIndex: issue.imageIndex,
      stepIndex: issue.stepIndex,
      label: issue.label,
      screenshot: issue.screenshot,
      bbox: issue.bbox,
      problem: issue.problem,
    });
  }
}

// ---------- Jobs ----------

export async function startSingleExecution(
  projectId: string,
  caseId: string,
  targetUrl?: string | null,
): Promise<{ jobId: string; executionHint: string }> {
  const project = await getProjectOr404(projectId);
  await getCaseOr404(caseId);
  // Fail fast (before the job exists) when the target is unreachable.
  await ensureTargetReachable(resolveTargetUrl(targetUrl, project.targetUrl));
  const job = createJob("execution", 1);
  runJob(job.id, async (report) => {
    report(`Executing ${caseId}`);
    const result = await runCaseExecution(projectId, caseId, { targetUrl });
    return result;
  });
  return { jobId: job.id, executionHint: caseId };
}

export async function startBatchExecution(
  projectId: string,
  caseIds: string[],
  targetUrl?: string | null,
): Promise<{ jobId: string; batchId: string }> {
  const project = await getProjectOr404(projectId);
  if (caseIds.length === 0)
    throw new BizError(40040, "No cases selected for execution");
  if (caseIds.length > 100) {
    throw new BizError(
      40043,
      "A batch is limited to 100 cases; split the selection",
    );
  }
  // Probe once up front so an unreachable target does not produce an empty
  // batch of per-case errors.
  await ensureTargetReachable(resolveTargetUrl(targetUrl, project.targetUrl));
  const batchId = uuid();
  cancelFlags.set(batchId, false);
  const job = createJob("batch-execution", caseIds.length);
  runJob(job.id, async (report) => {
    const results: { caseId: string; executionId: string; status: string }[] =
      [];
    let index = 0;
    for (const caseId of caseIds) {
      index += 1;
      if (cancelFlags.get(batchId)) {
        report(
          `Batch cancelled after ${index - 1}/${caseIds.length} cases`,
          index - 1,
          caseIds.length,
        );
        break;
      }
      report(
        `Executing case ${index}/${caseIds.length}: ${caseId}`,
        index,
        caseIds.length,
      );
      try {
        const result = await runCaseExecution(projectId, caseId, {
          targetUrl,
          batchId,
        });
        results.push({ caseId, executionId: result.id, status: result.status });
      } catch (error) {
        results.push({
          caseId,
          executionId: "",
          status: `error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    cancelFlags.delete(batchId);
    return { batchId, results };
  });
  return { jobId: job.id, batchId };
}

export function cancelBatch(batchId: string): { cancelled: boolean } {
  if (!cancelFlags.has(batchId)) return { cancelled: false };
  cancelFlags.set(batchId, true);
  return { cancelled: true };
}

/**
 * Executions run in process memory only, so a restart leaves their records
 * stuck in `running`. Mark them failed (mirroring the workflow recovery) and
 * write the case status back so the UI never shows a phantom "running" case.
 */
export async function recoverInterruptedExecutions(): Promise<number> {
  const rows = await db
    .select({
      id: executionRecords.id,
      testCaseId: executionRecords.testCaseId,
      startTime: executionRecords.startTime,
    })
    .from(executionRecords)
    .where(eq(executionRecords.status, "running"));
  if (rows.length === 0) return 0;
  const now = new Date();
  for (const row of rows) {
    await db
      .update(executionRecords)
      .set({
        status: "failed",
        errorCategory: "ENV_ERROR",
        errorMessage: "Interrupted by server restart; re-run the case",
        endTime: now,
        durationMs: row.startTime
          ? Math.max(0, now.getTime() - row.startTime.getTime())
          : 0,
      })
      .where(eq(executionRecords.id, row.id));
    await db
      .update(testCases)
      .set({ executionStatus: "failed", updatedAt: now })
      .where(
        and(
          eq(testCases.id, row.testCaseId),
          eq(testCases.executionStatus, "running"),
        ),
      );
  }
  return rows.length;
}

export async function getJobState(jobId: string) {
  const job = getJob(jobId);
  if (!job) throw new BizError(40408, `Job not found: ${jobId}`);
  return job;
}

// ---------- Queries ----------

export interface ExecutionDict {
  id: string;
  projectId: string;
  testCaseId: string;
  testCaseTitle: string;
  batchId: string | null;
  status: string;
  statusLabel: string;
  statusTone: string;
  mode: string;
  targetUrl: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMs: number;
  errorCategory: string | null;
  errorCategoryLabel: string | null;
  errorMessage: string | null;
  videoPath: string | null;
  passedSteps: number;
  totalSteps: number;
  requirementId: string | null;
  requirementVersion: string | null;
  requirementName: string | null;
  review: ReviewDict | null;
}

export interface ReviewDict {
  verdict: string;
  verdictLabel: string;
  verdictTone: string;
  verdictDescription: string;
  reason: string | null;
  model: string | null;
  imageCount: number;
  reviewer: string | null;
  reviewerNote: string | null;
  reviewedAt: string | null;
  issues: ReviewIssue[];
  reviewPoints: string[];
  recommendedAction: string | null;
  imageReviews: ImageReview[];
}

async function reviewForExecutions(
  executionIds: string[],
): Promise<Map<string, ReviewDict>> {
  const out = new Map<string, ReviewDict>();
  if (executionIds.length === 0) return out;
  const reviews = await db
    .select()
    .from(executionReviews)
    .where(inList(executionReviews.executionId, executionIds));
  if (reviews.length === 0) return out;
  const reviewIds = reviews.map((r) => r.id);
  const issues = await db
    .select()
    .from(executionReviewIssues)
    .where(inList(executionReviewIssues.reviewId, reviewIds));
  const images = await db
    .select()
    .from(executionReviewImages)
    .where(inList(executionReviewImages.reviewId, reviewIds));

  for (const review of reviews) {
    const verdictMeta = meta(AI_REVIEW_VERDICT_META, review.verdict);
    const reviewIssues: ReviewIssue[] = issues
      .filter((issue) => issue.reviewId === review.id)
      .map((issue) => ({
        imageIndex: issue.imageIndex,
        stepIndex: issue.stepIndex,
        label: issue.label,
        screenshot: toFileUrl(issue.screenshot),
        bbox: issue.bbox,
        problem: issue.problem || "",
      }));
    // Legacy compatibility: early AI verdicts may lack persisted issues;
    // surface an explicit review point so users know what to check.
    if (
      review.reviewer !== "manual" &&
      (review.verdict === VERDICT_SUSPECT ||
        review.verdict === VERDICT_UNAVAILABLE) &&
      reviewIssues.length === 0
    ) {
      reviewIssues.push({
        imageIndex: 0,
        stepIndex: null,
        label: "AI review point",
        screenshot: null,
        bbox: null,
        problem:
          (review.reason || "").trim() ||
          "AI review evidence insufficient or unavailable; check key screenshots, steps, and the video, then judge manually",
      });
    }
    let recommendedAction: string | null = null;
    if (review.reviewer === "manual") {
      recommendedAction = review.reviewerNote || "Human review completed.";
    } else if (review.verdict === VERDICT_SUSPECT) {
      recommendedAction =
        "Go through the review points below, open the screenshots and video to confirm; mark Pass manually when fine, or Fail when broken.";
    } else if (review.verdict === VERDICT_UNAVAILABLE) {
      recommendedAction =
        "Re-run the AI review first; if it stays unavailable, expand the step records, watch the video, and judge manually.";
    }
    const imageReviews: ImageReview[] = images
      .filter((image) => image.reviewId === review.id)
      .sort((a, b) => a.imageIndex - b.imageIndex)
      .map((image) => ({
        imageIndex: image.imageIndex,
        stepIndex: image.stepIndex,
        label: image.label,
        screenshot: toFileUrl(image.screenshot),
        verdict: image.verdict,
        analysis: image.analysis,
        bbox: image.bbox,
      }));
    out.set(review.executionId, {
      verdict: review.verdict,
      verdictLabel: verdictMeta.label,
      verdictTone: verdictMeta.tone,
      verdictDescription: verdictMeta.description,
      reason: review.reason,
      model: review.model,
      imageCount: review.imageCount,
      reviewer: review.reviewer,
      reviewerNote: review.reviewerNote,
      reviewedAt: review.reviewedAt?.toISOString() ?? null,
      issues: reviewIssues,
      reviewPoints: reviewIssues.map((issue) => issue.problem).filter(Boolean),
      recommendedAction,
      imageReviews,
    });
  }
  return out;
}

function executionToDict(
  row: ExecutionRow,
  review: ReviewDict | null,
  requirementInfo?: {
    requirementId: string | null;
    requirementVersion: string | null;
    requirementName: string | null;
  },
): ExecutionDict {
  const statusMeta = meta(CASE_EXECUTION_STATUS_META, row.status);
  const errorMeta = row.errorCategory
    ? meta(ERROR_CATEGORY_META, row.errorCategory)
    : null;
  return {
    id: row.id,
    projectId: row.projectId,
    testCaseId: row.testCaseId,
    testCaseTitle: row.testCaseTitle,
    batchId: row.batchId,
    status: row.status,
    statusLabel: statusMeta.label,
    statusTone: statusMeta.tone,
    mode: row.mode,
    targetUrl: row.targetUrl,
    startTime: row.startTime?.toISOString() ?? null,
    endTime: row.endTime?.toISOString() ?? null,
    durationMs: row.durationMs,
    errorCategory: row.errorCategory,
    errorCategoryLabel: errorMeta?.label ?? null,
    errorMessage: row.errorMessage,
    videoPath: toFileUrl(row.videoPath),
    passedSteps: row.passedSteps,
    totalSteps: row.totalSteps,
    requirementId: requirementInfo?.requirementId ?? null,
    requirementVersion: requirementInfo?.requirementVersion ?? null,
    requirementName: requirementInfo?.requirementName ?? null,
    review,
  };
}

export interface ExecutionListFilters {
  requirementId?: string | null;
  status?: string | null;
  batchId?: string | null;
  testCaseId?: string | null;
  page?: number;
  pageSize?: number;
  groupBy?: "case" | "execution";
}

export type ExecutionListItem = ExecutionDict & { executionCount?: number };

export interface ExecutionListResult {
  total: number;
  page: number;
  pageSize: number;
  groupedBy: "case" | "execution";
  items: ExecutionListItem[];
}

export async function listExecutions(
  pid: string,
  filters: ExecutionListFilters = {},
): Promise<ExecutionListResult> {
  await getProjectOr404(pid);
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 20));
  const groupBy = filters.groupBy === "case" ? "case" : "execution";

  // Load newest-first so "latest per case" grouping keeps the first match.
  const allRows = await db
    .select()
    .from(executionRecords)
    .where(eq(executionRecords.projectId, pid))
    .orderBy(desc(executionRecords.startTime), desc(executionRecords.id));

  const reqRows = await db
    .select()
    .from(executionRequirements)
    .where(eq(executionRequirements.projectId, pid));
  const reqByExec = new Map(reqRows.map((r) => [r.executionId, r]));

  // Apply every filter before pagination/grouping (the legacy bug applied the
  // limit first, truncating filtered results).
  let rows = allRows;
  if (filters.status)
    rows = rows.filter((row) => row.status === filters.status);
  if (filters.batchId)
    rows = rows.filter((row) => row.batchId === filters.batchId);
  if (filters.testCaseId)
    rows = rows.filter((row) => row.testCaseId === filters.testCaseId);
  if (filters.requirementId) {
    rows = rows.filter((row) => {
      const info = reqByExec.get(row.id);
      return filters.requirementId === "__none__"
        ? !info?.requirementId
        : info?.requirementId === filters.requirementId;
    });
  }

  // Total executions per case across the whole project (unfiltered), used for
  // the "run count" badge when grouping by case.
  const caseCounts = new Map<string, number>();
  for (const row of allRows) {
    caseCounts.set(row.testCaseId, (caseCounts.get(row.testCaseId) ?? 0) + 1);
  }

  let pageRows: ExecutionRow[];
  let total: number;
  if (groupBy === "case") {
    const seen = new Set<string>();
    const latestPerCase: ExecutionRow[] = [];
    for (const row of rows) {
      if (seen.has(row.testCaseId)) continue;
      seen.add(row.testCaseId);
      latestPerCase.push(row);
    }
    total = latestPerCase.length;
    pageRows = latestPerCase.slice((page - 1) * pageSize, page * pageSize);
  } else {
    total = rows.length;
    pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
  }

  const reviews = await reviewForExecutions(pageRows.map((r) => r.id));
  const items: ExecutionListItem[] = pageRows.map((row) => {
    const info = reqByExec.get(row.id);
    const dict = executionToDict(row, reviews.get(row.id) ?? null, {
      requirementId: info?.requirementId ?? null,
      requirementVersion: info?.requirementVersion ?? null,
      requirementName: info?.requirementName ?? null,
    });
    return groupBy === "case"
      ? { ...dict, executionCount: caseCounts.get(row.testCaseId) ?? 1 }
      : dict;
  });
  return { total, page, pageSize, groupedBy: groupBy, items };
}

export async function listExecutionsForCase(
  pid: string,
  cid: string,
): Promise<ExecutionDict[]> {
  await getProjectOr404(pid);
  const rows = await db
    .select()
    .from(executionRecords)
    .where(eq(executionRecords.testCaseId, cid))
    .orderBy(desc(executionRecords.startTime));
  const reviews = await reviewForExecutions(rows.map((r) => r.id));
  const reqRows = await db
    .select()
    .from(executionRequirements)
    .where(
      inList(
        executionRequirements.executionId,
        rows.map((r) => r.id),
      ),
    );
  const reqByExec = new Map(reqRows.map((r) => [r.executionId, r]));
  return rows.map((row) => {
    const info = reqByExec.get(row.id);
    return executionToDict(row, reviews.get(row.id) ?? null, {
      requirementId: info?.requirementId ?? null,
      requirementVersion: info?.requirementVersion ?? null,
      requirementName: info?.requirementName ?? null,
    });
  });
}

export async function getExecution(eid: string): Promise<ExecutionDict> {
  const rows = await db
    .select()
    .from(executionRecords)
    .where(eq(executionRecords.id, eid));
  const row = rows[0];
  if (!row) throw new BizError(40409, `Execution not found: ${eid}`);
  const reviews = await reviewForExecutions([eid]);
  const reqRows = await db
    .select()
    .from(executionRequirements)
    .where(eq(executionRequirements.executionId, eid));
  const info = reqRows[0];
  return executionToDict(row, reviews.get(eid) ?? null, {
    requirementId: info?.requirementId ?? null,
    requirementVersion: info?.requirementVersion ?? null,
    requirementName: info?.requirementName ?? null,
  });
}

export async function getExecutionSteps(eid: string) {
  const rows = await db
    .select()
    .from(executionSteps)
    .where(eq(executionSteps.executionId, eid));
  return rows
    .sort((a, b) => a.stepIndex - b.stepIndex)
    .map((row) => ({
      id: row.id,
      stepIndex: row.stepIndex,
      action: row.action,
      target: row.target,
      stepType: row.stepType,
      selectorUsed: row.selectorUsed,
      result: row.result,
      screenshotBefore: toFileUrl(row.screenshotBefore),
      screenshotAfter: toFileUrl(row.screenshotAfter),
      error: row.error,
      evidence: row.evidence ?? {},
      durationMs: row.durationMs,
    }));
}

// ---------- Manual review & re-review ----------

export async function manualReview(
  eid: string,
  input: { verdict: "passed" | "failed"; note?: string },
): Promise<ExecutionDict> {
  const rows = await db
    .select()
    .from(executionRecords)
    .where(eq(executionRecords.id, eid));
  const record = rows[0];
  if (!record) throw new BizError(40409, `Execution not found: ${eid}`);
  const finalStatus = input.verdict === "passed" ? "passed" : "failed";
  const reviewerNote = (input.note || "").trim().slice(0, 2000) || null;

  const existing = await db
    .select()
    .from(executionReviews)
    .where(eq(executionReviews.executionId, eid));
  if (existing[0]) {
    await db
      .update(executionReviews)
      .set({
        verdict: input.verdict === "passed" ? VERDICT_OK : VERDICT_SUSPECT,
        reviewer: "manual",
        reviewerNote,
        reviewedAt: new Date(),
      })
      .where(eq(executionReviews.id, existing[0].id));
  } else {
    await db.insert(executionReviews).values({
      id: uuid(),
      executionId: eid,
      verdict: input.verdict === "passed" ? VERDICT_OK : VERDICT_SUSPECT,
      reason: reviewerNote,
      imageCount: 0,
      reviewer: "manual",
      reviewerNote,
      reviewedAt: new Date(),
    });
  }
  await db
    .update(executionRecords)
    .set({ status: finalStatus, endTime: record.endTime ?? new Date() })
    .where(eq(executionRecords.id, eid));
  await db
    .update(testCases)
    .set({ executionStatus: finalStatus, updatedAt: new Date() })
    .where(eq(testCases.id, record.testCaseId));
  return getExecution(eid);
}

/** Re-run the AI review for one execution and re-decide the status. */
export async function llmReview(eid: string): Promise<ExecutionDict> {
  const rows = await db
    .select()
    .from(executionRecords)
    .where(eq(executionRecords.id, eid));
  const record = rows[0];
  if (!record) throw new BizError(40409, `Execution not found: ${eid}`);
  if (!(await visionEnabled())) {
    throw new BizError(
      40041,
      "No vision LLM configured; add one in Settings first",
    );
  }
  const existing = await db
    .select({ reviewer: executionReviews.reviewer })
    .from(executionReviews)
    .where(eq(executionReviews.executionId, eid));
  if (existing[0]?.reviewer === "manual") {
    throw new BizError(
      40024,
      "The manual review verdict is locked; run the manual review again to change it",
    );
  }
  // Raw step rows keep absolute on-disk paths; the AI review reads the
  // screenshot files directly, so never pass the /api/files URLs here.
  const stepRows = await db
    .select()
    .from(executionSteps)
    .where(eq(executionSteps.executionId, eid));
  const steps = stepRows
    .sort((a, b) => a.stepIndex - b.stepIndex)
    .map((row): ExecutionStepRecord => ({
      stepIndex: row.stepIndex,
      stepType: row.stepType,
      action: row.action,
      target: row.target,
      selectorUsed: row.selectorUsed,
      result: row.result,
      screenshotBefore: row.screenshotBefore,
      screenshotAfter: row.screenshotAfter,
      error: row.error,
      evidence: row.evidence ?? {},
      durationMs: row.durationMs,
    }));
  const snapshot = record.testCaseSnapshot as {
    title?: string;
    expectedResults?: string[];
  };
  const review = await reviewExecution(
    {
      title: snapshot?.title || record.testCaseTitle,
      expectedResults: snapshot?.expectedResults || [],
    },
    steps,
    record.targetUrl || serverEnv.targetUrlDefault,
  );
  if (!review) {
    throw new BizError(
      40041,
      "No vision LLM configured; add one in Settings first",
    );
  }
  await persistReview(eid, review);
  // Recompute the raw verdict from step results, then apply review rules.
  const rawStatus = originalStatusFromSteps(steps, record.status);
  const decided = decideStatus(rawStatus, review.verdict);
  await db
    .update(executionRecords)
    .set({ status: decided })
    .where(eq(executionRecords.id, eid));
  await db
    .update(testCases)
    .set({ executionStatus: decided, updatedAt: new Date() })
    .where(eq(testCases.id, record.testCaseId));
  return getExecution(eid);
}

export async function startBatchLlmReview(
  eids: string[],
): Promise<{ jobId: string }> {
  const ids = [...new Set(eids.filter(Boolean))];
  if (ids.length === 0) throw new BizError(40042, "No executions selected");
  if (ids.length > 20) {
    throw new BizError(
      40044,
      "Review at most 20 executions at a time; split the selection",
    );
  }
  const job = createJob("llm-review", ids.length);
  runJob(job.id, async (report) => {
    const results: { executionId: string; verdict: string }[] = [];
    let index = 0;
    for (const eid of ids) {
      index += 1;
      report(`Reviewing ${index}/${ids.length}: ${eid}`, index, ids.length);
      try {
        const dict = await llmReview(eid);
        results.push({
          executionId: eid,
          verdict: dict.review?.verdict ?? "unavailable",
        });
      } catch (error) {
        results.push({
          executionId: eid,
          verdict: `error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return results;
  });
  return { jobId: job.id };
}

export { updateJob, getJob };
