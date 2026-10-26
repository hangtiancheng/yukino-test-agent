/**
 * Project service: CRUD + PRD text handling.
 */
import { randomUUID } from "node:crypto";

import { asc, desc, eq, inArray } from "drizzle-orm";

import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { db } from "#/db";
import {
  caseGenerations,
  codeAnalyses,
  executionRecords,
  executionRequirements,
  executionReviewImages,
  executionReviewIssues,
  executionReviews,
  executionSteps,
  projects,
  requirementCaseChanges,
  requirementCases,
  requirementChanges,
  requirementChangeRuns,
  requirementSnapshots,
  requirements,
  stateMachines,
  testCaseVersions,
  testCases,
  testPoints,
  workflowCaseReviews,
  workflowCases,
  workflowResultAnalyses,
  workflowRuns,
  workflowStages,
} from "#/db/schema";
import { serverEnv } from "#/server/env";
import { BizError } from "#/server/services/settings";

import type { BackendResult, FrontendResult } from "#/lib/types";

export function uuid(): string {
  return randomUUID().replace(/-/g, "");
}

export type ProjectRow = typeof projects.$inferSelect;

export interface ProjectDict {
  id: string;
  name: string;
  description: string | null;
  sourceType: string;
  sourcePath: string | null;
  gitUrl: string | null;
  gitBranch: string | null;
  techStack: Record<string, string | null> | null;
  hasPrd: boolean;
  targetUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  latestAnalysisStatus?: string | null;
  requirementCount?: number;
  caseCount?: number;
}

export async function getProjectOr404(pid: string): Promise<ProjectRow> {
  const rows = await db.select().from(projects).where(eq(projects.id, pid));
  const project = rows[0];
  if (!project) throw new BizError(40401, `Project not found: ${pid}`);
  return project;
}

function projectToDict(row: ProjectRow): ProjectDict {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceType: row.sourceType,
    sourcePath: row.sourcePath,
    gitUrl: row.gitUrl,
    gitBranch: row.gitBranch,
    techStack: row.techStack,
    hasPrd: Boolean((row.prdContent || "").trim()),
    targetUrl: row.targetUrl,
    createdAt: row.createdAt?.toISOString() ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

export async function listProjects(): Promise<ProjectDict[]> {
  const rows = await db
    .select()
    .from(projects)
    .orderBy(desc(projects.updatedAt));
  const dicts = rows.map(projectToDict);
  // Attach latest analysis status + counts for list cards
  for (const dict of dicts) {
    const analyses = await db
      .select({ status: codeAnalyses.status })
      .from(codeAnalyses)
      .where(eq(codeAnalyses.projectId, dict.id))
      .orderBy(desc(codeAnalyses.createdAt))
      .limit(1);
    dict.latestAnalysisStatus = analyses[0]?.status ?? null;
    const reqs = await db
      .select({ id: requirements.id })
      .from(requirements)
      .where(eq(requirements.projectId, dict.id));
    dict.requirementCount = reqs.length;
    const cases = await db
      .select({ id: testCases.id })
      .from(testCases)
      .where(eq(testCases.projectId, dict.id));
    dict.caseCount = cases.length;
  }
  return dicts;
}

export async function getProject(pid: string): Promise<ProjectDict> {
  const row = await getProjectOr404(pid);
  const dict = projectToDict(row);
  const analyses = await db
    .select({ status: codeAnalyses.status })
    .from(codeAnalyses)
    .where(eq(codeAnalyses.projectId, pid))
    .orderBy(desc(codeAnalyses.createdAt))
    .limit(1);
  dict.latestAnalysisStatus = analyses[0]?.status ?? null;
  return dict;
}

export interface ProjectUpsertInput {
  name?: string;
  description?: string | null;
  sourceType?: string;
  sourcePath?: string | null;
  gitUrl?: string | null;
  gitBranch?: string | null;
  targetUrl?: string | null;
}

export async function createProject(
  input: ProjectUpsertInput,
): Promise<ProjectDict> {
  const name = (input.name || "").trim();
  if (!name) throw new BizError(40001, "Project name is required");
  const sourceType = input.sourceType === "git" ? "git" : "local_path";
  if (sourceType === "local_path" && !(input.sourcePath || "").trim()) {
    throw new BizError(40002, "sourcePath is required for local_path projects");
  }
  if (sourceType === "git" && !(input.gitUrl || "").trim()) {
    throw new BizError(40003, "gitUrl is required for git projects");
  }
  const id = uuid();
  await db.insert(projects).values({
    id,
    name: name.slice(0, 120),
    description: input.description || null,
    sourceType,
    sourcePath: (input.sourcePath || "").trim() || null,
    gitUrl: input.gitUrl || null,
    gitBranch: input.gitBranch || null,
    targetUrl: (input.targetUrl || "").trim() || serverEnv.targetUrlDefault,
  });
  return getProject(id);
}

export async function updateProject(
  pid: string,
  input: ProjectUpsertInput,
): Promise<ProjectDict> {
  const row = await getProjectOr404(pid);
  const patch: Partial<ProjectRow> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new BizError(40001, "Project name is required");
    patch.name = name.slice(0, 120);
  }
  if (input.description !== undefined) patch.description = input.description;
  if (input.sourceType !== undefined) {
    patch.sourceType = input.sourceType === "git" ? "git" : "local_path";
  }
  if (input.sourcePath !== undefined) patch.sourcePath = input.sourcePath;
  if (input.gitUrl !== undefined) patch.gitUrl = input.gitUrl;
  if (input.gitBranch !== undefined) patch.gitBranch = input.gitBranch;
  if (input.targetUrl !== undefined) patch.targetUrl = input.targetUrl;
  await db.update(projects).set(patch).where(eq(projects.id, row.id));
  return getProject(pid);
}

export async function deleteProject(pid: string): Promise<void> {
  await getProjectOr404(pid);
  // Cascade manually (the schema declares no foreign keys): cases
  // (+versions/mappings), points, requirements, analyses, state machines,
  // executions (+steps/reviews/requirement snapshots), workflow runs
  // (+stages/cases/reviews/result analyses).
  const caseRows = await db
    .select({ id: testCases.id })
    .from(testCases)
    .where(eq(testCases.projectId, pid));
  const caseIds = caseRows.map((row) => row.id);
  if (caseIds.length > 0) {
    await db
      .delete(requirementCases)
      .where(inList(requirementCases.testCaseId, caseIds));
    await db
      .delete(testCaseVersions)
      .where(inList(testCaseVersions.testCaseId, caseIds));
    await db.delete(testCases).where(eq(testCases.projectId, pid));
  }
  const reqRows = await db
    .select({ id: requirements.id })
    .from(requirements)
    .where(eq(requirements.projectId, pid));
  const reqIds = reqRows.map((row) => row.id);
  if (reqIds.length > 0) {
    await db
      .delete(requirementCases)
      .where(inList(requirementCases.requirementId, reqIds));
    await db.delete(testPoints).where(eq(testPoints.projectId, pid));
    await db.delete(requirements).where(eq(requirements.projectId, pid));
  }

  const execRows = await db
    .select({ id: executionRecords.id })
    .from(executionRecords)
    .where(eq(executionRecords.projectId, pid));
  const execIds = execRows.map((row) => row.id);
  if (execIds.length > 0) {
    const reviewRows = await db
      .select({ id: executionReviews.id })
      .from(executionReviews)
      .where(inList(executionReviews.executionId, execIds));
    const reviewIds = reviewRows.map((row) => row.id);
    if (reviewIds.length > 0) {
      await db
        .delete(executionReviewImages)
        .where(inList(executionReviewImages.reviewId, reviewIds));
      await db
        .delete(executionReviewIssues)
        .where(inList(executionReviewIssues.reviewId, reviewIds));
    }
    await db
      .delete(executionReviews)
      .where(inList(executionReviews.executionId, execIds));
    await db
      .delete(executionSteps)
      .where(inList(executionSteps.executionId, execIds));
    await db
      .delete(executionRequirements)
      .where(inList(executionRequirements.executionId, execIds));
    await db
      .delete(executionRecords)
      .where(eq(executionRecords.projectId, pid));
  }

  const runRows = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(eq(workflowRuns.projectId, pid));
  const runIds = runRows.map((row) => row.id);
  if (runIds.length > 0) {
    await db
      .delete(workflowCaseReviews)
      .where(inList(workflowCaseReviews.runId, runIds));
    await db
      .delete(workflowResultAnalyses)
      .where(inList(workflowResultAnalyses.runId, runIds));
    await db.delete(workflowCases).where(inList(workflowCases.runId, runIds));
    await db.delete(workflowStages).where(inList(workflowStages.runId, runIds));
    await db.delete(workflowRuns).where(eq(workflowRuns.projectId, pid));
  }

  await db
    .delete(requirementCaseChanges)
    .where(eq(requirementCaseChanges.projectId, pid));
  await db
    .delete(requirementChanges)
    .where(eq(requirementChanges.projectId, pid));
  await db
    .delete(requirementChangeRuns)
    .where(eq(requirementChangeRuns.projectId, pid));
  await db
    .delete(requirementSnapshots)
    .where(eq(requirementSnapshots.projectId, pid));
  await db.delete(caseGenerations).where(eq(caseGenerations.projectId, pid));
  await db.delete(stateMachines).where(eq(stateMachines.projectId, pid));
  await db.delete(codeAnalyses).where(eq(codeAnalyses.projectId, pid));
  await db.delete(projects).where(eq(projects.id, pid));
}

export async function getPrd(pid: string): Promise<{ content: string }> {
  const row = await getProjectOr404(pid);
  return { content: row.prdContent || "" };
}

export async function updatePrd(
  pid: string,
  content: string,
): Promise<{ content: string }> {
  await getProjectOr404(pid);
  await db
    .update(projects)
    .set({ prdContent: content, updatedAt: new Date() })
    .where(eq(projects.id, pid));
  return { content };
}

/**
 * Parse an uploaded PRD file. Supported formats: .md/.markdown/.txt/.pdf/.docx
 * (parity with the Python original: pypdf -> unpdf, python-docx -> mammoth).
 */
/** Upload ceiling for PRD documents (matches the legacy 20 MB client limit). */
const MAX_PRD_BYTES = 20 * 1024 * 1024;

export async function parsePrdText(
  filename: string,
  raw: Buffer | string,
): Promise<string> {
  const lower = filename.toLowerCase();
  const byteLength =
    typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.length;
  if (byteLength > MAX_PRD_BYTES) {
    throw new BizError(
      40014,
      `Document is too large (${(byteLength / 1024 / 1024).toFixed(1)} MB); the limit is ${MAX_PRD_BYTES / 1024 / 1024} MB`,
    );
  }
  let text: string;
  if (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".txt")
  ) {
    text = typeof raw === "string" ? raw : raw.toString("utf8");
  } else if (lower.endsWith(".pdf")) {
    if (typeof raw === "string")
      throw new BizError(40009, "PDF upload must be sent as binary content");
    const { extractText } = await import("unpdf");
    try {
      const result = await extractText(new Uint8Array(raw), {
        mergePages: true,
      });
      text = Array.isArray(result.text) ? result.text.join("\n") : result.text;
    } catch (error) {
      throw new BizError(
        40009,
        `Failed to parse PDF: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (lower.endsWith(".docx")) {
    if (typeof raw === "string")
      throw new BizError(40009, "DOCX upload must be sent as binary content");
    const mammoth = await import("mammoth");
    try {
      const result = await mammoth.extractRawText({ buffer: raw });
      text = result.value;
    } catch (error) {
      throw new BizError(
        40009,
        `Failed to parse DOCX: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    throw new BizError(
      40009,
      `Unsupported document type: ${filename}. Upload .md, .txt, .pdf or .docx.`,
    );
  }
  if (!text.trim()) throw new BizError(40008, "The uploaded document is empty");
  return text;
}

export async function uploadPrd(
  pid: string,
  filename: string,
  raw: Buffer | string,
): Promise<{ content: string; sourceFile: string }> {
  await getProjectOr404(pid);
  const text = await parsePrdText(filename, raw);
  await db
    .update(projects)
    .set({ prdContent: text, updatedAt: new Date() })
    .where(eq(projects.id, pid));
  return { content: text, sourceFile: filename };
}

// ---------- helpers shared by other services ----------

export function inList<T extends AnyPgColumn>(column: T, values: string[]) {
  return inArray(column, values.length > 0 ? values : ["__none__"]);
}

export interface GenerationContext {
  backend: BackendResult;
  frontend: FrontendResult;
  machines: {
    id: string;
    name: string;
    states: { name: string; label: string }[];
    transitions: Record<string, unknown>[];
    confidence: number;
  }[];
}

/** Assemble the generation context from the latest successful analysis. */
export async function getGenerationContext(pid: string): Promise<{
  backend: BackendResult;
  frontend: FrontendResult;
  machines: GenerationContext["machines"];
}> {
  const analyses = await db
    .select()
    .from(codeAnalyses)
    .where(eq(codeAnalyses.projectId, pid))
    .orderBy(desc(codeAnalyses.createdAt))
    .limit(1);
  const analysis = analyses[0];
  if (!analysis || analysis.status !== "success") {
    throw new BizError(40010, "Run code analysis before generating cases");
  }
  const machineRows = await db
    .select()
    .from(stateMachines)
    .where(eq(stateMachines.projectId, pid))
    .orderBy(asc(stateMachines.name));
  const emptyBackend: BackendResult = {
    language: "unknown",
    endpoints: [],
    entities: [],
    enums: [],
    businessRules: [],
    uiTexts: [],
  };
  const emptyFrontend: FrontendResult = {
    language: "unknown",
    pages: [],
    selectors: [],
    uiTexts: [],
    components: [],
  };
  return {
    backend: analysis.backendResult ?? emptyBackend,
    frontend: analysis.frontendResult ?? emptyFrontend,
    machines: machineRows.map((m) => ({
      id: m.id,
      name: m.name,
      states: m.states ?? [],
      transitions: (m.transitions ?? []) as unknown as Record<
        string,
        unknown
      >[],
      confidence: m.confidence,
    })),
  };
}
