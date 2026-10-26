/**
 * Code analysis orchestration: scan -> parse -> state machines -> persist.
 * Pure rules, zero LLM.
 */
import { desc, eq } from "drizzle-orm";

import { db } from "#/db";
import { codeAnalyses, projects, stateMachines } from "#/db/schema";
import { listByExt, scan, techStackOf } from "#/server/lib/analyzer/scanner";
import { analyzeBackend } from "#/server/lib/analyzer/spring";
import { analyzeFrontend as analyzeVueFrontend } from "#/server/lib/analyzer/vue";
import { analyzeGoBackend } from "#/server/lib/analyzer/go";
import { extractGoStateMachines } from "#/server/lib/analyzer/go-state-machine";
import { analyzeLitFrontend } from "#/server/lib/analyzer/lit";
import { extractStateMachines } from "#/server/lib/analyzer/state-machine";
import { createJob, runJob } from "#/server/lib/jobs";
import { BizError } from "#/server/services/settings";
import { getProjectOr404, uuid } from "#/server/services/projects";

import type { JobState } from "#/lib/types";

export async function triggerAnalysis(
  pid: string,
): Promise<{ analysisId: string; jobId: string }> {
  const project = await getProjectOr404(pid);
  if (project.sourceType !== "local_path" || !project.sourcePath) {
    throw new BizError(
      40006,
      "Only local_path projects can be analyzed (set sourcePath first)",
    );
  }
  const analysisId = uuid();
  await db.insert(codeAnalyses).values({
    id: analysisId,
    projectId: pid,
    status: "running",
  });
  const job = createJob("analysis");
  runJob(job.id, async (report) => {
    await runAnalysis(pid, analysisId, report);
  });
  return { analysisId, jobId: job.id };
}

export async function runAnalysis(
  pid: string,
  analysisId: string,
  report: (message: string) => void,
): Promise<void> {
  try {
    const project = await getProjectOr404(pid);
    const warnings: string[] = [];
    const root = project.sourcePath!;

    report("Scanning source files");
    const scanResult = scan(root);
    if (scanResult.files.length === 0) {
      await db
        .update(codeAnalyses)
        .set({
          status: "failed",
          errorMessage: `Source directory missing or empty: ${root}`,
        })
        .where(eq(codeAnalyses.id, analysisId));
      throw new Error(`Source directory missing or empty: ${root}`);
    }

    let backend = null;
    let frontend = null;
    if (scanResult.backend === "java-spring") {
      report("Analyzing Spring Boot backend");
      const javaFiles = listByExt(scanResult, new Set([".java"]));
      backend = analyzeBackend(javaFiles, root);
    } else if (scanResult.backend === "go") {
      report("Analyzing Go backend");
      const goFiles = listByExt(scanResult, new Set([".go"]));
      backend = analyzeGoBackend(goFiles, root);
    } else {
      warnings.push(
        "No supported backend detected (missing pom.xml / build.gradle / go.mod)",
      );
    }

    if (scanResult.frontend === "vue") {
      report("Analyzing Vue frontend");
      const vueJsFiles = listByExt(scanResult, new Set([".vue", ".js"]));
      frontend = analyzeVueFrontend(vueJsFiles, root);
    } else if (scanResult.frontend === "lit") {
      report("Analyzing Lit frontend");
      const litFiles = listByExt(
        scanResult,
        new Set([".tsx", ".jsx", ".ts", ".js"]),
      );
      frontend = analyzeLitFrontend(litFiles, root);
    } else {
      warnings.push(
        "No supported frontend detected (missing package.json with Vue or Lit dependencies)",
      );
    }

    // State machines depend on the backend result
    let machines: ReturnType<typeof extractStateMachines> = [];
    if (backend && scanResult.backend === "java-spring") {
      report("Extracting state machines");
      const javaFiles = listByExt(scanResult, new Set([".java"]));
      machines = extractStateMachines(backend, javaFiles, root);
    } else if (backend && scanResult.backend === "go") {
      report("Extracting state machines");
      const goFiles = listByExt(scanResult, new Set([".go"]));
      machines = extractGoStateMachines(backend, goFiles, root);
    }

    report("Persisting analysis results");
    await db
      .update(codeAnalyses)
      .set({
        status: "success",
        backendResult: backend,
        frontendResult: frontend,
        warnings,
        errorMessage: null,
      })
      .where(eq(codeAnalyses.id, analysisId));

    // Replace state machines
    await db.delete(stateMachines).where(eq(stateMachines.projectId, pid));
    for (const sm of machines) {
      await db.insert(stateMachines).values({
        id: uuid(),
        projectId: pid,
        name: sm.name,
        states: sm.states,
        transitions: sm.transitions,
        confidence: sm.confidence,
      });
    }

    // Backfill tech stack
    await db
      .update(projects)
      .set({ techStack: techStackOf(scanResult), updatedAt: new Date() })
      .where(eq(projects.id, pid));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(codeAnalyses)
      .set({ status: "failed", errorMessage: message.slice(0, 4000) })
      .where(eq(codeAnalyses.id, analysisId));
    throw error;
  }
}

export async function getLatestAnalysis(pid: string) {
  await getProjectOr404(pid);
  const rows = await db
    .select()
    .from(codeAnalyses)
    .where(eq(codeAnalyses.projectId, pid))
    .orderBy(desc(codeAnalyses.createdAt))
    .limit(1);
  const analysis = rows[0];
  if (!analysis) return null;
  const machineRows = await db
    .select()
    .from(stateMachines)
    .where(eq(stateMachines.projectId, pid));
  return {
    id: analysis.id,
    status: analysis.status,
    createdAt: analysis.createdAt?.toISOString() ?? null,
    backendResult: analysis.backendResult ?? null,
    frontendResult: analysis.frontendResult ?? null,
    stateMachines: machineRows.map((m) => ({
      id: m.id,
      name: m.name,
      states: m.states ?? [],
      transitions: m.transitions ?? [],
      confidence: m.confidence,
    })),
    warnings: analysis.warnings ?? [],
    errorMessage: analysis.errorMessage,
  };
}

export async function listStateMachines(pid: string) {
  await getProjectOr404(pid);
  const rows = await db
    .select()
    .from(stateMachines)
    .where(eq(stateMachines.projectId, pid));
  return rows.map((m) => ({
    id: m.id,
    name: m.name,
    states: m.states ?? [],
    transitions: m.transitions ?? [],
    confidence: m.confidence,
  }));
}

/**
 * Analyses run in process memory only, so a restart leaves their rows stuck
 * in `running`. Mark them failed so the UI never shows a phantom "analyzing"
 * state (mirrors the workflow/execution recovery).
 */
export async function recoverInterruptedAnalyses(): Promise<number> {
  const rows = await db
    .select({ id: codeAnalyses.id })
    .from(codeAnalyses)
    .where(eq(codeAnalyses.status, "running"));
  if (rows.length === 0) return 0;
  for (const row of rows) {
    await db
      .update(codeAnalyses)
      .set({
        status: "failed",
        errorMessage: "Interrupted by server restart; re-run the analysis",
      })
      .where(eq(codeAnalyses.id, row.id));
  }
  return rows.length;
}

export type { JobState };
