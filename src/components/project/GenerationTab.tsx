import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Eraser, History, Sparkles, Target } from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { useJobPoller } from "#/hooks/use-job-poller";
import { EmptyState } from "#/components/EmptyState";
import { StatusBadge } from "#/components/StatusBadge";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
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
import { timeAgo } from "#/lib/format";

import type { GenerationResult } from "#/server/services/generation";

const ALL = "__all__";
const LIVE_ID = "__live__";

export function GenerationTab({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"auto" | "rule" | "llm">("auto");
  const [requirementId, setRequirementId] = useState<string>(ALL);
  const [profileId, setProfileId] = useState<string>(ALL);
  const [jobId, setJobId] = useState<string | null>(null);
  const [selectedGenerationId, setSelectedGenerationId] =
    useState<string>(LIVE_ID);
  const [lastResult, setLastResult] = useState<GenerationResult | null>(null);
  const job = useJobPoller(jobId);
  const finishedRef = useRef<string | null>(null);

  const requirementsQuery = useQuery(
    trpc.requirements.list.queryOptions({ pid: projectId }),
  );
  const profilesQuery = useQuery(trpc.settings.listProfiles.queryOptions());
  const gapsQuery = useQuery(
    trpc.generation.coverageGaps.queryOptions({ pid: projectId }),
  );
  const versionsEnabled = requirementId !== ALL;
  const versionsQuery = useQuery(
    trpc.generation.versions.queryOptions(
      { rid: versionsEnabled ? requirementId : "", limit: 50 },
      { enabled: versionsEnabled },
    ),
  );
  const versionDetailQuery = useQuery(
    trpc.generation.version.queryOptions(
      {
        rid: versionsEnabled ? requirementId : "",
        generationId: selectedGenerationId,
      },
      {
        enabled:
          versionsEnabled &&
          selectedGenerationId !== LIVE_ID &&
          Boolean(selectedGenerationId),
      },
    ),
  );

  const requirements = requirementsQuery.data ?? [];
  const profiles = (profilesQuery.data ?? []).filter((p) => p.kind === "text");
  const gaps = gapsQuery.data ?? { transitionGaps: [], endpointGaps: [] };
  const versions = useMemo(
    () => (versionsEnabled ? (versionsQuery.data ?? []) : []),
    [versionsEnabled, versionsQuery.data],
  );

  useEffect(() => {
    if (job.isTerminal && jobId && finishedRef.current !== jobId) {
      finishedRef.current = jobId;
      if (job.isFailed) {
        toast.error(job.error ?? "Generation failed");
      } else {
        toast.success("Case generation complete");
        const result = job.job?.result as GenerationResult | undefined;
        if (result) setLastResult(result);
      }
      invalidate();
      setJobId(null);
    }
  }, [job.isTerminal, job.isFailed, job.error, jobId]);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: trpc.testcases.list.queryKey() });
    queryClient.invalidateQueries({
      queryKey: trpc.generation.coverageGaps.queryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: trpc.generation.versions.queryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: trpc.requirements.list.queryKey(),
    });
    queryClient.invalidateQueries({ queryKey: trpc.stats.overview.queryKey() });
  }

  const startMutation = useMutation(
    trpc.generation.start.mutationOptions({
      onSuccess: (result) => {
        setJobId(result.jobId);
        setLastResult(null);
        toast.info("Generating cases…");
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const clearProjectMutation = useMutation(
    trpc.testcases.clearGeneratedForProject.mutationOptions({
      onSuccess: () => {
        toast.success("Cleared generated cases");
        invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const running = startMutation.isPending || job.isRunning;
  const transitionGaps = gaps.transitionGaps;
  const versionDetail =
    selectedGenerationId !== LIVE_ID ? (versionDetailQuery.data ?? null) : null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Generate test cases</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
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
                  <SelectItem value="auto">Auto (rule + AI)</SelectItem>
                  <SelectItem value="rule">Rule only</SelectItem>
                  <SelectItem value="llm">AI only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Requirement version</Label>
              <Select
                value={requirementId}
                onValueChange={(v) => {
                  if (v === null) return;
                  setRequirementId(v);
                  setSelectedGenerationId(LIVE_ID);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All / none" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All requirements</SelectItem>
                  {requirements.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.version} · {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>LLM profile {mode === "rule" ? "(unused)" : ""}</Label>
              <Select
                value={profileId}
                onValueChange={(v) => v !== null && setProfileId(v)}
                disabled={mode === "rule"}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Default profile" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Default</SelectItem>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} · {p.model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground text-sm">
              {mode === "rule"
                ? "Deterministic generation from code facts only. No LLM calls."
                : mode === "llm"
                  ? "LLM generation grounded in code facts. Requires a configured text profile."
                  : "Combines deterministic rules with AI-generated cases, then validates them."}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => clearProjectMutation.mutate({ pid: projectId })}
                disabled={clearProjectMutation.isPending || running}
              >
                <Eraser className="size-4" aria-hidden />
                Clear generated
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  startMutation.mutate({
                    pid: projectId,
                    mode,
                    requirementId: requirementId === ALL ? null : requirementId,
                    profileId: profileId === ALL ? null : profileId,
                  })
                }
                disabled={running}
              >
                <Sparkles className="size-4" aria-hidden />
                {running ? "Generating…" : "Generate cases"}
              </Button>
            </div>
          </div>

          {running && job.progress !== null ? (
            <div className="flex items-center gap-3">
              <Progress value={job.progress * 100} className="flex-1" />
              <span className="text-muted-foreground text-xs">
                {job.message}
              </span>
            </div>
          ) : null}

          {lastResult && !running ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge
                  tone={lastResult.fallback ? "warning" : "success"}
                  label={`Kept ${lastResult.kept}/${lastResult.generated}`}
                />
                <Badge variant="outline">
                  mode: {lastResult.mode}
                  {lastResult.requestedMode !== lastResult.mode
                    ? ` (requested ${lastResult.requestedMode})`
                    : ""}
                </Badge>
                <Badge variant="outline">
                  AI {lastResult.llmCaseCount} · rule {lastResult.ruleCaseCount}
                </Badge>
                {lastResult.dropped > 0 ? (
                  <Badge variant="outline">dropped {lastResult.dropped}</Badge>
                ) : null}
              </div>
              {lastResult.fallback ? (
                <Alert variant="destructive">
                  <AlertTriangle className="size-4" aria-hidden />
                  <AlertTitle>Generation fell back to rules</AlertTitle>
                  <AlertDescription>
                    {lastResult.fallbackReason}
                  </AlertDescription>
                </Alert>
              ) : null}
              {lastResult.preservedExisting ? (
                <Alert>
                  <AlertTriangle className="size-4" aria-hidden />
                  <AlertTitle>Existing cases preserved</AlertTitle>
                  <AlertDescription>
                    This round produced 0 usable cases, so the previously
                    generated cases were kept instead of being cleared.
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {versionsEnabled ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="text-muted-foreground size-4" aria-hidden />
              Generation versions
            </CardTitle>
            <Select
              value={selectedGenerationId}
              onValueChange={(v) => v !== null && setSelectedGenerationId(v)}
            >
              <SelectTrigger className="w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={LIVE_ID}>Live cases (current)</SelectItem>
                {versions.map((version) => (
                  <SelectItem key={version.id} value={version.id}>
                    {version.createdAt
                      ? timeAgo(version.createdAt)
                      : version.id.slice(0, 8)}
                    {" · "}
                    {version.mode} · {version.caseCount} cases
                    {version.isLatest ? " · latest" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardHeader>
          <CardContent>
            {selectedGenerationId === LIVE_ID ? (
              <p className="text-muted-foreground text-sm">
                Showing live cases. Every completed generation is archived here
                as a read-only version; pick one from the dropdown to inspect
                its snapshot.
                {versions.length === 0 && !versionsQuery.isLoading
                  ? " No archived versions yet for this requirement."
                  : ""}
              </p>
            ) : versionDetailQuery.isLoading ? (
              <p className="text-muted-foreground text-sm">Loading version…</p>
            ) : versionDetail ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge
                    tone={versionDetail.isLatest ? "success" : "info"}
                    label={
                      versionDetail.mode === "legacy"
                        ? "Legacy archive (read-only)"
                        : versionDetail.isLatest
                          ? "Latest version (read-only)"
                          : "Historical version (read-only)"
                    }
                  />
                  <Badge variant="outline">mode: {versionDetail.mode}</Badge>
                  <Badge variant="outline">
                    {versionDetail.caseCount} cases
                  </Badge>
                  {versionDetail.summary?.fallback ? (
                    <Badge variant="outline" className="text-warning">
                      fallback
                    </Badge>
                  ) : null}
                  {versionDetail.createdAt ? (
                    <span className="text-muted-foreground text-xs">
                      {new Date(versionDetail.createdAt).toLocaleString()}
                    </span>
                  ) : null}
                </div>
                {typeof versionDetail.summary?.fallbackReason === "string" &&
                versionDetail.summary.fallbackReason ? (
                  <Alert variant="destructive">
                    <AlertTriangle className="size-4" aria-hidden />
                    <AlertTitle>This version fell back to rules</AlertTitle>
                    <AlertDescription>
                      {String(versionDetail.summary.fallbackReason)}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {typeof versionDetail.summary?.note === "string" ? (
                  <p className="text-muted-foreground text-xs">
                    {versionDetail.summary.note}
                  </p>
                ) : null}
                <div className="border-border/60 overflow-hidden rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableHead className="w-10">#</TableHead>
                        <TableHead>Title</TableHead>
                        <TableHead className="hidden w-24 md:table-cell">
                          Type
                        </TableHead>
                        <TableHead className="w-20">Priority</TableHead>
                        <TableHead className="hidden w-20 md:table-cell">
                          Source
                        </TableHead>
                        <TableHead className="hidden w-24 lg:table-cell">
                          Quality
                        </TableHead>
                        <TableHead className="hidden lg:table-cell">
                          Expected results
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {versionDetail.cases.map((snapshotCase, index) => (
                        <TableRow key={String(snapshotCase.id ?? index)}>
                          <TableCell className="text-muted-foreground text-xs tabular-nums">
                            {index + 1}
                          </TableCell>
                          <TableCell className="max-w-64 truncate font-medium">
                            {String(snapshotCase.title ?? "")}
                          </TableCell>
                          <TableCell className="hidden text-xs md:table-cell">
                            {String(snapshotCase.type ?? "")}
                          </TableCell>
                          <TableCell className="text-xs">
                            {String(snapshotCase.priority ?? "")}
                          </TableCell>
                          <TableCell className="hidden text-xs md:table-cell">
                            {snapshotCase.source === "ai"
                              ? "AI"
                              : String(snapshotCase.source ?? "")}
                          </TableCell>
                          <TableCell className="hidden text-xs tabular-nums lg:table-cell">
                            {snapshotCase.qualityScore == null
                              ? "—"
                              : String(snapshotCase.qualityScore)}
                          </TableCell>
                          <TableCell className="text-muted-foreground hidden max-w-72 truncate text-xs lg:table-cell">
                            {Array.isArray(snapshotCase.expectedResults)
                              ? snapshotCase.expectedResults.join(" / ")
                              : ""}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                Version not found.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Target className="text-muted-foreground size-4" aria-hidden />
            Coverage gaps
          </CardTitle>
        </CardHeader>
        <CardContent>
          {gapsQuery.isLoading ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : transitionGaps.length === 0 ? (
            <EmptyState
              icon={Target}
              title="No state-transition gaps"
              description="Every verified state transition is covered by at least one case."
              className="py-8"
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {transitionGaps.map((gap, i) => (
                <li
                  key={i}
                  className="border-border/60 bg-muted/30 flex items-center gap-3 rounded-lg border px-3 py-2"
                >
                  <StatusBadge tone="warning" label="Uncovered" />
                  <span className="font-mono text-xs">
                    {gap.from} → {gap.to}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    ({gap.trigger})
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default GenerationTab;
