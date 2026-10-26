/**
 * Experiment A (read-only): case-quality metrics for a project or one
 * requirement version.
 *
 * Usage:
 *   pnpm tsx scripts/evaluate.mts --project-id <pid> [--requirement-id <rid>]
 *
 * Unlike the legacy harness this never rewrites generated cases; it only reads
 * the current cases/points and prints the metric JSON. Ratios with no
 * denominator are reported as null (never fabricated as 0).
 */
import { asc, eq } from "drizzle-orm";

import { db } from "#/db";
import { requirementCases, testCases, testPoints } from "#/db/schema";
import {
  evaluateCaseSet,
  type MetricCase,
  type MetricPoint,
  type RequiredByRoute,
} from "#/server/lib/evaluation/metrics";
import { getGenerationContext } from "#/server/services/projects";

function arg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1]! : null;
}

/** { route: [[label, prop, placeholder], ...] } from the latest analysis. */
async function requiredByRoute(pid: string): Promise<RequiredByRoute> {
  const { backend, frontend } = await getGenerationContext(pid);
  const requiredNames = new Set<string>();
  for (const entity of backend.entities) {
    for (const c of entity.fieldConstraints) {
      if (["notblank", "notnull", "notempty", "required"].includes(c.rule)) {
        requiredNames.add(c.field);
      }
    }
  }
  const out: RequiredByRoute = {};
  for (const page of frontend.pages) {
    const tokens: string[][] = [];
    for (const form of page.forms || []) {
      for (const field of form.fields || []) {
        const required =
          field.required ||
          requiredNames.has(field.prop) ||
          requiredNames.has(field.label);
        if (!required) continue;
        tokens.push(
          [field.label, field.prop, field.placeholder]
            .filter((v): v is string => Boolean(v))
            .map(String),
        );
      }
    }
    out[page.route] = tokens;
  }
  return out;
}

async function main(): Promise<void> {
  const pid = arg("project-id");
  if (!pid) {
    console.error("Missing --project-id");
    process.exit(2);
  }
  const rid = arg("requirement-id");

  type CaseRow = typeof testCases.$inferSelect;
  let caseRows = (await db
    .select()
    .from(testCases)
    .where(eq(testCases.projectId, pid))
    .orderBy(asc(testCases.priority), asc(testCases.projectSeq))) as CaseRow[];

  const pointRows = rid
    ? await db
        .select()
        .from(testPoints)
        .where(eq(testPoints.requirementId, rid))
        .orderBy(asc(testPoints.seq))
    : await db
        .select()
        .from(testPoints)
        .where(eq(testPoints.projectId, pid))
        .orderBy(asc(testPoints.seq));

  let testPointIdByCase = new Map<string, string | null>();
  if (rid) {
    const mappings = await db
      .select()
      .from(requirementCases)
      .where(eq(requirementCases.requirementId, rid));
    const mappedIds = new Set(mappings.map((m) => m.testCaseId));
    testPointIdByCase = new Map(
      mappings.map((m) => [m.testCaseId, m.testPointId]),
    );
    caseRows = caseRows.filter((row) => mappedIds.has(row.id));
  }

  // Manual/imported cases are not generation output; exclude them.
  caseRows = caseRows.filter(
    (row) => row.source !== "manual" && row.source !== "import",
  );

  const cases: MetricCase[] = caseRows.map((row) => ({
    id: row.id,
    title: row.title,
    type: row.type,
    qualityScore: row.qualityScore,
    expectedResults: row.expectedResults ?? [],
    structuredSteps: (row.structuredSteps ??
      []) as MetricCase["structuredSteps"],
    coverageRefs: row.coverageRefs,
    testPointId: testPointIdByCase.get(row.id) ?? null,
  }));
  const points: MetricPoint[] = pointRows.map((p) => ({
    id: p.id,
    title: p.title,
    category: p.category,
  }));

  const required = await requiredByRoute(pid).catch(
    () => ({}) as RequiredByRoute,
  );
  const result = evaluateCaseSet(cases, points, required);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
