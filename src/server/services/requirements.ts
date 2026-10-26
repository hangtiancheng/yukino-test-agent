/**
 * Requirement version service: CRUD / PRD parsing + test point extraction
 * (LLM first, rule fallback).
 *
 * Data relations:
 *   Project 1--n Requirement 1--n TestPoint
 *   Requirement 1--n RequirementCase n--1 TestCase
 *
 * Design decisions:
 * - test_cases stays untouched; requirement_cases maps versions to cases.
 * - Updating requirement content invalidates old test points and generated
 *   cases: points are cleared, rule/AI cases are dropped, version mappings
 *   are removed, and status returns to draft.
 */
import { asc, eq } from "drizzle-orm";

import { db } from "#/db";
import {
  caseGenerations,
  requirementCaseChanges,
  requirementCases,
  requirementChanges,
  requirementChangeRuns,
  requirementSnapshots,
  requirements,
  testCaseVersions,
  testCases,
  testPoints,
} from "#/db/schema";
import { createJob, runJob } from "#/server/lib/jobs";
import {
  extractPointsLlm,
  extractPointsRule,
  factsForPrompt,
  filterStaticStructurePoints,
  normalizePoints,
} from "#/server/lib/generation/test-points";
import type { PointInput } from "#/server/lib/generation/test-points";
import { LlmUnavailableError } from "#/server/lib/llm";
import { BizError, getTextClient } from "#/server/services/settings";
import {
  getGenerationContext,
  getProjectOr404,
  inList,
  parsePrdText,
  uuid,
} from "#/server/services/projects";

import type {
  BackendResult,
  FrontendResult,
  StateMachineSpec,
} from "#/lib/types";

export type RequirementRow = typeof requirements.$inferSelect;
export type TestPointRow = typeof testPoints.$inferSelect;

export async function getRequirementOr404(
  rid: string,
): Promise<RequirementRow> {
  const rows = await db
    .select()
    .from(requirements)
    .where(eq(requirements.id, rid));
  const row = rows[0];
  if (!row) throw new BizError(40406, `Requirement version not found: ${rid}`);
  return row;
}

async function countsFor(
  reqIds: string[],
): Promise<{ points: Map<string, number>; cases: Map<string, number> }> {
  const points = new Map<string, number>();
  const cases = new Map<string, number>();
  if (reqIds.length === 0) return { points, cases };
  const pointRows = await db
    .select({ requirementId: testPoints.requirementId })
    .from(testPoints)
    .where(inList(testPoints.requirementId, reqIds));
  for (const row of pointRows) {
    points.set(row.requirementId, (points.get(row.requirementId) ?? 0) + 1);
  }
  const caseRows = await db
    .select({ requirementId: requirementCases.requirementId })
    .from(requirementCases)
    .where(inList(requirementCases.requirementId, reqIds));
  for (const row of caseRows) {
    cases.set(row.requirementId, (cases.get(row.requirementId) ?? 0) + 1);
  }
  return { points, cases };
}

export interface RequirementDict {
  id: string;
  projectId: string;
  name: string;
  version: string;
  status: string;
  errorMessage: string | null;
  sourceFile: string | null;
  contentLength: number;
  testPointCount: number;
  caseCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  content?: string;
}

function requirementToDict(
  row: RequirementRow,
  pointCount = 0,
  caseCount = 0,
): RequirementDict {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    version: row.version,
    status: row.status,
    errorMessage: row.errorMessage,
    sourceFile: row.sourceFile,
    contentLength: (row.content || "").length,
    testPointCount: pointCount,
    caseCount,
    createdAt: row.createdAt?.toISOString() ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

/** Lazy migration: turn a project's legacy PRD into its first requirement. */
export async function ensureInitialRequirement(
  projectId: string,
): Promise<void> {
  const project = await getProjectOr404(projectId);
  if (!(project.prdContent || "").trim()) return;
  const existing = await db
    .select({ id: requirements.id })
    .from(requirements)
    .where(eq(requirements.projectId, projectId));
  if (existing.length > 0) return;
  await db.insert(requirements).values({
    id: uuid(),
    projectId,
    name: "Legacy requirement (migrated)",
    version: "V1.0",
    content: project.prdContent,
    status: "draft",
  });
}

/**
 * After requirement content changes, drop cases generated from the old text
 * and unmap every case from this version. Manual/imported cases survive, but
 * their mapping to stale test points must go so the pipeline never reuses a
 * case that no longer matches the new requirement.
 */
async function invalidateGeneratedCases(rid: string): Promise<void> {
  const mappings = await db
    .select({ testCaseId: requirementCases.testCaseId })
    .from(requirementCases)
    .where(eq(requirementCases.requirementId, rid));
  const caseIds = mappings.map((m) => m.testCaseId);
  if (caseIds.length === 0) return;
  const caseRows = await db
    .select({ id: testCases.id, source: testCases.source })
    .from(testCases)
    .where(inList(testCases.id, caseIds));
  const generated = caseRows
    .filter((c) => c.source === "rule" || c.source === "ai")
    .map((c) => c.id);
  if (generated.length > 0) {
    await db
      .delete(testCaseVersions)
      .where(inList(testCaseVersions.testCaseId, generated));
    await db.delete(testCases).where(inList(testCases.id, generated));
  }
  await db
    .delete(requirementCases)
    .where(eq(requirementCases.requirementId, rid));
}

export async function listRequirements(
  pid: string,
): Promise<RequirementDict[]> {
  await getProjectOr404(pid);
  await ensureInitialRequirement(pid);
  const rows = await db
    .select()
    .from(requirements)
    .where(eq(requirements.projectId, pid))
    // Stable order when several versions share a created_at second, so the
    // "latest version" never degrades back to V1.
    .orderBy(asc(requirements.createdAt), asc(requirements.version));
  const { points, cases } = await countsFor(rows.map((r) => r.id));
  return rows.map((row) =>
    requirementToDict(row, points.get(row.id) ?? 0, cases.get(row.id) ?? 0),
  );
}

export async function getRequirement(rid: string): Promise<RequirementDict> {
  const row = await getRequirementOr404(rid);
  const { points, cases } = await countsFor([rid]);
  const dict = requirementToDict(
    row,
    points.get(rid) ?? 0,
    cases.get(rid) ?? 0,
  );
  dict.content = row.content || "";
  return dict;
}

async function checkVersionUnique(
  pid: string,
  version: string,
  excludeId?: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(requirements)
    .where(eq(requirements.projectId, pid));
  const dup = rows.find(
    (row) => row.version === version && row.id !== excludeId,
  );
  if (dup)
    throw new BizError(
      40012,
      `Version ${version} already exists; pick another one`,
    );
}

export async function createRequirement(
  pid: string,
  data: { name?: string; version?: string; content?: string },
): Promise<RequirementDict> {
  await getProjectOr404(pid);
  const name = (data.name || "").trim();
  const version = (data.version || "").trim();
  if (!name) throw new BizError(40013, "Requirement name is required");
  if (!version) throw new BizError(40013, "Version is required");
  await checkVersionUnique(pid, version);
  const id = uuid();
  await db.insert(requirements).values({
    id,
    projectId: pid,
    name,
    version,
    content: data.content || "",
    status: "draft",
  });
  return getRequirement(id);
}

export async function updateRequirement(
  rid: string,
  data: { name?: string; version?: string; content?: string | null },
): Promise<RequirementDict> {
  const row = await getRequirementOr404(rid);
  const patch: Partial<RequirementRow> = { updatedAt: new Date() };
  if (data.version && data.version.trim()) {
    const version = data.version.trim();
    await checkVersionUnique(row.projectId, version, rid);
    patch.version = version;
  }
  if (data.name && data.name.trim()) patch.name = data.name.trim();
  if (data.content !== undefined && data.content !== null) {
    if (data.content !== (row.content || "")) {
      // Content changed: old test points are invalidated, back to draft
      patch.content = data.content;
      await db.delete(testPoints).where(eq(testPoints.requirementId, rid));
      await invalidateGeneratedCases(rid);
      patch.status = "draft";
      patch.errorMessage = null;
    }
  }
  await db.update(requirements).set(patch).where(eq(requirements.id, rid));
  return getRequirement(rid);
}

export async function uploadRequirementPrd(
  rid: string,
  filename: string,
  raw: Buffer | string,
): Promise<RequirementDict> {
  await getRequirementOr404(rid);
  const text = await parsePrdText(filename, raw);
  await db.delete(testPoints).where(eq(testPoints.requirementId, rid));
  await invalidateGeneratedCases(rid);
  await db
    .update(requirements)
    .set({
      content: text,
      sourceFile: filename,
      status: "draft",
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(requirements.id, rid));
  return getRequirement(rid);
}

export async function deleteRequirement(rid: string): Promise<void> {
  const row = await getRequirementOr404(rid);
  const mappings = await db
    .select({ testCaseId: requirementCases.testCaseId })
    .from(requirementCases)
    .where(eq(requirementCases.requirementId, rid));
  const caseIds = mappings.map((m) => m.testCaseId);
  if (caseIds.length > 0) {
    // Auto-generated cases die with the version; manual/imported cases stay
    // and only lose the version mapping.
    const caseRows = await db
      .select({ id: testCases.id, source: testCases.source })
      .from(testCases)
      .where(inList(testCases.id, caseIds));
    const generated = caseRows
      .filter((c) => c.source === "rule" || c.source === "ai")
      .map((c) => c.id);
    if (generated.length > 0) {
      await db
        .delete(testCaseVersions)
        .where(inList(testCaseVersions.testCaseId, generated));
      await db.delete(testCases).where(inList(testCases.id, generated));
    }
    await db
      .delete(requirementCases)
      .where(eq(requirementCases.requirementId, rid));
  }
  await db.delete(testPoints).where(eq(testPoints.requirementId, rid));
  await db
    .delete(caseGenerations)
    .where(eq(caseGenerations.requirementId, rid));
  await db
    .delete(requirementCaseChanges)
    .where(eq(requirementCaseChanges.requirementId, rid));
  await db
    .delete(requirementChanges)
    .where(eq(requirementChanges.requirementId, rid));
  await db
    .delete(requirementChangeRuns)
    .where(eq(requirementChangeRuns.requirementId, rid));
  await db
    .delete(requirementSnapshots)
    .where(eq(requirementSnapshots.requirementId, rid));
  await db.delete(requirements).where(eq(requirements.id, row.id));
}

// ---------- Test points ----------

export interface TestPointDict {
  id: string;
  requirementId: string;
  seq: number;
  title: string;
  category: string;
  priority: string;
  description: string;
  pageRoute: string;
  endpoint: string;
  fields: string[];
  expected: string;
  source: string;
  confidence: number;
}

export function testPointToDict(row: TestPointRow): TestPointDict {
  return {
    id: row.id,
    requirementId: row.requirementId,
    seq: row.seq,
    title: row.title,
    category: row.category,
    priority: row.priority,
    description: row.description || "",
    pageRoute: row.pageRoute || "",
    endpoint: row.endpoint || "",
    fields: row.fields ?? [],
    expected: row.expected || "",
    source: row.source,
    confidence: row.confidence,
  };
}

export async function listTestPoints(rid: string): Promise<TestPointDict[]> {
  await getRequirementOr404(rid);
  const rows = await db
    .select()
    .from(testPoints)
    .where(eq(testPoints.requirementId, rid))
    .orderBy(asc(testPoints.seq));
  return rows.map(testPointToDict);
}

async function loadCodeFacts(pid: string): Promise<{
  backend: BackendResult | null;
  frontend: FrontendResult | null;
  machines: StateMachineSpec[];
}> {
  try {
    const ctx = await getGenerationContext(pid);
    return {
      backend: ctx.backend,
      frontend: ctx.frontend,
      machines: ctx.machines as unknown as StateMachineSpec[],
    };
  } catch {
    // No completed analysis yet: test points rely on the PRD alone
    return { backend: null, frontend: null, machines: [] };
  }
}

/**
 * Synchronous test point extraction (shared by the workflow and background
 * jobs). LLM first; unavailable/empty results degrade to rules; mode=rule
 * uses rules only.
 */
export async function parsePoints(
  req: RequirementRow,
  mode: "auto" | "rule" | "llm" = "auto",
  profileId?: string | null,
): Promise<PointInput[]> {
  const { backend, frontend, machines } = await loadCodeFacts(req.projectId);
  let points: PointInput[] = [];
  if (mode === "llm" || mode === "auto") {
    const client = await getTextClient(profileId);
    if (client.available()) {
      try {
        const facts = factsForPrompt(backend, frontend, machines);
        const raw = await extractPointsLlm(client, {
          requirementVersion: req.version,
          requirementName: req.name,
          content: (req.content || "").slice(0, 12000),
          facts,
        });
        points = raw;
      } catch (error) {
        if (!(error instanceof LlmUnavailableError)) throw error;
        // degrade to rules below
      }
    }
  }
  if (points.length === 0) {
    points = extractPointsRule(req.content || "", backend, frontend, machines);
  }
  return filterStaticStructurePoints(points);
}

/** Replace all test points of a requirement; caller handles status. */
export async function savePoints(
  req: RequirementRow,
  points: PointInput[],
): Promise<void> {
  await db.delete(testPoints).where(eq(testPoints.requirementId, req.id));
  let seq = 0;
  for (const point of points) {
    seq += 1;
    await db.insert(testPoints).values({
      id: uuid(),
      requirementId: req.id,
      projectId: req.projectId,
      seq,
      title: point.title,
      category: String(point.category),
      priority: String(point.priority),
      description: point.description || "",
      pageRoute: point.pageRoute || null,
      endpoint: point.endpoint || null,
      fields: point.fields || [],
      expected: point.expected || "",
      source: point.source || "rule",
      confidence: point.confidence || 0.7,
    });
  }
  await db
    .update(requirements)
    .set({ status: "ready", errorMessage: null, updatedAt: new Date() })
    .where(eq(requirements.id, req.id));
}

export async function startRequirementAnalysis(
  rid: string,
  mode: "auto" | "rule" | "llm" = "auto",
  profileId?: string | null,
): Promise<{ requirementId: string; status: string; jobId: string }> {
  const req = await getRequirementOr404(rid);
  if (!(req.content || "").trim()) {
    throw new BizError(
      40014,
      "Requirement content is empty; fill it in or upload a document first",
    );
  }
  await db
    .update(requirements)
    .set({ status: "analyzing", errorMessage: null, updatedAt: new Date() })
    .where(eq(requirements.id, rid));
  const job = createJob("requirement-analysis");
  runJob(job.id, async () => {
    try {
      const fresh = await getRequirementOr404(rid);
      const points = await parsePoints(fresh, mode, profileId);
      await savePoints(fresh, points);
      return { requirementId: rid, points: points.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(requirements)
        .set({
          status: "failed",
          errorMessage: message.slice(0, 2000),
          updatedAt: new Date(),
        })
        .where(eq(requirements.id, rid));
      throw error;
    }
  });
  return { requirementId: rid, status: "analyzing", jobId: job.id };
}

export { normalizePoints };
