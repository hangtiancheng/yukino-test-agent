import { z } from "zod";

import {
  getLatestAnalysis,
  listStateMachines,
  triggerAnalysis,
} from "#/server/services/analysis";
import { fixCase, rerunGate, reviewCases } from "#/server/services/case-review";
import { getCoverageMatrix } from "#/server/services/coverage";
import {
  cancelBatch,
  getExecution,
  getExecutionSteps,
  getJobState,
  listExecutions,
  listExecutionsForCase,
  llmReview,
  manualReview,
  runCaseExecution,
  startBatchExecution,
  startBatchLlmReview,
  startSingleExecution,
} from "#/server/services/executions";
import {
  coverageGaps,
  generateCases,
  getCaseGeneration,
  listCaseGenerations,
  startGeneration,
} from "#/server/services/generation";
import {
  getMindmap,
  getMindmapMarkdown,
  getMindmapXmind,
} from "#/server/services/mindmap";
import {
  createProject,
  deleteProject,
  getGenerationContext,
  getPrd,
  getProject,
  listProjects,
  updatePrd,
  updateProject,
  uploadPrd,
} from "#/server/services/projects";
import {
  createRequirement,
  deleteRequirement,
  getRequirement,
  listRequirements,
  listTestPoints,
  startRequirementAnalysis,
  updateRequirement,
  uploadRequirementPrd,
} from "#/server/services/requirements";
import {
  createProfile,
  deleteProfile,
  getSettingsInfo,
  listProfiles,
  setDefaultProfile,
  testLlm,
  updateProfile,
} from "#/server/services/settings";
import { getOverview } from "#/server/services/stats";
import {
  casesForRequirement,
  clearGeneratedForProject,
  clearGeneratedForRequirement,
  copyCasesTo,
  createManualCase,
  deleteCase,
  deleteCasesBulk,
  exportCasesCsv,
  getCase,
  importCasesCsv,
  listCases,
  listVersions,
  rollbackVersion,
  updateCase,
} from "#/server/services/testcases";
import {
  analyzeIncremental,
  buildSnapshot,
  generateIncremental,
  getLatestSnapshot,
  getRun as getIncrementalRun,
  latestRun as latestIncrementalRun,
  listRuns as listIncrementalRuns,
  reviewChange as reviewIncrementalChange,
  reviewRegression as reviewIncrementalRegression,
  startIncrementalGeneration,
} from "#/server/services/incremental";
import { createRun, getRunDetail, listRuns } from "#/server/services/workflows";

import { createTRPCRouter, publicProcedure } from "./init";

import type { TRPCRouterRecord } from "@trpc/server";

const pidInput = z.object({ pid: z.string().min(1) });

// ---------- projects ----------

const projectUpsert = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  sourceType: z.string().optional(),
  sourcePath: z.string().nullable().optional(),
  gitUrl: z.string().nullable().optional(),
  gitBranch: z.string().nullable().optional(),
  targetUrl: z.string().nullable().optional(),
});

const projectsRouter = {
  list: publicProcedure.query(() => listProjects()),
  get: publicProcedure
    .input(pidInput)
    .query(({ input }) => getProject(input.pid)),
  create: publicProcedure
    .input(projectUpsert)
    .mutation(({ input }) => createProject(input)),
  update: publicProcedure
    .input(projectUpsert.extend({ pid: z.string().min(1) }))
    .mutation(({ input }) => {
      const { pid, ...rest } = input;
      return updateProject(pid, rest);
    }),
  delete: publicProcedure
    .input(pidInput)
    .mutation(({ input }) => deleteProject(input.pid)),
  prd: publicProcedure.input(pidInput).query(({ input }) => getPrd(input.pid)),
  updatePrd: publicProcedure
    .input(z.object({ pid: z.string().min(1), content: z.string() }))
    .mutation(({ input }) => updatePrd(input.pid, input.content)),
  uploadPrd: publicProcedure
    .input(
      z.object({
        pid: z.string().min(1),
        filename: z.string(),
        base64: z.string(),
      }),
    )
    .mutation(({ input }) =>
      uploadPrd(input.pid, input.filename, Buffer.from(input.base64, "base64")),
    ),
  generationContext: publicProcedure
    .input(pidInput)
    .query(({ input }) => getGenerationContext(input.pid)),
} satisfies TRPCRouterRecord;

// ---------- analysis ----------

const analysisRouter = {
  trigger: publicProcedure
    .input(pidInput)
    .mutation(({ input }) => triggerAnalysis(input.pid)),
  latest: publicProcedure
    .input(pidInput)
    .query(({ input }) => getLatestAnalysis(input.pid)),
  stateMachines: publicProcedure
    .input(pidInput)
    .query(({ input }) => listStateMachines(input.pid)),
} satisfies TRPCRouterRecord;

// ---------- requirements ----------

const requirementsRouter = {
  list: publicProcedure
    .input(pidInput)
    .query(({ input }) => listRequirements(input.pid)),
  get: publicProcedure
    .input(z.object({ rid: z.string().min(1) }))
    .query(({ input }) => getRequirement(input.rid)),
  create: publicProcedure
    .input(
      z.object({
        pid: z.string().min(1),
        name: z.string().optional(),
        version: z.string().optional(),
        content: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      const { pid, ...rest } = input;
      return createRequirement(pid, rest);
    }),
  update: publicProcedure
    .input(
      z.object({
        rid: z.string().min(1),
        name: z.string().optional(),
        version: z.string().optional(),
        content: z.string().nullable().optional(),
      }),
    )
    .mutation(({ input }) => {
      const { rid, ...rest } = input;
      return updateRequirement(rid, rest);
    }),
  delete: publicProcedure
    .input(z.object({ rid: z.string().min(1) }))
    .mutation(({ input }) => deleteRequirement(input.rid)),
  uploadPrd: publicProcedure
    .input(
      z.object({
        rid: z.string().min(1),
        filename: z.string(),
        base64: z.string(),
      }),
    )
    .mutation(({ input }) =>
      uploadRequirementPrd(
        input.rid,
        input.filename,
        Buffer.from(input.base64, "base64"),
      ),
    ),
  testPoints: publicProcedure
    .input(z.object({ rid: z.string().min(1) }))
    .query(({ input }) => listTestPoints(input.rid)),
  analyze: publicProcedure
    .input(
      z.object({
        rid: z.string().min(1),
        mode: z.enum(["auto", "rule", "llm"]).default("auto"),
        profileId: z.string().nullable().optional(),
      }),
    )
    .mutation(({ input }) =>
      startRequirementAnalysis(input.rid, input.mode, input.profileId ?? null),
    ),
} satisfies TRPCRouterRecord;

// ---------- test cases ----------

const caseListFilters = z.object({
  requirementId: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  executionStatus: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  keyword: z.string().nullable().optional(),
});

const structuredStep = z.object({
  order: z.number().int(),
  type: z.string(),
  action: z.string(),
  target: z.string(),
  uiSelector: z.object({ type: z.string(), value: z.string() }).optional(),
  expected: z.string().optional(),
  inputValue: z.string().optional(),
  variable: z.string().optional(),
  pattern: z.string().optional(),
});

const caseUpdateInput = z.object({
  title: z.string().optional(),
  module: z.string().optional(),
  type: z.string().optional(),
  priority: z.string().optional(),
  preconditions: z.array(z.string()).optional(),
  steps: z.array(z.string()).optional(),
  expectedResults: z.array(z.string()).optional(),
  structuredSteps: z.array(structuredStep).optional(),
  testData: z.record(z.string(), z.string()).optional(),
  executionStatus: z.string().optional(),
  source: z.string().optional(),
  changeNote: z.string().optional(),
});

const testcasesRouter = {
  list: publicProcedure
    .input(
      z.object({ pid: z.string().min(1), filters: caseListFilters.optional() }),
    )
    .query(({ input }) => listCases(input.pid, input.filters ?? {})),
  get: publicProcedure
    .input(z.object({ cid: z.string().min(1) }))
    .query(({ input }) => getCase(input.cid)),
  update: publicProcedure
    .input(caseUpdateInput.extend({ cid: z.string().min(1) }))
    .mutation(({ input }) => {
      const { cid, ...rest } = input;
      return updateCase(cid, rest);
    }),
  createManual: publicProcedure
    .input(caseUpdateInput.extend({ pid: z.string().min(1) }))
    .mutation(({ input }) => {
      const { pid, ...rest } = input;
      return createManualCase(pid, rest);
    }),
  delete: publicProcedure
    .input(z.object({ cid: z.string().min(1) }))
    .mutation(({ input }) => deleteCase(input.cid)),
  deleteBulk: publicProcedure
    .input(z.object({ cids: z.array(z.string()) }))
    .mutation(({ input }) => deleteCasesBulk(input.cids)),
  versions: publicProcedure
    .input(z.object({ cid: z.string().min(1) }))
    .query(({ input }) => listVersions(input.cid)),
  rollback: publicProcedure
    .input(z.object({ cid: z.string().min(1), vid: z.string().min(1) }))
    .mutation(({ input }) => rollbackVersion(input.cid, input.vid)),
  exportCsv: publicProcedure
    .input(pidInput)
    .query(({ input }) => exportCasesCsv(input.pid)),
  importCsv: publicProcedure
    .input(z.object({ pid: z.string().min(1), csv: z.string() }))
    .mutation(({ input }) => importCasesCsv(input.pid, input.csv)),
  copyTo: publicProcedure
    .input(
      z.object({
        sourcePid: z.string().min(1),
        targetPid: z.string().min(1),
        cids: z.array(z.string()),
      }),
    )
    .mutation(({ input }) =>
      copyCasesTo(input.sourcePid, input.targetPid, input.cids),
    ),
  forRequirement: publicProcedure
    .input(z.object({ rid: z.string().min(1) }))
    .query(async ({ input }) => {
      const pairs = await casesForRequirement(input.rid);
      return pairs.map((p) => ({
        caseId: p.row.id,
        testPointId: p.mapping.testPointId,
      }));
    }),
  clearGeneratedForRequirement: publicProcedure
    .input(z.object({ rid: z.string().min(1) }))
    .mutation(({ input }) => clearGeneratedForRequirement(input.rid)),
  clearGeneratedForProject: publicProcedure
    .input(pidInput)
    .mutation(({ input }) => clearGeneratedForProject(input.pid)),
  aiReview: publicProcedure
    .input(z.object({ pid: z.string().min(1), cids: z.array(z.string()) }))
    .mutation(({ input }) => reviewCases(input.pid, input.cids)),
  aiFix: publicProcedure
    .input(
      z.object({
        pid: z.string().min(1),
        cid: z.string().min(1),
        issues: z
          .array(
            z.object({
              severity: z.string().default("warning"),
              field: z.string().default("case"),
              problem: z.string(),
              suggestion: z.string().optional(),
              evidence: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(({ input }) => fixCase(input.pid, input.cid, input.issues ?? [])),
  rerunGate: publicProcedure
    .input(z.object({ pid: z.string().min(1), cid: z.string().min(1) }))
    .mutation(({ input }) => rerunGate(input.pid, input.cid)),
} satisfies TRPCRouterRecord;

// ---------- generation ----------

const generationRouter = {
  start: publicProcedure
    .input(
      z.object({
        pid: z.string().min(1),
        mode: z.enum(["auto", "rule", "llm"]).default("auto"),
        requirementId: z.string().nullable().optional(),
        profileId: z.string().nullable().optional(),
      }),
    )
    .mutation(({ input }) =>
      startGeneration(input.pid, {
        mode: input.mode,
        requirementId: input.requirementId ?? null,
        profileId: input.profileId ?? null,
      }),
    ),
  generateSync: publicProcedure
    .input(
      z.object({
        pid: z.string().min(1),
        mode: z.enum(["auto", "rule", "llm"]).default("auto"),
        requirementId: z.string().nullable().optional(),
        profileId: z.string().nullable().optional(),
      }),
    )
    .mutation(({ input }) =>
      generateCases(input.pid, {
        mode: input.mode,
        requirementId: input.requirementId ?? null,
        profileId: input.profileId ?? null,
      }),
    ),
  coverageGaps: publicProcedure
    .input(pidInput)
    .query(({ input }) => coverageGaps(input.pid)),
  versions: publicProcedure
    .input(
      z.object({
        rid: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(({ input }) => listCaseGenerations(input.rid, input.limit)),
  version: publicProcedure
    .input(
      z.object({ rid: z.string().min(1), generationId: z.string().min(1) }),
    )
    .query(({ input }) => getCaseGeneration(input.rid, input.generationId)),
} satisfies TRPCRouterRecord;

// ---------- executions ----------

const executionsRouter = {
  runSingle: publicProcedure
    .input(
      z.object({
        pid: z.string().min(1),
        cid: z.string().min(1),
        targetUrl: z.string().nullable().optional(),
      }),
    )
    .mutation(({ input }) =>
      startSingleExecution(input.pid, input.cid, input.targetUrl ?? null),
    ),
  runBatch: publicProcedure
    .input(
      z.object({
        pid: z.string().min(1),
        cids: z.array(z.string()),
        targetUrl: z.string().nullable().optional(),
      }),
    )
    .mutation(({ input }) =>
      startBatchExecution(input.pid, input.cids, input.targetUrl ?? null),
    ),
  runSync: publicProcedure
    .input(
      z.object({
        pid: z.string().min(1),
        cid: z.string().min(1),
        targetUrl: z.string().nullable().optional(),
      }),
    )
    .mutation(({ input }) =>
      runCaseExecution(input.pid, input.cid, {
        targetUrl: input.targetUrl ?? null,
      }),
    ),
  cancelBatch: publicProcedure
    .input(z.object({ batchId: z.string().min(1) }))
    .mutation(({ input }) => cancelBatch(input.batchId)),
  list: publicProcedure
    .input(
      z.object({
        pid: z.string().min(1),
        requirementId: z.string().nullable().optional(),
        status: z.string().nullable().optional(),
        batchId: z.string().nullable().optional(),
        testCaseId: z.string().nullable().optional(),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(200).optional(),
        groupBy: z.enum(["case", "execution"]).optional(),
      }),
    )
    .query(({ input }) => {
      const { pid, ...filters } = input;
      return listExecutions(pid, filters);
    }),
  forCase: publicProcedure
    .input(z.object({ pid: z.string().min(1), cid: z.string().min(1) }))
    .query(({ input }) => listExecutionsForCase(input.pid, input.cid)),
  get: publicProcedure
    .input(z.object({ eid: z.string().min(1) }))
    .query(({ input }) => getExecution(input.eid)),
  steps: publicProcedure
    .input(z.object({ eid: z.string().min(1) }))
    .query(({ input }) => getExecutionSteps(input.eid)),
  manualReview: publicProcedure
    .input(
      z.object({
        eid: z.string().min(1),
        verdict: z.enum(["passed", "failed"]),
        note: z.string().optional(),
      }),
    )
    .mutation(({ input }) =>
      manualReview(input.eid, { verdict: input.verdict, note: input.note }),
    ),
  llmReview: publicProcedure
    .input(z.object({ eid: z.string().min(1) }))
    .mutation(({ input }) => llmReview(input.eid)),
  batchLlmReview: publicProcedure
    .input(z.object({ eids: z.array(z.string()) }))
    .mutation(({ input }) => startBatchLlmReview(input.eids)),
} satisfies TRPCRouterRecord;

// ---------- settings ----------

const profileUpsert = z.object({
  name: z.string().optional(),
  kind: z.enum(["text", "vision"]).optional(),
  apiKey: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

const settingsRouter = {
  info: publicProcedure.query(() => getSettingsInfo()),
  listProfiles: publicProcedure.query(() => listProfiles()),
  createProfile: publicProcedure
    .input(profileUpsert)
    .mutation(({ input }) => createProfile(input)),
  updateProfile: publicProcedure
    .input(profileUpsert.extend({ id: z.string().min(1) }))
    .mutation(({ input }) => {
      const { id, ...rest } = input;
      return updateProfile(id, rest);
    }),
  setDefaultProfile: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => setDefaultProfile(input.id)),
  deleteProfile: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => deleteProfile(input.id)),
  testLlm: publicProcedure
    .input(
      z.object({
        profileId: z.string().nullable().optional(),
        kind: z.enum(["text", "vision"]).default("text"),
      }),
    )
    .mutation(({ input }) => testLlm(input.profileId ?? null, input.kind)),
} satisfies TRPCRouterRecord;

// ---------- workflows ----------

const workflowCreate = z.object({
  requirementId: z.string().min(1),
  mode: z.enum(["auto", "rule", "llm"]).default("auto"),
  autoExecute: z.boolean().default(true),
  maxRevisions: z.number().int().min(0).max(2).default(2),
  maxCases: z.number().int().min(1).max(100).default(20),
  reuseExistingCases: z.boolean().default(true),
  reanalyzePoints: z.boolean().default(false),
  targetUrl: z.string().nullable().optional(),
  testPointLlmProfileId: z.string().nullable().optional(),
  caseLlmProfileId: z.string().nullable().optional(),
  analyzeCode: z.boolean().default(true),
  reanalyzeCode: z.boolean().default(false),
  reviewEnabled: z.boolean().default(true),
  analyzeEnabled: z.boolean().default(true),
});

const workflowsRouter = {
  create: publicProcedure
    .input(workflowCreate.extend({ pid: z.string().min(1) }))
    .mutation(({ input }) => {
      const { pid, ...rest } = input;
      return createRun(pid, rest);
    }),
  list: publicProcedure
    .input(
      z.object({ pid: z.string().min(1), limit: z.number().int().optional() }),
    )
    .query(({ input }) => listRuns(input.pid, input.limit ?? 20)),
  detail: publicProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(({ input }) => getRunDetail(input.runId)),
} satisfies TRPCRouterRecord;

// ---------- stats / coverage / mindmap / jobs ----------

const statsRouter = {
  overview: publicProcedure.query(() => getOverview()),
} satisfies TRPCRouterRecord;

const coverageRouter = {
  matrix: publicProcedure
    .input(
      z.object({
        pid: z.string().min(1),
        requirementId: z.string().nullable().optional(),
      }),
    )
    .query(({ input }) =>
      getCoverageMatrix(input.pid, input.requirementId ?? null),
    ),
} satisfies TRPCRouterRecord;

const mindmapScope = pidInput.extend({
  requirementId: z.string().nullable().optional(),
});

const mindmapRouter = {
  tree: publicProcedure
    .input(mindmapScope)
    .query(({ input }) => getMindmap(input.pid, input.requirementId ?? null)),
  markdown: publicProcedure
    .input(mindmapScope)
    .query(({ input }) =>
      getMindmapMarkdown(input.pid, input.requirementId ?? null),
    ),
  xmind: publicProcedure
    .input(mindmapScope)
    .query(({ input }) =>
      getMindmapXmind(input.pid, input.requirementId ?? null),
    ),
} satisfies TRPCRouterRecord;

const jobsRouter = {
  get: publicProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .query(({ input }) => getJobState(input.jobId)),
} satisfies TRPCRouterRecord;

// ---------- incremental requirement analysis ----------

const incrementalRouter = {
  createSnapshot: publicProcedure
    .input(
      z.object({
        rid: z.string().min(1),
        analysisId: z.string().nullable().optional(),
      }),
    )
    .mutation(({ input }) =>
      buildSnapshot(input.rid, { analysisId: input.analysisId ?? null }),
    ),
  snapshot: publicProcedure
    .input(z.object({ rid: z.string().min(1) }))
    .query(({ input }) => getLatestSnapshot(input.rid)),
  analyze: publicProcedure
    .input(
      z.object({
        rid: z.string().min(1),
        baselineRequirementId: z.string().min(1),
        mode: z.enum(["auto", "llm", "rule"]).default("auto"),
        profileId: z.string().nullable().optional(),
      }),
    )
    .mutation(({ input }) =>
      analyzeIncremental(input.rid, input.baselineRequirementId, {
        mode: input.mode,
        profileId: input.profileId ?? null,
      }),
    ),
  runs: publicProcedure
    .input(
      z.object({
        rid: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(({ input }) => listIncrementalRuns(input.rid, input.limit)),
  latest: publicProcedure
    .input(z.object({ rid: z.string().min(1) }))
    .query(({ input }) => latestIncrementalRun(input.rid)),
  run: publicProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(({ input }) => getIncrementalRun(input.runId)),
  generate: publicProcedure
    .input(
      z.object({
        runId: z.string().min(1),
        mode: z.enum(["auto", "llm", "rule"]).default("auto"),
        profileId: z.string().nullable().optional(),
      }),
    )
    .mutation(({ input }) =>
      startIncrementalGeneration(input.runId, {
        mode: input.mode,
        profileId: input.profileId ?? null,
      }),
    ),
  generateSync: publicProcedure
    .input(
      z.object({
        runId: z.string().min(1),
        mode: z.enum(["auto", "llm", "rule"]).default("auto"),
        profileId: z.string().nullable().optional(),
      }),
    )
    .mutation(({ input }) =>
      generateIncremental(input.runId, {
        mode: input.mode,
        profileId: input.profileId ?? null,
      }),
    ),
  reviewChange: publicProcedure
    .input(
      z.object({
        runId: z.string().min(1),
        changeId: z.string().min(1),
        status: z.enum(["confirmed", "rejected"]),
      }),
    )
    .mutation(({ input }) =>
      reviewIncrementalChange(input.runId, input.changeId, input.status),
    ),
  reviewRegression: publicProcedure
    .input(
      z.object({
        caseChangeId: z.string().min(1),
        status: z.enum(["accepted", "rejected"]),
      }),
    )
    .mutation(({ input }) =>
      reviewIncrementalRegression(input.caseChangeId, input.status),
    ),
} satisfies TRPCRouterRecord;

export const trpcRouter = createTRPCRouter({
  projects: projectsRouter,
  analysis: analysisRouter,
  requirements: requirementsRouter,
  testcases: testcasesRouter,
  generation: generationRouter,
  executions: executionsRouter,
  settings: settingsRouter,
  workflows: workflowsRouter,
  stats: statsRouter,
  coverage: coverageRouter,
  mindmap: mindmapRouter,
  jobs: jobsRouter,
  incremental: incrementalRouter,
});
export type TRPCRouter = typeof trpcRouter;
