import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  GitCompareArrows,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { useJobPoller } from "#/hooks/use-job-poller";
import { EmptyState } from "#/components/EmptyState";
import { StatusBadge } from "#/components/StatusBadge";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Label } from "#/components/ui/label";
import { Progress } from "#/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { formatPercent, timeAgo } from "#/lib/format";

import type { RunDict } from "#/server/services/incremental";

const NONE = "__none__";

const RUN_STATUS_LABEL: Record<string, string> = {
  analyzing: "Analyzing",
  review: "Awaiting review",
  generating: "Generating",
  completed: "Completed",
  failed: "Failed",
};
const RUN_STATUS_TONE: Record<string, string> = {
  analyzing: "primary",
  review: "warning",
  generating: "primary",
  completed: "success",
  failed: "danger",
};

const ENTITY_LABEL: Record<string, string> = {
  endpoint: "Endpoint",
  business_rule: "Business rule",
  state_transition: "State transition",
  permission: "Permission",
  conflict: "Conflict",
};
const CHANGE_TYPE_LABEL: Record<string, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  unchanged: "Unchanged",
  uncertain: "Uncertain",
};
const CHANGE_TYPE_TONE: Record<string, string> = {
  added: "success",
  modified: "warning",
  deleted: "danger",
  unchanged: "info",
  uncertain: "danger",
};
const REVIEW_LABEL: Record<string, string> = {
  auto: "Auto",
  pending: "Pending",
  confirmed: "Confirmed",
  rejected: "Rejected",
};
const REVIEW_TONE: Record<string, string> = {
  auto: "info",
  pending: "warning",
  confirmed: "success",
  rejected: "danger",
};
const ACTION_LABEL: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  reused: "Reused",
  pending_delete: "Pending delete",
  missing: "Missing / to confirm",
};
const ACTION_TONE: Record<string, string> = {
  created: "success",
  updated: "warning",
  reused: "info",
  pending_delete: "danger",
  missing: "warning",
};
const IMPACT_LABEL: Record<string, string> = {
  direct: "Direct",
  indirect: "Indirect",
  none: "None",
};
const IMPACT_TONE: Record<string, string> = {
  direct: "danger",
  indirect: "warning",
  none: "info",
};
const REGRESSION_LABEL: Record<string, string> = {
  suggested: "Suggested",
  accepted: "Accepted",
  rejected: "Ignored",
};
const REGRESSION_TONE: Record<string, string> = {
  suggested: "warning",
  accepted: "success",
  rejected: "info",
};

function changeTarget(row: {
  entityType: string;
  matchKey: string;
  oldData: unknown;
  newData: unknown;
}): string {
  const data = (row.newData ?? row.oldData) as Record<string, unknown> | null;
  if (row.entityType === "endpoint" && data && !Array.isArray(data)) {
    const method = String(data.method ?? "");
    const pathValue = String(data.path ?? "");
    if (method || pathValue) return `${method} ${pathValue}`.trim();
  }
  if (row.entityType === "business_rule" && data && !Array.isArray(data)) {
    return String(data.description ?? row.matchKey);
  }
  return row.matchKey;
}

export function IncrementalTab({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [baselineId, setBaselineId] = useState<string>(NONE);
  const [currentId, setCurrentId] = useState<string>(NONE);
  const [mode, setMode] = useState<"auto" | "llm" | "rule">("auto");
  const [profileId, setProfileId] = useState<string>(NONE);
  const [runId, setRunId] = useState<string>(NONE);
  const [detailTab, setDetailTab] = useState("changes");
  const [changeFilter, setChangeFilter] = useState("all");
  const [caseFilter, setCaseFilter] = useState("all");
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJobPoller(jobId);
  const finishedRef = useRef<string | null>(null);

  const requirementsQuery = useQuery(
    trpc.requirements.list.queryOptions({ pid: projectId }),
  );
  const profilesQuery = useQuery(trpc.settings.listProfiles.queryOptions());
  const requirements = requirementsQuery.data ?? [];
  const textProfiles = (profilesQuery.data ?? []).filter(
    (p) => p.kind === "text",
  );

  // Default baseline/current once requirements load: baseline = previous
  // version, current = latest version.
  const defaultedRef = useRef(false);
  useEffect(() => {
    if (defaultedRef.current || requirements.length === 0) return;
    defaultedRef.current = true;
    const latest = requirements[requirements.length - 1];
    setCurrentId((prev) => (prev === NONE && latest ? latest.id : prev));
    if (requirements.length >= 2) {
      const previous = requirements[requirements.length - 2];
      setBaselineId((prev) => (prev === NONE && previous ? previous.id : prev));
    }
  }, [requirements]);

  const baselineSnapshotQuery = useQuery(
    trpc.incremental.snapshot.queryOptions(
      { rid: baselineId },
      { enabled: baselineId !== NONE },
    ),
  );
  const currentSnapshotQuery = useQuery(
    trpc.incremental.snapshot.queryOptions(
      { rid: currentId },
      { enabled: currentId !== NONE },
    ),
  );
  const runsQuery = useQuery(
    trpc.incremental.runs.queryOptions(
      { rid: currentId, limit: 20 },
      { enabled: currentId !== NONE },
    ),
  );
  const runs = runsQuery.data ?? [];

  // Follow the latest run automatically until the user picks one explicitly.
  const pickedRunRef = useRef(false);
  useEffect(() => {
    if (pickedRunRef.current) return;
    const latest = runs[0];
    if (latest) setRunId(latest.id);
  }, [runs]);

  const runQuery = useQuery(
    trpc.incremental.run.queryOptions(
      { runId },
      {
        enabled: runId !== NONE,
        refetchInterval: runId !== NONE ? 4000 : false,
      },
    ),
  );
  const run: RunDict | null = runQuery.data ?? null;

  useEffect(() => {
    if (job.isTerminal && jobId && finishedRef.current !== jobId) {
      finishedRef.current = jobId;
      if (job.isFailed)
        toast.error(job.error ?? "Incremental generation failed");
      else {
        toast.success("Incremental generation complete");
        setDetailTab("cases");
      }
      invalidate();
      setJobId(null);
    }
  }, [job.isTerminal, job.isFailed, job.error, jobId]);

  function invalidate() {
    queryClient.invalidateQueries({
      queryKey: trpc.incremental.run.queryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: trpc.incremental.runs.queryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: trpc.incremental.snapshot.queryKey(),
    });
    queryClient.invalidateQueries({ queryKey: trpc.testcases.list.queryKey() });
    queryClient.invalidateQueries({
      queryKey: trpc.generation.versions.queryKey(),
    });
    queryClient.invalidateQueries({ queryKey: trpc.stats.overview.queryKey() });
  }

  const snapshotMutation = useMutation(
    trpc.incremental.createSnapshot.mutationOptions({
      onSuccess: () => {
        toast.success("Baseline snapshot created");
        queryClient.invalidateQueries({
          queryKey: trpc.incremental.snapshot.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const analyzeMutation = useMutation(
    trpc.incremental.analyze.mutationOptions({
      onSuccess: (result) => {
        pickedRunRef.current = true;
        setRunId(result.id);
        toast.success("Change analysis complete");
        invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const generateMutation = useMutation(
    trpc.incremental.generate.mutationOptions({
      onSuccess: (result) => {
        setJobId(result.jobId);
        toast.info("Generating incremental cases…");
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const reviewChangeMutation = useMutation(
    trpc.incremental.reviewChange.mutationOptions({
      onSuccess: (_result, variables) => {
        toast.success(
          variables.status === "confirmed"
            ? "Change confirmed"
            : "Change rejected",
        );
        invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const reviewRegressionMutation = useMutation(
    trpc.incremental.reviewRegression.mutationOptions({
      onSuccess: (_result, variables) => {
        toast.success(
          variables.status === "accepted"
            ? "Regression pick accepted"
            : "Regression pick ignored",
        );
        invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const canAnalyze =
    baselineId !== NONE && currentId !== NONE && baselineId !== currentId;
  const generating = generateMutation.isPending || job.isRunning;
  const baselineSnapshot = baselineSnapshotQuery.data ?? null;
  const currentSnapshot = currentSnapshotQuery.data ?? null;

  const summary = (run?.summary ?? {}) as Record<string, unknown>;
  const endpointCounts = (summary.endpointCounts ?? {}) as Record<
    string,
    number
  >;
  const caseSummary = (summary.caseChanges ?? {}) as Record<string, number>;
  const changes = run?.changes ?? [];
  const caseChanges = run?.caseChanges ?? [];

  const ruleChangeCount = changes.filter(
    (c) => c.entityType === "business_rule" && c.changeType !== "unchanged",
  ).length;
  const permissionChangeCount = changes.filter(
    (c) => c.entityType === "permission",
  ).length;
  const transitionChangeCount = changes.filter(
    (c) => c.entityType === "state_transition",
  ).length;

  const filteredChanges = useMemo(() => {
    if (changeFilter === "all") return changes;
    if (changeFilter === "pending") {
      return changes.filter(
        (c) => c.reviewStatus === "pending" || c.requiresConfirmation,
      );
    }
    if (changeFilter === "endpoint") {
      return changes.filter((c) => c.entityType === "endpoint");
    }
    if (changeFilter === "rule") {
      return changes.filter((c) => c.entityType === "business_rule");
    }
    if (changeFilter === "conflict") {
      return changes.filter((c) => c.entityType === "conflict");
    }
    return changes.filter((c) =>
      ["permission", "state_transition"].includes(c.entityType),
    );
  }, [changes, changeFilter]);

  const filteredCaseChanges = useMemo(() => {
    if (caseFilter === "all") return caseChanges;
    return caseChanges.filter((c) => c.action === caseFilter);
  }, [caseChanges, caseFilter]);

  const regressionRows = useMemo(
    () =>
      caseChanges.filter(
        (c) =>
          c.baselineCaseId &&
          ["direct", "indirect"].includes(c.regressionImpact) &&
          c.regressionStatus !== "rejected",
      ),
    [caseChanges],
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <GitCompareArrows
              className="text-muted-foreground size-4"
              aria-hidden
            />
            Incremental analysis
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div className="space-y-2">
              <Label>Baseline version</Label>
              <Select
                value={baselineId}
                onValueChange={(v) => v !== null && setBaselineId(v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick phase-1 baseline" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not selected</SelectItem>
                  {requirements.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.version} · {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Current version</Label>
              <Select
                value={currentId}
                onValueChange={(v) => {
                  if (v === null) return;
                  setCurrentId(v);
                  pickedRunRef.current = false;
                  setRunId(NONE);
                  const index = requirements.findIndex((item) => item.id === v);
                  if (
                    index > 0 &&
                    (baselineId === NONE ||
                      baselineId === v ||
                      !requirements.some((item) => item.id === baselineId))
                  ) {
                    setBaselineId(requirements[index - 1].id);
                  }
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick phase-2 version" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not selected</SelectItem>
                  {requirements.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.version} · {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Mode</Label>
              <Select
                value={mode}
                onValueChange={(v) => setMode(v as typeof mode)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (LLM first)</SelectItem>
                  <SelectItem value="llm">LLM only</SelectItem>
                  <SelectItem value="rule">Rule only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Text LLM {mode === "rule" ? "(unused)" : ""}</Label>
              <Select
                value={profileId}
                onValueChange={(v) => v !== null && setProfileId(v)}
                disabled={mode === "rule"}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Default profile" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Default</SelectItem>
                  {textProfiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} · {p.model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={baselineId === NONE || snapshotMutation.isPending}
              onClick={() =>
                snapshotMutation.mutate({ rid: baselineId, analysisId: null })
              }
            >
              {snapshotMutation.isPending
                ? "Building snapshot…"
                : "Build baseline snapshot"}
            </Button>
            <Button
              size="sm"
              disabled={!canAnalyze || analyzeMutation.isPending}
              onClick={() =>
                analyzeMutation.mutate({
                  rid: currentId,
                  baselineRequirementId: baselineId,
                  mode,
                  profileId: profileId === NONE ? null : profileId,
                })
              }
            >
              <GitCompareArrows className="size-4" aria-hidden />
              {analyzeMutation.isPending ? "Analyzing…" : "Analyze changes"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={runId === NONE || generating}
              onClick={() =>
                generateMutation.mutate({
                  runId,
                  mode,
                  profileId: profileId === NONE ? null : profileId,
                })
              }
            >
              <Sparkles className="size-4" aria-hidden />
              {generating ? "Generating…" : "Generate incremental cases"}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh"
              onClick={() => invalidate()}
            >
              <RefreshCw className="size-4" aria-hidden />
            </Button>
          </div>

          <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
            <span className="flex items-center gap-1.5">
              Baseline snapshot:
              {baselineSnapshot ? (
                <>
                  <StatusBadge
                    tone="success"
                    label={`${(baselineSnapshot.endpoints ?? []).length} endpoints`}
                  />
                  {baselineSnapshot.createdAt
                    ? timeAgo(baselineSnapshot.createdAt)
                    : ""}
                </>
              ) : (
                <StatusBadge tone="warning" label="Not built" />
              )}
            </span>
            <span className="flex items-center gap-1.5">
              Current snapshot:
              {currentSnapshot ? (
                <>
                  <StatusBadge
                    tone="success"
                    label={`${(currentSnapshot.endpoints ?? []).length} endpoints`}
                  />
                  {currentSnapshot.createdAt
                    ? timeAgo(currentSnapshot.createdAt)
                    : ""}
                </>
              ) : (
                <StatusBadge
                  tone="info"
                  label="Built automatically on analyze"
                />
              )}
            </span>
            {runs.length > 0 ? (
              <span className="flex items-center gap-1.5">
                Run:
                <Select
                  value={runId}
                  onValueChange={(v) => {
                    if (v === null) return;
                    pickedRunRef.current = true;
                    setRunId(v);
                  }}
                >
                  <SelectTrigger className="h-7 w-64 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {runs.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.createdAt
                          ? timeAgo(item.createdAt)
                          : item.id.slice(0, 8)}
                        {" · "}
                        {RUN_STATUS_LABEL[item.status] ?? item.status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {run ? (
                  <StatusBadge
                    tone={RUN_STATUS_TONE[run.status] ?? "info"}
                    label={RUN_STATUS_LABEL[run.status] ?? run.status}
                  />
                ) : null}
              </span>
            ) : null}
          </div>

          {generating && job.progress !== null ? (
            <div className="flex items-center gap-3">
              <Progress value={job.progress * 100} className="flex-1" />
              <span className="text-muted-foreground text-xs">
                {job.message}
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {baselineId !== NONE &&
      !baselineSnapshot &&
      !baselineSnapshotQuery.isLoading ? (
        <Alert>
          <AlertTriangle className="size-4" aria-hidden />
          <AlertTitle>No baseline snapshot yet</AlertTitle>
          <AlertDescription>
            Build the baseline snapshot while the phase-1 code analysis is still
            current, then switch to the phase-2 analysis. Without a baseline the
            comparison would treat every endpoint as newly added.
          </AlertDescription>
        </Alert>
      ) : null}

      {run && run.status === "failed" && run.errorMessage ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertTitle>Run failed</AlertTitle>
          <AlertDescription>{run.errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {requirements.length === 0 ? (
        <EmptyState
          icon={GitCompareArrows}
          title="No requirement versions"
          description="Create the phase-1 and phase-2 requirement versions first."
        />
      ) : !run ? (
        <EmptyState
          icon={GitCompareArrows}
          title="No change run yet"
          description="Pick a baseline and a current version, then run Analyze changes to produce the change list and regression recommendations."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <MetricCard
              label="Endpoints added"
              value={endpointCounts.added ?? 0}
              className="text-success"
            />
            <MetricCard
              label="Endpoints modified"
              value={endpointCounts.modified ?? 0}
              className="text-warning"
            />
            <MetricCard
              label="Deleted / uncertain"
              value={
                (endpointCounts.deleted ?? 0) + (endpointCounts.uncertain ?? 0)
              }
              className="text-destructive"
            />
            <MetricCard
              label="Endpoints unchanged"
              value={endpointCounts.unchanged ?? 0}
            />
            <MetricCard
              label="Cases created"
              value={caseSummary.created ?? 0}
            />
            <MetricCard
              label="Cases updated"
              value={caseSummary.updated ?? 0}
            />
            <MetricCard label="Cases reused" value={caseSummary.reused ?? 0} />
            <MetricCard
              label="Regression picks"
              value={caseSummary.regressionRecommended ?? 0}
              className="text-warning"
            />
          </div>

          {Number(summary.conflicts ?? 0) > 0 ||
          Number(summary.requiresConfirmation ?? 0) > 0 ||
          ruleChangeCount > 0 ||
          permissionChangeCount > 0 ||
          transitionChangeCount > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {Number(summary.conflicts ?? 0) > 0 ? (
                <StatusBadge
                  tone="danger"
                  label={`Doc/code conflicts: ${summary.conflicts}`}
                />
              ) : null}
              {Number(summary.requiresConfirmation ?? 0) > 0 ? (
                <StatusBadge
                  tone="warning"
                  label={`Need confirmation: ${summary.requiresConfirmation}`}
                />
              ) : null}
              {ruleChangeCount > 0 ? (
                <StatusBadge
                  tone="info"
                  label={`Rule changes: ${ruleChangeCount}`}
                />
              ) : null}
              {permissionChangeCount > 0 ? (
                <StatusBadge
                  tone="warning"
                  label={`Auth changes: ${permissionChangeCount}`}
                />
              ) : null}
              {transitionChangeCount > 0 ? (
                <StatusBadge
                  tone="info"
                  label={`Transition changes: ${transitionChangeCount}`}
                />
              ) : null}
              <span className="text-muted-foreground text-xs">
                Decide on generation after confirming; unconfirmed deletions
                never physically delete historical cases.
              </span>
            </div>
          ) : null}

          <Tabs value={detailTab} onValueChange={setDetailTab}>
            <TabsList>
              <TabsTrigger value="changes">
                Change list ({changes.length})
              </TabsTrigger>
              <TabsTrigger value="cases">
                Case changes ({caseChanges.length})
              </TabsTrigger>
              <TabsTrigger value="regression">
                Regression picks ({regressionRows.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="changes" className="mt-4 flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <Select
                  value={changeFilter}
                  onValueChange={(v) => v !== null && setChangeFilter(v)}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All changes</SelectItem>
                    <SelectItem value="pending">Need confirmation</SelectItem>
                    <SelectItem value="endpoint">Endpoints only</SelectItem>
                    <SelectItem value="rule">Business rules only</SelectItem>
                    <SelectItem value="conflict">Conflicts only</SelectItem>
                    <SelectItem value="misc">
                      Auth / transitions only
                    </SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground text-xs">
                  {filteredChanges.length} row(s)
                </span>
              </div>
              <div className="border-border/70 overflow-hidden rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="w-28">Entity</TableHead>
                      <TableHead className="w-24">Change</TableHead>
                      <TableHead className="min-w-44">
                        Endpoint / rule
                      </TableHead>
                      <TableHead className="min-w-52">Reason</TableHead>
                      <TableHead className="w-20 text-center">
                        Confidence
                      </TableHead>
                      <TableHead className="w-24 text-center">Status</TableHead>
                      <TableHead className="w-32 text-center">
                        Actions
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredChanges.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={7}
                          className="text-muted-foreground py-8 text-center text-sm"
                        >
                          No changes
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredChanges.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="text-xs">
                            {ENTITY_LABEL[row.entityType] ?? row.entityType}
                          </TableCell>
                          <TableCell>
                            <StatusBadge
                              tone={CHANGE_TYPE_TONE[row.changeType] ?? "info"}
                              label={
                                CHANGE_TYPE_LABEL[row.changeType] ??
                                row.changeType
                              }
                            />
                          </TableCell>
                          <TableCell
                            className="max-w-56 truncate font-mono text-xs"
                            title={changeTarget(row)}
                          >
                            {changeTarget(row)}
                          </TableCell>
                          <TableCell
                            className="text-muted-foreground max-w-72 truncate text-xs"
                            title={row.reason}
                          >
                            {row.reason}
                          </TableCell>
                          <TableCell className="text-center text-xs tabular-nums">
                            {formatPercent(row.confidence, 0)}
                          </TableCell>
                          <TableCell className="text-center">
                            <StatusBadge
                              tone={REVIEW_TONE[row.reviewStatus] ?? "info"}
                              label={
                                REVIEW_LABEL[row.reviewStatus] ??
                                row.reviewStatus
                              }
                            />
                          </TableCell>
                          <TableCell className="text-center">
                            {row.reviewStatus !== "confirmed" &&
                            row.reviewStatus !== "rejected" ? (
                              <div className="flex items-center justify-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="text-success hover:text-success size-7"
                                  aria-label="Confirm change"
                                  disabled={reviewChangeMutation.isPending}
                                  onClick={() =>
                                    reviewChangeMutation.mutate({
                                      runId: run.id,
                                      changeId: row.id,
                                      status: "confirmed",
                                    })
                                  }
                                >
                                  <Check className="size-4" aria-hidden />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="text-destructive hover:text-destructive size-7"
                                  aria-label="Reject change"
                                  disabled={reviewChangeMutation.isPending}
                                  onClick={() =>
                                    reviewChangeMutation.mutate({
                                      runId: run.id,
                                      changeId: row.id,
                                      status: "rejected",
                                    })
                                  }
                                >
                                  <X className="size-4" aria-hidden />
                                </Button>
                              </div>
                            ) : (
                              <span className="text-muted-foreground text-xs">
                                —
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="cases" className="mt-4 flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <Select
                  value={caseFilter}
                  onValueChange={(v) => v !== null && setCaseFilter(v)}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All destinations</SelectItem>
                    <SelectItem value="created">Created</SelectItem>
                    <SelectItem value="updated">Updated</SelectItem>
                    <SelectItem value="reused">Reused</SelectItem>
                    <SelectItem value="pending_delete">
                      Pending delete
                    </SelectItem>
                    <SelectItem value="missing">
                      Missing / to confirm
                    </SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground text-xs">
                  {filteredCaseChanges.length} row(s)
                </span>
              </div>
              <div className="border-border/70 overflow-hidden rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="w-32">Destination</TableHead>
                      <TableHead className="min-w-44">Phase-2 case</TableHead>
                      <TableHead className="min-w-44">
                        Historical case
                      </TableHead>
                      <TableHead className="w-24 text-center">Impact</TableHead>
                      <TableHead className="min-w-52">Notes</TableHead>
                      <TableHead className="w-28 text-center">
                        Regression
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredCaseChanges.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="text-muted-foreground py-8 text-center text-sm"
                        >
                          No incremental cases generated yet
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredCaseChanges.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>
                            <StatusBadge
                              tone={ACTION_TONE[row.action] ?? "info"}
                              label={ACTION_LABEL[row.action] ?? row.action}
                            />
                          </TableCell>
                          <TableCell
                            className="max-w-56 truncate text-xs"
                            title={row.targetCaseTitle}
                          >
                            {row.targetCaseTitle || "—"}
                          </TableCell>
                          <TableCell
                            className="max-w-56 truncate text-xs"
                            title={row.baselineCaseTitle}
                          >
                            {row.baselineCaseTitle || "—"}
                          </TableCell>
                          <TableCell className="text-center">
                            <StatusBadge
                              tone={IMPACT_TONE[row.regressionImpact] ?? "info"}
                              label={
                                IMPACT_LABEL[row.regressionImpact] ??
                                row.regressionImpact
                              }
                            />
                          </TableCell>
                          <TableCell
                            className="text-muted-foreground max-w-72 truncate text-xs"
                            title={row.reason}
                          >
                            {row.reason}
                          </TableCell>
                          <TableCell className="text-center">
                            <StatusBadge
                              tone={
                                REGRESSION_TONE[row.regressionStatus] ?? "info"
                              }
                              label={
                                REGRESSION_LABEL[row.regressionStatus] ??
                                row.regressionStatus
                              }
                            />
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent
              value="regression"
              className="mt-4 flex flex-col gap-3"
            >
              <Alert>
                <AlertTitle>How regression picks are inferred</AlertTitle>
                <AlertDescription>
                  Recommendations come from endpoint changes, linked business
                  rules, shared security configuration, and shared controllers.
                  Without a full dependency graph, uncertain items carry their
                  reason and need manual confirmation.
                </AlertDescription>
              </Alert>
              <div className="border-border/70 overflow-hidden rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="min-w-56">
                        Historical case
                      </TableHead>
                      <TableHead className="w-24 text-center">Impact</TableHead>
                      <TableHead className="min-w-64">Reason</TableHead>
                      <TableHead className="w-28 text-center">Status</TableHead>
                      <TableHead className="w-32 text-center">
                        Actions
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {regressionRows.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="text-muted-foreground py-8 text-center text-sm"
                        >
                          No regression recommendations
                        </TableCell>
                      </TableRow>
                    ) : (
                      regressionRows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell
                            className="max-w-64 truncate text-xs"
                            title={row.baselineCaseTitle}
                          >
                            {row.baselineCaseTitle || row.baselineCaseId}
                          </TableCell>
                          <TableCell className="text-center">
                            <StatusBadge
                              tone={IMPACT_TONE[row.regressionImpact] ?? "info"}
                              label={
                                IMPACT_LABEL[row.regressionImpact] ??
                                row.regressionImpact
                              }
                            />
                          </TableCell>
                          <TableCell
                            className="text-muted-foreground max-w-80 truncate text-xs"
                            title={row.regressionReason}
                          >
                            {row.regressionReason}
                          </TableCell>
                          <TableCell className="text-center">
                            <StatusBadge
                              tone={
                                REGRESSION_TONE[row.regressionStatus] ?? "info"
                              }
                              label={
                                REGRESSION_LABEL[row.regressionStatus] ??
                                row.regressionStatus
                              }
                            />
                          </TableCell>
                          <TableCell className="text-center">
                            <div className="flex items-center justify-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-success hover:text-success h-7"
                                disabled={reviewRegressionMutation.isPending}
                                onClick={() =>
                                  reviewRegressionMutation.mutate({
                                    caseChangeId: row.id,
                                    status: "accepted",
                                  })
                                }
                              >
                                Accept
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:text-destructive h-7"
                                disabled={reviewRegressionMutation.isPending}
                                onClick={() =>
                                  reviewRegressionMutation.mutate({
                                    caseChangeId: row.id,
                                    status: "rejected",
                                  })
                                }
                              >
                                Ignore
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className?: string;
}) {
  return (
    <div className="border-border/70 bg-card rounded-xl border px-3 py-2.5">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${className ?? ""}`}>
        {value}
      </div>
    </div>
  );
}

export default IncrementalTab;
