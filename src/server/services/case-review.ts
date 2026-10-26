/**
 * Standalone AI quality review and repair for existing test cases.
 *
 * Mirrors the pipeline's review stage but works on demand over an arbitrary
 * selection of cases: deterministic checks always run, the LLM verdict is
 * advisory, and a repair patch must pass source-fact validation before it is
 * written back (a new version snapshot is recorded).
 */
import { eq } from "drizzle-orm";

import { db } from "#/db";
import {
  requirementCases,
  requirements,
  testCases,
  testPoints,
} from "#/db/schema";
import { LlmUnavailableError } from "#/server/lib/llm";
import { BizError, getTextClient } from "#/server/services/settings";
import { caseToDict, getCase, getCaseOr404 } from "#/server/services/testcases";
import {
  deterministicReview,
  llmWorkflowReview,
  repairCase,
  sourceFacts,
} from "#/server/services/workflows";

import type { LlmClient } from "#/server/lib/llm";
import type { CaseDict } from "#/server/services/testcases";
import type {
  ReviewIssueDict,
  SourceFactsResult,
} from "#/server/services/workflows";

const MAX_REVIEW_CASES = 20;

export type CaseReviewVerdict = "pass" | "suspect" | "fail" | "unavailable";

export interface CaseReviewResult {
  caseId: string;
  title: string;
  verdict: CaseReviewVerdict;
  reason: string;
  issues: ReviewIssueDict[];
  missingCoverage: string[];
  suggestions: string[];
  qualityScore: number;
  model: string;
}

export interface CaseReviewSummary {
  total: number;
  reviewed: number;
  problems: number;
  results: CaseReviewResult[];
}

async function requirementPoint(cid: string) {
  const mapping = (
    await db
      .select()
      .from(requirementCases)
      .where(eq(requirementCases.testCaseId, cid))
  )[0] as typeof requirementCases.$inferSelect | undefined;
  if (!mapping) return { requirement: null, point: null };
  const requirement =
    (
      await db
        .select()
        .from(requirements)
        .where(eq(requirements.id, mapping.requirementId))
    )[0] ?? null;
  const point = mapping.testPointId
    ? ((
        await db
          .select()
          .from(testPoints)
          .where(eq(testPoints.id, mapping.testPointId))
      )[0] ?? null)
    : null;
  return { requirement, point };
}

function verdictFor(
  blocking: string[],
  fixable: string[],
  llmStatus: string | null,
): CaseReviewVerdict {
  if (blocking.length > 0 || llmStatus === "reject") return "fail";
  if (llmStatus === "revise" || fixable.length > 0) return "suspect";
  return "pass";
}

/**
 * Review up to `MAX_REVIEW_CASES` cases. Deterministic findings are always
 * returned; when no text profile is configured the verdict is `unavailable`
 * rather than a fabricated pass.
 */
export async function reviewCases(
  pid: string,
  caseIds: string[],
): Promise<CaseReviewSummary> {
  const ids = Array.from(new Set(caseIds.filter(Boolean)));
  if (ids.length === 0) {
    throw new BizError(40025, "Select at least one case to review");
  }
  if (ids.length > MAX_REVIEW_CASES) {
    throw new BizError(
      40025,
      `Review at most ${MAX_REVIEW_CASES} cases at a time`,
    );
  }

  const client = await getTextClient();
  const factsCache = new Map<string, SourceFactsResult>();
  const results: CaseReviewResult[] = [];

  for (const cid of ids) {
    const row = await getCaseOr404(cid);
    if (row.projectId !== pid) {
      throw new BizError(40402, `Case not found in this project: ${cid}`);
    }
    const caseDict = caseToDict(row);
    const { requirement, point } = await requirementPoint(cid);
    const cacheKey = `${requirement?.id ?? "__project__"}:${point?.id ?? ""}`;
    if (!factsCache.has(cacheKey)) {
      factsCache.set(cacheKey, await sourceFacts(pid, requirement, point));
    }
    const { facts, frontend } = factsCache.get(cacheKey)!;

    const deterministic = deterministicReview(
      caseDict,
      facts,
      frontend,
      String(
        (facts.requirement as Record<string, unknown> | undefined)?.excerpt ??
          "",
      ),
      point,
    );

    if (!client.available()) {
      results.push({
        caseId: cid,
        title: caseDict.title,
        verdict: "unavailable",
        reason:
          deterministic.issues.length > 0
            ? `AI review unavailable (no text LLM configured). Deterministic findings: ${deterministic.issues.slice(0, 4).join("; ")}`
            : "AI review unavailable: no text LLM configured. Deterministic checks found no issues.",
        issues: deterministic.issues.map((problem) => ({
          severity: deterministic.blocking.includes(problem)
            ? "blocker"
            : "warning",
          field: "case",
          problem,
        })),
        missingCoverage: [],
        suggestions: [],
        qualityScore: deterministic.qualityScore,
        model: client.model,
      });
      continue;
    }

    let llm: {
      reviewStatus: string;
      issues: ReviewIssueDict[];
      missingCoverage: string[];
      suggestions: string[];
    } | null = null;
    let unavailableReason = "";
    try {
      llm = await llmWorkflowReview(
        client,
        caseDict,
        facts,
        deterministic.issues,
        deterministic.blocking,
        deterministic.qualityScore,
      );
    } catch (error) {
      if (error instanceof LlmUnavailableError) {
        unavailableReason = error.message;
      } else {
        unavailableReason =
          error instanceof Error ? error.message : String(error);
      }
    }

    if (!llm) {
      results.push({
        caseId: cid,
        title: caseDict.title,
        verdict: "unavailable",
        reason: `AI review unavailable: ${unavailableReason}`.slice(0, 1200),
        issues: deterministic.issues.map((problem) => ({
          severity: deterministic.blocking.includes(problem)
            ? "blocker"
            : "warning",
          field: "case",
          problem,
        })),
        missingCoverage: [],
        suggestions: [],
        qualityScore: deterministic.qualityScore,
        model: client.model,
      });
      continue;
    }

    const verdict = verdictFor(
      deterministic.blocking,
      deterministic.fixable,
      llm.reviewStatus,
    );
    const seen = new Set<string>();
    const issues: ReviewIssueDict[] = [];
    for (const issue of [
      ...llm.issues,
      ...deterministicIssues(deterministic),
    ]) {
      const key = `${issue.field}:${issue.problem}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(issue);
    }
    const reason =
      llm.issues
        .map((issue) => issue.problem)
        .filter(Boolean)
        .slice(0, 3)
        .join("; ") ||
      deterministic.issues.slice(0, 3).join("; ") ||
      "No issues found by deterministic checks or the AI reviewer.";

    results.push({
      caseId: cid,
      title: caseDict.title,
      verdict,
      reason: reason.slice(0, 1200),
      issues: issues.slice(0, 20),
      missingCoverage: llm.missingCoverage,
      suggestions: llm.suggestions,
      qualityScore: Math.max(
        0,
        Math.min(100, deterministic.qualityScore - llmDeduction(llm.issues)),
      ),
      model: client.model,
    });
  }

  return {
    total: results.length,
    reviewed: results.filter((r) => r.verdict !== "unavailable").length,
    problems: results.filter(
      (r) => r.verdict === "suspect" || r.verdict === "fail",
    ).length,
    results,
  };
}

function deterministicIssues(deterministic: {
  blocking: string[];
  fixable: string[];
  warnings: string[];
}): ReviewIssueDict[] {
  return [
    ...deterministic.blocking.map((problem) => ({
      severity: "blocker",
      field: "case",
      problem,
    })),
    ...deterministic.fixable.map((problem) => ({
      severity: "warning",
      field: "case",
      problem,
    })),
    ...deterministic.warnings.map((problem) => ({
      severity: "info",
      field: "case",
      problem,
    })),
  ];
}

function llmDeduction(issues: ReviewIssueDict[]): number {
  let deduction = 0;
  for (const issue of issues) {
    if (issue.severity === "blocker") deduction += 25;
    else if (issue.severity === "warning") deduction += 10;
    else deduction += 3;
  }
  return Math.min(60, deduction);
}

/**
 * Ask the model for a repair patch, validate it against the source facts, and
 * write it back as a new case version. Throws when the patch is invalid so a
 * bad repair never silently lands.
 */
export async function fixCase(
  pid: string,
  cid: string,
  issues: ReviewIssueDict[] = [],
): Promise<{ summary: string; testCase: CaseDict }> {
  const row = await getCaseOr404(cid);
  if (row.projectId !== pid) {
    throw new BizError(40402, `Case not found in this project: ${cid}`);
  }
  const client: LlmClient = await getTextClient();
  if (!client.available()) {
    throw new BizError(40022, "No text LLM configured; cannot run AI repair");
  }
  const { requirement, point } = await requirementPoint(cid);
  const { facts, frontend } = await sourceFacts(pid, requirement, point);
  const summary = await repairCase(
    pid,
    cid,
    issues,
    client,
    facts,
    frontend,
    point,
  );
  return {
    summary: summary || "Repaired",
    testCase: await getCase(cid),
  };
}

/**
 * Re-run the deterministic quality gate for a single case and persist the
 * resulting score/lint issues (used after a manual edit).
 */
export async function rerunGate(
  pid: string,
  cid: string,
): Promise<{ qualityScore: number; lintIssues: string[] }> {
  const row = await getCaseOr404(cid);
  if (row.projectId !== pid) {
    throw new BizError(40402, `Case not found in this project: ${cid}`);
  }
  const caseDict = caseToDict(row);
  const { requirement, point } = await requirementPoint(cid);
  const { facts, frontend } = await sourceFacts(pid, requirement, point);
  const deterministic = deterministicReview(
    caseDict,
    facts,
    frontend,
    String(
      (facts.requirement as Record<string, unknown> | undefined)?.excerpt ?? "",
    ),
    point,
  );
  await db
    .update(testCases)
    .set({
      qualityScore: Math.max(0, Math.min(100, deterministic.qualityScore)),
      lintIssues: deterministic.issues,
      updatedAt: new Date(),
    })
    .where(eq(testCases.id, cid));
  return {
    qualityScore: Math.max(0, Math.min(100, deterministic.qualityScore)),
    lintIssues: deterministic.issues,
  };
}
