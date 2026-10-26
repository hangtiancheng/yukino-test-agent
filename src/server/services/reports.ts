/**
 * Self-contained HTML reports (English).
 *
 * Reports are single files with inline CSS and evidence referenced through
 * the `/api/files/...` route, so they can be opened or saved standalone.
 * A project report aggregates executions; a workflow report adds the stage
 * timeline and per-case review/analysis.
 */
import { asc, eq } from "drizzle-orm";

import { db } from "#/db";
import {
  executionRecords,
  executionRequirements,
  executionSteps,
  projects,
} from "#/db/schema";
import { STAGE_LABELS } from "#/lib/enums";
import { toFileUrl } from "#/server/lib/files";
import { getCoverageMatrix } from "#/server/services/coverage";
import { getRunDetail } from "#/server/services/workflows";

import type { CoverageMatrix } from "#/server/lib/coverage";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STATUS_CLASS: Record<string, string> = {
  passed: "pass",
  failed: "fail",
  skipped: "skip",
  needs_review: "skip",
  cancelled: "muted",
  running: "muted",
  not_run: "muted",
};

const BASE_CSS = `
:root{color-scheme:light dark}
body{font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;margin:0;padding:32px;background:#fafafa;color:#18181b;line-height:1.5}
.wrap{max-width:960px;margin:0 auto}
h1{font-size:24px;font-weight:600;margin:0 0 4px}
h2{font-size:16px;font-weight:600;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid #e4e4e7}
.sub{color:#71717a;font-size:13px;margin-bottom:20px}
.rate{font-size:44px;font-weight:700;color:#16a34a;line-height:1}
.bar{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}
.stat{background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:12px 18px;min-width:96px}
.stat b{display:block;font-size:20px;font-weight:600}
.stat span{font-size:12px;color:#71717a}
.pass{color:#16a34a}.fail{color:#dc2626}.skip{color:#d97706}.muted{color:#71717a}
table{width:100%;border-collapse:collapse;margin:8px 0;font-size:13px;background:#fff;border:1px solid #e4e4e7;border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #f4f4f5;vertical-align:top}
th{background:#f4f4f5;font-weight:600;color:#3f3f46}
tr:last-child td{border-bottom:none}
details{border:1px solid #e4e4e7;border-radius:10px;margin:8px 0;padding:10px 14px;background:#fff}
summary{cursor:pointer;font-weight:500}
img{max-width:300px;border:1px solid #e4e4e7;border-radius:8px;margin:6px 6px 0 0}
.step{margin:10px 0;padding-top:8px;border-top:1px dashed #e4e4e7}
.meter{height:8px;background:#f4f4f5;border-radius:99px;overflow:hidden;margin-top:4px}
.meter i{display:block;height:100%;background:#18181b}
code{background:#f4f4f5;padding:1px 5px;border-radius:4px;font-size:12px}
ul{margin:8px 0;padding-left:20px}
`;

interface ReportRecord {
  id: string;
  title: string;
  status: string;
  durationMs: number;
  errorCategory: string | null;
  errorMessage: string | null;
  videoPath: string | null;
  steps: {
    stepIndex: number;
    action: string;
    result: string;
    error: string | null;
    screenshotBefore: string | null;
    screenshotAfter: string | null;
  }[];
}

async function loadRecords(
  pid: string,
  ids: string[] | null,
): Promise<ReportRecord[]> {
  let rows = await db
    .select()
    .from(executionRecords)
    .where(eq(executionRecords.projectId, pid))
    .orderBy(asc(executionRecords.startTime));
  if (ids) rows = rows.filter((row) => ids.includes(row.id));
  const out: ReportRecord[] = [];
  for (const row of rows) {
    const stepRows = await db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.executionId, row.id))
      .orderBy(asc(executionSteps.stepIndex));
    out.push({
      id: row.id,
      title: row.testCaseTitle,
      status: row.status,
      durationMs: row.durationMs,
      errorCategory: row.errorCategory,
      errorMessage: row.errorMessage,
      videoPath: row.videoPath,
      steps: stepRows.map((s) => ({
        stepIndex: s.stepIndex,
        action: s.action,
        result: s.result,
        error: s.error,
        screenshotBefore: s.screenshotBefore,
        screenshotAfter: s.screenshotAfter,
      })),
    });
  }
  return out;
}

function coverageSection(matrix: CoverageMatrix): string {
  const blocks: [string, CoverageMatrix["apiEndpoint"]][] = [
    ["API endpoints", matrix.apiEndpoint],
    ["State transitions", matrix.stateTransition],
    ["Business rules", matrix.businessRule],
  ];
  const rows = blocks
    .map(([label, block]) => {
      const planned = (block.plannedRate * 100).toFixed(1);
      const executed = (block.executedRate * 100).toFixed(1);
      return `<tr><td>${label}</td><td>${planned}%</td><td>${executed}%</td><td>${block.executedCovered}/${block.total}</td><td style="min-width:120px"><div class="meter"><i style="width:${executed}%"></i></div></td></tr>`;
    })
    .join("");
  return `<h2>Coverage Matrix</h2><table><thead><tr><th>Dimension</th><th>Planned</th><th>Executed</th><th>Covered</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function caseExecutionSection(matrix: CoverageMatrix): string {
  const ce = matrix.caseExecution;
  const moduleRows =
    ce.modules
      .map(
        (m) =>
          `<tr><td>${escapeHtml(m.module)}</td><td>${m.total}</td><td>${m.passed}</td><td>${m.failed}</td><td>${m.needsReview}</td><td>${m.notRun}</td><td>${(m.passRate * 100).toFixed(1)}%</td></tr>`,
      )
      .join("") || '<tr><td colspan="7">No live cases in scope</td></tr>';
  return `<h2>Execution Pass Matrix</h2><p class="muted">Current live cases: ${ce.total} · passed ${ce.passed} · failed ${ce.failed} · needs review ${ce.needsReview} · not run ${ce.notRun} · pass rate ${(ce.passRate * 100).toFixed(1)}%. ${escapeHtml(ce.note)}</p><table><thead><tr><th>Module</th><th>Cases</th><th>Passed</th><th>Failed</th><th>Needs review</th><th>Not run</th><th>Pass rate</th></tr></thead><tbody>${moduleRows}</tbody></table>`;
}

function recordsSection(records: ReportRecord[]): string {
  if (records.length === 0) {
    return '<h2>Execution Details</h2><p class="muted">No executions yet.</p>';
  }
  const items = records
    .map((record) => {
      const cls = STATUS_CLASS[record.status] ?? "muted";
      const steps = record.steps
        .map((step) => {
          const before = toFileUrl(step.screenshotBefore);
          const after = toFileUrl(step.screenshotAfter);
          const imgs = [before, after]
            .filter(Boolean)
            .map(
              (url) =>
                `<img src="${escapeHtml(url)}" alt="step ${step.stepIndex}">`,
            )
            .join("");
          const err = step.error
            ? `<div class="fail">${escapeHtml(step.error)}</div>`
            : "";
          return `<div class="step"><b>Step ${step.stepIndex} <span class="${STATUS_CLASS[step.result] ?? "muted"}">[${escapeHtml(step.result)}]</span></b> ${escapeHtml(step.action)}${err}${imgs}</div>`;
        })
        .join("");
      const error = record.errorCategory
        ? `<p class="fail">Error: <code>${escapeHtml(record.errorCategory)}</code> ${escapeHtml(record.errorMessage ?? "")}</p>`
        : "";
      const video = record.videoPath
        ? `<p>Video: <a href="${escapeHtml(toFileUrl(record.videoPath))}">recording</a></p>`
        : "";
      return `<details><summary>${escapeHtml(record.title)} — <span class="${cls}">${escapeHtml(record.status)}</span> <span class="muted">(${record.durationMs}ms)</span></summary>${error}${video}${steps}</details>`;
    })
    .join("");
  return `<h2>Execution Details</h2>${items}`;
}

function statsBlock(records: ReportRecord[]): string {
  const total = records.length;
  const passed = records.filter((r) => r.status === "passed").length;
  const failed = records.filter((r) => r.status === "failed").length;
  const skipped = records.filter((r) => r.status === "skipped").length;
  const review = records.filter((r) => r.status === "needs_review").length;
  const avg =
    total > 0
      ? Math.round(records.reduce((a, r) => a + r.durationMs, 0) / total)
      : 0;
  const rate = total > 0 ? `${Math.round((passed / total) * 100)}%` : "—";
  const failCounts = new Map<string, number>();
  for (const record of records) {
    if (record.status === "failed" && record.errorCategory) {
      failCounts.set(
        record.errorCategory,
        (failCounts.get(record.errorCategory) ?? 0) + 1,
      );
    }
  }
  const failList =
    failCounts.size > 0
      ? `<ul>${[...failCounts.entries()].map(([cat, n]) => `<li><code>${escapeHtml(cat)}</code>: ${n}</li>`).join("")}</ul>`
      : '<p class="muted">No failures.</p>';
  return `
<div class="rate">${rate}</div>
<div class="bar">
  <div class="stat"><b>${total}</b><span>Total</span></div>
  <div class="stat"><b class="pass">${passed}</b><span>Passed</span></div>
  <div class="stat"><b class="fail">${failed}</b><span>Failed</span></div>
  <div class="stat"><b class="skip">${skipped}</b><span>Skipped</span></div>
  <div class="stat"><b class="skip">${review}</b><span>Needs Review</span></div>
  <div class="stat"><b>${avg}ms</b><span>Avg duration</span></div>
</div>
<h2>Failure Categories</h2>${failList}`;
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${BASE_CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

/**
 * Execution ids in scope for a requirement version, mirroring the coverage
 * matrix scoping: `__none__` keeps project executions that are NOT linked to
 * any requirement; a concrete id keeps only executions linked to it.
 */
async function requirementExecutionIds(
  pid: string,
  requirementId: string,
): Promise<Set<string>> {
  const projectRows = await db
    .select({ id: executionRecords.id })
    .from(executionRecords)
    .where(eq(executionRecords.projectId, pid));
  const projectIds = projectRows.map((r) => r.id);
  const links = await db
    .select()
    .from(executionRequirements)
    .where(eq(executionRequirements.projectId, pid));
  if (requirementId === "__none__") {
    const linked = new Set(
      links.filter((l) => l.requirementId).map((l) => l.executionId),
    );
    return new Set(projectIds.filter((id) => !linked.has(id)));
  }
  return new Set(
    links
      .filter((l) => l.requirementId === requirementId)
      .map((l) => l.executionId),
  );
}

export async function buildProjectReport(
  pid: string,
  opts: { requirementId?: string | null; workflowRunId?: string | null } = {},
): Promise<string> {
  const projRows = await db.select().from(projects).where(eq(projects.id, pid));
  const project = projRows[0];
  const projectName = project?.name ?? "Project";

  let ids: string[] | null = null;
  let workflowSection = "";
  if (opts.workflowRunId) {
    const detail = await getRunDetail(opts.workflowRunId);
    ids = detail.cases
      .map((c) => c.execution?.id)
      .filter((x): x is string => Boolean(x));
    const stageRows = detail.stages
      .map(
        (s) =>
          `<tr><td>${escapeHtml(s.label)}</td><td>${escapeHtml(s.status)}</td><td>${escapeHtml(s.outputSummary ?? "")}${s.errorMessage ? ` <span class="fail">(${escapeHtml(s.errorMessage)})</span>` : ""}</td><td>${s.durationMs}ms</td></tr>`,
      )
      .join("");
    const caseRows = detail.cases
      .map((c) => {
        const issue = c.finalReview?.issues?.[0]?.problem ?? "";
        return `<tr><td>${escapeHtml(c.title)}</td><td>${escapeHtml(c.automationStatus)}</td><td>${escapeHtml(c.reviewStatus)}</td><td>${c.qualityScore}</td><td>${c.revisionCount}</td><td>${escapeHtml(c.execution?.status ?? "—")}</td><td>${escapeHtml(c.analysis?.failureCategory ?? "—")}</td><td>${escapeHtml(c.analysis?.failureReason ?? "")}${issue ? `<br><small class="muted">${escapeHtml(issue)}</small>` : ""}</td></tr>`;
      })
      .join("");
    workflowSection = `
<h2>Multi-Agent Workflow</h2>
<p class="sub">Requirement ${escapeHtml(detail.requirementVersion ?? "—")} ${escapeHtml(detail.requirementName ?? "")} · Status <b>${escapeHtml(detail.status)}</b></p>
<table><thead><tr><th>Stage</th><th>Status</th><th>Result</th><th>Duration</th></tr></thead><tbody>${stageRows}</tbody></table>
<h3 style="font-size:14px;margin:18px 0 6px">Case Review & Result Analysis</h3>
<table><thead><tr><th>Case</th><th>Automation</th><th>Review</th><th>Score</th><th>Revisions</th><th>Execution</th><th>Root Cause</th><th>Analysis</th></tr></thead><tbody>${caseRows}</tbody></table>`;
  }

  // Scope the execution records by requirement version (legacy build_report
  // filtered records by requirement, not just the coverage matrix).
  if (opts.requirementId) {
    const allowed = await requirementExecutionIds(pid, opts.requirementId);
    ids = ids ? ids.filter((id) => allowed.has(id)) : [...allowed];
  }

  const records = await loadRecords(pid, ids);
  const matrix = await getCoverageMatrix(pid, opts.requirementId ?? null);
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  const body = `
<h1>${escapeHtml(projectName)} · Test Report</h1>
<div class="sub">Generated ${generatedAt} UTC</div>
${statsBlock(records)}
${workflowSection}
${coverageSection(matrix)}
${caseExecutionSection(matrix)}
${recordsSection(records)}`;
  return page(`${projectName} Test Report`, body);
}

export async function buildExecutionReport(eid: string): Promise<string> {
  const rows = await db
    .select()
    .from(executionRecords)
    .where(eq(executionRecords.id, eid));
  const record = rows[0];
  if (!record) return page("Not Found", "<h1>Execution not found</h1>");
  const records = await loadRecords(record.projectId, [eid]);
  const projRows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, record.projectId));
  const projectName = projRows[0]?.name ?? "Project";
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  const body = `
<h1>${escapeHtml(record.testCaseTitle)}</h1>
<div class="sub">${escapeHtml(projectName)} · Execution ${escapeHtml(eid)} · Generated ${generatedAt} UTC</div>
${statsBlock(records)}
${recordsSection(records)}`;
  return page(`${record.testCaseTitle} Execution Report`, body);
}

export { STAGE_LABELS };
