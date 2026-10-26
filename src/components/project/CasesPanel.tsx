import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Copy,
  Download,
  ListChecks,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { useJobPoller } from "#/hooks/use-job-poller";
import { EmptyState } from "#/components/EmptyState";
import { StatusBadge } from "#/components/StatusBadge";
import { CaseEditDialog } from "#/components/project/CaseEditDialog";
import { CaseReviewDialog } from "#/components/project/CaseReviewDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Checkbox } from "#/components/ui/checkbox";
import { Progress } from "#/components/ui/progress";
import { Skeleton } from "#/components/ui/skeleton";
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
import {
  CASE_EXECUTION_STATUS_META,
  CASE_SOURCE_META,
  CASE_TYPE_META,
  PRIORITY_META,
  meta,
} from "#/lib/enums";
import { cn } from "#/lib/utils";

import type { CaseReviewResult } from "#/server/services/case-review";
import type { CaseDict } from "#/server/services/testcases";

const ALL = "__all__";

interface CaseFilters {
  requirementId: string;
  type: string;
  priority: string;
  executionStatus: string;
  keyword: string;
}

const DEFAULT_FILTERS: CaseFilters = {
  requirementId: ALL,
  type: ALL,
  priority: ALL,
  executionStatus: ALL,
  keyword: "",
};

export function CasesPanel({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<CaseFilters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runJobId, setRunJobId] = useState<string | null>(null);
  const [runBatchId, setRunBatchId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editCase, setEditCase] = useState<CaseDict | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewResults, setReviewResults] = useState<CaseReviewResult[]>([]);
  const [reviewSummary, setReviewSummary] = useState<{
    total: number;
    reviewed: number;
    problems: number;
  } | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyTarget, setCopyTarget] = useState("");

  const serverFilters = useMemo(
    () => ({
      requirementId:
        filters.requirementId === ALL ? null : filters.requirementId,
      type: filters.type === ALL ? null : filters.type,
      priority: filters.priority === ALL ? null : filters.priority,
      executionStatus:
        filters.executionStatus === ALL ? null : filters.executionStatus,
      keyword: filters.keyword.trim() || null,
    }),
    [filters],
  );

  const casesQuery = useQuery({
    ...trpc.testcases.list.queryOptions({
      pid: projectId,
      filters: serverFilters,
    }),
  });
  const requirementsQuery = useQuery(
    trpc.requirements.list.queryOptions({ pid: projectId }),
  );
  const projectsQuery = useQuery(trpc.projects.list.queryOptions());

  const cases = casesQuery.data ?? [];
  const requirements = (requirementsQuery.data ?? []) as {
    id: string;
    version: string;
    name: string;
  }[];

  const run = useJobPoller(runJobId);

  function invalidateCases() {
    queryClient.invalidateQueries({ queryKey: trpc.testcases.list.queryKey() });
    queryClient.invalidateQueries({
      queryKey: trpc.executions.list.queryKey(),
    });
    queryClient.invalidateQueries({ queryKey: trpc.stats.overview.queryKey() });
  }

  const runSingleMutation = useMutation(
    trpc.executions.runSingle.mutationOptions({
      onSuccess: (data) => {
        if ("jobId" in data && data.jobId) {
          setRunJobId(data.jobId);
          toast.info("Execution started");
        } else {
          invalidateCases();
        }
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const runBatchMutation = useMutation(
    trpc.executions.runBatch.mutationOptions({
      onSuccess: (data) => {
        if ("jobId" in data && data.jobId) {
          setRunJobId(data.jobId);
          setRunBatchId("batchId" in data ? data.batchId : null);
          toast.info(`Batch execution started (${selected.size} cases)`);
        } else {
          invalidateCases();
        }
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const cancelBatchMutation = useMutation(
    trpc.executions.cancelBatch.mutationOptions({
      onSuccess: (data) => {
        if (data.cancelled)
          toast.info("Cancelling batch after the current case");
        else toast.info("Batch already finished");
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const deleteBulkMutation = useMutation(
    trpc.testcases.deleteBulk.mutationOptions({
      onSuccess: async () => {
        toast.success(`Deleted ${selected.size} cases`);
        setSelected(new Set());
        invalidateCases();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const importMutation = useMutation(
    trpc.testcases.importCsv.mutationOptions({
      onSuccess: async () => {
        toast.success("Cases imported");
        invalidateCases();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const aiReviewMutation = useMutation(
    trpc.testcases.aiReview.mutationOptions({
      onSuccess: (result) => {
        setReviewResults(result.results);
        setReviewSummary({
          total: result.total,
          reviewed: result.reviewed,
          problems: result.problems,
        });
        setReviewOpen(true);
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const copyToMutation = useMutation(
    trpc.testcases.copyTo.mutationOptions({
      onSuccess: () => {
        toast.success(`Copied ${selected.size} case(s)`);
        setSelected(new Set());
        setCopyOpen(false);
        setCopyTarget("");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  // Finish polling a run job exactly once, then refresh.
  const finishedRunRef = useRef<string | null>(null);
  useEffect(() => {
    if (run.isTerminal && runJobId && finishedRunRef.current !== runJobId) {
      finishedRunRef.current = runJobId;
      if (run.isFailed) toast.error(run.error ?? "Execution failed");
      else toast.success("Execution finished");
      invalidateCases();
      setRunJobId(null);
      setRunBatchId(null);
    }
  }, [run.isTerminal, run.isFailed, run.error, runJobId]);

  const allSelected = cases.length > 0 && selected.size === cases.length;
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(cases.map((c) => c.id)));
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function runCase(cid: string) {
    runSingleMutation.mutate({ pid: projectId, cid });
  }
  function runSelected() {
    if (selected.size === 0) return;
    runBatchMutation.mutate({ pid: projectId, cids: Array.from(selected) });
  }
  function deleteSelected() {
    if (selected.size === 0) return;
    deleteBulkMutation.mutate({ cids: Array.from(selected) });
  }
  function reviewSelected() {
    if (selected.size === 0) return;
    aiReviewMutation.mutate({ pid: projectId, cids: Array.from(selected) });
  }
  function copySelected() {
    if (selected.size === 0 || !copyTarget) return;
    copyToMutation.mutate({
      sourcePid: projectId,
      targetPid: copyTarget,
      cids: Array.from(selected),
    });
  }

  async function exportCsv() {
    try {
      const csv = await queryClient.fetchQuery(
        trpc.testcases.exportCsv.queryOptions({ pid: projectId }),
      );
      const blob = new Blob([String(csv)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `cases-${projectId.slice(0, 8)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed");
    }
  }

  function onImportFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      if (!text.trim()) {
        toast.error("The CSV file is empty");
        return;
      }
      importMutation.mutate({ pid: projectId, csv: text });
    };
    reader.readAsText(file);
  }

  const running =
    runSingleMutation.isPending || runBatchMutation.isPending || run.isRunning;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={filters.requirementId}
          onValueChange={(v) =>
            setFilters((f) => ({ ...f, requirementId: v ?? f.requirementId }))
          }
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Requirement" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All requirements</SelectItem>
            {requirements.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.version} · {r.name}
              </SelectItem>
            ))}
            <SelectItem value="__none__">No requirement</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.type}
          onValueChange={(v) =>
            setFilters((f) => ({ ...f, type: v ?? f.type }))
          }
        >
          <SelectTrigger className="w-32">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {Object.entries(CASE_TYPE_META).map(([code, m]) => (
              <SelectItem key={code} value={code}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.priority}
          onValueChange={(v) =>
            setFilters((f) => ({ ...f, priority: v ?? f.priority }))
          }
        >
          <SelectTrigger className="w-28">
            <SelectValue placeholder="Priority" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All</SelectItem>
            {Object.entries(PRIORITY_META).map(([code, m]) => (
              <SelectItem key={code} value={code}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.executionStatus}
          onValueChange={(v) =>
            setFilters((f) => ({
              ...f,
              executionStatus: v ?? f.executionStatus,
            }))
          }
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {Object.entries(CASE_EXECUTION_STATUS_META).map(([code, m]) => (
              <SelectItem key={code} value={code}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative min-w-44 flex-1">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            value={filters.keyword}
            placeholder="Filter by title…"
            className="pl-9"
            onChange={(e) =>
              setFilters((f) => ({ ...f, keyword: e.target.value }))
            }
          />
        </div>

        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh"
          onClick={() => casesQuery.refetch()}
        >
          <RefreshCw
            className={cn("size-4", casesQuery.isFetching && "animate-spin")}
            aria-hidden
          />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="size-4" aria-hidden />
          Import CSV
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImportFile(file);
            e.target.value = "";
          }}
        />
        <Button variant="outline" size="sm" onClick={exportCsv}>
          <Download className="size-4" aria-hidden />
          Export CSV
        </Button>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" aria-hidden />
          New case
        </Button>

        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 ? (
            <>
              <Button size="sm" onClick={runSelected} disabled={running}>
                <Play className="size-4" aria-hidden />
                Run {selected.size}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={reviewSelected}
                disabled={aiReviewMutation.isPending}
              >
                <Sparkles className="size-4" aria-hidden />
                {aiReviewMutation.isPending
                  ? "Reviewing…"
                  : `AI review ${selected.size}`}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCopyOpen(true)}
                disabled={copyToMutation.isPending}
              >
                <Copy className="size-4" aria-hidden />
                Copy to
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={deleteSelected}
                disabled={deleteBulkMutation.isPending}
              >
                <Trash2 className="size-4" aria-hidden />
                Delete {selected.size}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              onClick={() =>
                runBatchMutation.mutate({
                  pid: projectId,
                  cids: cases.map((c) => c.id),
                })
              }
              disabled={running || cases.length === 0}
            >
              <Play className="size-4" aria-hidden />
              Run all
            </Button>
          )}
        </div>
      </div>

      {run.isRunning && run.progress !== null ? (
        <div className="border-border/60 bg-muted/40 flex items-center gap-3 rounded-lg border px-4 py-3">
          <Progress value={run.progress * 100} className="flex-1" />
          <span className="text-muted-foreground text-xs tabular-nums">
            {run.job?.current ?? 0}/{run.job?.total ?? 0}
          </span>
          {runBatchId ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                cancelBatchMutation.mutate({ batchId: runBatchId })
              }
              disabled={cancelBatchMutation.isPending}
            >
              <X className="size-4" aria-hidden />
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}

      {casesQuery.isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : cases.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No test cases"
          description="Generate cases from a requirement, import a CSV, or create one manually."
        />
      ) : (
        <div className="border-border/70 overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={toggleAll}
                    aria-label="Select all cases"
                  />
                </TableHead>
                <TableHead className="w-24">ID</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="hidden md:table-cell">Module</TableHead>
                <TableHead className="w-24">Type</TableHead>
                <TableHead className="w-20">Priority</TableHead>
                <TableHead className="hidden w-20 lg:table-cell">
                  Source
                </TableHead>
                <TableHead className="w-32">Status</TableHead>
                <TableHead className="w-20 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cases.map((kase) => {
                const typeMeta = meta(CASE_TYPE_META, kase.type);
                const priorityMeta = meta(PRIORITY_META, kase.priority);
                const sourceMeta = meta(CASE_SOURCE_META, kase.source);
                const statusMeta = meta(
                  CASE_EXECUTION_STATUS_META,
                  kase.executionStatus,
                );
                return (
                  <TableRow
                    key={kase.id}
                    data-state={selected.has(kase.id) ? "selected" : undefined}
                  >
                    <TableCell>
                      <Checkbox
                        checked={selected.has(kase.id)}
                        onCheckedChange={() => toggleOne(kase.id)}
                        aria-label={`Select ${kase.title}`}
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      {kase.projectSeq}
                    </TableCell>
                    <TableCell className="max-w-64">
                      <Link
                        to="/projects/$projectId/cases/$caseId"
                        params={{ projectId, caseId: kase.id }}
                        className="line-clamp-2 font-medium hover:underline"
                        title={kase.title}
                      >
                        {kase.title}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden max-w-32 truncate md:table-cell">
                      {kase.module}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        tone={typeMeta.tone}
                        label={typeMeta.label}
                      />
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        tone={priorityMeta.tone}
                        label={priorityMeta.label}
                      />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <StatusBadge
                        tone={sourceMeta.tone}
                        label={sourceMeta.label}
                      />
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        tone={statusMeta.tone}
                        label={statusMeta.label}
                        dot
                        pulse={kase.executionStatus === "running"}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="Run case"
                          onClick={() => runCase(kase.id)}
                          disabled={running}
                        >
                          <Play className="size-3.5" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="Edit case"
                          onClick={() => setEditCase(kase)}
                        >
                          <Pencil className="size-3.5" aria-hidden />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="text-muted-foreground flex items-center justify-between text-xs">
        <span>
          {cases.length} case{cases.length === 1 ? "" : "s"}
          {selected.size > 0 ? ` · ${selected.size} selected` : ""}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          render={
            <Link
              to="/projects/$projectId"
              params={{ projectId }}
              search={{ tab: "generation" }}
            />
          }
          nativeButton={false}
        >
          <Plus className="size-3.5" aria-hidden />
          Generate cases
        </Button>
      </div>

      <CaseEditDialog
        open={createOpen || editCase !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            setEditCase(null);
          }
        }}
        projectId={projectId}
        caseData={editCase}
      />

      <CaseReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        projectId={projectId}
        results={reviewResults}
        summary={reviewSummary}
      />

      <Dialog open={copyOpen} onOpenChange={setCopyOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Copy cases to another project</DialogTitle>
            <DialogDescription>
              {selected.size} selected case(s) will be duplicated into the
              target project with fresh ids.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Select
              value={copyTarget}
              onValueChange={(v) => v !== null && setCopyTarget(v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a target project" />
              </SelectTrigger>
              <SelectContent>
                {(projectsQuery.data ?? [])
                  .filter((proj) => proj.id !== projectId)
                  .map((proj) => (
                    <SelectItem key={proj.id} value={proj.id}>
                      {proj.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCopyOpen(false)}
              disabled={copyToMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={copySelected}
              disabled={!copyTarget || copyToMutation.isPending}
            >
              {copyToMutation.isPending ? "Copying…" : "Copy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default CasesPanel;
