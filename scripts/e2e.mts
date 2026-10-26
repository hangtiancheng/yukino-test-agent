/**
 * End-to-end self check: demo target site -> static analysis -> rule
 * generation -> real browser execution -> coverage matrix.
 *
 * Usage: pnpm e2e
 *
 * The run is self-cleaning: it creates a throwaway project, executes every
 * generated case against the bundled demo site, prints a verdict table, then
 * deletes the project again. Evidence goes to a temporary directory so the
 * development `outputs/` folder stays untouched.
 *
 * Acceptance: >= 12 generated cases, >= 90% pass rate, one video per run.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE = path.join(ROOT, "scripts", "sample-src");
const TARGET = process.env.E2E_TARGET_URL ?? "http://127.0.0.1:8200";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "yukino-e2e-"));

// Must be set before the server modules read process.env.
process.env.OUTPUT_DIR = path.join(TMP, "outputs");
// The self check runs in pure rule mode: clear any LLM env config so the
// vision fallback can never pick up a text model (a text model rejects
// images, which would flip every deterministic pass into needs_review).
for (const key of [
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "LLM_VISION_API_KEY",
  "LLM_VISION_BASE_URL",
  "LLM_VISION_MODEL",
  "LLM_EXTRA_BODY",
]) {
  delete process.env[key];
}

const { sql, eq, inArray } = await import("drizzle-orm");
const { db } = await import("#/db");
const {
  codeAnalyses,
  executionRecords,
  executionSteps,
  llmProfiles,
  testCases,
} = await import("#/db/schema");
const { createProject, deleteProject, uuid } =
  await import("#/server/services/projects");
const { runAnalysis } = await import("#/server/services/analysis");
const { generateCases } = await import("#/server/services/generation");
const { runCaseExecution } = await import("#/server/services/executions");
const { getCoverageMatrix } = await import("#/server/services/coverage");

async function targetIsUp(): Promise<boolean> {
  try {
    const res = await fetch(TARGET, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

let demo: ReturnType<typeof spawn> | null = null;
if (!(await targetIsUp())) {
  demo = spawn(
    process.execPath,
    [path.join(ROOT, "scripts", "demo-site", "server.mjs")],
    { stdio: "ignore", detached: true },
  );
  for (let i = 0; i < 20 && !(await targetIsUp()); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
if (!(await targetIsUp())) {
  console.error(`[e2e] demo target site is not reachable at ${TARGET}`);
  process.exit(1);
}

let pid: string | null = null;
let exitCode = 0;
// DB profiles survive env clearing; disable them for the run so AI review
// stays off and execution statuses are deterministic. Restored in `finally`.
const enabledProfileIds = (
  await db
    .select({ id: llmProfiles.id })
    .from(llmProfiles)
    .where(eq(llmProfiles.enabled, true))
).map((row) => row.id);
if (enabledProfileIds.length > 0) {
  await db
    .update(llmProfiles)
    .set({ enabled: false, updatedAt: new Date() })
    .where(inArray(llmProfiles.id, enabledProfileIds));
}
try {
  const project = await createProject({
    name: `e2e-${Date.now()}`,
    description: "Throwaway project created by scripts/e2e.mts",
    sourceType: "local_path",
    sourcePath: SAMPLE,
    targetUrl: TARGET,
  });
  pid = project.id;
  console.log(`[e2e] project ${pid} -> ${SAMPLE}`);

  const analysisId = uuid();
  await db.insert(codeAnalyses).values({
    id: analysisId,
    projectId: pid,
    status: "running",
  });
  await runAnalysis(pid, analysisId, (message) =>
    console.log(`  · ${message}`),
  );

  const generation = await generateCases(pid, { mode: "rule" });
  console.log(
    `[e2e] generated ${generation.generated}, kept ${generation.kept}, dropped ${generation.dropped}`,
  );
  console.log(`[e2e] by type ${JSON.stringify(generation.byType)}`);
  if (generation.dropped > 0) {
    console.log(`[e2e] drop reasons ${JSON.stringify(generation.dropReasons)}`);
  }

  const cases = await db
    .select()
    .from(testCases)
    .where(eq(testCases.projectId, pid));
  const statuses: string[] = [];
  for (const kase of cases) {
    const run = await runCaseExecution(pid, kase.id, { targetUrl: TARGET });
    statuses.push(run.status);
    console.log(
      `  [${run.status.padEnd(12)}] ${kase.type.padEnd(9)} ${run.passedSteps}/${run.totalSteps} steps  ${kase.title.slice(0, 64)}`,
    );
  }

  const passed = statuses.filter((status) => status === "passed").length;
  const rate = statuses.length > 0 ? passed / statuses.length : 0;
  const [stepRow] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(executionSteps);
  const runs = await db
    .select({ id: executionRecords.id, videoPath: executionRecords.videoPath })
    .from(executionRecords)
    .where(eq(executionRecords.projectId, pid));
  const videos = runs.filter((run) => run.videoPath).length;
  const matrix = await getCoverageMatrix(pid, null);

  console.log("");
  console.log(
    `[e2e] pass rate: ${passed}/${statuses.length} = ${(rate * 100).toFixed(0)}%`,
  );
  console.log(
    `[e2e] steps: ${stepRow?.value ?? 0}  videos: ${videos}/${runs.length}`,
  );
  console.log(
    `[e2e] planned coverage: endpoints ${matrix.apiEndpoint.plannedCovered}/${matrix.apiEndpoint.total}, ` +
      `transitions ${matrix.stateTransition.plannedCovered}/${matrix.stateTransition.total}, ` +
      `rules ${matrix.businessRule.plannedCovered}/${matrix.businessRule.total}`,
  );
  console.log(
    `[e2e] executed coverage: endpoints ${matrix.apiEndpoint.executedCovered}/${matrix.apiEndpoint.total}, ` +
      `transitions ${matrix.stateTransition.executedCovered}/${matrix.stateTransition.total}, ` +
      `rules ${matrix.businessRule.executedCovered}/${matrix.businessRule.total}`,
  );

  if (statuses.length < 12) {
    console.error(
      `[e2e] FAIL: expected at least 12 generated cases, got ${statuses.length}`,
    );
    exitCode = 1;
  }
  if (rate < 0.9) {
    console.error("[e2e] FAIL: pass rate below 90%");
    exitCode = 1;
  }
  if (videos !== runs.length) {
    console.error("[e2e] FAIL: expected one video per execution");
    exitCode = 1;
  }
  console.log(exitCode === 0 ? "[e2e] OK" : "[e2e] completed with failures");
} catch (error) {
  console.error("[e2e] error", error);
  exitCode = 1;
} finally {
  if (enabledProfileIds.length > 0) {
    await db
      .update(llmProfiles)
      .set({ enabled: true, updatedAt: new Date() })
      .where(inArray(llmProfiles.id, enabledProfileIds))
      .catch((error) => console.error("[e2e] profile restore failed", error));
  }
  if (pid) {
    await deleteProject(pid).catch((error) =>
      console.error("[e2e] cleanup failed", error),
    );
  }
  if (demo?.pid) {
    try {
      process.kill(-demo.pid);
    } catch {
      demo.kill();
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(exitCode);
}
