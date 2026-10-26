/**
 * Coverage service: assemble the planned-vs-executed coverage matrix from
 * the latest code analysis, the project's cases, and passed executions.
 *
 * Conventions (mirroring the analysis pipeline):
 * - Planned coverage: a case's coverageRefs reference a real endpoint,
 *   verified state transition, or business rule.
 * - Executed coverage: only `passed` executions count, preferring the case
 *   snapshot captured at execution time.
 */
import { and, eq } from "drizzle-orm";

import { db } from "#/db";
import {
  executionRecords,
  executionRequirements,
  testCases,
} from "#/db/schema";
import { buildCoverageMatrix } from "#/server/lib/coverage";
import type { CoverageCaseInput, CoverageMatrix } from "#/server/lib/coverage";
import {
  getGenerationContext,
  getProjectOr404,
} from "#/server/services/projects";
import { casesForRequirement } from "#/server/services/testcases";
import type { TestCaseRow } from "#/server/services/testcases";

import type { BackendResult, StateMachineSpec } from "#/lib/types";

function caseToCoverageInput(row: TestCaseRow): CoverageCaseInput {
  return {
    id: row.id,
    title: row.title,
    module: row.module,
    coverageRefs: row.coverageRefs,
    steps: row.steps ?? [],
    structuredSteps: row.structuredSteps ?? [],
    testData: row.testData ?? {},
    executionStatus: row.executionStatus,
  };
}

export async function getCoverageMatrix(
  pid: string,
  requirementId: string | null = null,
): Promise<CoverageMatrix> {
  await getProjectOr404(pid);

  let backend: BackendResult | null = null;
  let machines: StateMachineSpec[] = [];
  try {
    const ctx = await getGenerationContext(pid);
    backend = ctx.backend;
    machines = ctx.machines as unknown as StateMachineSpec[];
  } catch {
    backend = null;
    machines = [];
  }

  let caseRows: TestCaseRow[];
  if (requirementId && requirementId !== "__none__") {
    const pairs = await casesForRequirement(requirementId);
    caseRows = pairs.map((p) => p.row);
  } else {
    caseRows = (await db
      .select()
      .from(testCases)
      .where(eq(testCases.projectId, pid))) as TestCaseRow[];
  }
  const cases = caseRows.map(caseToCoverageInput);

  let passedRecords = await db
    .select()
    .from(executionRecords)
    .where(
      and(
        eq(executionRecords.projectId, pid),
        eq(executionRecords.status, "passed"),
      ),
    );
  if (requirementId) {
    const links = await db
      .select()
      .from(executionRequirements)
      .where(eq(executionRequirements.projectId, pid));
    const allowed = new Set(
      links
        .filter((link) =>
          requirementId === "__none__"
            ? !link.requirementId
            : link.requirementId === requirementId,
        )
        .map((link) => link.executionId),
    );
    passedRecords = passedRecords.filter((record) => allowed.has(record.id));
  }

  const caseById = new Map(caseRows.map((row) => [row.id, row]));
  // The matrix only reflects current live cases: once a case is replaced by a
  // new generation round, its old execution records must not keep contributing
  // "executed" coverage.
  passedRecords = passedRecords.filter((record) =>
    caseById.has(record.testCaseId),
  );
  const passedSnapshots: Record<string, unknown>[] = [];
  for (const record of passedRecords) {
    let snapshot = record.testCaseSnapshot ?? {};
    if (Object.keys(snapshot).length === 0 && caseById.has(record.testCaseId)) {
      const row = caseById.get(record.testCaseId)!;
      snapshot = caseToCoverageInput(row) as unknown as Record<string, unknown>;
    }
    if (Object.keys(snapshot).length > 0) passedSnapshots.push(snapshot);
  }

  return buildCoverageMatrix({
    projectId: pid,
    requirementId,
    backend,
    machines,
    cases,
    passedSnapshots,
  });
}
