/**
 * Incremental requirement analysis: baseline snapshots, change detection,
 * incremental generation, and regression recommendations.
 *
 * Design boundaries (mirroring the legacy subsystem):
 * - Existing test_cases / requirement_cases semantics are untouched; new
 *   snapshot / change-run / change / case-change tables keep phase-1 data
 *   from being overwritten by phase 2.
 * - Code analysis stays project-level "latest facts"; every requirement
 *   version freezes an immutable snapshot, and comparisons only read
 *   snapshots so a later re-analysis can never silently rewrite a baseline.
 * - Unchanged endpoints reuse their historical cases without any LLM call;
 *   modified endpoints only generate incremental points for the changed
 *   params/rules/auth.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "#/db";
import {
  caseGenerations,
  codeAnalyses,
  requirementCaseChanges,
  requirementCases,
  requirementChanges,
  requirementChangeRuns,
  requirementSnapshots,
  requirements,
  stateMachines,
  testCases,
  testPoints,
} from "#/db/schema";
import { generateLlmCasesForPoints } from "#/server/lib/generation/llm-cases";
import {
  generateRuleCasesForPoints,
  newCase,
} from "#/server/lib/generation/rule-cases";
import { createJob, runJob } from "#/server/lib/jobs";
import { asTextList } from "#/server/lib/text-list";
import {
  getGenerationContext,
  getProjectOr404,
  inList,
  uuid,
} from "#/server/services/projects";
import { getRequirementOr404 } from "#/server/services/requirements";
import { BizError, getTextClient } from "#/server/services/settings";
import { saveGeneratedCaseInTx } from "#/server/services/testcases";

import type { PointInput } from "#/server/lib/generation/test-points";
import type { Tx } from "#/server/services/testcases";
import type {
  BackendResult,
  BusinessRule,
  Endpoint,
  FrontendResult,
  GeneratedCase,
  StateMachineSpec,
} from "#/lib/types";

// ---------- Constants & small helpers ----------

const DELETION_WORDS = [
  "delete",
  "deleted",
  "remove",
  "removed",
  "deprecate",
  "deprecated",
  "retire",
  "retired",
  "discontinue",
  "discontinued",
  "no longer provided",
  "no longer supported",
  "drop",
  "dropped",
  // Legacy Chinese PRDs remain readable by the same flow.
  "删除",
  "移除",
  "下线",
  "废弃",
  "不再提供",
  "不再支持",
  "停止提供",
];
const DELETION_NEGATIONS = [
  "not delete",
  "keep",
  "不删除",
  "无需删除",
  "保留",
  "暂不删除",
];
const SECURITY_PATTERNS = [
  "SecurityFilterChain",
  "authorizeHttpRequests",
  "hasRole",
  "hasAuthority",
  "permitAll",
  "denyAll",
  "@PreAuthorize",
  "@Secured",
  "@RolesAllowed",
  "@EnableWebSecurity",
];
const PRD_ENDPOINT_RE =
  /\b(GET|POST|PUT|DELETE|PATCH)\s+(\/[A-Za-z0-9\-./{}:_-]+)/gi;
const PARAM_KEY_RE = /\{[^/{}]+\}|:[A-Za-z_][A-Za-z0-9_]*/g;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{8,}$/i;

type Json = Record<string, unknown>;

function stableStringify(value: unknown): string {
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) {
        out[key] = walk((item as Record<string, unknown>)[key]);
      }
      return out;
    }
    return item;
  };
  return JSON.stringify(walk(value));
}

function sha(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value), "utf8")
    .digest("hex");
}

function normText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** Path normalization for matching only; never rewrites the displayed path. */
export function normalizePath(rawPath: string): string {
  let raw = String(rawPath || "/")
    .split("?")[0]
    .trim();
  raw = raw.replace(/\/+/g, "/");
  raw = raw.replace(PARAM_KEY_RE, "{param}");
  const segments = raw
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((segment) =>
      segment &&
      (/^\d+$/.test(segment) || UUID_RE.test(segment) || HEX_RE.test(segment))
        ? "{param}"
        : segment.toLowerCase(),
    );
  return `/${segments.join("/")}`;
}

export function endpointKey(endpoint: Json): string {
  return `${String(endpoint.method ?? "").toUpperCase()} ${normalizePath(String(endpoint.path ?? ""))}`;
}

// ---------- Snapshot building ----------

interface SnapshotEndpoint extends Json {
  id: string;
  method: string;
  path: string;
  normalizedPath: string;
  controller: string;
  methodName: string;
  file: string;
  line: number;
  params: Json[];
  auth: string[];
  rules: Json[];
  fingerprint: string;
}

function entityMap(backend: BackendResult): Map<string, Json> {
  const result = new Map<string, Json>();
  for (const entity of backend.entities) {
    const fields = entity.fields.map((field) => {
      const constraints = entity.fieldConstraints
        .filter((c) => c.field === field.name)
        .map((c) => ({ rule: c.rule, value: c.value ?? null }));
      return {
        name: field.name,
        type: field.type,
        constraints,
        required: constraints.some((c) =>
          ["notblank", "notnull", "notempty"].includes(String(c.rule)),
        ),
      };
    });
    result.set(entity.name, { name: entity.name, file: entity.file, fields });
  }
  return result;
}

/** Expand @RequestBody DTOs into field-level params so required/constraint changes are visible. */
function expandParams(params: Json[], entities: Map<string, Json>): Json[] {
  const expanded: Json[] = [];
  const seen = new Set<string>();
  for (const param of params || []) {
    if (!param || typeof param !== "object") continue;
    const item = {
      name: String(param.name ?? ""),
      type: String(param.type ?? ""),
      source: String(param.source ?? "unknown"),
      required: Boolean(param.required),
      constraints: ((param.constraints ?? []) as unknown[]).map(String).sort(),
    };
    if (!item.name) continue;
    const signature = `${item.name}|${item.source}`;
    if (!seen.has(signature)) {
      expanded.push(item);
      seen.add(signature);
    }
    const dtoType = String(param.dtoType ?? "");
    const entity = entities.get(dtoType);
    if (!entity) continue;
    for (const field of (entity.fields ?? []) as Json[]) {
      const fieldName = String(field.name ?? "");
      if (!fieldName) continue;
      const constraints = ((field.constraints ?? []) as Json[])
        .filter((c) => c.rule)
        .map((c) =>
          c.value !== null && c.value !== undefined
            ? `${String(c.rule)}(${String(c.value)})`
            : String(c.rule),
        )
        .sort();
      const fieldSource = "request_body_field";
      const fieldSignature = `${fieldName}|${fieldSource}`;
      if (seen.has(fieldSignature)) continue;
      expanded.push({
        name: fieldName,
        type: String(field.type ?? ""),
        source: fieldSource,
        required: Boolean(field.required),
        constraints,
      });
      seen.add(fieldSignature);
    }
  }
  return expanded;
}

function ruleSnapshot(rule: BusinessRule): Json {
  return {
    id: rule.id ?? "",
    description: rule.description ?? "",
    guard: rule.guard ?? "",
    file: rule.file ?? "",
    line: rule.line ?? 0,
    key: `${normText(rule.description)}|${normText(rule.guard)}`,
  };
}

function relatedRules(endpoint: Endpoint, rules: Json[]): Json[] {
  const related: Json[] = [];
  const methodName = String(endpoint.methodName || "").toLowerCase();
  for (const rule of rules) {
    const sameFile = rule.file && rule.file === endpoint.file;
    const near =
      sameFile &&
      Math.abs(Number(rule.line ?? 0) - Number(endpoint.line ?? 0)) <= 120;
    const text = `${rule.description ?? ""} ${rule.guard ?? ""}`.toLowerCase();
    const semantic = Boolean(
      methodName && methodName.length >= 4 && text.includes(methodName),
    );
    if (near || semantic) related.push(rule);
  }
  return related;
}

/** Lightweight scan of shared security configuration; explicitly marked unavailable when sources cannot be read. */
function buildSecurity(sourcePath: string | null): Json {
  const root = sourcePath || "";
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return {
      available: false,
      hash: "",
      signals: [],
      reason: "Source directory unavailable",
    };
  }
  const signals: { file: string; patterns: string[] }[] = [];
  let files = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files > 500) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["target", "build", ".git", "node_modules"].includes(entry.name))
          continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".java")) continue;
      files += 1;
      let text = "";
      try {
        if (fs.statSync(abs).size > 2 * 1024 * 1024) continue;
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const matched = SECURITY_PATTERNS.filter((pattern) =>
        text.includes(pattern),
      ).sort();
      if (matched.length > 0) {
        signals.push({ file: path.relative(root, abs), patterns: matched });
      }
    }
  };
  walk(root);
  const payload = signals.sort((a, b) => a.file.localeCompare(b.file));
  return {
    available: true,
    hash: sha(payload),
    signals: payload.slice(0, 30),
    filesScanned: files,
  };
}

function transitionSnapshot(machines: Json[]): Json[] {
  const out: Json[] = [];
  for (const machine of machines || []) {
    for (const transition of (machine.transitions ?? []) as Json[]) {
      if (!transition.verified) continue;
      const item = {
        id: String(transition.id ?? ""),
        machine: String(machine.name ?? ""),
        from: String(transition.from ?? ""),
        to: String(transition.to ?? ""),
        trigger: String(transition.trigger ?? ""),
        key: `${String(transition.from ?? "")}->${String(transition.to ?? "")}:${String(transition.trigger ?? "")}`,
      };
      if (item.id) out.push(item);
    }
  }
  return out;
}

export interface SnapshotDict {
  id: string;
  projectId: string;
  requirementId: string;
  analysisId: string | null;
  source: string;
  endpoints: SnapshotEndpoint[];
  rules: Json[];
  stateTransitions: Json[];
  security: Json;
  warnings: unknown[];
  fingerprint: string | null;
  createdAt: string | null;
}

type SnapshotRow = typeof requirementSnapshots.$inferSelect;

function snapshotToDict(row: SnapshotRow): SnapshotDict {
  return {
    id: row.id,
    projectId: row.projectId,
    requirementId: row.requirementId,
    analysisId: row.analysisId,
    source: row.source,
    endpoints: (row.endpoints ?? []) as unknown as SnapshotEndpoint[],
    rules: row.rules ?? [],
    stateTransitions: row.stateTransitions ?? [],
    security: row.security ?? {},
    warnings: row.warnings ?? [],
    fingerprint: row.fingerprint,
    createdAt: row.createdAt?.toISOString() ?? null,
  };
}

/** Freeze an endpoint/rule snapshot for a requirement version. */
export async function buildSnapshot(
  requirementId: string,
  options: { analysisId?: string | null; source?: string } = {},
): Promise<SnapshotDict> {
  const requirement = await getRequirementOr404(requirementId);
  const project = await getProjectOr404(requirement.projectId);

  let analysis: typeof codeAnalyses.$inferSelect | undefined;
  if (options.analysisId) {
    const rows = await db
      .select()
      .from(codeAnalyses)
      .where(
        and(
          eq(codeAnalyses.id, options.analysisId),
          eq(codeAnalyses.projectId, project.id),
        ),
      )
      .limit(1);
    analysis = rows[0];
    if (!analysis) {
      throw new BizError(
        40410,
        `Code analysis not found: ${options.analysisId}`,
      );
    }
  } else {
    const rows = await db
      .select()
      .from(codeAnalyses)
      .where(eq(codeAnalyses.projectId, project.id))
      .orderBy(desc(codeAnalyses.createdAt))
      .limit(1);
    analysis = rows[0];
  }
  if (!analysis || analysis.status !== "success") {
    throw new BizError(
      40060,
      "No successful code analysis available; run code analysis first",
    );
  }

  const backend = analysis.backendResult ?? {
    language: "unknown",
    endpoints: [],
    entities: [],
    enums: [],
    businessRules: [],
    uiTexts: [],
  };
  const machineRows = await db
    .select()
    .from(stateMachines)
    .where(eq(stateMachines.projectId, project.id));
  const machines: Json[] = machineRows.map((row) => ({
    id: row.id,
    name: row.name,
    states: row.states ?? [],
    transitions: (row.transitions ?? []) as unknown as Json[],
    confidence: row.confidence,
  }));

  const entities = entityMap(backend);
  const rules = backend.businessRules.map(ruleSnapshot);
  const endpoints: SnapshotEndpoint[] = [];
  for (const endpoint of backend.endpoints) {
    const related = relatedRules(endpoint, rules);
    const item = {
      id: endpoint.id,
      method: String(endpoint.method || "").toUpperCase(),
      path: endpoint.path || "",
      normalizedPath: normalizePath(endpoint.path),
      controller: endpoint.controller || "",
      methodName: endpoint.methodName || "",
      file: endpoint.file || "",
      line: endpoint.line || 0,
      params: expandParams(
        ((endpoint.params ?? []) as unknown as Json[]).map((p) => p),
        entities,
      ),
      auth: [...(endpoint.auth ?? [])].map(String).sort(),
      rules: related,
    } as SnapshotEndpoint;
    item.fingerprint = sha({
      method: item.method,
      path: item.normalizedPath,
      controller: item.controller,
      methodName: item.methodName,
      params: item.params,
      auth: item.auth,
      rules: related.map((rule) => rule.key),
    });
    endpoints.push(item);
  }

  const security = buildSecurity(project.sourcePath);
  const transitions = transitionSnapshot(machines);
  const fingerprint = sha({
    endpoints,
    rules,
    stateTransitions: transitions,
    security,
    warnings: analysis.warnings ?? [],
  });
  const id = uuid();
  await db.insert(requirementSnapshots).values({
    id,
    projectId: project.id,
    requirementId,
    analysisId: analysis.id,
    baselineRequirementId: null,
    source: options.source ?? "code_analysis",
    endpoints: endpoints,
    rules,
    stateTransitions: transitions,
    security,
    warnings: (analysis.warnings ?? []) as unknown[],
    fingerprint,
  });
  const rows = await db
    .select()
    .from(requirementSnapshots)
    .where(eq(requirementSnapshots.id, id))
    .limit(1);
  return snapshotToDict(rows[0]);
}

export async function getLatestSnapshotRow(
  requirementId: string,
): Promise<SnapshotRow | null> {
  const rows = await db
    .select()
    .from(requirementSnapshots)
    .where(eq(requirementSnapshots.requirementId, requirementId))
    .orderBy(desc(requirementSnapshots.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getLatestSnapshot(
  requirementId: string,
): Promise<SnapshotDict | null> {
  const row = await getLatestSnapshotRow(requirementId);
  return row ? snapshotToDict(row) : null;
}

/** Latest snapshot, rebuilt when a newer successful code analysis exists. */
export async function ensureCurrentSnapshot(
  requirementId: string,
): Promise<SnapshotDict> {
  const requirement = await getRequirementOr404(requirementId);
  const row = await getLatestSnapshotRow(requirementId);
  const analyses = await db
    .select({ id: codeAnalyses.id, status: codeAnalyses.status })
    .from(codeAnalyses)
    .where(eq(codeAnalyses.projectId, requirement.projectId))
    .orderBy(desc(codeAnalyses.createdAt))
    .limit(1);
  const latest = analyses[0];
  if (
    row &&
    (latest?.status !== "success" ||
      !row.analysisId ||
      row.analysisId === latest.id)
  ) {
    return snapshotToDict(row);
  }
  return buildSnapshot(requirementId);
}

// ---------- Snapshot comparison ----------

function endpointReasons(oldEp: Json, newEp: Json): string[] {
  const reasons: string[] = [];
  if (String(oldEp.path ?? "") !== String(newEp.path ?? "")) {
    reasons.push(`Path changed: ${oldEp.path} → ${newEp.path}`);
  }
  for (const [field, label] of [
    ["controller", "Controller"],
    ["methodName", "Method name"],
    ["method", "HTTP method"],
  ] as const) {
    if (String(oldEp[field] ?? "") !== String(newEp[field] ?? "")) {
      reasons.push(
        `${label} changed: ${String(oldEp[field])} → ${String(newEp[field])}`,
      );
    }
  }

  const keyOf = (p: Json) => `${p.name}|${p.source}`;
  const oldParams = new Map(
    ((oldEp.params ?? []) as Json[]).map((p) => [keyOf(p), p]),
  );
  const newParams = new Map(
    ((newEp.params ?? []) as Json[]).map((p) => [keyOf(p), p]),
  );
  for (const key of [...newParams.keys()]
    .filter((k) => !oldParams.has(k))
    .sort()) {
    reasons.push(`New parameter: ${newParams.get(key)!.name}`);
  }
  for (const key of [...oldParams.keys()]
    .filter((k) => !newParams.has(k))
    .sort()) {
    reasons.push(`Removed parameter: ${oldParams.get(key)!.name}`);
  }
  for (const key of [...newParams.keys()]
    .filter((k) => oldParams.has(k))
    .sort()) {
    const before = oldParams.get(key)!;
    const after = newParams.get(key)!;
    if (Boolean(before.required) !== Boolean(after.required)) {
      reasons.push(
        `Parameter ${after.name} required changed: ${String(before.required)} → ${String(after.required)}`,
      );
    }
    const bc = [...((before.constraints ?? []) as string[])].sort();
    const ac = [...((after.constraints ?? []) as string[])].sort();
    if (JSON.stringify(bc) !== JSON.stringify(ac)) {
      reasons.push(`Parameter ${after.name} constraints changed`);
    }
  }

  const oldAuth = [...((oldEp.auth ?? []) as string[])].sort();
  const newAuth = [...((newEp.auth ?? []) as string[])].sort();
  if (JSON.stringify(oldAuth) !== JSON.stringify(newAuth)) {
    reasons.push("Endpoint auth requirements changed");
  }
  const oldRules = new Set(
    ((oldEp.rules ?? []) as Json[]).map((r) => String(r.key)),
  );
  const newRules = new Set(
    ((newEp.rules ?? []) as Json[]).map((r) => String(r.key)),
  );
  if (
    [...oldRules].some((k) => !newRules.has(k)) ||
    [...newRules].some((k) => !oldRules.has(k))
  ) {
    reasons.push("Related business rules changed");
  }
  return reasons;
}

function sentenceFor(text: string, needle: string): string {
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return "";
  const start = Math.max(0, index - 100);
  const end = Math.min(text.length, index + needle.length + 100);
  return text.slice(start, end);
}

/** Only treat a doc sentence near the endpoint that explicitly says delete/offline as deletion evidence. */
export function explicitDeletion(content: string, endpoint: Json): boolean {
  if (!(content || "").trim()) return false;
  const text = content.replace(/\r/g, "\n");
  const method = String(endpoint.method ?? "").toLowerCase();
  const rawPath = String(endpoint.path ?? "").toLowerCase();
  if (!rawPath) return false;
  const candidates = [`${method} ${rawPath}`, rawPath, normalizePath(rawPath)];
  for (const candidate of candidates) {
    const sentence = sentenceFor(text, candidate);
    if (!sentence) continue;
    const lowered = sentence.toLowerCase();
    if (DELETION_NEGATIONS.some((word) => lowered.includes(word))) continue;
    if (DELETION_WORDS.some((word) => lowered.includes(word))) return true;
  }
  return false;
}

function prdRefs(
  content: string,
): { method: string; path: string; key: string }[] {
  const refs: { method: string; path: string; key: string }[] = [];
  for (const match of (content || "").matchAll(PRD_ENDPOINT_RE)) {
    const item = {
      method: (match[1] ?? "").toUpperCase(),
      path: String(match[2] ?? "").replace(/[.,;:]+$/, ""),
    };
    refs.push({ ...item, key: endpointKey(item) });
  }
  return refs;
}

interface ChangeDraft {
  entity_type: string;
  change_type: string;
  match_key: string;
  old_ref?: string | null;
  new_ref?: string | null;
  old_data?: unknown;
  new_data?: unknown;
  reason: string;
  confidence: number;
  requires_confirmation: boolean;
  review_status: string;
}

function addChange(
  target: ChangeDraft[],
  change: {
    entityType: string;
    changeType: string;
    matchKey: string;
    oldRef?: string | null;
    newRef?: string | null;
    oldData?: unknown;
    newData?: unknown;
    reason?: string;
    confidence?: number;
    requiresConfirmation?: boolean;
  },
): ChangeDraft {
  const draft: ChangeDraft = {
    entity_type: change.entityType,
    change_type: change.changeType,
    match_key: change.matchKey.slice(0, 255),
    old_ref: change.oldRef ?? null,
    new_ref: change.newRef ?? null,
    old_data: change.oldData,
    new_data: change.newData,
    reason: change.reason ?? "",
    confidence: change.confidence ?? 1,
    requires_confirmation: Boolean(change.requiresConfirmation),
    review_status: change.requiresConfirmation ? "pending" : "auto",
  };
  target.push(draft);
  return draft;
}

/** Ratcliff-Obershelp matching-char count (Python difflib SequenceMatcher semantics). */
function matchingChars(a: string, b: string): number {
  if (!a || !b) return 0;
  let bestI = 0;
  let bestJ = 0;
  let bestSize = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > bestSize) {
        bestI = i;
        bestJ = j;
        bestSize = k;
      }
    }
  }
  if (bestSize === 0) return 0;
  return (
    bestSize +
    matchingChars(a.slice(0, bestI), b.slice(0, bestJ)) +
    matchingChars(a.slice(bestI + bestSize), b.slice(bestJ + bestSize))
  );
}

/** difflib-compatible ratio: 2*matched/(len(a)+len(b)); the 0.6/0.85 thresholds assume it. */
function similarity(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  return (2 * matchingChars(a, b)) / total;
}

/**
 * Match an old endpoint against remaining new ones by method name /
 * controller / path similarity. Returns the best candidate, or a tie list
 * when no single candidate wins.
 */
function findPathCandidate(
  oldEp: Json,
  candidates: Json[],
): { candidate: Json | null; ties: [number, number, Json][] } {
  const scored: [number, number, Json][] = [];
  const oldNorm = normalizePath(String(oldEp.path ?? ""));
  for (const newEp of candidates) {
    if (
      String(oldEp.method ?? "").toUpperCase() !==
      String(newEp.method ?? "").toUpperCase()
    ) {
      continue;
    }
    const sameMethodName = Boolean(
      oldEp.methodName && oldEp.methodName === newEp.methodName,
    );
    let score = sameMethodName ? 3.0 : 0.0;
    if (oldEp.controller && oldEp.controller === newEp.controller) score += 1;
    const ratio = similarity(oldNorm, normalizePath(String(newEp.path ?? "")));
    if (sameMethodName && ratio >= 0.6) score += 1;
    else if (!sameMethodName && ratio >= 0.85) score += 2;
    // Only treat two different keys as the same business endpoint when the
    // method name matches or the path is highly similar.
    if (score >= 3 && (sameMethodName || ratio >= 0.85)) {
      scored.push([score, ratio, newEp]);
    }
  }
  scored.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  if (scored.length === 0) return { candidate: null, ties: [] };
  const top = scored[0];
  const ties = scored.filter(
    (item) => item[0] === top[0] && item[1] === top[1],
  );
  if (ties.length > 1) return { candidate: null, ties };
  return { candidate: top[2], ties: [] };
}

export interface CompareSummary {
  baselineEndpoints: number;
  currentEndpoints: number;
  endpointCounts: Record<string, number>;
  ruleCounts: Record<string, number>;
  stateTransitionCounts: Record<string, number>;
  conflicts: number;
  requiresConfirmation: number;
  unchangedEndpoints: number;
  hasChanges: boolean;
}

/** Compare two snapshots; returns structured changes + stats. No DB writes. */
export function compareSnapshots(
  baseline: SnapshotDict,
  current: SnapshotDict,
  requirementContent = "",
): { changes: ChangeDraft[]; summary: CompareSummary } {
  const changes: ChangeDraft[] = [];
  const oldEndpoints = [...(baseline.endpoints ?? [])] as Json[];
  const newEndpoints = [...(current.endpoints ?? [])] as Json[];
  const oldByKey = new Map<string, Json[]>();
  const newByKey = new Map<string, Json[]>();
  for (const endpoint of oldEndpoints) {
    const key = endpointKey(endpoint);
    oldByKey.set(key, [...(oldByKey.get(key) ?? []), endpoint]);
  }
  for (const endpoint of newEndpoints) {
    const key = endpointKey(endpoint);
    newByKey.set(key, [...(newByKey.get(key) ?? []), endpoint]);
  }

  const matchedOld = new Set<string>();
  const matchedNew = new Set<string>();

  const commonKeys = [...oldByKey.keys()].filter((k) => newByKey.has(k)).sort();
  for (const key of commonKeys) {
    const oldList = oldByKey.get(key)!;
    const newList = newByKey.get(key)!;
    if (oldList.length === 1 && newList.length === 1) {
      const [oldEp] = oldList;
      const [newEp] = newList;
      const reasons = endpointReasons(oldEp, newEp);
      if (reasons.length > 0) {
        addChange(changes, {
          entityType: "endpoint",
          changeType: "modified",
          matchKey: key,
          oldData: oldEp,
          newData: newEp,
          oldRef: String(oldEp.id),
          newRef: String(newEp.id),
          reason: reasons.join("; "),
          confidence: 0.92,
        });
      } else {
        addChange(changes, {
          entityType: "endpoint",
          changeType: "unchanged",
          matchKey: key,
          oldData: oldEp,
          newData: newEp,
          oldRef: String(oldEp.id),
          newRef: String(newEp.id),
          reason: "No changes to endpoint, params, auth, or related rules",
          confidence: 1.0,
        });
      }
      matchedOld.add(String(oldEp.id));
      matchedNew.add(String(newEp.id));
    } else {
      addChange(changes, {
        entityType: "endpoint",
        changeType: "uncertain",
        matchKey: key,
        oldData: oldList,
        newData: newList,
        reason:
          "Multiple endpoints share the same method + normalized path; matching needs manual confirmation",
        confidence: 0.4,
        requiresConfirmation: true,
      });
      for (const item of oldList) matchedOld.add(String(item.id));
      for (const item of newList) matchedNew.add(String(item.id));
    }
  }

  const remainingOld = oldEndpoints.filter(
    (ep) => !matchedOld.has(String(ep.id)),
  );
  const remainingNew = newEndpoints.filter(
    (ep) => !matchedNew.has(String(ep.id)),
  );

  for (const oldEp of remainingOld) {
    const { candidate, ties } = findPathCandidate(oldEp, remainingNew);
    if (candidate) {
      const reasons = endpointReasons(oldEp, candidate);
      addChange(changes, {
        entityType: "endpoint",
        changeType: "modified",
        matchKey: endpointKey(candidate),
        oldData: oldEp,
        newData: candidate,
        oldRef: String(oldEp.id),
        newRef: String(candidate.id),
        reason: `${reasons.join("; ")}; path/signature changed, matched by method name/controller, needs confirmation`,
        confidence: 0.6,
        requiresConfirmation: true,
      });
      matchedOld.add(String(oldEp.id));
      matchedNew.add(String(candidate.id));
    } else if (ties.length > 0) {
      addChange(changes, {
        entityType: "endpoint",
        changeType: "uncertain",
        matchKey: endpointKey(oldEp),
        oldData: oldEp,
        newData: ties.map((item) => item[2]),
        oldRef: String(oldEp.id),
        reason:
          "Several suspected matching endpoints; cannot reliably decide whether it is the same business endpoint, needs manual confirmation",
        confidence: 0.35,
        requiresConfirmation: true,
      });
      matchedOld.add(String(oldEp.id));
    }
  }

  for (const oldEp of remainingOld) {
    if (matchedOld.has(String(oldEp.id))) continue;
    if (explicitDeletion(requirementContent, oldEp)) {
      addChange(changes, {
        entityType: "endpoint",
        changeType: "deleted",
        matchKey: endpointKey(oldEp),
        oldData: oldEp,
        oldRef: String(oldEp.id),
        reason:
          "The requirements doc explicitly deletes this endpoint; historical cases and executions are kept, only marked obsolete after confirmation",
        confidence: 0.95,
        requiresConfirmation: true,
      });
    } else {
      addChange(changes, {
        entityType: "endpoint",
        changeType: "uncertain",
        matchKey: endpointKey(oldEp),
        oldData: oldEp,
        oldRef: String(oldEp.id),
        reason:
          "Not found in the current code analysis and not explicitly deleted in the doc; needs manual confirmation",
        confidence: 0.4,
        requiresConfirmation: true,
      });
    }
    matchedOld.add(String(oldEp.id));
  }

  for (const newEp of remainingNew) {
    if (matchedNew.has(String(newEp.id))) continue;
    addChange(changes, {
      entityType: "endpoint",
      changeType: "added",
      matchKey: endpointKey(newEp),
      newData: newEp,
      newRef: String(newEp.id),
      reason: "New endpoint in the current code analysis",
      confidence: 0.95,
    });
    matchedNew.add(String(newEp.id));
  }

  // Business rules: match by description first, then compare guards; missing
  // rules are only marked uncertain, never deleted outright.
  const oldRules = [...(baseline.rules ?? [])];
  const newRules = [...(current.rules ?? [])];
  const oldRuleByDesc = new Map<string, Json[]>();
  const newRuleByDesc = new Map<string, Json[]>();
  for (const rule of oldRules) {
    const key = normText(rule.description);
    oldRuleByDesc.set(key, [...(oldRuleByDesc.get(key) ?? []), rule]);
  }
  for (const rule of newRules) {
    const key = normText(rule.description);
    newRuleByDesc.set(key, [...(newRuleByDesc.get(key) ?? []), rule]);
  }
  const matchedRuleIds = new Set<string>();
  for (const descKey of [...oldRuleByDesc.keys()]
    .filter((k) => newRuleByDesc.has(k))
    .sort()) {
    const before = oldRuleByDesc.get(descKey)![0];
    const after = newRuleByDesc.get(descKey)![0];
    matchedRuleIds.add(String(before.id));
    matchedRuleIds.add(String(after.id));
    if (normText(before.guard) !== normText(after.guard)) {
      addChange(changes, {
        entityType: "business_rule",
        changeType: "modified",
        matchKey: descKey,
        oldData: before,
        newData: after,
        oldRef: String(before.id),
        newRef: String(after.id),
        reason: "Same rule description but the guard condition changed",
        confidence: 0.9,
      });
    }
  }
  for (const rule of oldRules) {
    if (matchedRuleIds.has(String(rule.id))) continue;
    addChange(changes, {
      entityType: "business_rule",
      changeType: "uncertain",
      matchKey: normText(rule.description),
      oldData: rule,
      oldRef: String(rule.id),
      reason:
        "Not found in the current code analysis and not explicitly deleted in the doc; needs manual confirmation",
      confidence: 0.4,
      requiresConfirmation: true,
    });
  }
  for (const rule of newRules) {
    if (matchedRuleIds.has(String(rule.id))) continue;
    addChange(changes, {
      entityType: "business_rule",
      changeType: "added",
      matchKey: normText(rule.description),
      newData: rule,
      newRef: String(rule.id),
      reason: "New business rule in the current code analysis",
      confidence: 0.9,
    });
  }

  // State transitions
  const oldTransitions = new Map(
    (baseline.stateTransitions ?? []).map((item) => [String(item.key), item]),
  );
  const newTransitions = new Map(
    (current.stateTransitions ?? []).map((item) => [String(item.key), item]),
  );
  for (const key of [...newTransitions.keys()]
    .filter((k) => !oldTransitions.has(k))
    .sort()) {
    addChange(changes, {
      entityType: "state_transition",
      changeType: "added",
      matchKey: key,
      newData: newTransitions.get(key),
      newRef: String(newTransitions.get(key)!.id),
      reason: "New state transition",
      confidence: 0.9,
    });
  }
  for (const key of [...oldTransitions.keys()]
    .filter((k) => !newTransitions.has(k))
    .sort()) {
    addChange(changes, {
      entityType: "state_transition",
      changeType: "uncertain",
      matchKey: key,
      oldData: oldTransitions.get(key),
      oldRef: String(oldTransitions.get(key)!.id),
      reason:
        "Not found in the current code analysis; confirm whether it was deleted",
      confidence: 0.4,
      requiresConfirmation: true,
    });
  }

  // Shared security configuration
  const oldSecurity = baseline.security ?? {};
  const newSecurity = current.security ?? {};
  if (
    oldSecurity.available &&
    newSecurity.available &&
    oldSecurity.hash !== newSecurity.hash
  ) {
    addChange(changes, {
      entityType: "permission",
      changeType: "modified",
      matchKey: "security-config",
      oldData: oldSecurity,
      newData: newSecurity,
      reason:
        "Shared security configuration changed; may affect every protected endpoint (inferred from security config text)",
      confidence: 0.75,
      requiresConfirmation: true,
    });
  }

  // Doc mentions an endpoint the code analysis does not have -> conflict, never silently generated.
  for (const ref of prdRefs(requirementContent)) {
    if (newByKey.has(ref.key)) continue;
    const oldList = oldByKey.get(ref.key);
    if (oldList && explicitDeletion(requirementContent, oldList[0])) continue;
    addChange(changes, {
      entityType: "conflict",
      changeType: "uncertain",
      matchKey: ref.key,
      oldData: oldList ?? [],
      newData: null,
      reason:
        "The requirements doc mentions this endpoint but the current code analysis does not find it; confirm the analysis is up to date",
      confidence: 0.3,
      requiresConfirmation: true,
    });
  }

  const endpointCounts: Record<string, number> = {};
  const ruleCounts: Record<string, number> = {};
  const transitionCounts: Record<string, number> = {};
  for (const change of changes) {
    if (change.entity_type === "endpoint") {
      endpointCounts[change.change_type] =
        (endpointCounts[change.change_type] ?? 0) + 1;
    } else if (change.entity_type === "business_rule") {
      ruleCounts[change.change_type] =
        (ruleCounts[change.change_type] ?? 0) + 1;
    } else if (change.entity_type === "state_transition") {
      transitionCounts[change.change_type] =
        (transitionCounts[change.change_type] ?? 0) + 1;
    }
  }
  const summary: CompareSummary = {
    baselineEndpoints: oldEndpoints.length,
    currentEndpoints: newEndpoints.length,
    endpointCounts,
    ruleCounts,
    stateTransitionCounts: transitionCounts,
    conflicts: changes.filter((c) => c.entity_type === "conflict").length,
    requiresConfirmation: changes.filter((c) => c.requires_confirmation).length,
    unchangedEndpoints: endpointCounts.unchanged ?? 0,
    hasChanges: changes.some(
      (c) =>
        ["added", "modified", "deleted"].includes(c.change_type) &&
        c.entity_type !== "conflict",
    ),
  };
  return { changes, summary };
}

// ---------- Run / change serialization ----------

type ChangeRow = typeof requirementChanges.$inferSelect;
type CaseChangeRow = typeof requirementCaseChanges.$inferSelect;
type RunRow = typeof requirementChangeRuns.$inferSelect;

export interface ChangeDict {
  id: string;
  runId: string;
  entityType: string;
  changeType: string;
  matchKey: string;
  oldRef: string | null;
  newRef: string | null;
  oldData: unknown;
  newData: unknown;
  reason: string;
  confidence: number;
  requiresConfirmation: boolean;
  reviewStatus: string;
  createdAt: string | null;
}

export interface CaseChangeDict {
  id: string;
  runId: string;
  changeId: string | null;
  testCaseId: string | null;
  baselineCaseId: string | null;
  action: string;
  targetCaseTitle: string;
  baselineCaseTitle: string;
  regressionImpact: string;
  regressionReason: string;
  regressionStatus: string;
  confidence: number;
  reviewStatus: string;
  reason: string;
  createdAt: string | null;
}

export interface RunDict {
  id: string;
  projectId: string;
  requirementId: string;
  requirementVersion: string;
  requirementName: string;
  baselineRequirementId: string;
  baselineRequirementVersion: string;
  baselineRequirementName: string;
  status: string;
  mode: string;
  profileId: string | null;
  summary: Json;
  errorMessage: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  changes: ChangeDict[];
  caseChanges: CaseChangeDict[];
}

function changeToDict(row: ChangeRow): ChangeDict {
  return {
    id: row.id,
    runId: row.runId,
    entityType: row.entityType,
    changeType: row.changeType,
    matchKey: row.matchKey,
    oldRef: row.oldRef,
    newRef: row.newRef,
    oldData: row.oldData,
    newData: row.newData,
    reason: row.reason || "",
    confidence: row.confidence,
    requiresConfirmation: row.requiresConfirmation,
    reviewStatus: row.reviewStatus,
    createdAt: row.createdAt?.toISOString() ?? null,
  };
}

function caseChangeToDict(
  row: CaseChangeRow,
  titleById: Map<string, string>,
): CaseChangeDict {
  return {
    id: row.id,
    runId: row.runId,
    changeId: row.changeId,
    testCaseId: row.testCaseId,
    baselineCaseId: row.baselineCaseId,
    action: row.action,
    targetCaseTitle: titleById.get(row.testCaseId ?? "") ?? "",
    baselineCaseTitle: titleById.get(row.baselineCaseId ?? "") ?? "",
    regressionImpact: row.regressionImpact,
    regressionReason: row.regressionReason || "",
    regressionStatus: row.regressionStatus,
    confidence: row.confidence,
    reviewStatus: row.reviewStatus,
    reason: row.reason || "",
    createdAt: row.createdAt?.toISOString() ?? null,
  };
}

function caseChangesSummary(rows: CaseChangeRow[]): Json {
  const byAction: Record<string, number> = {};
  const byImpact: Record<string, number> = {};
  const regressionBaselineIds = new Set<string>();
  let pending = 0;
  for (const row of rows) {
    byAction[row.action] = (byAction[row.action] ?? 0) + 1;
    byImpact[row.regressionImpact] = (byImpact[row.regressionImpact] ?? 0) + 1;
    if (
      row.baselineCaseId &&
      ["direct", "indirect"].includes(row.regressionImpact) &&
      row.regressionStatus !== "rejected"
    ) {
      regressionBaselineIds.add(row.baselineCaseId);
    }
    if (row.reviewStatus === "pending") pending += 1;
  }
  return {
    actions: byAction,
    regressionImpact: byImpact,
    regressionRecommended: regressionBaselineIds.size,
    pendingReview: pending,
    created: byAction.created ?? 0,
    updated: byAction.updated ?? 0,
    reused: byAction.reused ?? 0,
    pendingDelete: byAction.pending_delete ?? 0,
    missing: byAction.missing ?? 0,
  };
}

async function runToDict(
  run: RunRow,
  options: { includeChanges?: boolean } = {},
): Promise<RunDict> {
  const includeChanges = options.includeChanges ?? true;
  const changeRows = includeChanges
    ? await db
        .select()
        .from(requirementChanges)
        .where(eq(requirementChanges.runId, run.id))
    : [];
  const caseRows = includeChanges
    ? await db
        .select()
        .from(requirementCaseChanges)
        .where(eq(requirementCaseChanges.runId, run.id))
    : [];
  const caseIds = [
    ...new Set(
      caseRows
        .flatMap((row) => [row.testCaseId, row.baselineCaseId])
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const titleById = new Map<string, string>();
  if (caseIds.length > 0) {
    const rows = await db
      .select({ id: testCases.id, title: testCases.title })
      .from(testCases)
      .where(inList(testCases.id, caseIds));
    for (const row of rows) titleById.set(row.id, row.title);
  }
  const reqRows = await db
    .select()
    .from(requirements)
    .where(
      inList(requirements.id, [run.requirementId, run.baselineRequirementId]),
    );
  const req = reqRows.find((r) => r.id === run.requirementId);
  const baseline = reqRows.find((r) => r.id === run.baselineRequirementId);
  const summary = { ...(run.summary ?? {}) };
  summary.caseChanges = caseChangesSummary(caseRows);
  return {
    id: run.id,
    projectId: run.projectId,
    requirementId: run.requirementId,
    requirementVersion: req?.version ?? "",
    requirementName: req?.name ?? "",
    baselineRequirementId: run.baselineRequirementId,
    baselineRequirementVersion: baseline?.version ?? "",
    baselineRequirementName: baseline?.name ?? "",
    status: run.status,
    mode: run.mode,
    profileId: run.profileId,
    summary,
    errorMessage: run.errorMessage,
    createdAt: run.createdAt?.toISOString() ?? null,
    updatedAt: run.updatedAt?.toISOString() ?? null,
    changes: changeRows.map(changeToDict),
    caseChanges: caseRows.map((row) => caseChangeToDict(row, titleById)),
  };
}

async function getRunRowOr404(runId: string): Promise<RunRow> {
  const rows = await db
    .select()
    .from(requirementChangeRuns)
    .where(eq(requirementChangeRuns.id, runId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new BizError(40411, `Incremental run not found: ${runId}`);
  return row;
}

export async function listRuns(
  requirementId: string,
  limit = 20,
): Promise<RunDict[]> {
  const rows = await db
    .select()
    .from(requirementChangeRuns)
    .where(eq(requirementChangeRuns.requirementId, requirementId))
    .orderBy(desc(requirementChangeRuns.createdAt))
    .limit(Math.max(1, Math.min(100, limit)));
  const out: RunDict[] = [];
  for (const row of rows)
    out.push(await runToDict(row, { includeChanges: false }));
  return out;
}

export async function getRun(runId: string): Promise<RunDict> {
  return runToDict(await getRunRowOr404(runId));
}

export async function latestRun(
  requirementId: string,
): Promise<RunDict | null> {
  const runs = await listRuns(requirementId, 1);
  return runs[0] ?? null;
}

async function requireBaselineSnapshot(
  baselineId: string,
): Promise<SnapshotDict> {
  const row = await getLatestSnapshotRow(baselineId);
  if (!row) {
    const baseline = await getRequirementOr404(baselineId);
    throw new BizError(
      40950,
      `Baseline version ${baseline.version} has no endpoint snapshot yet; build a snapshot for the baseline before running incremental analysis`,
    );
  }
  return snapshotToDict(row);
}

/** Compare baseline vs current requirement, persist the change list, and wait for user confirmation/generation. */
export async function analyzeIncremental(
  requirementId: string,
  baselineRequirementId: string,
  options: { mode?: string; profileId?: string | null } = {},
): Promise<RunDict> {
  const currentReq = await getRequirementOr404(requirementId);
  const baseline = await db
    .select()
    .from(requirements)
    .where(eq(requirements.id, baselineRequirementId))
    .limit(1);
  if (!baseline[0]) {
    throw new BizError(
      40406,
      `Baseline version not found: ${baselineRequirementId}`,
    );
  }
  if (currentReq.projectId !== baseline[0].projectId) {
    throw new BizError(
      40061,
      "Baseline and current requirement belong to different projects",
    );
  }
  if (currentReq.id === baseline[0].id) {
    throw new BizError(
      40062,
      "Baseline and current requirement must be different versions",
    );
  }
  if (!(currentReq.content || "").trim()) {
    throw new BizError(
      40014,
      "Current requirement content is empty; fill in or upload the phase-2 doc first",
    );
  }

  const baselinePayload = await requireBaselineSnapshot(baseline[0].id);
  const currentPayload = await ensureCurrentSnapshot(currentReq.id);
  const { changes, summary } = compareSnapshots(
    baselinePayload,
    currentPayload,
    currentReq.content || "",
  );

  const runId = uuid();
  await db.insert(requirementChangeRuns).values({
    id: runId,
    projectId: currentReq.projectId,
    requirementId: currentReq.id,
    baselineRequirementId: baseline[0].id,
    baselineSnapshotId: baselinePayload.id,
    currentSnapshotId: currentPayload.id,
    status: "review",
    mode: options.mode ?? "auto",
    profileId: options.profileId ?? null,
    summary: summary as unknown as Json,
  });
  if (changes.length > 0) {
    await db.insert(requirementChanges).values(
      changes.map((change) => ({
        id: uuid(),
        runId,
        projectId: currentReq.projectId,
        requirementId: currentReq.id,
        baselineRequirementId: baseline[0].id,
        entityType: change.entity_type,
        changeType: change.change_type,
        matchKey: change.match_key,
        oldRef: change.old_ref ?? null,
        newRef: change.new_ref ?? null,
        oldData: change.old_data ?? null,
        newData: change.new_data ?? null,
        reason: change.reason || "",
        confidence: change.confidence || 0,
        requiresConfirmation: change.requires_confirmation,
        reviewStatus: change.review_status || "auto",
      })),
    );
  }
  return getRun(runId);
}

export async function reviewChange(
  runId: string,
  changeId: string,
  status: string,
): Promise<RunDict> {
  if (!["confirmed", "rejected"].includes(status)) {
    throw new BizError(40063, "Review status must be confirmed or rejected");
  }
  const run = await getRunRowOr404(runId);
  const rows = await db
    .select()
    .from(requirementChanges)
    .where(eq(requirementChanges.id, changeId))
    .limit(1);
  const change = rows[0];
  if (!change || change.runId !== run.id) {
    throw new BizError(40411, "Change record not found");
  }
  await db
    .update(requirementChanges)
    .set({ reviewStatus: status })
    .where(eq(requirementChanges.id, change.id));
  if (change.entityType === "endpoint" && change.changeType === "deleted") {
    // Confirming/rejecting a deletion cascades to its pending_delete cases.
    await db
      .update(requirementCaseChanges)
      .set({ reviewStatus: status === "confirmed" ? "confirmed" : "rejected" })
      .where(
        and(
          eq(requirementCaseChanges.runId, run.id),
          eq(requirementCaseChanges.changeId, change.id),
          eq(requirementCaseChanges.action, "pending_delete"),
        ),
      );
  }
  return getRun(runId);
}

export async function reviewRegression(
  caseChangeId: string,
  status: string,
): Promise<RunDict | Json> {
  if (!["accepted", "rejected"].includes(status)) {
    throw new BizError(40064, "Regression status must be accepted or rejected");
  }
  const rows = await db
    .select()
    .from(requirementCaseChanges)
    .where(eq(requirementCaseChanges.id, caseChangeId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new BizError(40412, "Case change record not found");
  await db
    .update(requirementCaseChanges)
    .set(
      status === "rejected"
        ? { regressionStatus: status, regressionImpact: "none" }
        : { regressionStatus: status },
    )
    .where(eq(requirementCaseChanges.id, row.id));
  const runRows = await db
    .select()
    .from(requirementChangeRuns)
    .where(eq(requirementChangeRuns.id, row.runId))
    .limit(1);
  return runRows[0] ? runToDict(runRows[0]) : {};
}

// ---------- Incremental generation ----------

interface ChangeContext {
  directOldIds: Set<string>;
  deleted: Map<string, ChangeRow>;
  uncertain: Map<string, ChangeRow>;
  rejectedDeleted: Map<string, ChangeRow>;
  controllers: Set<string>;
  files: Set<string>;
  auth: Set<string>;
  ruleIds: Set<string>;
  securityChange: ChangeRow | null;
  changeByOld: Map<string, ChangeRow>;
  changeByNew: Map<string, ChangeRow>;
  ruleChanges: ChangeRow[];
}

function changeContext(changes: ChangeRow[]): ChangeContext {
  const ctx: ChangeContext = {
    directOldIds: new Set(),
    deleted: new Map(),
    uncertain: new Map(),
    rejectedDeleted: new Map(),
    controllers: new Set(),
    files: new Set(),
    auth: new Set(),
    ruleIds: new Set(),
    securityChange: null,
    changeByOld: new Map(),
    changeByNew: new Map(),
    ruleChanges: [],
  };
  for (const change of changes) {
    const oldData = (change.oldData ?? {}) as Json;
    const newData = (change.newData ?? {}) as Json;
    if (change.entityType === "endpoint") {
      if (change.oldRef) ctx.changeByOld.set(change.oldRef, change);
      if (change.newRef) ctx.changeByNew.set(change.newRef, change);
      if (change.reviewStatus === "rejected") {
        // A rejected deletion counts as kept; rejected adds/modifications
        // count as unchanged and take no part in impact inference.
        if (change.changeType === "deleted" && change.oldRef) {
          ctx.rejectedDeleted.set(change.oldRef, change);
        }
        continue;
      }
      for (const endpoint of [oldData, newData]) {
        if (
          endpoint &&
          typeof endpoint === "object" &&
          !Array.isArray(endpoint)
        ) {
          if (endpoint.controller)
            ctx.controllers.add(String(endpoint.controller));
          if (endpoint.file) ctx.files.add(String(endpoint.file));
          for (const item of (endpoint.auth ?? []) as string[]) {
            ctx.auth.add(String(item));
          }
        }
      }
      if (change.changeType === "deleted" && change.oldRef) {
        ctx.deleted.set(change.oldRef, change);
        ctx.directOldIds.add(change.oldRef);
      } else if (change.changeType === "uncertain" && change.oldRef) {
        ctx.uncertain.set(change.oldRef, change);
      } else if (change.changeType === "modified" && change.oldRef) {
        ctx.directOldIds.add(change.oldRef);
      }
    } else if (
      change.entityType === "business_rule" &&
      change.reviewStatus !== "rejected"
    ) {
      ctx.ruleChanges.push(change);
      if (change.oldRef) ctx.ruleIds.add(change.oldRef);
      if (change.newRef) ctx.ruleIds.add(change.newRef);
    } else if (
      change.entityType === "permission" &&
      change.reviewStatus !== "rejected"
    ) {
      ctx.securityChange = change;
    }
  }
  return ctx;
}

type TestCaseRowLite = typeof testCases.$inferSelect;
type TestPointRowLite = typeof testPoints.$inferSelect;

/** Resolve the baseline endpoints a historical case covers (coverageRefs first, then its test point). */
function caseEndpoints(
  kase: TestCaseRowLite,
  point: TestPointRowLite | null,
  baselineEps: Map<string, Json>,
): Json[] {
  const refs = (kase.coverageRefs ?? {}) as Json;
  const ids = (refs.endpointIds ?? []) as string[];
  const found = ids
    .filter((id) => baselineEps.has(id))
    .map((id) => baselineEps.get(id)!);
  if (found.length > 0) {
    const byId = new Map(found.map((ep) => [String(ep.id), ep]));
    return [...byId.values()];
  }
  if (point) {
    const endpointText = String(point.endpoint || "").trim();
    const match = /^([A-Za-z]+)\s+(.+)$/.exec(endpointText);
    if (match) {
      const key = endpointKey({ method: match[1], path: match[2] });
      for (const endpoint of baselineEps.values()) {
        if (endpointKey(endpoint) === key) return [endpoint];
      }
    }
    const route = normalizePath(point.pageRoute || "");
    if (route && route !== "/") {
      for (const endpoint of baselineEps.values()) {
        if (normalizePath(String(endpoint.path ?? "")) === route)
          return [endpoint];
      }
    }
  }
  return [];
}

function impactForCase(
  endpoints: Json[],
  refs: Json,
  ctx: ChangeContext,
): { impact: string; reason: string; changeId: string | null } {
  const reasons: string[] = [];
  let changeId: string | null = null;
  if (endpoints.length === 0) {
    const ruleHit = ((refs.ruleIds ?? []) as string[]).some((id) =>
      ctx.ruleIds.has(id),
    );
    if (ruleHit) {
      return {
        impact: "direct",
        reason: "A business rule linked to the historical case changed",
        changeId: null,
      };
    }
    return {
      impact: "none",
      reason:
        "Cannot link the historical case to an endpoint; manual confirmation recommended",
      changeId: null,
    };
  }
  for (const endpoint of endpoints) {
    const id = String(endpoint.id ?? "");
    const rejectedDeleted = ctx.rejectedDeleted.get(id);
    if (rejectedDeleted) {
      return {
        impact: "direct",
        reason:
          "The deletion change was rejected; keep the historical case and run a regression",
        changeId: rejectedDeleted.id,
      };
    }
    const change = ctx.changeByOld.get(id);
    if (change && ["modified", "deleted"].includes(change.changeType)) {
      reasons.push(`Endpoint ${endpointKey(endpoint)} changed`);
      changeId = change.id;
    }
  }

  const ruleHit = ((refs.ruleIds ?? []) as string[]).some((id) =>
    ctx.ruleIds.has(id),
  );
  if (ruleHit) {
    reasons.push("A linked business rule changed");
    changeId = changeId || (ctx.ruleChanges[0]?.id ?? null);
  }

  if (reasons.length > 0) {
    return { impact: "direct", reason: reasons.join("; "), changeId };
  }

  const securityChange = ctx.securityChange;
  if (securityChange) {
    const protectedEp = endpoints.some(
      (endpoint) => ((endpoint.auth ?? []) as string[]).length > 0,
    );
    return {
      impact: protectedEp ? "direct" : "indirect",
      reason: protectedEp
        ? "Shared security configuration changed and this endpoint is protected"
        : "Shared security configuration changed; possible indirect impact",
      changeId: securityChange.id,
    };
  }

  for (const endpoint of endpoints) {
    if (
      ctx.controllers.has(String(endpoint.controller ?? "")) ||
      ctx.files.has(String(endpoint.file ?? ""))
    ) {
      return {
        impact: "indirect",
        reason:
          "Shares a controller/source file with a changed endpoint; regression recommended",
        changeId: null,
      };
    }
    const epAuth = ((endpoint.auth ?? []) as string[]).map(String);
    if (epAuth.some((item) => ctx.auth.has(item))) {
      return {
        impact: "indirect",
        reason:
          "Shares auth requirements with a changed endpoint; regression recommended",
        changeId: null,
      };
    }
  }
  return {
    impact: "none",
    reason: "No direct or indirect impact found",
    changeId: null,
  };
}

function successText(frontend: FrontendResult): string {
  for (const text of frontend.uiTexts || []) {
    if (text.toLowerCase().includes("success")) return `"${text}"`;
  }
  return '"Operation successful"';
}

function constraintExpected(param: Json): string {
  for (const constraint of (param.constraints ?? []) as string[]) {
    const value = String(constraint);
    // Constraint annotations may carry a human-readable message=... argument.
    const message = /message\s*=\s*"([^"]+)"/i.exec(value);
    if (message?.[1]) return `"${message[1]}"`;
  }
  return '"Validation failed"';
}

interface IncrementalPoint extends PointInput {
  id: string;
  _changeId: string;
  _newRef: string | null;
  _endpointKey: string;
  _module: string;
  _pointSig: string;
  _manualOnly: boolean;
}

function makePoint(options: {
  change: ChangeRow;
  endpoint: Json;
  title: string;
  category: string;
  priority: string;
  expected: string;
  fields?: string[];
  description?: string;
  module?: string;
  refKind?: "endpoint" | "rule";
  pageRoute?: string | null;
}): IncrementalPoint {
  const refKind = options.refKind ?? "endpoint";
  const route = options.pageRoute ?? "";
  let expected = options.expected;
  // Pure API endpoints have no UI page; expectations must describe HTTP
  // behavior instead of borrowing copy from another page.
  if (refKind === "endpoint" && !route) {
    if (options.category === "permission") {
      expected = "Endpoint returns unauthorized (HTTP 401/403)";
    } else if (["negative", "boundary"].includes(options.category)) {
      expected = "Endpoint returns a parameter validation error (HTTP 4xx)";
    } else {
      expected = "Endpoint returns a success response (HTTP 2xx)";
    }
  }
  const signature = sha([
    options.title,
    options.category,
    expected,
    route,
  ]).slice(0, 12);
  return {
    id: uuid(),
    title: options.title.slice(0, 255),
    category: options.category,
    priority: options.priority,
    description: options.description || options.title,
    pageRoute: route,
    endpoint:
      `${String(options.endpoint.method ?? "")} ${String(options.endpoint.path ?? "")}`.trim(),
    fields: (options.fields ?? []).slice(0, 20),
    expected,
    source: "incremental",
    confidence: 0.9,
    _changeId: options.change.id,
    _newRef:
      refKind === "endpoint"
        ? String(options.endpoint.id ?? "") || null
        : (options.change.newRef ?? null),
    _endpointKey:
      refKind === "endpoint"
        ? endpointKey(options.endpoint)
        : options.change.matchKey,
    _module:
      options.module ||
      String(options.endpoint.controller ?? "") ||
      "Endpoint increment",
    _pointSig: signature,
    // Pure API endpoints or business rules have no executable UI page; only
    // generate manual/to-be-completed cases for them.
    _manualOnly: refKind !== "endpoint" || !route,
  };
}

/** Map a backend endpoint onto an existing frontend page; pure API endpoints return '' so no fake UI steps are generated. */
function inferPageRoute(endpoint: Json, frontend: FrontendResult): string {
  const routes = (frontend.pages || [])
    .map((page) => String(page.route || ""))
    .filter(Boolean);
  if (routes.length === 0) return "";
  const normalized = normalizePath(String(endpoint.path ?? ""));
  const method = String(endpoint.method ?? "").toUpperCase();
  const pathText = normalized.toLowerCase();
  for (const route of routes) {
    if (normalizePath(route) === normalized) return route;
  }
  if (method === "GET" && pathText.endsWith("/orders")) {
    for (const route of routes) {
      if (route.toLowerCase().includes("list")) return route;
    }
  }
  if (method === "POST" && pathText.endsWith("/orders")) {
    for (const route of routes) {
      const lower = route.toLowerCase();
      if (
        lower.includes("create") ||
        lower.includes("add") ||
        lower.includes("new")
      ) {
        return route;
      }
    }
  }
  if (["PUT", "DELETE"].includes(method) && normalized.includes("{param}")) {
    for (const route of routes) {
      const lower = route.toLowerCase();
      if (
        lower.includes("list") ||
        lower.includes("detail") ||
        lower.includes("edit")
      ) {
        return route;
      }
    }
  }
  if (
    ["/pay", "/ship", "/complete", "/cancel", "/refund"].some((word) =>
      pathText.includes(word),
    )
  ) {
    for (const route of routes) {
      if (route.toLowerCase().includes("list")) return route;
    }
  }
  if (method === "GET" && normalized.includes("{param}")) {
    for (const route of routes) {
      if (route.toLowerCase().includes("detail")) return route;
    }
  }
  return "";
}

function buildPointsForChanges(
  changes: ChangeRow[],
  currentSnapshot: SnapshotDict,
  frontend: FrontendResult,
): IncrementalPoint[] {
  const points: IncrementalPoint[] = [];
  const success = successText(frontend);
  const transitions = currentSnapshot.stateTransitions ?? [];
  const ruleChanges = changes.filter(
    (item) =>
      item.entityType === "business_rule" && item.reviewStatus !== "rejected",
  );

  for (const change of changes) {
    if (change.reviewStatus === "rejected") continue;
    if (
      change.entityType !== "endpoint" ||
      !["added", "modified"].includes(change.changeType)
    ) {
      continue;
    }
    const oldData = (change.oldData ?? {}) as Json;
    const newData = (change.newData ?? {}) as Json;
    const endpoint = Object.keys(newData).length > 0 ? newData : oldData;
    if (Object.keys(endpoint).length === 0) continue;
    const pageRoute = inferPageRoute(endpoint, frontend);
    const keyOf = (p: Json) => `${p.name}|${p.source}`;
    const oldParams = new Map(
      ((oldData.params ?? []) as Json[]).map((p) => [keyOf(p), p]),
    );
    const newParams = new Map(
      ((newData.params ?? []) as Json[]).map((p) => [keyOf(p), p]),
    );
    const changedParams: Json[] = [];
    const allKeys = [
      ...new Set([...oldParams.keys(), ...newParams.keys()]),
    ].sort();
    for (const key of allKeys) {
      const before = oldParams.get(key);
      const after = newParams.get(key);
      if (!before || !after) {
        changedParams.push((after ?? before)!);
      } else if (
        Boolean(before.required) !== Boolean(after.required) ||
        JSON.stringify([...((before.constraints ?? []) as string[])].sort()) !==
          JSON.stringify([...((after.constraints ?? []) as string[])].sort())
      ) {
        changedParams.push(after);
      }
    }

    if (change.changeType === "added") {
      points.push(
        makePoint({
          change,
          endpoint,
          title: `${String(endpoint.method)} ${String(endpoint.path)} normal request`,
          category: "functional",
          priority: "P0",
          expected: success,
          fields: [...newParams.values()]
            .filter((p) => p.required)
            .map((p) => String(p.name)),
          description: "Main-flow regression for the new endpoint",
          pageRoute,
        }),
      );
      for (const param of changedParams.slice(0, 4)) {
        points.push(
          makePoint({
            change,
            endpoint,
            title: `${String(endpoint.method)} ${String(endpoint.path)} ${String(param.name)} parameter validation`,
            category: param.required ? "negative" : "boundary",
            priority: "P1",
            expected: constraintExpected(param),
            fields: [String(param.name)],
            description: `New parameter ${String(param.name)} (source ${String(param.source)})`,
            pageRoute,
          }),
        );
      }
      const auth = (endpoint.auth ?? []) as string[];
      if (auth.length > 0) {
        points.push(
          makePoint({
            change,
            endpoint,
            title: `${String(endpoint.method)} ${String(endpoint.path)} auth check`,
            category: "permission",
            priority: "P1",
            expected: '"Unauthorized"',
            description: `Endpoint auth requirements: ${auth.join("; ")}`,
            pageRoute,
          }),
        );
      }
      for (const transition of transitions) {
        const trigger = String(transition.trigger ?? "");
        const text = `${String(endpoint.path)} ${String(endpoint.methodName)}`;
        if (trigger && text.includes(trigger)) {
          points.push(
            makePoint({
              change,
              endpoint,
              title: `${String(endpoint.method)} ${String(endpoint.path)} ${trigger} state transition`,
              category: "state",
              priority: "P1",
              expected: `"${trigger} successful"`,
              description: `State goes from ${String(transition.from)} to ${String(transition.to)}`,
              pageRoute,
            }),
          );
        }
      }
    } else {
      for (const param of changedParams.slice(0, 4)) {
        const isNew = ![...oldParams.values()].some(
          (p) => String(p.name) === String(param.name),
        );
        points.push(
          makePoint({
            change,
            endpoint,
            title: `${String(endpoint.method)} ${String(endpoint.path)} ${String(param.name)} parameter change validation`,
            category: param.required ? "negative" : "boundary",
            priority: "P1",
            expected: constraintExpected(param),
            fields: [String(param.name)],
            description: `${isNew ? "New" : "Modified"} parameter ${String(param.name)}; verify the new constraints`,
            pageRoute,
          }),
        );
      }
      const oldAuth = [...((oldData.auth ?? []) as string[])].sort();
      const newAuth = [...((newData.auth ?? []) as string[])].sort();
      if (JSON.stringify(oldAuth) !== JSON.stringify(newAuth)) {
        points.push(
          makePoint({
            change,
            endpoint,
            title: `${String(endpoint.method)} ${String(endpoint.path)} auth change check`,
            category: "permission",
            priority: "P1",
            expected: '"Unauthorized"',
            description: `Auth requirements changed: ${oldAuth.join("; ") || "none"} → ${newAuth.join("; ") || "none"}`,
            pageRoute,
          }),
        );
      }
      if (String(oldData.path ?? "") !== String(newData.path ?? "")) {
        points.push(
          makePoint({
            change,
            endpoint,
            title: `${String(endpoint.method)} ${String(endpoint.path)} new-path main flow`,
            category: "functional",
            priority: "P0",
            expected: success,
            description:
              "Endpoint path changed; verify the new path is reachable",
            pageRoute,
          }),
        );
      }
      if (
        changedParams.length === 0 &&
        JSON.stringify(oldAuth) === JSON.stringify(newAuth) &&
        String(oldData.path ?? "") === String(newData.path ?? "")
      ) {
        points.push(
          makePoint({
            change,
            endpoint,
            title: `${String(endpoint.method)} ${String(endpoint.path)} change regression`,
            category: "functional",
            priority: "P0",
            expected: success,
            description: "Endpoint changed; run the main-flow regression",
            pageRoute,
          }),
        );
      }
    }
  }

  for (const change of ruleChanges.slice(0, 10)) {
    const newData = (change.newData ?? {}) as Json;
    const description = String(
      newData.description || change.matchKey || "Business rule change",
    );
    points.push(
      makePoint({
        change,
        endpoint: { method: "", path: "", id: "" },
        title: `Business rule: ${description}`.slice(0, 255),
        category: "functional",
        priority: "P1",
        expected: `"${description}"`,
        description: `Business rule changed: ${description}`,
        module: "Business rules",
        refKind: "rule",
      }),
    );
  }
  return points.slice(0, 40);
}

function manualCase(
  point: IncrementalPoint,
  requirementName: string,
  requirementVersion: string,
): GeneratedCase {
  return newCase({
    title: String(point.title || "Incremental case").slice(0, 255),
    module: String(point._module || "Endpoint increment").slice(0, 120),
    type: ["positive", "negative", "boundary", "state"].includes(
      String(point.category),
    )
      ? String(point.category)
      : "positive",
    priority: String(point.priority || "P1"),
    preconditions: [
      `Requirement version: ${requirementVersion} ${requirementName}`,
    ],
    steps: [String(point.description || point.title || "")],
    expectedResults: [
      String(point.expected || point.title || "Operation successful"),
    ],
    structuredSteps: [],
    testData: {},
    coverageRefs: {
      endpointIds:
        point._changeId && point._newRef && point._module !== "Business rules"
          ? [point._newRef]
          : [],
      ruleIds:
        point._module === "Business rules" && point._newRef
          ? [point._newRef]
          : [],
      transitionIds: [],
      testPointIds: [],
    },
    source: "rule",
    confidence: 0.5,
    testPointId: point.id,
  });
}

async function generateCasesForPoints(
  requirement: { id: string; projectId: string; version: string; name: string },
  points: IncrementalPoint[],
  options: { mode: string; profileId: string | null },
  report: (message: string, current?: number, total?: number) => void,
): Promise<GeneratedCase[]> {
  if (points.length === 0) return [];
  let backend: BackendResult;
  let frontend: FrontendResult;
  let machines: StateMachineSpec[];
  try {
    const ctx = await getGenerationContext(requirement.projectId);
    backend = ctx.backend;
    frontend = ctx.frontend;
    machines = ctx.machines as unknown as StateMachineSpec[];
  } catch {
    backend = {
      language: "unknown",
      endpoints: [],
      entities: [],
      enums: [],
      businessRules: [],
      uiTexts: [],
    };
    frontend = {
      language: "unknown",
      pages: [],
      selectors: [],
      uiTexts: [],
      components: [],
    };
    machines = [];
  }
  const cases: GeneratedCase[] = [];
  const manualOnly = points.filter((point) => point._manualOnly);
  const uiPoints = points.filter((point) => !point._manualOnly);
  if (uiPoints.length > 0 && ["llm", "auto"].includes(options.mode)) {
    const client = await getTextClient(options.profileId);
    if (client.available()) {
      try {
        cases.push(
          ...(await generateLlmCasesForPoints(
            client,
            { version: requirement.version, name: requirement.name },
            uiPoints,
            backend,
            frontend,
            machines,
            {
              onEvent: (event) =>
                report(event.message, event.current, event.total),
            },
          )),
        );
      } catch (error) {
        report(
          `Incremental LLM generation failed, degrading to rules: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  let covered = new Set(
    cases.map((item) => String(item.testPointId ?? "")).filter(Boolean),
  );
  const missing = uiPoints.filter((point) => !covered.has(point.id));
  if (missing.length > 0) {
    cases.push(
      ...generateRuleCasesForPoints(missing, backend, frontend, machines),
    );
  }
  covered = new Set(
    cases.map((item) => String(item.testPointId ?? "")).filter(Boolean),
  );
  for (const point of uiPoints) {
    if (!covered.has(point.id)) {
      cases.push(manualCase(point, requirement.name, requirement.version));
    }
  }
  for (const point of manualOnly) {
    cases.push(manualCase(point, requirement.name, requirement.version));
  }
  return cases;
}

function generatedFromCase(row: TestCaseRowLite): GeneratedCase {
  return newCase({
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
  });
}

/** Map baseline coverage refs onto the current snapshot ids (endpoint key / rule description / transition key). */
function remapCoverageRefs(
  refs: Json,
  baseline: SnapshotDict,
  current: SnapshotDict,
): Json {
  const baselineEps = new Map(
    ((baseline.endpoints ?? []) as Json[]).map((ep) => [String(ep.id), ep]),
  );
  const currentByKey = new Map(
    ((current.endpoints ?? []) as Json[]).map((ep) => [endpointKey(ep), ep]),
  );
  const baselineRules = new Map(
    (baseline.rules ?? []).map((rule) => [String(rule.id), rule]),
  );
  const currentRules = new Map(
    (current.rules ?? []).map((rule) => [normText(rule.description), rule]),
  );
  const baselineTransitions = new Map(
    (baseline.stateTransitions ?? []).map((item) => [String(item.id), item]),
  );
  const currentTransitions = new Map(
    (current.stateTransitions ?? []).map((item) => [String(item.key), item]),
  );
  const mapped: Record<string, string[]> = {
    endpointIds: [],
    ruleIds: [],
    transitionIds: [],
    testPointIds: [],
  };
  for (const oldId of (refs.endpointIds ?? []) as string[]) {
    const oldEp = baselineEps.get(oldId);
    if (!oldEp) continue;
    const newEp = currentByKey.get(endpointKey(oldEp));
    if (newEp) mapped.endpointIds.push(String(newEp.id));
  }
  for (const oldId of (refs.ruleIds ?? []) as string[]) {
    const oldRule = baselineRules.get(oldId);
    if (!oldRule) continue;
    const newRule = currentRules.get(normText(oldRule.description));
    if (newRule) mapped.ruleIds.push(String(newRule.id));
  }
  for (const oldId of (refs.transitionIds ?? []) as string[]) {
    const oldTransition = baselineTransitions.get(oldId);
    if (!oldTransition) continue;
    const newTransition = currentTransitions.get(String(oldTransition.key));
    if (newTransition) mapped.transitionIds.push(String(newTransition.id));
  }
  for (const key of Object.keys(mapped)) {
    mapped[key] = [...new Set(mapped[key].filter(Boolean))];
  }
  return mapped;
}

async function ensureMappingInTx(
  tx: Tx,
  requirementId: string,
  caseId: string,
): Promise<void> {
  const rows = await tx
    .select({ id: requirementCases.id })
    .from(requirementCases)
    .where(
      and(
        eq(requirementCases.requirementId, requirementId),
        eq(requirementCases.testCaseId, caseId),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    await tx.insert(requirementCases).values({
      id: uuid(),
      requirementId,
      testCaseId: caseId,
      testPointId: null,
    });
  }
}

/**
 * Save (or reuse across runs) the phase-2 case for one dedupe key and record
 * its case-change row for this run. Repeated generation is idempotent: the
 * same dedupe key never creates a second case.
 */
async function saveIncrementalCaseInTx(
  tx: Tx,
  run: RunRow,
  options: {
    generated: GeneratedCase;
    action: string;
    changeId: string | null;
    dedupeKey: string;
    baselineCaseId: string | null;
    impact: string;
    reason: string;
    reviewStatus?: string;
  },
): Promise<void> {
  const existingRows = await tx
    .select()
    .from(requirementCaseChanges)
    .where(
      and(
        eq(requirementCaseChanges.requirementId, run.requirementId),
        eq(requirementCaseChanges.dedupeKey, options.dedupeKey),
      ),
    )
    .orderBy(desc(requirementCaseChanges.createdAt))
    .limit(1);
  const existing = existingRows[0];
  let targetCaseId: string | null = null;
  if (existing?.testCaseId) {
    const caseRows = await tx
      .select({ id: testCases.id })
      .from(testCases)
      .where(eq(testCases.id, existing.testCaseId))
      .limit(1);
    if (caseRows[0]) targetCaseId = caseRows[0].id;
  }
  if (!targetCaseId) {
    targetCaseId = await saveGeneratedCaseInTx(
      tx,
      run.projectId,
      options.generated,
      run.requirementId,
      null,
    );
  } else {
    await ensureMappingInTx(tx, run.requirementId, targetCaseId);
  }

  const rowRows = await tx
    .select()
    .from(requirementCaseChanges)
    .where(
      and(
        eq(requirementCaseChanges.runId, run.id),
        eq(requirementCaseChanges.dedupeKey, options.dedupeKey),
      ),
    )
    .limit(1);
  const row = rowRows[0];
  if (!row) {
    await tx.insert(requirementCaseChanges).values({
      id: uuid(),
      runId: run.id,
      projectId: run.projectId,
      requirementId: run.requirementId,
      baselineRequirementId: run.baselineRequirementId,
      changeId: options.changeId,
      testCaseId: targetCaseId,
      baselineCaseId: options.baselineCaseId,
      action: options.action,
      regressionImpact: options.impact,
      regressionReason: options.reason,
      regressionStatus: "suggested",
      confidence:
        options.impact === "direct"
          ? 0.8
          : options.impact === "indirect"
            ? 0.6
            : 0.4,
      dedupeKey: options.dedupeKey,
      reviewStatus: options.reviewStatus ?? "auto",
      reason: options.reason,
    });
  } else {
    await tx
      .update(requirementCaseChanges)
      .set({
        testCaseId: targetCaseId,
        baselineCaseId: options.baselineCaseId,
        action: options.action,
        regressionImpact: options.impact,
        regressionReason: options.reason,
        reviewStatus: options.reviewStatus ?? "auto",
        reason: options.reason,
      })
      .where(eq(requirementCaseChanges.id, row.id));
  }
}

async function addCaseChangeInTx(
  tx: Tx,
  run: RunRow,
  options: {
    action: string;
    changeId: string | null;
    dedupeKey: string;
    baselineCaseId: string | null;
    testCaseId: string | null;
    impact?: string;
    reason?: string;
    reviewStatus?: string;
  },
): Promise<void> {
  const rows = await tx
    .select({ id: requirementCaseChanges.id })
    .from(requirementCaseChanges)
    .where(
      and(
        eq(requirementCaseChanges.runId, run.id),
        eq(requirementCaseChanges.dedupeKey, options.dedupeKey),
      ),
    )
    .limit(1);
  if (rows.length > 0) return;
  await tx.insert(requirementCaseChanges).values({
    id: uuid(),
    runId: run.id,
    projectId: run.projectId,
    requirementId: run.requirementId,
    baselineRequirementId: run.baselineRequirementId,
    changeId: options.changeId,
    testCaseId: options.testCaseId,
    baselineCaseId: options.baselineCaseId,
    action: options.action,
    regressionImpact: options.impact ?? "none",
    regressionReason: options.reason ?? "",
    regressionStatus: "suggested",
    confidence: 0.4,
    dedupeKey: options.dedupeKey,
    reviewStatus: options.reviewStatus ?? "pending",
    reason: options.reason ?? "",
  });
}

/** Archive this run's phase-2 cases as a case_generations version for the generation-history dropdown. */
async function saveIncrementalGenerationSnapshotInTx(
  tx: Tx,
  run: RunRow,
  caseRows: CaseChangeRow[],
): Promise<void> {
  const mappings = await tx
    .select({
      testCaseId: requirementCases.testCaseId,
      testPointId: requirementCases.testPointId,
    })
    .from(requirementCases)
    .where(eq(requirementCases.requirementId, run.requirementId));
  const pointByCase = new Map(
    mappings.map((m) => [m.testCaseId, m.testPointId]),
  );
  const caseIds = [
    ...new Set(
      caseRows
        .filter(
          (row) =>
            ["created", "updated", "reused"].includes(row.action) &&
            row.testCaseId,
        )
        .map((row) => row.testCaseId!),
    ),
  ];
  if (caseIds.length === 0) return;
  const cases = await tx
    .select()
    .from(testCases)
    .where(inArray(testCases.id, caseIds));
  cases.sort((a, b) => a.projectSeq - b.projectSeq);
  const snapshot = cases.map((row) => ({
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
  const sourceCounts: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const row of cases) {
    sourceCounts[row.source] = (sourceCounts[row.source] ?? 0) + 1;
    byType[row.type] = (byType[row.type] ?? 0) + 1;
  }
  const summary: Json = {
    mode: "incremental",
    incrementalRunId: run.id,
    baselineRequirementId: run.baselineRequirementId,
    caseChangeSummary: caseChangesSummary(caseRows),
    llmCaseCount: sourceCounts.ai ?? 0,
    ruleCaseCount: sourceCounts.rule ?? 0,
    byType,
    fallback: false,
    fallbackReason: "",
  };
  const existingRows = await tx
    .select()
    .from(caseGenerations)
    .where(eq(caseGenerations.requirementId, run.requirementId))
    .orderBy(desc(caseGenerations.createdAt))
    .limit(50);
  const existing = existingRows.find(
    (row) => ((row.summary ?? {}) as Json).incrementalRunId === run.id,
  );
  if (existing) {
    await tx
      .update(caseGenerations)
      .set({
        caseCount: snapshot.length,
        summary,
        snapshot: snapshot,
        profileId: run.profileId,
      })
      .where(eq(caseGenerations.id, existing.id));
  } else {
    await tx.insert(caseGenerations).values({
      id: uuid(),
      projectId: run.projectId,
      requirementId: run.requirementId,
      mode: "incremental",
      profileId: run.profileId,
      caseCount: snapshot.length,
      summary,
      snapshot: snapshot,
    });
  }
}

/**
 * Generate phase-2 cases from the confirmed/auto change list.
 * Never deletes phase-1 data. Reads and the (slow) LLM phase run outside the
 * write transaction; all writes commit atomically so a failure can never
 * damage the baseline.
 */
export async function generateIncremental(
  runId: string,
  options: { mode?: string; profileId?: string | null } = {},
  report: (
    message: string,
    current?: number,
    total?: number,
  ) => void = () => {},
): Promise<RunDict> {
  const mode = options.mode ?? "auto";
  const profileId = options.profileId ?? null;
  const run = await getRunRowOr404(runId);
  if (run.status === "generating") {
    throw new BizError(40065, "This incremental run is already generating");
  }
  const requirementRows = await db
    .select()
    .from(requirements)
    .where(
      inList(requirements.id, [run.requirementId, run.baselineRequirementId]),
    );
  const requirement = requirementRows.find((r) => r.id === run.requirementId);
  const baseline = requirementRows.find(
    (r) => r.id === run.baselineRequirementId,
  );
  if (!requirement || !baseline) {
    throw new BizError(
      40406,
      "Requirement versions linked to this run no longer exist",
    );
  }

  await db
    .update(requirementChangeRuns)
    .set({
      status: "generating",
      mode,
      profileId,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(requirementChangeRuns.id, run.id));
  const generatingRun: RunRow = {
    ...run,
    status: "generating",
    mode,
    profileId,
  };

  try {
    report("Loading change list and snapshots");
    const changes = await db
      .select()
      .from(requirementChanges)
      .where(eq(requirementChanges.runId, run.id));
    const ctx = changeContext(changes);

    let baselinePayload: SnapshotDict;
    let currentPayload: SnapshotDict;
    if (run.baselineSnapshotId) {
      const rows = await db
        .select()
        .from(requirementSnapshots)
        .where(eq(requirementSnapshots.id, run.baselineSnapshotId))
        .limit(1);
      baselinePayload = rows[0]
        ? snapshotToDict(rows[0])
        : await requireBaselineSnapshot(baseline.id);
    } else {
      baselinePayload = await requireBaselineSnapshot(baseline.id);
    }
    if (run.currentSnapshotId) {
      const rows = await db
        .select()
        .from(requirementSnapshots)
        .where(eq(requirementSnapshots.id, run.currentSnapshotId))
        .limit(1);
      currentPayload = rows[0]
        ? snapshotToDict(rows[0])
        : await ensureCurrentSnapshot(requirement.id);
    } else {
      currentPayload = await ensureCurrentSnapshot(requirement.id);
    }
    const baselineEps = new Map(
      ((baselinePayload.endpoints ?? []) as Json[]).map((ep) => [
        String(ep.id),
        ep,
      ]),
    );

    // Phase-1 cases and points
    const mappings = await db
      .select()
      .from(requirementCases)
      .where(eq(requirementCases.requirementId, baseline.id));
    const baselineCaseIds = mappings.map((m) => m.testCaseId);
    const baselineCases =
      baselineCaseIds.length > 0
        ? await db
            .select()
            .from(testCases)
            .where(inList(testCases.id, baselineCaseIds))
        : [];
    const baselinePointRows = await db
      .select()
      .from(testPoints)
      .where(eq(testPoints.requirementId, baseline.id));
    const baselinePoints = new Map(
      baselinePointRows.map((row) => [row.id, row]),
    );
    const mappingByCase = new Map(mappings.map((m) => [m.testCaseId, m]));
    const baselineCaseIdsByEndpoint = new Map<string, Set<string>>();

    const endpointsForCase = (kase: TestCaseRowLite): Json[] => {
      const mapping = mappingByCase.get(kase.id);
      const point = mapping?.testPointId
        ? (baselinePoints.get(mapping.testPointId) ?? null)
        : null;
      return caseEndpoints(kase, point, baselineEps);
    };
    for (const kase of baselineCases) {
      for (const endpoint of endpointsForCase(kase)) {
        const id = String(endpoint.id ?? "");
        if (!id) continue;
        const set = baselineCaseIdsByEndpoint.get(id) ?? new Set<string>();
        set.add(kase.id);
        baselineCaseIdsByEndpoint.set(id, set);
      }
    }

    // Build points for added/modified changes before the write phase.
    report("Building incremental test points");
    let frontend: FrontendResult;
    try {
      frontend = (await getGenerationContext(requirement.projectId)).frontend;
    } catch {
      frontend = {
        language: "unknown",
        pages: [],
        selectors: [],
        uiTexts: [],
        components: [],
      };
    }
    const points = buildPointsForChanges(changes, currentPayload, frontend);
    report(
      `Generating cases for ${points.length} incremental test points`,
      0,
      points.length,
    );
    const generatedCases = await generateCasesForPoints(
      {
        id: requirement.id,
        projectId: requirement.projectId,
        version: requirement.version,
        name: requirement.name,
      },
      points,
      { mode, profileId },
      report,
    );

    // Write phase: everything commits atomically.
    report("Persisting incremental case changes");
    await db.transaction(async (tx) => {
      // 1) Deleted/uncertain endpoints: never physically delete; register for review.
      for (const kase of baselineCases) {
        const endpoints = endpointsForCase(kase);
        const deleted = endpoints
          .map((ep) => ctx.deleted.get(String(ep.id ?? "")))
          .find((item) => item);
        const uncertain = endpoints
          .map((ep) => ctx.uncertain.get(String(ep.id ?? "")))
          .find((item) => item);
        if (deleted) {
          await addCaseChangeInTx(tx, generatingRun, {
            action: "pending_delete",
            changeId: deleted.id,
            dedupeKey: `delete:${kase.id}`,
            baselineCaseId: kase.id,
            testCaseId: kase.id,
            reason:
              "Endpoint deletion pending confirmation; historical cases and execution records are kept",
            reviewStatus:
              deleted.reviewStatus === "confirmed" ? "confirmed" : "pending",
          });
          continue;
        }
        if (uncertain) {
          await addCaseChangeInTx(tx, generatingRun, {
            action: "missing",
            changeId: uncertain.id,
            dedupeKey: `uncertain:${kase.id}`,
            baselineCaseId: kase.id,
            testCaseId: null,
            reason:
              "Endpoint change not confirmed yet; the historical case is not reused for now",
            reviewStatus: "pending",
          });
        }
      }

      // 2) Non-deleted cases: clone into phase 2 by impact, without any model call.
      for (const kase of baselineCases) {
        const endpoints = endpointsForCase(kase);
        if (endpoints.some((ep) => ctx.deleted.has(String(ep.id ?? ""))))
          continue;
        if (endpoints.some((ep) => ctx.uncertain.has(String(ep.id ?? ""))))
          continue;
        const refs = (kase.coverageRefs ?? {}) as Json;
        const { impact, reason, changeId } = impactForCase(
          endpoints,
          refs,
          ctx,
        );
        const generated = generatedFromCase(kase);
        generated.coverageRefs = remapCoverageRefs(
          generated.coverageRefs as unknown as Json,
          baselinePayload,
          currentPayload,
        ) as unknown as GeneratedCase["coverageRefs"];
        const hasEndpointLink = endpoints.length > 0;
        const ruleHit = ((refs.ruleIds ?? []) as string[]).some((id) =>
          ctx.ruleIds.has(id),
        );
        await saveIncrementalCaseInTx(tx, generatingRun, {
          generated,
          action: "reused",
          changeId,
          dedupeKey: `reuse:${kase.id}`,
          baselineCaseId: kase.id,
          impact,
          reason,
          reviewStatus: !hasEndpointLink && !ruleHit ? "pending" : "auto",
        });
      }

      // 3) Unchanged endpoints without a historical case -> pending, never silently skipped.
      for (const change of changes) {
        if (
          change.entityType !== "endpoint" ||
          change.changeType !== "unchanged" ||
          change.reviewStatus === "rejected"
        ) {
          continue;
        }
        const newData = (change.newData ?? {}) as Json;
        const endpointId = String(newData.id ?? "");
        if (
          endpointId &&
          (baselineCaseIdsByEndpoint.get(endpointId)?.size ?? 0) > 0
        ) {
          continue;
        }
        await addCaseChangeInTx(tx, generatingRun, {
          action: "missing",
          changeId: change.id,
          dedupeKey: `missing:${endpointKey(newData)}`,
          baselineCaseId: null,
          testCaseId: null,
          reason:
            "Endpoint unchanged but no linkable historical case; add one or confirm manually",
          reviewStatus: "pending",
        });
      }

      // 4) Added/modified endpoints: generate only for the changed points.
      const pointById = new Map(points.map((point) => [point.id, point]));
      for (const generated of generatedCases) {
        const point = pointById.get(String(generated.testPointId ?? ""));
        if (!point) continue;
        const change = changes.find((item) => item.id === point._changeId);
        if (!change) continue;
        const oldData = (change.oldData ?? {}) as Json;
        const baselineIds = baselineCaseIdsByEndpoint.get(
          String(oldData.id ?? ""),
        );
        const baselineCaseId = baselineIds
          ? ([...baselineIds].sort()[0] ?? null)
          : null;
        const action =
          change.changeType === "modified" && baselineCaseId
            ? "updated"
            : "created";
        const dedupe =
          action === "updated"
            ? `update:${baselineCaseId}:${point._pointSig}`
            : `gen:${point._endpointKey || change.matchKey}:${point._pointSig}`;
        const refs = generated.coverageRefs as unknown as Json;
        if (point._newRef && !((refs.endpointIds ?? []) as string[]).length) {
          if (point._module === "Business rules") {
            refs.ruleIds = [point._newRef];
          } else {
            refs.endpointIds = [point._newRef];
          }
        }
        await saveIncrementalCaseInTx(tx, generatingRun, {
          generated,
          action,
          changeId: change.id,
          dedupeKey: dedupe,
          baselineCaseId: action === "updated" ? baselineCaseId : null,
          impact: "direct",
          reason: "Endpoint/rule changed; generated an incremental case",
        });
      }

      const caseRows = await tx
        .select()
        .from(requirementCaseChanges)
        .where(eq(requirementCaseChanges.runId, generatingRun.id));
      const summary = { ...(generatingRun.summary ?? {}) };
      summary.caseChanges = caseChangesSummary(caseRows);
      await saveIncrementalGenerationSnapshotInTx(tx, generatingRun, caseRows);
      await tx
        .update(requirementChangeRuns)
        .set({
          summary,
          status: "completed",
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(requirementChangeRuns.id, generatingRun.id));
    });

    return getRun(runId);
  } catch (error) {
    // Guarantee: a failure never damages baseline data (writes rolled back).
    await db
      .update(requirementChangeRuns)
      .set({
        status: "failed",
        errorMessage: (error instanceof Error
          ? error.message
          : String(error)
        ).slice(0, 4000),
        updatedAt: new Date(),
      })
      .where(eq(requirementChangeRuns.id, run.id));
    if (error instanceof BizError) throw error;
    throw new BizError(
      50050,
      `Incremental generation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Start incremental generation as a background job; returns the job id for polling. */
export async function startIncrementalGeneration(
  runId: string,
  options: { mode?: string; profileId?: string | null } = {},
): Promise<{ jobId: string }> {
  // Fail fast on the same errors the synchronous path would raise.
  const run = await getRunRowOr404(runId);
  if (run.status === "generating") {
    throw new BizError(40065, "This incremental run is already generating");
  }
  const job = createJob("incremental-generation");
  runJob(job.id, async (report) => generateIncremental(runId, options, report));
  return { jobId: job.id };
}

/**
 * Incremental generation lives only in process memory; after a restart mark
 * stuck `generating`/`analyzing` runs failed so the UI never shows a phantom
 * in-progress run.
 */
export async function recoverInterruptedIncrementalRuns(): Promise<number> {
  const rows = await db
    .select({ id: requirementChangeRuns.id })
    .from(requirementChangeRuns)
    .where(inArray(requirementChangeRuns.status, ["generating", "analyzing"]));
  if (rows.length === 0) return 0;
  await db
    .update(requirementChangeRuns)
    .set({
      status: "failed",
      errorMessage: "Interrupted by a server restart",
      updatedAt: new Date(),
    })
    .where(
      inArray(
        requirementChangeRuns.id,
        rows.map((row) => row.id),
      ),
    );
  return rows.length;
}
