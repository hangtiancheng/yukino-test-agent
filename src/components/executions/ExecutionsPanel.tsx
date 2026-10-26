import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  FileText,
  PlayCircle,
  RefreshCw,
  RotateCcw,
} from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { useJobPoller } from "#/hooks/use-job-poller";
import { EmptyState } from "#/components/EmptyState";
import { StatusBadge } from "#/components/StatusBadge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
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
  AI_REVIEW_VERDICT_META,
  CASE_EXECUTION_STATUS_META,
  meta,
} from "#/lib/enums";
import { formatDuration, timeAgo } from "#/lib/format";
import { cn } from "#/lib/utils";

import type { ExecutionListItem } from "#/server/services/executions";

const ALL = "__all__";
const NONE = "__none__";

export function ExecutionsPanel({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>(ALL);
  const [requirementId, setRequirementId] = useState<string>(ALL);
  const [groupBy, setGroupBy] = useState<"case" | "execution">("case");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewJobId, setReviewJobId] = useState<string | null>(null);
  const [rerunTarget, setRerunTarget] = useState<ExecutionListItem | null>(
    null,
  );
  const [rerunJobId, setRerunJobId] = useState<string | null>(null);

  const { data, isLoading, isFetching, refetch } = useQuery(
    trpc.executions.list.queryOptions({
      pid: projectId,
      status: status === ALL ? null : status,
      requirementId:
        requirementId === ALL
          ? null
          : requirementId === NONE
            ? NONE
            : requirementId,
      groupBy,
      page,
      pageSize,
    }),
  );
  const requirementsQuery = useQuery(
    trpc.requirements.list.queryOptions({ pid: projectId }),
  );
  const executions = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const requirements = (requirementsQuery.data ?? []) as {
    id: string;
    version: string;
    name: string;
  }[];

  const reviewJob = useJobPoller(reviewJobId);

  function invalidate() {
    queryClient.invalidateQueries({
      queryKey: trpc.executions.list.queryKey(),
    });
    queryClient.invalidateQueries({ queryKey: trpc.executions.get.queryKey() });
    queryClient.invalidateQueries({
      queryKey: trpc.executions.forCase.queryKey(),
    });
  }

  const finishedReviewRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      reviewJob.isTerminal &&
      reviewJobId &&
      finishedReviewRef.current !== reviewJobId
    ) {
      finishedReviewRef.current = reviewJobId;
      if (reviewJob.isFailed)
        toast.error(reviewJob.error ?? "AI review failed");
      else toast.success("AI review finished");
      setSelected(new Set());
      invalidate();
      setReviewJobId(null);
    }
  }, [reviewJob.isTerminal, reviewJob.isFailed, reviewJob.error, reviewJobId]);

  const rerunJob = useJobPoller(rerunJobId);
  const finishedRerunRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      rerunJob.isTerminal &&
      rerunJobId &&
      finishedRerunRef.current !== rerunJobId
    ) {
      finishedRerunRef.current = rerunJobId;
      if (rerunJob.isFailed) {
        toast.error(rerunJob.error ?? "Re-run failed");
      } else {
        const result = rerunJob.job?.result as
          | { status?: string; passedSteps?: number; totalSteps?: number }
          | undefined;
        toast.success(
          result
            ? `Re-run finished: ${result.status} (${result.passedSteps ?? 0}/${result.totalSteps ?? 0} steps)`
            : "Re-run finished",
        );
      }
      invalidate();
      setRerunJobId(null);
    }
  }, [
    rerunJob.isTerminal,
    rerunJob.isFailed,
    rerunJob.error,
    rerunJob.job,
    rerunJobId,
  ]);

  const batchReviewMutation = useMutation(
    trpc.executions.batchLlmReview.mutationOptions({
      onSuccess: (result) => {
        setReviewJobId(result.jobId);
        toast.info(`Reviewing ${selected.size} execution(s)…`);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const rerunMutation = useMutation(
    trpc.executions.runSingle.mutationOptions({
      onSuccess: (result) => {
        setRerunJobId(result.jobId);
        toast.info("Execution started…");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const allSelected =
    executions.length > 0 && selected.size === executions.length;
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(executions.map((e) => e.id)));
  }

  const reviewing = batchReviewMutation.isPending || reviewJob.isRunning;
  const rerunBusy = rerunMutation.isPending || rerunJob.isRunning;
  const reportUrl = `/api/report/project/${projectId}${
    requirementId !== ALL && requirementId !== NONE
      ? `?requirementId=${encodeURIComponent(requirementId)}`
      : ""
  }`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={requirementId}
          onValueChange={(v) => {
            if (v === null) return;
            setRequirementId(v);
            setPage(1);
          }}
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
            <SelectItem value={NONE}>No requirement</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={status}
          onValueChange={(v) => {
            if (v === null) return;
            setStatus(v);
            setPage(1);
          }}
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

        <Select
          value={groupBy}
          onValueChange={(v) => {
            setGroupBy(v as typeof groupBy);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="case">Latest per case</SelectItem>
            <SelectItem value="execution">All runs</SelectItem>
          </SelectContent>
        </Select>

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

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {selected.size > 0 ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                batchReviewMutation.mutate({ eids: Array.from(selected) })
              }
              disabled={reviewing}
            >
              <Bot className="size-4" aria-hidden />
              {reviewing ? "Reviewing…" : `AI review (${selected.size})`}
            </Button>
          ) : null}
          <Button
            render={<a href={reportUrl} target="_blank" rel="noreferrer" />}
            nativeButton={false}
            size="sm"
            variant="outline"
          >
            <FileText className="size-4" aria-hidden />
            Report
          </Button>
        </div>
      </div>

      {reviewJob.isRunning && reviewJob.progress !== null ? (
        <div className="flex items-center gap-3">
          <Progress value={reviewJob.progress * 100} className="flex-1" />
          <span className="text-muted-foreground text-xs">
            {reviewJob.message}
          </span>
        </div>
      ) : null}

      {isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : executions.length === 0 ? (
        <EmptyState
          icon={PlayCircle}
          title="No executions"
          description="Run a test case to see its browser execution recorded here."
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
                    aria-label="Select all"
                  />
                </TableHead>
                <TableHead className="w-28">ID</TableHead>
                <TableHead>Test case</TableHead>
                <TableHead className="hidden md:table-cell">
                  Requirement
                </TableHead>
                {groupBy === "case" ? (
                  <TableHead className="hidden w-20 lg:table-cell">
                    Runs
                  </TableHead>
                ) : null}
                <TableHead className="w-24">Progress</TableHead>
                <TableHead className="w-24">Duration</TableHead>
                <TableHead className="w-32">Status</TableHead>
                <TableHead className="hidden w-32 xl:table-cell">
                  AI review
                </TableHead>
                <TableHead className="hidden w-28 lg:table-cell">
                  When
                </TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {executions.map((execution) => (
                <ExecutionRow
                  key={execution.id}
                  execution={execution}
                  groupBy={groupBy}
                  selected={selected.has(execution.id)}
                  onToggle={() => toggleOne(execution.id)}
                  rerunBusy={rerunBusy}
                  onRerun={() => setRerunTarget(execution)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="text-muted-foreground flex items-center justify-between text-xs">
        <span>
          {total} record{total === 1 ? "" : "s"}
          {selected.size > 0 ? ` · ${selected.size} selected` : ""}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Previous page"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <span className="px-1 tabular-nums">
            Page {page} / {totalPages}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Next page"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      <AlertDialog
        open={rerunTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRerunTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-run this case?</AlertDialogTitle>
            <AlertDialogDescription>
              A new execution record will be created for “
              {rerunTarget?.testCaseTitle}”. The original record is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (rerunTarget) {
                  rerunMutation.mutate({
                    pid: projectId,
                    cid: rerunTarget.testCaseId,
                    targetUrl: rerunTarget.targetUrl,
                  });
                }
                setRerunTarget(null);
              }}
            >
              Start execution
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ExecutionRow({
  execution,
  groupBy,
  selected,
  onToggle,
  rerunBusy,
  onRerun,
}: {
  execution: ExecutionListItem;
  groupBy: "case" | "execution";
  selected: boolean;
  onToggle: () => void;
  rerunBusy: boolean;
  onRerun: () => void;
}) {
  const statusMeta = meta(CASE_EXECUTION_STATUS_META, execution.status);
  const reviewMeta = execution.review
    ? meta(AI_REVIEW_VERDICT_META, execution.review.verdict)
    : null;
  const progress =
    execution.totalSteps > 0 ? execution.passedSteps / execution.totalSteps : 0;

  return (
    <TableRow data-state={selected ? "selected" : undefined}>
      <TableCell>
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          aria-label={`Select ${execution.testCaseTitle}`}
        />
      </TableCell>
      <TableCell className="text-muted-foreground font-mono text-xs">
        <Link
          to="/executions/$executionId"
          params={{ executionId: execution.id }}
          className="hover:underline"
        >
          {execution.id.slice(0, 10)}
        </Link>
      </TableCell>
      <TableCell className="max-w-56">
        <Link
          to="/executions/$executionId"
          params={{ executionId: execution.id }}
          className="line-clamp-1 font-medium hover:underline"
          title={execution.testCaseTitle}
        >
          {execution.testCaseTitle}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground hidden truncate text-xs md:table-cell">
        {execution.requirementVersion ?? "—"}
      </TableCell>
      {groupBy === "case" ? (
        <TableCell className="text-muted-foreground hidden text-xs tabular-nums lg:table-cell">
          {execution.executionCount ?? 1}
        </TableCell>
      ) : null}
      <TableCell>
        <div className="flex items-center gap-2">
          <Progress value={progress * 100} className="h-1.5 w-12" />
          <span className="text-muted-foreground text-xs tabular-nums">
            {execution.passedSteps}/{execution.totalSteps}
          </span>
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground text-xs tabular-nums">
        {formatDuration(execution.durationMs)}
      </TableCell>
      <TableCell>
        <StatusBadge
          tone={statusMeta.tone}
          label={statusMeta.label}
          dot
          pulse={execution.status === "running"}
        />
      </TableCell>
      <TableCell className="hidden xl:table-cell">
        {reviewMeta && execution.review ? (
          <StatusBadge tone={reviewMeta.tone} label={reviewMeta.label} />
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground hidden text-xs lg:table-cell">
        {timeAgo(execution.startTime)}
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onRerun}
          disabled={rerunBusy || execution.status === "running"}
        >
          <RotateCcw
            className={cn("size-3.5", rerunBusy && "animate-spin")}
            aria-hidden
          />
          Re-run
        </Button>
      </TableCell>
    </TableRow>
  );
}

export default ExecutionsPanel;
