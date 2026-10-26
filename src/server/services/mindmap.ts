/**
 * Mindmap service: loads the project's cases (optionally scoped to one
 * requirement version) and builds the exportable tree.
 */
import { asc, eq } from "drizzle-orm";

import { db } from "#/db";
import { testCases } from "#/db/schema";
import { buildTree, exportMarkdown, exportXmind } from "#/server/lib/mindmap";
import { getProjectOr404 } from "#/server/services/projects";
import { casesForRequirement } from "#/server/services/testcases";

import type { MindmapResult } from "#/server/lib/mindmap";
import type { TestCaseRow } from "#/server/services/testcases";

export async function getMindmap(
  pid: string,
  requirementId: string | null = null,
): Promise<MindmapResult> {
  const project = await getProjectOr404(pid);
  let rows: TestCaseRow[];
  if (requirementId) {
    const pairs = await casesForRequirement(requirementId);
    rows = pairs
      .filter((pair) => pair.row.projectId === pid)
      .map((pair) => pair.row)
      .sort((a, b) => a.projectSeq - b.projectSeq);
  } else {
    rows = (await db
      .select()
      .from(testCases)
      .where(eq(testCases.projectId, pid))
      .orderBy(asc(testCases.projectSeq))) as TestCaseRow[];
  }
  return buildTree(project.name, rows);
}

export async function getMindmapMarkdown(
  pid: string,
  requirementId: string | null = null,
): Promise<string> {
  return exportMarkdown(await getMindmap(pid, requirementId));
}

/** Base64 so the payload survives the tRPC/superjson boundary intact. */
export async function getMindmapXmind(
  pid: string,
  requirementId: string | null = null,
): Promise<string> {
  const result = await getMindmap(pid, requirementId);
  return exportXmind(result).toString("base64");
}
