/**
 * Coverage matrix: planned coverage vs passed-execution coverage.
 *
 * Fixed semantics:
 * - Planned coverage: whether case coverageRefs reference real endpoints /
 *   verified state transitions / business rules.
 * - Execution coverage: only status=passed execution records of current live
 *   cases count, reading
 *   the case snapshot captured at execution time first.
 * - Stale ids absent from the latest code facts never count; ratios are
 *   always clamped to 0~1.
 */
import type {
  BackendResult,
  CoverageRefs,
  StateMachineSpec,
  StructuredStep,
} from "#/lib/types";

const ACTION_ALIASES: [string, string[]][] = [
  ["create", ["create", "add", "new", "submit", "save"]],
  ["list", ["list", "query", "search", "filter"]],
  ["pay", ["pay", "payment"]],
  ["ship", ["ship", "deliver", "shipment"]],
  ["complete", ["complete", "finish", "confirm receipt"]],
  ["cancel", ["cancel"]],
  ["refund", ["refund"]],
  ["update", ["update", "edit", "modify"]],
  ["delete", ["delete", "remove"]],
  ["login", ["login", "sign in", "signin"]],
];

export interface CoverageCaseInput {
  id?: string;
  title?: string;
  module?: string;
  coverageRefs?: Partial<CoverageRefs> | null;
  steps?: (string | StructuredStep)[];
  structuredSteps?: StructuredStep[];
  testData?: Record<string, unknown> | null;
  /** Latest execution status of the live case (for the execution matrix). */
  executionStatus?: string | null;
}

function normaliseRefs(
  value: Partial<CoverageRefs> | null | undefined,
): CoverageRefs {
  const raw = value || {};
  const uniq = (list: unknown[] | undefined): string[] => [
    ...new Set((list || []).map((item) => String(item)).filter(Boolean)),
  ];
  return {
    endpointIds: uniq(raw.endpointIds),
    transitionIds: uniq(raw.transitionIds),
    ruleIds: uniq(raw.ruleIds),
    testPointIds: uniq(raw.testPointIds),
  };
}

function caseText(
  title = "",
  moduleName = "",
  steps: (string | StructuredStep)[] | null = null,
  testData: Record<string, unknown> | null = null,
  point: Record<string, unknown> | null = null,
): string {
  const parts: string[] = [title, moduleName];
  for (const step of steps || []) {
    if (step && typeof step === "object") {
      const s = step;
      parts.push(
        String(s.action || ""),
        String(s.target || ""),
        String(s.expected || ""),
        String(s.inputValue || ""),
      );
      const selector = s.uiSelector;
      if (selector) parts.push(String(selector.value || ""));
    } else {
      parts.push(String(step || ""));
    }
  }
  if (testData) {
    parts.push(...Object.keys(testData).map(String));
    parts.push(...Object.values(testData).map(String));
  }
  if (point) {
    parts.push(
      ...[
        "title",
        "category",
        "description",
        "pageRoute",
        "endpoint",
        "expected",
      ].map((key) => String(point[key] || "")),
    );
    const fields = point.fields;
    if (Array.isArray(fields)) parts.push(...fields.map(String));
  }
  return parts.join(" ").toLowerCase();
}

function explicitEndpointIds(
  point: Record<string, unknown> | null,
  endpoints: Record<string, unknown>[],
): string[] {
  if (!point) return [];
  const raw = String(point.endpoint || "").trim();
  if (!raw) return [];
  let method = "";
  let endpointPath = raw;
  const match = /^([A-Za-z]+)\s+(.+)$/.exec(raw);
  if (match) {
    method = match[1].toUpperCase();
    endpointPath = match[2].trim();
  }
  const matched: string[] = [];
  for (const endpoint of endpoints) {
    const epPath = String(endpoint.path || "");
    if (
      !endpointPath ||
      !epPath.toLowerCase().includes(endpointPath.toLowerCase())
    ) {
      continue;
    }
    if (method && method !== String(endpoint.method || "").toUpperCase())
      continue;
    matched.push(String(endpoint.id));
  }
  return matched.filter(Boolean);
}

function inferEndpointIds(
  text: string,
  point: Record<string, unknown> | null,
  endpoints: Record<string, unknown>[],
): string[] {
  const explicit = explicitEndpointIds(point, endpoints);
  if (explicit.length > 0) return explicit;

  const matched: string[] = [];
  for (const endpoint of endpoints) {
    const endpointPath = String(endpoint.path || "").toLowerCase();
    if (endpointPath && text.includes(endpointPath)) {
      matched.push(String(endpoint.id || ""));
    }
  }

  // State cases may walk several transitions at once, so match each action
  // and merge; when one action hits multiple endpoints it is ambiguous and
  // skipped — supporting multi-endpoint coverage without mass false hits.
  for (const [action, words] of ACTION_ALIASES) {
    if (!words.some((word) => text.includes(word))) continue;
    const actionMatches: string[] = [];
    for (const endpoint of endpoints) {
      const endpointPath = String(endpoint.path || "").toLowerCase();
      const methodName = String(
        endpoint.methodName || endpoint.method_name || "",
      ).toLowerCase();
      const epText = `${endpointPath} ${methodName}`;
      const hasAction =
        epText.includes(action) || words.some((word) => epText.includes(word));
      if (hasAction) actionMatches.push(String(endpoint.id || ""));
    }
    if (actionMatches.length === 1) matched.push(actionMatches[0]);
  }

  return [...new Set(matched)].filter(Boolean);
}

function inferRuleIds(
  text: string,
  point: Record<string, unknown> | null,
  testData: Record<string, unknown> | null,
  rules: Record<string, unknown>[],
): string[] {
  const matched: string[] = [];
  const caseFields = new Set(
    [
      ...Object.keys(testData || {}),
      ...((point?.fields as string[] | undefined) || []),
    ]
      .map((item) => String(item).toLowerCase())
      .filter(Boolean),
  );
  for (const rule of rules) {
    const ruleId = String(rule.id || "");
    if (!ruleId) continue;
    const description = String(rule.description || "");
    const guard = String(rule.guard || "");
    const ruleText = `${description} ${guard}`.toLowerCase();
    if (text.includes(ruleId.toLowerCase())) {
      matched.push(ruleId);
      continue;
    }
    if (description && text.includes(description.toLowerCase())) {
      matched.push(ruleId);
      continue;
    }
    // Field rules: only use real business fields, so generic tokens like
    // order/status/id do not link one rule to every case.
    if (
      [...caseFields].some(
        (field) => field && ruleText.includes(field) && text.includes(field),
      )
    ) {
      matched.push(ruleId);
      continue;
    }
    // State rules: link only when the rule's action words match the case's.
    for (const [, words] of ACTION_ALIASES) {
      if (
        words.some((word) => ruleText.includes(word)) &&
        words.some((word) => text.includes(word))
      ) {
        matched.push(ruleId);
        break;
      }
    }
  }
  return [...new Set(matched)];
}

/**
 * Infer and merge coverage refs. Explicit refs always win; inference only
 * adds high-confidence matches grounded in code facts.
 */
export function resolveCoverageRefs(
  kase: CoverageCaseInput,
  backend: BackendResult | null,
  machines: StateMachineSpec[] | null,
  point: Record<string, unknown> | null = null,
): CoverageRefs {
  const refs = normaliseRefs(kase.coverageRefs);
  const endpoints = (backend?.endpoints || []) as unknown as Record<
    string,
    unknown
  >[];
  const rules = (backend?.businessRules || []) as unknown as Record<
    string,
    unknown
  >[];
  const steps = kase.structuredSteps || kase.steps || [];
  const text = caseText(
    String(kase.title || ""),
    String(kase.module || ""),
    steps,
    kase.testData,
    point,
  );

  // Explicit refs are precise facts from humans/models and beat action-word
  // inference; otherwise multiple create endpoints would all count covered.
  if (refs.endpointIds.length === 0) {
    refs.endpointIds = inferEndpointIds(text, point, endpoints);
  }
  if (refs.ruleIds.length === 0) {
    refs.ruleIds = inferRuleIds(text, point, kase.testData ?? null, rules);
  }

  const transitionIds = new Set(refs.transitionIds);
  for (const machine of machines || []) {
    for (const transition of machine.transitions || []) {
      if (!transition.verified) continue;
      const trigger = String(transition.trigger || "");
      if (trigger && text.includes(trigger.toLowerCase())) {
        transitionIds.add(String(transition.id || ""));
      }
    }
  }
  refs.transitionIds = [...transitionIds].filter(Boolean);
  return refs;
}

export interface CoverageBlock {
  total: number;
  plannedCovered: number;
  executedCovered: number;
  uncoveredCount: number;
  plannedRate: number;
  executedRate: number;
  uncovered: { id: string; label: string }[];
}

export interface CaseExecutionModuleStats {
  module: string;
  total: number;
  passed: number;
  failed: number;
  needsReview: number;
  notRun: number;
  other: number;
  passRate: number;
}

/** Per-module pass statistics over each current live case's latest status. */
export interface CaseExecutionStats {
  total: number;
  passed: number;
  failed: number;
  needsReview: number;
  notRun: number;
  running: number;
  skipped: number;
  cancelled: number;
  passRate: number;
  statusCounts: Record<string, number>;
  modules: CaseExecutionModuleStats[];
  note: string;
}

export interface CoverageMatrix {
  scope: {
    projectId: string;
    requirementId: string | null;
    executionBasis: string;
    snapshotBased: boolean;
  };
  scoped: {
    endpoints: number;
    transitions: number;
    rules: number;
    cases: number;
    passedExecutions: number;
  };
  apiEndpoint: CoverageBlock;
  stateTransition: CoverageBlock;
  businessRule: CoverageBlock;
  caseExecution: CaseExecutionStats;
  stateMachines: StateMachineSpec[];
}

export interface CoverageMatrixInput {
  projectId: string;
  requirementId: string | null;
  backend: BackendResult | null;
  machines: StateMachineSpec[];
  cases: CoverageCaseInput[];
  /** Snapshots of passed executions (case dicts captured at execution time). */
  passedSnapshots: Record<string, unknown>[];
}

export function buildCoverageMatrix(
  input: CoverageMatrixInput,
): CoverageMatrix {
  const endpoints = (input.backend?.endpoints || []) as unknown as Record<
    string,
    unknown
  >[];
  const rules = (input.backend?.businessRules || []) as unknown as Record<
    string,
    unknown
  >[];
  const machineSpecs: StateMachineSpec[] = structuredClone(
    input.machines || [],
  );
  // Only verified transitions (those backed by a real status write site) are
  // part of the coverage denominator; unverified guesses must not inflate the
  // total or show up as "uncovered" noise.
  for (const machine of machineSpecs) {
    machine.transitions = (machine.transitions || []).filter((t) => t.verified);
  }
  const transitions = machineSpecs.flatMap(
    (m) => (m.transitions || []) as unknown as Record<string, unknown>[],
  );

  const validEndpoints = new Set(endpoints.map((e) => String(e.id)));
  const validTransitions = new Set(transitions.map((t) => String(t.id)));
  const validRules = new Set(rules.map((r) => String(r.id)));

  const plannedEndpoint = new Set<string>();
  const plannedTransition = new Set<string>();
  const plannedRule = new Set<string>();
  const transitionCases = new Map<string, string[]>();

  for (const kase of input.cases) {
    const refs = resolveCoverageRefs(kase, input.backend, machineSpecs);
    for (const id of refs.endpointIds)
      if (validEndpoints.has(id)) plannedEndpoint.add(id);
    for (const id of refs.transitionIds) {
      if (!validTransitions.has(id)) continue;
      plannedTransition.add(id);
      const list = transitionCases.get(id) ?? [];
      if (kase.id) list.push(kase.id);
      transitionCases.set(id, list);
    }
    for (const id of refs.ruleIds) if (validRules.has(id)) plannedRule.add(id);
  }

  const executedEndpoint = new Set<string>();
  const executedTransition = new Set<string>();
  const executedRule = new Set<string>();
  for (const snapshot of input.passedSnapshots) {
    if (!snapshot || typeof snapshot !== "object") continue;
    const refs = resolveCoverageRefs(snapshot, input.backend, machineSpecs);
    for (const id of refs.endpointIds)
      if (validEndpoints.has(id)) executedEndpoint.add(id);
    for (const id of refs.transitionIds)
      if (validTransitions.has(id)) executedTransition.add(id);
    for (const id of refs.ruleIds) if (validRules.has(id)) executedRule.add(id);
  }

  const block = (
    total: number,
    planned: Set<string>,
    executed: Set<string>,
    uncovered: { id: string; label: string }[],
  ): CoverageBlock => ({
    total,
    plannedCovered: planned.size,
    executedCovered: executed.size,
    uncoveredCount: Math.max(total - planned.size, 0),
    plannedRate: total ? Number((planned.size / total).toFixed(4)) : 0,
    executedRate: total ? Number((executed.size / total).toFixed(4)) : 0,
    uncovered,
  });

  const endpointUncovered = endpoints
    .filter((item) => !plannedEndpoint.has(String(item.id)))
    .map((item) => ({
      id: String(item.id),
      label: `${String(item.method || "")} ${String(item.path || "")}`.trim(),
    }));
  const transitionUncovered = transitions
    .filter((item) => !plannedTransition.has(String(item.id)))
    .map((item) => ({
      id: String(item.id),
      label: `${String(item.from || "")} → ${String(item.to || "")} (${String(item.trigger || "")})`,
    }));
  const ruleUncovered = rules
    .filter((item) => !plannedRule.has(String(item.id)))
    .map((item) => ({
      id: String(item.id),
      label:
        String(item.description || "") ||
        String(item.guard || "") ||
        String(item.id || ""),
    }));

  for (const machine of machineSpecs) {
    for (const transition of machine.transitions || []) {
      const transitionId = String(transition.id || "");
      transition.planned = plannedTransition.has(transitionId);
      transition.plannedCaseIds = transitionCases.get(transitionId) ?? [];
      transition.executed = executedTransition.has(transitionId);
    }
  }

  // Execution-pass matrix: based on each current live case's latest
  // execution status. Historical snapshots and deleted cases never count.
  const statusCounts: Record<string, number> = {};
  const moduleStats = new Map<string, CaseExecutionModuleStats>();
  for (const kase of input.cases) {
    const status = kase.executionStatus || "not_run";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    const key = kase.module || "Ungrouped";
    let bucket = moduleStats.get(key);
    if (!bucket) {
      bucket = {
        module: key,
        total: 0,
        passed: 0,
        failed: 0,
        needsReview: 0,
        notRun: 0,
        other: 0,
        passRate: 0,
      };
      moduleStats.set(key, bucket);
    }
    bucket.total += 1;
    if (status === "passed") bucket.passed += 1;
    else if (status === "failed") bucket.failed += 1;
    else if (status === "needs_review") bucket.needsReview += 1;
    else if (status === "not_run") bucket.notRun += 1;
    else bucket.other += 1;
  }
  const modules = [...moduleStats.values()]
    .sort((a, b) => b.total - a.total || a.module.localeCompare(b.module))
    .map((bucket) => ({
      ...bucket,
      passRate: bucket.total > 0 ? bucket.passed / bucket.total : 0,
    }));
  const passedCases = statusCounts.passed ?? 0;
  const caseExecution: CaseExecutionStats = {
    total: input.cases.length,
    passed: passedCases,
    failed: statusCounts.failed ?? 0,
    needsReview: statusCounts.needs_review ?? 0,
    notRun: statusCounts.not_run ?? 0,
    running: statusCounts.running ?? 0,
    skipped: statusCounts.skipped ?? 0,
    cancelled: statusCounts.cancelled ?? 0,
    passRate: input.cases.length > 0 ? passedCases / input.cases.length : 0,
    statusCounts,
    modules,
    note: "Counts each current live case by its latest execution status; historical snapshots and deleted cases are excluded.",
  };

  return {
    scope: {
      projectId: input.projectId,
      requirementId: input.requirementId,
      executionBasis:
        "Only status=passed execution records belonging to current live cases count",
      snapshotBased: true,
    },
    scoped: {
      endpoints: endpoints.length,
      transitions: transitions.length,
      rules: rules.length,
      cases: input.cases.length,
      passedExecutions: input.passedSnapshots.length,
    },
    apiEndpoint: block(
      endpoints.length,
      plannedEndpoint,
      executedEndpoint,
      endpointUncovered,
    ),
    stateTransition: block(
      transitions.length,
      plannedTransition,
      executedTransition,
      transitionUncovered,
    ),
    businessRule: block(rules.length, plannedRule, executedRule, ruleUncovered),
    caseExecution,
    stateMachines: machineSpecs,
  };
}
