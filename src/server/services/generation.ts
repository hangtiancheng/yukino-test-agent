/**
 * Case generation orchestration: load analysis -> rule/LLM generation ->
 * three quality gates -> persist -> coverage self-check.
 */
import { asc, desc, eq } from "drizzle-orm";

import { db } from "#/db";
import {
  caseGenerations,
  codeAnalyses,
  requirementCases,
  testCases,
  testPoints,
  requirements as requirementsTable,
} from "#/db/schema";
import { normalizeCaseCounts } from "#/server/lib/generation/count-assertion";
import { runQualityGate } from "#/server/lib/generation/quality-gate";
import {
  generateLlmCasesForPoints,
  generateProjectCasesLlm,
} from "#/server/lib/generation/llm-cases";
import {
  generateRuleCases,
  generateRuleCasesForPoints,
} from "#/server/lib/generation/rule-cases";
import type { PointInput } from "#/server/lib/generation/test-points";
import { createJob, runJob } from "#/server/lib/jobs";
import { resolveCoverageRefs } from "#/server/lib/coverage";
import { BizError, getTextClient } from "#/server/services/settings";
import {
  getGenerationContext,
  getProjectOr404,
  inList,
  uuid,
} from "#/server/services/projects";
import { getRequirementOr404 } from "#/server/services/requirements";
import {
  clearGeneratedForProject,
  clearGeneratedForRequirement,
  countGeneratedForProject,
  countGeneratedForRequirement,
  saveGeneratedCase,
} from "#/server/services/testcases";
import { asTextList } from "#/server/lib/text-list";

import type {
  BackendResult,
  GeneratedCase,
  StateMachineSpec,
} from "#/lib/types";

export interface GenerationResult {
  generated: number;
  kept: number;
  dropped: number;
  dropReasons: Record<string, number>;
  byType: Record<string, number>;
  mode: "rule" | "llm";
  requestedMode: "auto" | "rule" | "llm";
  llmCaseCount: number;
  ruleCaseCount: number;
  fallback: boolean;
  fallbackReason: string;
  generationId: string | null;
  requirementId: string | null;
  testPointCount: number;
  preservedExisting: boolean;
}

export interface GenerateOptions {
  mode?: "auto" | "rule" | "llm";
  requirementId?: string | null;
  profileId?: string | null;
}

async function pointsForGeneration(rid: string): Promise<PointInput[]> {
  const rows = await db
    .select()
    .from(testPoints)
    .where(eq(testPoints.requirementId, rid))
    .orderBy(asc(testPoints.seq));
  return rows.map((p) => ({
    id: p.id,
    title: p.title,
    category: p.category,
    priority: p.priority,
    description: p.description || "",
    pageRoute: p.pageRoute || "",
    endpoint: p.endpoint || "",
    fields: p.fields ?? [],
    expected: p.expected || "",
    source: p.source,
    confidence: p.confidence,
  }));
}

function enrichCoverageRefs(
  cases: GeneratedCase[],
  backend: BackendResult,
  machines: StateMachineSpec[],
  points: PointInput[],
): void {
  const pointById = new Map(points.map((p) => [String(p.id), p]));
  for (const kase of cases) {
    const testPointId = String(kase.testPointId || "");
    const point = pointById.get(testPointId);
    const pointDict = point
      ? {
          title: point.title,
          category: point.category,
          description: point.description,
          pageRoute: point.pageRoute,
          endpoint: point.endpoint,
          expected: point.expected,
          fields: point.fields,
        }
      : null;
    kase.coverageRefs = resolveCoverageRefs(
      {
        title: kase.title,
        module: kase.module,
        coverageRefs: kase.coverageRefs,
        steps: kase.steps,
        structuredSteps: kase.structuredSteps,
        testData: kase.testData,
      },
      backend,
      machines,
      pointDict,
    );
    if (testPointId) {
      kase.coverageRefs.testPointIds = [testPointId];
    }
  }
}

/** Run generation synchronously (used by the job runner and the pipeline). */
export async function generateCases(
  pid: string,
  options: GenerateOptions = {},
  report: (
    message: string,
    current?: number,
    total?: number,
  ) => void = () => {},
): Promise<GenerationResult> {
  const mode = options.mode ?? "auto";
  await getProjectOr404(pid);
  const requirement = options.requirementId
    ? await getRequirementOr404(options.requirementId)
    : null;
  const { backend, frontend, machines } = await getGenerationContext(pid);
  const machineSpecs = machines as unknown as StateMachineSpec[];
  let points: PointInput[] = [];
  if (requirement) {
    points = await pointsForGeneration(requirement.id);
    if (points.length === 0) {
      throw new BizError(
        40011,
        "No test points for this requirement version; parse it first",
      );
    }
  }

  let actualMode: "rule" | "llm" = "rule";
  let fallbackReason = "";
  let cases: GeneratedCase[] = [];

  if (requirement) {
    report(
      `Generating cases for ${points.length} test points`,
      0,
      points.length,
    );
    if (mode === "llm" || mode === "auto") {
      const client = await getTextClient(options.profileId);
      if (client.available()) {
        const runInfo: { fallbackReason?: string; fallbackAt?: number } = {};
        try {
          const llmCases = await generateLlmCasesForPoints(
            client,
            { version: requirement.version, name: requirement.name },
            points,
            backend,
            frontend,
            machineSpecs,
            {
              onEvent: (event) =>
                report(event.message, event.current, event.total),
              runInfo,
            },
          );
          if (llmCases.length > 0) {
            cases.push(...llmCases);
            actualMode = "llm";
          }
          if (runInfo.fallbackReason) {
            fallbackReason = runInfo.fallbackReason;
          }
        } catch (error) {
          // Degrade the whole requirement to rule mode.
          fallbackReason = `LLM call failed: ${error instanceof Error ? error.message : String(error)}`;
          report(
            `LLM call failed, switching to rule generation: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        fallbackReason = "No usable text LLM configured; using rule generation";
        report("No usable text LLM configured; using rule generation");
      }
    }
    const covered = new Set(cases.map((c) => c.testPointId));
    const missing = points.filter((p) => !covered.has(p.id));
    if (missing.length > 0) {
      report(`Rule fallback for ${missing.length} test points`);
      cases.push(
        ...generateRuleCasesForPoints(missing, backend, frontend, machineSpecs),
      );
    }
  } else {
    // Project-level generation (backward compatible)
    report("Generating project-level rule cases");
    cases = generateRuleCases(backend, frontend, machineSpecs);
    if (mode === "llm" || mode === "auto") {
      const client = await getTextClient(options.profileId);
      if (client.available()) {
        try {
          const llmCases = await generateProjectCasesLlm(
            client,
            backend,
            frontend,
            machineSpecs,
          );
          if (llmCases.length > 0) {
            cases = [...llmCases, ...cases];
            actualMode = "llm";
          }
        } catch (error) {
          // Degrade to rules.
          fallbackReason = `LLM call failed: ${error instanceof Error ? error.message : String(error)}`;
          report(
            `LLM call failed, switching to rule generation: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        fallbackReason = "No usable text LLM configured; using rule generation";
        report("No usable text LLM configured; using rule generation");
      }
    }
  }

  enrichCoverageRefs(cases, backend, machineSpecs, points);
  const listRoutes = frontend.pages.map((p) => p.route).filter(Boolean);
  const normalizedCases: GeneratedCase[] = [];
  for (const kase of cases) {
    const proxy = {
      structuredSteps: kase.structuredSteps,
      expectedResults: kase.expectedResults,
      steps: kase.steps,
      preconditions: kase.preconditions,
    };
    const transformed = normalizeCaseCounts(proxy, listRoutes);
    if (transformed.drop) {
      // Skip fixed-total cases that cannot establish a runtime baseline
      continue;
    }
    if (transformed.changed) {
      // The normalizer reassigns expectedResults/steps on the proxy; copy
      // every field back so the saved case matches the rewritten steps.
      kase.structuredSteps = proxy.structuredSteps;
      kase.expectedResults = proxy.expectedResults;
      kase.steps = proxy.steps;
      kase.preconditions = proxy.preconditions;
    }
    normalizedCases.push(kase);
  }
  cases = normalizedCases;
  const gate = runQualityGate(cases);

  report(`Quality gate kept ${gate.kept.length}/${gate.generated} cases`);
  // An empty gate must not wipe the old cases: when the quality gate or the
  // count-rewriter drops everything, the previous cases are still the most
  // valuable artifact, so only clear when this round actually kept cases.
  const hadExisting = requirement
    ? (await countGeneratedForRequirement(requirement.id)) > 0
    : (await countGeneratedForProject(pid)) > 0;
  const preservedExisting = gate.kept.length === 0 && hadExisting;
  if (gate.kept.length > 0) {
    if (requirement) {
      await clearGeneratedForRequirement(requirement.id);
    } else {
      await clearGeneratedForProject(pid);
    }
  } else if (preservedExisting) {
    report("Generated 0 usable cases; keeping the existing cases");
  }

  const saved: {
    row: Awaited<ReturnType<typeof saveGeneratedCase>>;
    testPointId: string | null;
  }[] = [];
  for (const kase of gate.kept) {
    const testPointId = kase.testPointId ?? null;
    const row = await saveGeneratedCase(
      pid,
      kase,
      requirement ? requirement.id : null,
      testPointId,
    );
    saved.push({ row, testPointId });
    if (saved.length % 5 === 0 || saved.length === gate.kept.length) {
      report(
        `Saved ${saved.length}/${gate.kept.length} cases`,
        saved.length,
        gate.kept.length,
      );
    }
  }

  const byType: Record<string, number> = {};
  for (const kase of gate.kept) {
    byType[String(kase.type)] = (byType[String(kase.type)] ?? 0) + 1;
  }

  // Archive the run as a read-only generation version (B2 history).
  let generationId: string | null = null;
  if (saved.length > 0) {
    generationId = uuid();
    const snapshot = saved.map(({ row, testPointId }) => ({
      id: row.id,
      testPointId,
      title: row.title,
      module: row.module,
      type: row.type,
      priority: row.priority,
      source: row.source,
      qualityScore: row.qualityScore,
      expectedResults: asTextList(row.expectedResults ?? []),
    }));
    const sourceCounts = countBy(saved.map(({ row }) => row.source));
    const summary = {
      mode: actualMode,
      requestedMode: mode,
      profileId: options.profileId ?? null,
      fallback: Boolean(fallbackReason),
      fallbackReason,
      llmCaseCount: sourceCounts.ai ?? 0,
      ruleCaseCount: sourceCounts.rule ?? 0,
      dropReasons: gate.dropReasons,
      byType,
    };
    await db.insert(caseGenerations).values({
      id: generationId,
      projectId: pid,
      requirementId: requirement ? requirement.id : null,
      mode: actualMode,
      profileId: options.profileId ?? null,
      caseCount: saved.length,
      summary,
      snapshot,
    });
  }

  const sourceCounts = countBy(gate.kept.map((kase) => String(kase.source)));
  return {
    generated: gate.generated,
    kept: gate.kept.length,
    dropped: gate.dropped,
    dropReasons: gate.dropReasons,
    byType,
    mode: actualMode,
    requestedMode: mode,
    llmCaseCount: sourceCounts.ai ?? 0,
    ruleCaseCount: sourceCounts.rule ?? 0,
    fallback: Boolean(fallbackReason),
    fallbackReason,
    generationId,
    requirementId: requirement ? requirement.id : null,
    testPointCount: points.length,
    preservedExisting,
  };
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) {
    const key = value || "unknown";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Start generation as a background job; returns the job id for polling. */
export async function startGeneration(
  pid: string,
  options: GenerateOptions = {},
): Promise<{ jobId: string }> {
  const job = createJob("generation");
  runJob(job.id, async (report) => {
    const result = await generateCases(pid, options, report);
    return result;
  });
  return { jobId: job.id };
}

// ---------- Generation version history (read-only archives) ----------

export interface CaseGenerationSummary {
  id: string;
  requirementId: string | null;
  mode: string;
  profileId: string | null;
  caseCount: number;
  summary: Record<string, unknown>;
  isLatest: boolean;
  createdAt: string | null;
}

export interface CaseGenerationDetail extends CaseGenerationSummary {
  cases: Record<string, unknown>[];
}

/**
 * Live cases that predate version archiving have no generation rows; on the
 * first version-list read, archive them once as a read-only "legacy" version.
 * This never mutates cases or requirements and does not imply the cases came
 * from a single generation run.
 */
async function ensureLegacyGeneration(rid: string): Promise<void> {
  const existing = await db
    .select({ id: caseGenerations.id })
    .from(caseGenerations)
    .where(eq(caseGenerations.requirementId, rid))
    .limit(1);
  if (existing.length > 0) return;

  const requirement = await db
    .select()
    .from(requirementsTable)
    .where(eq(requirementsTable.id, rid))
    .limit(1);
  const req = requirement[0];
  if (!req) return;

  const mappings = await db
    .select({
      testCaseId: requirementCases.testCaseId,
      testPointId: requirementCases.testPointId,
    })
    .from(requirementCases)
    .where(eq(requirementCases.requirementId, rid));
  if (mappings.length === 0) return;
  const pointByCase = new Map(
    mappings.map((m) => [m.testCaseId, m.testPointId]),
  );
  const rows = (await db
    .select()
    .from(testCases)
    .where(
      inList(
        testCases.id,
        mappings.map((m) => m.testCaseId),
      ),
    )
    .orderBy(asc(testCases.projectSeq))) as Awaited<
    ReturnType<typeof saveGeneratedCase>
  >[];
  if (rows.length === 0) return;

  const snapshot = rows.map((row) => ({
    id: row.id,
    testPointId: pointByCase.get(row.id) ?? null,
    title: row.title,
    module: row.module,
    type: row.type,
    priority: row.priority,
    source: row.source,
    qualityScore: row.qualityScore,
    expectedResults: asTextList(row.expectedResults ?? []),
  }));
  const sourceCounts = countBy(rows.map((row) => row.source));
  const byType = countBy(rows.map((row) => row.type));
  const createdAt = rows.reduce<Date | null>(
    (acc, row) =>
      row.createdAt && (!acc || row.createdAt > acc) ? row.createdAt : acc,
    null,
  );
  await db.insert(caseGenerations).values({
    id: uuid(),
    projectId: req.projectId,
    requirementId: rid,
    mode: "legacy",
    profileId: null,
    caseCount: rows.length,
    summary: {
      legacy: true,
      note: "Live cases that predate version archiving; auto-archived on first view. Does not represent a single generation run.",
      llmCaseCount: sourceCounts.ai ?? 0,
      ruleCaseCount: sourceCounts.rule ?? 0,
      byType,
      fallback: false,
      fallbackReason: "",
    },
    snapshot,
    createdAt: createdAt ?? undefined,
  });
}

export async function listCaseGenerations(
  rid: string,
  limit = 50,
): Promise<CaseGenerationSummary[]> {
  // Back-fill failure must not block the version list.
  try {
    await ensureLegacyGeneration(rid);
  } catch {
    // ignore; the list still works without the legacy archive
  }
  const rows = await db
    .select()
    .from(caseGenerations)
    .where(eq(caseGenerations.requirementId, rid))
    .orderBy(desc(caseGenerations.createdAt))
    .limit(Math.max(1, Math.min(100, limit)));
  const latestId = rows[0]?.id ?? null;
  return rows.map((row) => ({
    id: row.id,
    requirementId: row.requirementId,
    mode: row.mode,
    profileId: row.profileId,
    caseCount: row.caseCount,
    summary: row.summary ?? {},
    isLatest: row.id === latestId,
    createdAt: row.createdAt?.toISOString() ?? null,
  }));
}

export async function getCaseGeneration(
  rid: string,
  generationId: string,
): Promise<CaseGenerationDetail> {
  const rows = await db
    .select()
    .from(caseGenerations)
    .where(eq(caseGenerations.id, generationId))
    .limit(1);
  const row = rows[0];
  if (!row || row.requirementId !== rid) {
    throw new BizError(40409, `Generation version not found: ${generationId}`);
  }
  const cases = (row.snapshot ?? []).map((item) => ({
    ...item,
    expectedResults: asTextList((item.expectedResults ?? []) as unknown[]),
  }));
  return {
    id: row.id,
    requirementId: row.requirementId,
    mode: row.mode,
    profileId: row.profileId,
    caseCount: row.caseCount,
    summary: row.summary ?? {},
    isLatest: false,
    createdAt: row.createdAt?.toISOString() ?? null,
    cases,
  };
}

/** Coverage self-check: verified transitions without cases, unused endpoints. */
export async function coverageGaps(pid: string): Promise<{
  transitionGaps: { from: string; to: string; trigger: string }[];
  endpointGaps: never[];
}> {
  const { machines } = await getGenerationContext(pid);
  const caseRows = await db
    .select({ coverageRefs: testCases.coverageRefs })
    .from(testCases)
    .where(eq(testCases.projectId, pid));
  const referencedTransitions = new Set<string>();
  for (const row of caseRows) {
    const refs = row.coverageRefs;
    for (const id of refs?.transitionIds ?? []) referencedTransitions.add(id);
  }
  const transitionGaps: { from: string; to: string; trigger: string }[] = [];
  for (const machine of machines) {
    for (const t of (machine.transitions ?? []) as {
      id?: string;
      from: string;
      to: string;
      trigger?: string;
      verified?: boolean;
    }[]) {
      if (t.verified && t.id && !referencedTransitions.has(t.id)) {
        transitionGaps.push({
          from: t.from,
          to: t.to,
          trigger: t.trigger || "",
        });
      }
    }
  }
  return { transitionGaps, endpointGaps: [] };
}

export { codeAnalyses, requirementCases };
