import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, RefreshCw, Sparkles, Workflow } from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { PageHeader } from "#/components/PageHeader";
import { EmptyState } from "#/components/EmptyState";
import { ProjectPicker } from "#/components/ProjectPicker";
import { QuickStartDialog } from "#/components/QuickStartDialog";
import { StatusBadge } from "#/components/StatusBadge";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Progress } from "#/components/ui/progress";
import { Skeleton } from "#/components/ui/skeleton";
import { Switch } from "#/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { STAGE_LABELS, WORKFLOW_STATUS_META, meta } from "#/lib/enums";
import { timeAgo } from "#/lib/format";
import { cn } from "#/lib/utils";

import type { RunDict } from "#/server/services/workflows";

const ALL = "__all__";

interface PipelineSearch {
  pid?: string;
}

export const Route = createFileRoute("/pipeline/")({
  component: PipelinePage,
  validateSearch: (search: Record<string, unknown>): PipelineSearch => ({
    pid: typeof search.pid === "string" ? search.pid : undefined,
  }),
});

function PipelinePage() {
  const { pid } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [createOpen, setCreateOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <PageHeader
        title="Pipeline"
        description="End-to-end runs that analyze code, extract points, generate and review cases, then execute them."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setQuickOpen(true)}>
              <Sparkles className="size-4" aria-hidden />
              Quick start
            </Button>
            <ProjectPicker
              value={pid ?? null}
              onChange={(projectId) =>
                navigate({ search: { pid: projectId }, replace: true })
              }
            />
            <Button onClick={() => setCreateOpen(true)} disabled={!pid}>
              <Plus className="size-4" aria-hidden />
              New run
            </Button>
          </div>
        }
      />

      {pid ? (
        <RunsList key={pid} projectId={pid} />
      ) : (
        <EmptyState
          icon={Workflow}
          title="Choose a project"
          description="Select a project to view and start pipeline runs, or create a project and requirement in one step."
          action={
            <Button onClick={() => setQuickOpen(true)}>
              <Sparkles className="size-4" aria-hidden />
              Quick start
            </Button>
          }
        />
      )}

      {pid ? (
        <CreateRunDialog
          key={`create-${pid}`}
          open={createOpen}
          onOpenChange={setCreateOpen}
          projectId={pid}
        />
      ) : null}

      <QuickStartDialog
        open={quickOpen}
        onOpenChange={setQuickOpen}
        onCreated={({ projectId }) => navigate({ search: { pid: projectId } })}
      />
    </div>
  );
}

function RunsList({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const { data, isLoading, isFetching, refetch } = useQuery(
    trpc.workflows.list.queryOptions({ pid: projectId, limit: 30 }),
  );
  const runs = data ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end">
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh"
          onClick={() => refetch()}
        >
          <RefreshCw
            className={cn("size-4", isFetching && "animate-spin")}
            aria-hidden
          />
        </Button>
      </div>
      {isLoading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No pipeline runs"
          description="Start a run to generate, review, and execute test cases end to end."
        />
      ) : (
        runs.map((run) => <RunCard key={run.id} run={run} />)
      )}
    </div>
  );
}

function RunCard({ run }: { run: RunDict }) {
  const statusMeta = meta(WORKFLOW_STATUS_META, run.status);
  const stageLabel =
    run.currentStageLabel ??
    (run.currentStage ? STAGE_LABELS[run.currentStage] : null);

  return (
    <Card className="hover:border-primary/40 transition-colors">
      <CardContent className="flex items-center gap-4 p-4">
        <div className="min-w-0 flex-1">
          <Link
            to="/pipeline/$runId"
            params={{ runId: run.id }}
            className="block truncate text-sm font-semibold hover:underline"
          >
            {run.requirementName ?? "Pipeline run"}
            {run.requirementVersion ? ` · ${run.requirementVersion}` : ""}
          </Link>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {run.mode} mode · started {timeAgo(run.createdAt)}
            {stageLabel && run.status === "running" ? ` · ${stageLabel}` : ""}
          </p>
        </div>
        {run.status === "running" ? <RunProgress runId={run.id} /> : null}
        <StatusBadge
          tone={statusMeta.tone}
          label={statusMeta.label}
          dot
          pulse={run.status === "running"}
        />
      </CardContent>
    </Card>
  );
}

function RunProgress({ runId }: { runId: string }) {
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.workflows.detail.queryOptions({ runId }),
    refetchInterval: 2000,
  });
  const detail = data as { stages?: { status: string }[] } | undefined;
  const stages = detail?.stages ?? [];
  const done = stages.filter(
    (s) =>
      s.status === "completed" ||
      s.status === "failed" ||
      s.status === "skipped",
  ).length;
  const progress = stages.length > 0 ? done / stages.length : 0;
  return <Progress value={progress * 100} className="h-1.5 w-24" />;
}

function CreateRunDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: Route.fullPath });
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [requirementId, setRequirementId] = useState<string>("");
  const [mode, setMode] = useState<"auto" | "rule" | "llm">("auto");
  const [targetUrl, setTargetUrl] = useState("");
  const [testPointProfileId, setTestPointProfileId] = useState<string>(ALL);
  const [caseProfileId, setCaseProfileId] = useState<string>(ALL);
  const [maxRevisions, setMaxRevisions] = useState(2);
  const [maxCases, setMaxCases] = useState(20);
  const [autoExecute, setAutoExecute] = useState(true);
  const [reviewEnabled, setReviewEnabled] = useState(true);
  const [analyzeEnabled, setAnalyzeEnabled] = useState(true);
  const [analyzeCode, setAnalyzeCode] = useState(true);
  const [reanalyzeCode, setReanalyzeCode] = useState(false);
  const [reuseExistingCases, setReuseExistingCases] = useState(true);
  const [reanalyzePoints, setReanalyzePoints] = useState(false);

  const { data } = useQuery(
    trpc.requirements.list.queryOptions({ pid: projectId }),
  );
  const requirements = data ?? [];
  const profilesQuery = useQuery(trpc.settings.listProfiles.queryOptions());
  const textProfiles = (profilesQuery.data ?? []).filter(
    (profile) => profile.kind === "text",
  );

  const createMutation = useMutation(
    trpc.workflows.create.mutationOptions({
      onSuccess: (result) => {
        toast.success("Pipeline run created");
        queryClient.invalidateQueries({
          queryKey: trpc.workflows.list.queryKey(),
        });
        onOpenChange(false);
        const runId = (result as { run?: { id: string } }).run?.id;
        if (runId) navigate({ to: "/pipeline/$runId", params: { runId } });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  function start() {
    createMutation.mutate({
      pid: projectId,
      requirementId,
      mode,
      autoExecute,
      reviewEnabled,
      analyzeEnabled,
      analyzeCode,
      reanalyzeCode,
      reuseExistingCases,
      reanalyzePoints,
      maxRevisions,
      maxCases,
      targetUrl: targetUrl.trim() || null,
      testPointLlmProfileId:
        testPointProfileId === ALL ? null : testPointProfileId,
      caseLlmProfileId: caseProfileId === ALL ? null : caseProfileId,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New pipeline run</DialogTitle>
          <DialogDescription>
            Runs the full pipeline for a requirement version: analysis, test
            points, generation, review, and execution.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="space-y-2">
            <Label>Requirement version</Label>
            <Select
              value={requirementId}
              onValueChange={(v) => v !== null && setRequirementId(v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a requirement" />
              </SelectTrigger>
              <SelectContent>
                {requirements.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.version} · {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="run-target">Target URL</Label>
            <Input
              id="run-target"
              value={targetUrl}
              placeholder="Leave empty to use the project target URL"
              className="font-mono text-xs"
              onChange={(e) => setTargetUrl(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Generation mode</Label>
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
              <Label>Test point LLM</Label>
              <Select
                value={testPointProfileId}
                onValueChange={(v) => v !== null && setTestPointProfileId(v)}
                disabled={mode === "rule"}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Default text profile" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Default</SelectItem>
                  {textProfiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name} · {profile.model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Case LLM</Label>
            <Select
              value={caseProfileId}
              onValueChange={(v) => v !== null && setCaseProfileId(v)}
              disabled={mode === "rule"}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Default text profile" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Default</SelectItem>
                {textProfiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name} · {profile.model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="border-border/60 flex items-center justify-between rounded-lg border px-3 py-2">
            <div>
              <p className="text-sm font-medium">Execute after review</p>
              <p className="text-muted-foreground text-xs">
                Run approved cases in a browser.
              </p>
            </div>
            <Switch checked={autoExecute} onCheckedChange={setAutoExecute} />
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground self-start"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? "Hide advanced" : "Show advanced"}
          </Button>

          {showAdvanced ? (
            <div className="border-border/60 bg-muted/20 flex flex-col gap-3 rounded-lg border p-3">
              <AdvancedSwitch
                label="Enable case review"
                hint="Deterministic gate plus LLM review and repair rounds."
                checked={reviewEnabled}
                onChange={setReviewEnabled}
              />
              <AdvancedSwitch
                label="Analyze execution results"
                hint="Evidence-driven failure classification after execution."
                checked={analyzeEnabled}
                onChange={setAnalyzeEnabled}
              />
              <AdvancedSwitch
                label="Analyze code when missing"
                hint="Run static analysis if no successful analysis exists."
                checked={analyzeCode}
                onChange={setAnalyzeCode}
              />
              <AdvancedSwitch
                label="Force re-analysis"
                hint="Re-scan the source tree even when an analysis exists."
                checked={reanalyzeCode}
                onChange={setReanalyzeCode}
              />
              <AdvancedSwitch
                label="Reuse existing cases"
                hint="Keep already generated cases instead of regenerating."
                checked={reuseExistingCases}
                onChange={setReuseExistingCases}
              />
              <AdvancedSwitch
                label="Re-extract test points"
                hint="Regenerate test points; forces case regeneration."
                checked={reanalyzePoints}
                onChange={setReanalyzePoints}
              />
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="run-revisions">Repair rounds</Label>
                  <Input
                    id="run-revisions"
                    type="number"
                    min={0}
                    max={2}
                    value={maxRevisions}
                    onChange={(e) =>
                      setMaxRevisions(
                        Math.min(2, Math.max(0, Number(e.target.value) || 0)),
                      )
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="run-maxcases">Case limit</Label>
                  <Input
                    id="run-maxcases"
                    type="number"
                    min={1}
                    max={100}
                    value={maxCases}
                    onChange={(e) =>
                      setMaxCases(
                        Math.min(100, Math.max(1, Number(e.target.value) || 1)),
                      )
                    }
                  />
                </div>
              </div>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={start}
            disabled={createMutation.isPending || !requirementId}
          >
            {createMutation.isPending ? "Starting…" : "Start run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdvancedSwitch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
