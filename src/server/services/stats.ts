/**
 * Dashboard statistics: aggregate counts and recent activity for the
 * landing overview. All reads are cheap aggregate queries.
 */
import { desc, eq, sql } from "drizzle-orm";

import { db } from "#/db";
import {
  executionRecords,
  projects,
  testCases,
  workflowRuns,
} from "#/db/schema";

export interface RecentExecution {
  id: string;
  testCaseId: string;
  testCaseTitle: string;
  status: string;
  durationMs: number;
  startTime: string | null;
}

export interface RecentRun {
  id: string;
  projectId: string;
  projectName: string;
  requirementVersion: string | null;
  status: string;
  currentStage: string | null;
  createdAt: string | null;
}

export interface StatsOverview {
  projects: number;
  testCases: number;
  executions: number;
  passRate: number;
  executionStatuses: Record<string, number>;
  caseTypes: Record<string, number>;
  recentExecutions: RecentExecution[];
  recentRuns: RecentRun[];
}

export async function getOverview(): Promise<StatsOverview> {
  const [projectRows] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(projects);
  const [caseRows] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(testCases);
  const [execRows] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(executionRecords);
  const [passedRows] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(executionRecords)
    .where(eq(executionRecords.status, "passed"));

  const projectCount = projectRows?.value ?? 0;
  const caseCount = caseRows?.value ?? 0;
  const execCount = execRows?.value ?? 0;
  const passedCount = passedRows?.value ?? 0;
  const passRate =
    execCount > 0 ? Math.round((passedCount / execCount) * 10000) / 10000 : 0;

  const statusRows = await db
    .select({
      status: executionRecords.status,
      value: sql<number>`count(*)::int`,
    })
    .from(executionRecords)
    .groupBy(executionRecords.status);
  const executionStatuses: Record<string, number> = {};
  for (const row of statusRows) executionStatuses[row.status] = row.value;

  const typeRows = await db
    .select({ type: testCases.type, value: sql<number>`count(*)::int` })
    .from(testCases)
    .groupBy(testCases.type);
  const caseTypes: Record<string, number> = {};
  for (const row of typeRows) caseTypes[row.type] = row.value;

  const recentExecRows = await db
    .select({
      id: executionRecords.id,
      testCaseId: executionRecords.testCaseId,
      testCaseTitle: executionRecords.testCaseTitle,
      status: executionRecords.status,
      durationMs: executionRecords.durationMs,
      startTime: executionRecords.startTime,
    })
    .from(executionRecords)
    .orderBy(desc(executionRecords.startTime))
    .limit(8);
  const recentExecutions: RecentExecution[] = recentExecRows.map((row) => ({
    id: row.id,
    testCaseId: row.testCaseId,
    testCaseTitle: row.testCaseTitle,
    status: row.status,
    durationMs: row.durationMs,
    startTime: row.startTime?.toISOString() ?? null,
  }));

  const runRows = await db
    .select({
      id: workflowRuns.id,
      projectId: workflowRuns.projectId,
      requirementVersion: workflowRuns.requirementVersion,
      status: workflowRuns.status,
      currentStage: workflowRuns.currentStage,
      createdAt: workflowRuns.createdAt,
    })
    .from(workflowRuns)
    .orderBy(desc(workflowRuns.createdAt))
    .limit(5);
  const projectIds = [...new Set(runRows.map((r) => r.projectId))];
  const projectNameById = new Map<string, string>();
  if (projectIds.length > 0) {
    const projRows = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects);
    for (const p of projRows) projectNameById.set(p.id, p.name);
  }
  const recentRuns: RecentRun[] = runRows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    projectName: projectNameById.get(row.projectId) ?? "Unknown project",
    requirementVersion: row.requirementVersion,
    status: row.status,
    currentStage: row.currentStage,
    createdAt: row.createdAt?.toISOString() ?? null,
  }));

  return {
    projects: projectCount,
    testCases: caseCount,
    executions: execCount,
    passRate,
    executionStatuses,
    caseTypes,
    recentExecutions,
    recentRuns,
  };
}
