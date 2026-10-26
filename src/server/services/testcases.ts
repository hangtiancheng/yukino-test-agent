/**
 * Test case service: CRUD, version history/rollback, batch operations,
 * CSV import/export.
 */
import { asc, desc, eq } from "drizzle-orm";

import { db } from "#/db";
import {
  executionRecords,
  idSequences,
  requirementCases,
  testCaseVersions,
  testCases,
} from "#/db/schema";
import { CASE_EXECUTION_STATUS_META, meta } from "#/lib/enums";
import { asTextList } from "#/server/lib/text-list";
import { runQualityGate } from "#/server/lib/generation/quality-gate";
import { BizError } from "#/server/services/settings";
import { getProjectOr404, inList, uuid } from "#/server/services/projects";

import type { CoverageRefs, GeneratedCase, StructuredStep } from "#/lib/types";

export type TestCaseRow = typeof testCases.$inferSelect & {
  preconditions: string[];
  steps: string[];
  expectedResults: string[];
  structuredSteps: StructuredStep[];
  testData: Record<string, string>;
  coverageRefs: CoverageRefs;
  lintIssues: string[];
};

export interface CaseDict {
  id: string;
  projectSeq: number;
  projectId: string;
  title: string;
  module: string;
  type: string;
  priority: string;
  preconditions: string[];
  steps: string[];
  expectedResults: string[];
  structuredSteps: StructuredStep[];
  testData: Record<string, string>;
  coverageRefs: CoverageRefs;
  source: string;
  confidence: number;
  qualityScore: number;
  lintIssues: string[];
  executionStatus: string;
  executionStatusLabel: string;
  executionStatusDescription: string;
  executionStatusTone: string;
  createdAt: string | null;
  updatedAt: string | null;
  requirementId?: string | null;
  testPointId?: string | null;
}

export function caseToDict(row: TestCaseRow): CaseDict {
  const statusMeta = meta(CASE_EXECUTION_STATUS_META, row.executionStatus);
  return {
    id: row.id,
    projectSeq: row.projectSeq,
    projectId: row.projectId,
    title: row.title,
    module: row.module,
    type: row.type,
    priority: row.priority,
    preconditions: row.preconditions ?? [],
    steps: row.steps ?? [],
    expectedResults: asTextList(row.expectedResults ?? []),
    structuredSteps: row.structuredSteps ?? [],
    testData: row.testData ?? {},
    coverageRefs: row.coverageRefs ?? {
      endpointIds: [],
      transitionIds: [],
      ruleIds: [],
    },
    source: row.source,
    confidence: row.confidence,
    qualityScore: row.qualityScore,
    lintIssues: row.lintIssues ?? [],
    executionStatus: row.executionStatus,
    executionStatusLabel: statusMeta.label,
    executionStatusDescription: statusMeta.description,
    executionStatusTone: statusMeta.tone,
    createdAt: row.createdAt?.toISOString() ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

export async function getCaseOr404(cid: string): Promise<TestCaseRow> {
  const rows = await db.select().from(testCases).where(eq(testCases.id, cid));
  const row = rows[0] as TestCaseRow | undefined;
  if (!row) throw new BizError(40405, `Test case not found: ${cid}`);
  return row;
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Allocate the next value of a named sequence under a row lock so two workers
 * generating cases concurrently never receive the same number. The previous
 * max(id)+1 scan raced and could hand out a duplicate primary key. `scanMax`
 * reseeds the counter from existing rows (e.g. after a restore) so it never
 * goes backwards. Must run inside the same transaction as the insert.
 */
async function nextSequenceValue(
  tx: Tx,
  name: string,
  scanMax: () => Promise<number>,
): Promise<number> {
  const maxExisting = await scanMax();
  let rows = await tx
    .select()
    .from(idSequences)
    .where(eq(idSequences.name, name))
    .for("update");
  if (rows.length === 0) {
    await tx
      .insert(idSequences)
      .values({ name, value: maxExisting })
      .onConflictDoNothing({ target: idSequences.name });
    rows = await tx
      .select()
      .from(idSequences)
      .where(eq(idSequences.name, name))
      .for("update");
  }
  const next = Math.max(rows[0]?.value ?? 0, maxExisting) + 1;
  await tx
    .update(idSequences)
    .set({ value: next, updatedAt: new Date() })
    .where(eq(idSequences.name, name));
  return next;
}

/** Global TC-{6-digit sequence} numbering (numeric compare, not lexical). */
async function nextTcIdInTx(tx: Tx): Promise<string> {
  const value = await nextSequenceValue(tx, "test_case", async () => {
    const ids = await tx.select({ id: testCases.id }).from(testCases);
    let maxNum = 0;
    for (const { id } of ids) {
      if (id.startsWith("TC-")) {
        const num = Number.parseInt(id.slice(3), 10);
        if (Number.isFinite(num)) maxNum = Math.max(maxNum, num);
      }
    }
    return maxNum;
  });
  return `TC-${String(value).padStart(6, "0")}`;
}

async function nextProjectSeqInTx(tx: Tx, pid: string): Promise<number> {
  return nextSequenceValue(tx, `project_seq:${pid}`, async () => {
    const rows = await tx
      .select({ projectSeq: testCases.projectSeq })
      .from(testCases)
      .where(eq(testCases.projectId, pid));
    return rows.reduce((acc, row) => Math.max(acc, row.projectSeq), 0);
  });
}

/**
 * Insert a generated case (+ requirement mapping) inside an existing
 * transaction so callers can batch several saves atomically. The id/seq
 * allocation shares the transaction so the sequence row lock is held until
 * commit. Returns the new case id.
 */
export async function saveGeneratedCaseInTx(
  tx: Tx,
  pid: string,
  kase: GeneratedCase,
  requirementId?: string | null,
  testPointId?: string | null,
): Promise<string> {
  const tcId = await nextTcIdInTx(tx);
  const projectSeq = await nextProjectSeqInTx(tx, pid);
  await tx.insert(testCases).values({
    id: tcId,
    projectSeq,
    projectId: pid,
    title: kase.title,
    module: kase.module,
    type: String(kase.type),
    priority: String(kase.priority),
    preconditions: kase.preconditions,
    steps: kase.steps,
    expectedResults: kase.expectedResults,
    structuredSteps: kase.structuredSteps,
    testData: kase.testData,
    coverageRefs: kase.coverageRefs,
    source: String(kase.source),
    confidence: kase.confidence,
    qualityScore: kase.qualityScore ?? 100,
    lintIssues: kase.lintIssues ?? [],
    executionStatus: "not_run",
  });
  if (requirementId) {
    await tx.insert(requirementCases).values({
      id: uuid(),
      requirementId,
      testCaseId: tcId,
      testPointId: testPointId ?? null,
    });
  }
  return tcId;
}

export async function saveGeneratedCase(
  pid: string,
  kase: GeneratedCase,
  requirementId?: string | null,
  testPointId?: string | null,
): Promise<TestCaseRow> {
  const id = await db.transaction(async (tx) =>
    saveGeneratedCaseInTx(tx, pid, kase, requirementId, testPointId),
  );
  return getCaseOr404(id);
}

export interface CaseListFilters {
  requirementId?: string | null;
  type?: string | null;
  priority?: string | null;
  executionStatus?: string | null;
  source?: string | null;
  keyword?: string | null;
}

export async function listCases(
  pid: string,
  filters: CaseListFilters = {},
): Promise<CaseDict[]> {
  await getProjectOr404(pid);
  let rows = (await db
    .select()
    .from(testCases)
    .where(eq(testCases.projectId, pid))
    .orderBy(asc(testCases.projectSeq))) as TestCaseRow[];

  if (filters.requirementId === "__none__") {
    // Unmapped scope: exclude every case already linked to some requirement
    // version (mirrors legacy testcase_service "__none__" branch).
    const projectIds = rows.map((r) => r.id);
    const mapped = new Set<string>();
    if (projectIds.length > 0) {
      const links = await db
        .select({ testCaseId: requirementCases.testCaseId })
        .from(requirementCases)
        .where(inList(requirementCases.testCaseId, projectIds));
      for (const link of links) mapped.add(link.testCaseId);
    }
    rows = rows.filter((row) => !mapped.has(row.id));
  } else if (filters.requirementId) {
    const mappings = await db
      .select({ testCaseId: requirementCases.testCaseId })
      .from(requirementCases)
      .where(eq(requirementCases.requirementId, filters.requirementId));
    const ids = new Set(mappings.map((m) => m.testCaseId));
    rows = rows.filter((row) => ids.has(row.id));
  }
  if (filters.type) rows = rows.filter((row) => row.type === filters.type);
  if (filters.priority)
    rows = rows.filter((row) => row.priority === filters.priority);
  if (filters.executionStatus) {
    rows = rows.filter(
      (row) => row.executionStatus === filters.executionStatus,
    );
  }
  if (filters.source)
    rows = rows.filter((row) => row.source === filters.source);
  if (filters.keyword) {
    const kw = filters.keyword.toLowerCase();
    rows = rows.filter(
      (row) =>
        row.title.toLowerCase().includes(kw) ||
        row.module.toLowerCase().includes(kw) ||
        row.id.toLowerCase().includes(kw),
    );
  }

  // Attach requirement/test point mapping info
  const mappings = await db
    .select()
    .from(requirementCases)
    .where(
      inList(
        requirementCases.testCaseId,
        rows.map((r) => r.id),
      ),
    );
  const mappingByCase = new Map(mappings.map((m) => [m.testCaseId, m]));
  return rows.map((row) => {
    const dict = caseToDict(row);
    const mapping = mappingByCase.get(row.id);
    dict.requirementId = mapping?.requirementId ?? null;
    dict.testPointId = mapping?.testPointId ?? null;
    return dict;
  });
}

export async function getCase(cid: string): Promise<CaseDict> {
  const row = await getCaseOr404(cid);
  const dict = caseToDict(row);
  const mappings = await db
    .select()
    .from(requirementCases)
    .where(eq(requirementCases.testCaseId, cid));
  dict.requirementId = mappings[0]?.requirementId ?? null;
  dict.testPointId = mappings[0]?.testPointId ?? null;
  return dict;
}

export interface CaseUpdateInput {
  title?: string;
  module?: string;
  type?: string;
  priority?: string;
  preconditions?: string[];
  steps?: string[];
  expectedResults?: string[];
  structuredSteps?: StructuredStep[];
  testData?: Record<string, string>;
  coverageRefs?: CoverageRefs;
  executionStatus?: string;
  source?: string;
  changeNote?: string;
}

async function snapshotVersion(
  cid: string,
  note: string | null,
): Promise<void> {
  const row = await getCaseOr404(cid);
  const versions = await db
    .select({ version: testCaseVersions.version })
    .from(testCaseVersions)
    .where(eq(testCaseVersions.testCaseId, cid));
  const nextVersion =
    versions.reduce((acc, v) => Math.max(acc, v.version), 0) + 1;
  await db.insert(testCaseVersions).values({
    id: uuid(),
    testCaseId: cid,
    version: nextVersion,
    snapshot: caseToDict(row) as unknown as Record<string, unknown>,
    changeNote: note,
  });
}

/**
 * Re-run the deterministic quality gate for a merged case edit. Rejects
 * edits that would drop the case below the bar (no expected results or a
 * score under 40); otherwise returns the fresh score/lint issues to persist.
 */
function gateOrReject(kase: GeneratedCase): {
  qualityScore: number;
  lintIssues: string[];
} {
  const gate = runQualityGate([{ ...kase }]);
  const kept = gate.kept[0];
  if (!kept) {
    throw new BizError(
      40011,
      "Case failed the quality gate (no expected results or score too low)",
    );
  }
  return {
    qualityScore: kept.qualityScore ?? 0,
    lintIssues: kept.lintIssues ?? [],
  };
}

export async function updateCase(
  cid: string,
  input: CaseUpdateInput,
): Promise<CaseDict> {
  const row = await getCaseOr404(cid);
  if (
    input.structuredSteps !== undefined &&
    input.structuredSteps.length === 0
  ) {
    throw new BizError(40012, "structuredSteps cannot be empty");
  }
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of [
    "title",
    "module",
    "type",
    "priority",
    "preconditions",
    "steps",
    "expectedResults",
    "structuredSteps",
    "testData",
    "coverageRefs",
    "executionStatus",
    "source",
  ] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  // Gate the merged state before any write so a rejected edit leaves no
  // version snapshot and no partial patch behind.
  const gated = gateOrReject({
    title: (patch.title as string | undefined) ?? row.title,
    module: (patch.module as string | undefined) ?? row.module,
    type: (patch.type as string | undefined) ?? row.type,
    priority: (patch.priority as string | undefined) ?? row.priority,
    preconditions:
      (patch.preconditions as string[] | undefined) ?? row.preconditions ?? [],
    steps: (patch.steps as string[] | undefined) ?? row.steps ?? [],
    expectedResults:
      (patch.expectedResults as string[] | undefined) ??
      row.expectedResults ??
      [],
    structuredSteps:
      (patch.structuredSteps as StructuredStep[] | undefined) ??
      row.structuredSteps ??
      [],
    testData:
      (patch.testData as Record<string, string> | undefined) ??
      row.testData ??
      {},
    coverageRefs:
      (patch.coverageRefs as CoverageRefs | undefined) ?? row.coverageRefs,
    source: (patch.source as string | undefined) ?? row.source,
    confidence: row.confidence,
  });
  patch.qualityScore = gated.qualityScore;
  patch.lintIssues = gated.lintIssues;
  await snapshotVersion(cid, input.changeNote ?? "Edited");
  await db.update(testCases).set(patch).where(eq(testCases.id, row.id));
  return getCase(cid);
}

export async function deleteCase(cid: string): Promise<void> {
  await getCaseOr404(cid);
  await db.delete(testCaseVersions).where(eq(testCaseVersions.testCaseId, cid));
  await db.delete(requirementCases).where(eq(requirementCases.testCaseId, cid));
  await db.delete(testCases).where(eq(testCases.id, cid));
}

export async function deleteCasesBulk(
  cids: string[],
): Promise<{ deleted: number }> {
  if (cids.length === 0) return { deleted: 0 };
  await db
    .delete(testCaseVersions)
    .where(inList(testCaseVersions.testCaseId, cids));
  await db
    .delete(requirementCases)
    .where(inList(requirementCases.testCaseId, cids));
  await db.delete(testCases).where(inList(testCases.id, cids));
  return { deleted: cids.length };
}

export async function listVersions(cid: string) {
  await getCaseOr404(cid);
  const rows = await db
    .select()
    .from(testCaseVersions)
    .where(eq(testCaseVersions.testCaseId, cid))
    .orderBy(desc(testCaseVersions.version));
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    changeNote: row.changeNote,
    createdAt: row.createdAt?.toISOString() ?? null,
    snapshot: row.snapshot,
  }));
}

export async function rollbackVersion(
  cid: string,
  vid: string,
): Promise<CaseDict> {
  const row = await getCaseOr404(cid);
  const versions = await db
    .select()
    .from(testCaseVersions)
    .where(eq(testCaseVersions.testCaseId, cid));
  const target = versions.find((v) => v.id === vid);
  if (!target) throw new BizError(40407, `Version not found: ${vid}`);
  const snapshot = target.snapshot as unknown as CaseDict;
  const restored: GeneratedCase = {
    title: snapshot.title ?? row.title,
    module: snapshot.module ?? row.module,
    type: snapshot.type ?? row.type,
    priority: snapshot.priority ?? row.priority,
    preconditions: snapshot.preconditions ?? [],
    steps: snapshot.steps ?? [],
    expectedResults: snapshot.expectedResults ?? [],
    structuredSteps: snapshot.structuredSteps ?? [],
    testData: snapshot.testData ?? {},
    coverageRefs: snapshot.coverageRefs ?? {
      endpointIds: [],
      transitionIds: [],
      ruleIds: [],
    },
    source: snapshot.source ?? row.source,
    confidence: row.confidence,
  };
  // Gate the restored content before writing anything.
  const gated = gateOrReject(restored);
  await snapshotVersion(cid, `Before rollback to v${target.version}`);
  const executionStatus =
    snapshot.executionStatus &&
    snapshot.executionStatus in CASE_EXECUTION_STATUS_META
      ? snapshot.executionStatus
      : row.executionStatus;
  await db
    .update(testCases)
    .set({
      title: restored.title,
      module: restored.module,
      type: restored.type,
      priority: restored.priority,
      preconditions: restored.preconditions,
      steps: restored.steps,
      expectedResults: restored.expectedResults,
      structuredSteps: restored.structuredSteps,
      testData: restored.testData,
      coverageRefs: restored.coverageRefs,
      source: restored.source,
      executionStatus,
      qualityScore: gated.qualityScore,
      lintIssues: gated.lintIssues,
      updatedAt: new Date(),
    })
    .where(eq(testCases.id, cid));
  return getCase(cid);
}

export async function updateExecutionStatus(
  cid: string,
  status: string,
): Promise<CaseDict> {
  await getCaseOr404(cid);
  if (!(status in CASE_EXECUTION_STATUS_META)) {
    throw new BizError(40020, `Unknown execution status: ${status}`);
  }
  await db
    .update(testCases)
    .set({ executionStatus: status, updatedAt: new Date() })
    .where(eq(testCases.id, cid));
  return getCase(cid);
}

// ---------- CSV import/export ----------

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

export async function exportCasesCsv(pid: string): Promise<string> {
  const cases = await listCases(pid);
  const header = [
    "id",
    "title",
    "module",
    "type",
    "priority",
    "preconditions",
    "steps",
    "expectedResults",
    "source",
    "executionStatus",
  ];
  const lines = [header.join(",")];
  for (const c of cases) {
    lines.push(
      [
        c.id,
        c.title,
        c.module,
        c.type,
        c.priority,
        c.preconditions.join(" | "),
        c.steps.join(" | "),
        c.expectedResults.join(" | "),
        c.source,
        c.executionStatus,
      ]
        .map((v) => csvEscape(String(v ?? "")))
        .join(","),
    );
  }
  return lines.join("\n");
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

export async function importCasesCsv(
  pid: string,
  csv: string,
): Promise<{ imported: number }> {
  await getProjectOr404(pid);
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new BizError(40021, "CSV has no data rows");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string): number => header.indexOf(name);
  const titleIdx = col("title");
  if (titleIdx < 0)
    throw new BizError(40022, 'CSV must contain a "title" column');
  const moduleIdx = col("module");
  const typeIdx = col("type");
  const priorityIdx = col("priority");
  const preIdx = col("preconditions");
  const stepsIdx = col("steps");
  const expectedIdx = col("expectedresults");

  let imported = 0;
  for (const row of rows.slice(1)) {
    const title = (row[titleIdx] || "").trim();
    if (!title) continue;
    const splitPipe = (value: string | undefined): string[] =>
      (value || "")
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
    const steps = splitPipe(row[stepsIdx ?? -1]);
    await saveGeneratedCase(
      pid,
      {
        title: title.slice(0, 255),
        module: (row[moduleIdx ?? -1] || "").trim().slice(0, 120),
        type: (row[typeIdx ?? -1] || "positive").trim(),
        priority: (row[priorityIdx ?? -1] || "P1").trim(),
        preconditions: splitPipe(row[preIdx ?? -1]),
        steps,
        expectedResults: splitPipe(row[expectedIdx ?? -1]),
        structuredSteps: [],
        testData: {},
        coverageRefs: { endpointIds: [], transitionIds: [], ruleIds: [] },
        source: "import",
        confidence: 1,
      },
      null,
      null,
    );
    imported += 1;
  }
  return { imported };
}

export async function copyCasesTo(
  sourcePid: string,
  targetPid: string,
  cids: string[],
): Promise<{ copied: number }> {
  await getProjectOr404(sourcePid);
  await getProjectOr404(targetPid);
  const rows = (await db
    .select()
    .from(testCases)
    .where(inList(testCases.id, cids))) as TestCaseRow[];
  let copied = 0;
  for (const row of rows) {
    await saveGeneratedCase(
      targetPid,
      {
        title: row.title,
        module: row.module,
        type: row.type,
        priority: row.priority,
        preconditions: row.preconditions ?? [],
        steps: row.steps ?? [],
        expectedResults: row.expectedResults ?? [],
        structuredSteps: row.structuredSteps ?? [],
        testData: row.testData ?? {},
        coverageRefs: row.coverageRefs ?? {
          endpointIds: [],
          transitionIds: [],
          ruleIds: [],
        },
        source: "manual",
        confidence: row.confidence,
      },
      null,
      null,
    );
    copied += 1;
  }
  return { copied };
}

export async function createManualCase(
  pid: string,
  input: CaseUpdateInput,
): Promise<CaseDict> {
  await getProjectOr404(pid);
  const title = (input.title || "").trim();
  if (!title) throw new BizError(40023, "Case title is required");
  const structuredSteps = input.structuredSteps ?? [];
  if (structuredSteps.length === 0) {
    throw new BizError(40012, "structuredSteps cannot be empty");
  }
  const kase: GeneratedCase = {
    title: title.slice(0, 255),
    module: (input.module || "").slice(0, 120),
    type: input.type || "positive",
    priority: input.priority || "P1",
    preconditions: input.preconditions ?? [],
    steps: input.steps ?? [],
    expectedResults: input.expectedResults ?? [],
    structuredSteps,
    testData: input.testData ?? {},
    coverageRefs: input.coverageRefs ?? {
      endpointIds: [],
      transitionIds: [],
      ruleIds: [],
    },
    source: "manual",
    confidence: 1,
  };
  const gated = gateOrReject(kase);
  const row = await saveGeneratedCase(
    pid,
    {
      ...kase,
      qualityScore: gated.qualityScore,
      lintIssues: gated.lintIssues,
    },
    null,
    null,
  );
  return caseToDict(row);
}

/** Cases of a project that belong to a requirement (via mapping). */
export async function casesForRequirement(
  rid: string,
): Promise<{ row: TestCaseRow; mapping: { testPointId: string | null } }[]> {
  const mappings = await db
    .select()
    .from(requirementCases)
    .where(eq(requirementCases.requirementId, rid));
  if (mappings.length === 0) return [];
  const rows = (await db
    .select()
    .from(testCases)
    .where(
      inList(
        testCases.id,
        mappings.map((m) => m.testCaseId),
      ),
    )) as TestCaseRow[];
  const mappingByCase = new Map(mappings.map((m) => [m.testCaseId, m]));
  return rows.map((row) => ({
    row,
    mapping: { testPointId: mappingByCase.get(row.id)?.testPointId ?? null },
  }));
}

/** Count generated (rule/ai) cases mapped to a requirement version. */
export async function countGeneratedForRequirement(
  rid: string,
): Promise<number> {
  const mappings = await db
    .select({ testCaseId: requirementCases.testCaseId })
    .from(requirementCases)
    .where(eq(requirementCases.requirementId, rid));
  const caseIds = mappings.map((m) => m.testCaseId);
  if (caseIds.length === 0) return 0;
  const rows = await db
    .select({ id: testCases.id, source: testCases.source })
    .from(testCases)
    .where(inList(testCases.id, caseIds));
  return rows.filter((row) => row.source === "rule" || row.source === "ai")
    .length;
}

/** Count generated (rule/ai) cases in a project. */
export async function countGeneratedForProject(pid: string): Promise<number> {
  const rows = await db
    .select({ source: testCases.source })
    .from(testCases)
    .where(eq(testCases.projectId, pid));
  return rows.filter((row) => row.source === "rule" || row.source === "ai")
    .length;
}

export async function clearGeneratedForRequirement(rid: string): Promise<void> {
  const mappings = await db
    .select({ testCaseId: requirementCases.testCaseId })
    .from(requirementCases)
    .where(eq(requirementCases.requirementId, rid));
  const caseIds = mappings.map((m) => m.testCaseId);
  if (caseIds.length === 0) return;
  const rows = await db
    .select({ id: testCases.id, source: testCases.source })
    .from(testCases)
    .where(inList(testCases.id, caseIds));
  const generated = rows
    .filter((row) => row.source === "rule" || row.source === "ai")
    .map((row) => row.id);
  if (generated.length === 0) return;
  await db
    .delete(testCaseVersions)
    .where(inList(testCaseVersions.testCaseId, generated));
  await db
    .delete(requirementCases)
    .where(inList(requirementCases.testCaseId, generated));
  await db.delete(testCases).where(inList(testCases.id, generated));
}

export async function clearGeneratedForProject(pid: string): Promise<void> {
  const rows = await db
    .select({ id: testCases.id, source: testCases.source })
    .from(testCases)
    .where(eq(testCases.projectId, pid));
  const oldIds = rows
    .filter((row) => row.source === "rule" || row.source === "ai")
    .map((row) => row.id);
  if (oldIds.length === 0) return;
  await db
    .delete(testCaseVersions)
    .where(inList(testCaseVersions.testCaseId, oldIds));
  // Clean mappings too, otherwise orphan mappings wrongly re-associate when
  // new cases reuse TC-xxxx ids.
  await db
    .delete(requirementCases)
    .where(inList(requirementCases.testCaseId, oldIds));
  await db.delete(testCases).where(inList(testCases.id, oldIds));
}

export { executionRecords };
