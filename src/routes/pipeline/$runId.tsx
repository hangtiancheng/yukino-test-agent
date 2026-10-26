import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
  FileText,
  Loader2,
  XCircle,
  MinusCircle,
} from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { StatusBadge } from "#/components/StatusBadge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Skeleton } from "#/components/ui/skeleton";
import { Separator } from "#/components/ui/separator";
import {
  CASE_TYPE_META,
  CASE_EXECUTION_STATUS_META,
  FAILURE_CATEGORY_META,
  PRIORITY_META,
  REVIEW_STATUS_META,
  STAGE_STATUS_META,
  WORKFLOW_STATUS_META,
  meta,
} from "#/lib/enums";
import { formatDuration, timeAgo } from "#/lib/format";
import { cn } from "#/lib/utils";

import type { StageDict, WorkflowCaseDict } from "#/server/services/workflows";

export const Route = createFileRoute("/pipeline/$runId")({
  component: RunDetailPage,
});

function RunDetailPage() {
  const { runId } = Route.useParams();
  const trpc = useTRPC();

  const { data, isLoading } = useQuery({
    ...trpc.workflows.detail.queryOptions({ runId }),
    refetchInterval: (query) => {
      const detail = query.state.data;
      if (!detail) return 2000;
      return detail.status === "running" || detail.status === "pending"
        ? 2000
        : false;
    },
  });
  const run = data ?? null;

  if (isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 py-20 text-center">
        <CircleDashed className="text-muted-foreground size-10" aria-hidden />
        <h1 className="text-lg font-semibold">Run not found</h1>
        <Button
          render={<Link to="/pipeline" />}
          nativeButton={false}
          variant="outline"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to pipeline
        </Button>
      </div>
    );
  }

  const statusMeta = meta(WORKFLOW_STATUS_META, run.status);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div>
        <Button
          render={<Link to="/pipeline" search={{ pid: run.projectId }} />}
          nativeButton={false}
          variant="ghost"
          size="sm"
          className="text-muted-foreground mb-2 -ml-2"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Pipeline
        </Button>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              tone={statusMeta.tone}
              label={statusMeta.label}
              dot
              pulse={run.status === "running"}
            />
            <StatusBadge tone="info" label={`${run.mode} mode`} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            {run.requirementName ?? "Pipeline run"}
            {run.requirementVersion ? ` · ${run.requirementVersion}` : ""}
          </h1>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span>Started {timeAgo(run.createdAt)}</span>
            {run.currentStageLabel ? (
              <span>Stage: {run.currentStageLabel}</span>
            ) : null}
            <Link
              to="/projects/$projectId"
              params={{ projectId: run.projectId }}
              className="hover:underline"
            >
              View project
            </Link>
          </div>
          {run.errorMessage ? (
            <p className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm">
              {run.errorMessage}
            </p>
          ) : null}
          {run.reportUrl ? (
            <div>
              <Button
                render={
                  <a href={run.reportUrl} target="_blank" rel="noreferrer" />
                }
                nativeButton={false}
                variant="outline"
                size="sm"
              >
                <FileText className="size-4" aria-hidden />
                Open report
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Stages</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col">
              {run.stages.map((stage, index) => (
                <StageRow
                  key={stage.id}
                  stage={stage}
                  isLast={index === run.stages.length - 1}
                />
              ))}
            </ol>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Cases ({run.cases.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {run.cases.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No cases produced yet.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {run.cases.map((kase) => (
                  <WorkflowCaseRow
                    key={kase.id}
                    kase={kase}
                    projectId={run.projectId}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StageRow({ stage, isLast }: { stage: StageDict; isLast: boolean }) {
  const statusMeta = meta(STAGE_STATUS_META, stage.status);
  const Icon =
    stage.status === "completed"
      ? CheckCircle2
      : stage.status === "failed"
        ? XCircle
        : stage.status === "running"
          ? Loader2
          : stage.status === "skipped"
            ? MinusCircle
            : CircleDashed;

  return (
    <li className="relative flex gap-3 pb-4">
      {!isLast ? (
        <span
          className="bg-border absolute top-6 left-[11px] h-full w-px"
          aria-hidden
        />
      ) : null}
      <span
        className={cn(
          "bg-background relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border",
          stage.status === "completed" && "border-success/40 text-success",
          stage.status === "failed" && "border-destructive/40 text-destructive",
          stage.status === "running" && "border-primary/40 text-primary",
          (stage.status === "pending" || stage.status === "skipped") &&
            "border-border text-muted-foreground",
        )}
      >
        <Icon
          className={cn(
            "size-3.5",
            stage.status === "running" && "animate-spin",
          )}
          aria-hidden
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium">{stage.label}</p>
          <StatusBadge tone={statusMeta.tone} label={statusMeta.label} />
        </div>
        {stage.outputSummary ? (
          <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
            {stage.outputSummary}
          </p>
        ) : null}
        {stage.errorMessage ? (
          <p className="text-destructive mt-0.5 line-clamp-2 text-xs">
            {stage.errorMessage}
          </p>
        ) : null}
        {stage.durationMs > 0 ? (
          <p className="text-muted-foreground mt-0.5 text-xs">
            {formatDuration(stage.durationMs)}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function WorkflowCaseRow({
  kase,
  projectId,
}: {
  kase: WorkflowCaseDict;
  projectId: string;
}) {
  const typeMeta = meta(CASE_TYPE_META, kase.type);
  const priorityMeta = meta(PRIORITY_META, kase.priority);
  const reviewMeta = meta(REVIEW_STATUS_META, kase.reviewStatus);
  const execMeta = kase.execution
    ? meta(CASE_EXECUTION_STATUS_META, kase.execution.status)
    : null;
  const analysisMeta = kase.analysis
    ? meta(FAILURE_CATEGORY_META, kase.analysis.failureCategory)
    : null;

  return (
    <div className="border-border/60 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            to="/projects/$projectId/cases/$caseId"
            params={{ projectId, caseId: kase.caseId }}
            className="line-clamp-1 text-sm font-medium hover:underline"
            title={kase.title}
          >
            {kase.title}
          </Link>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StatusBadge tone={typeMeta.tone} label={typeMeta.label} />
            <StatusBadge tone={priorityMeta.tone} label={priorityMeta.label} />
            <StatusBadge
              tone={reviewMeta.tone}
              label={`Review: ${reviewMeta.label}`}
            />
            {kase.execution && execMeta ? (
              <StatusBadge
                tone={execMeta.tone}
                label={`Exec: ${execMeta.label}`}
              />
            ) : null}
            {analysisMeta &&
            kase.analysis &&
            kase.analysis.failureCategory !== "none" ? (
              <StatusBadge
                tone={analysisMeta.tone}
                label={analysisMeta.label}
              />
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-muted-foreground text-xs">
            Q {Math.round(kase.qualityScore)}
          </span>
          {kase.revisionCount > 0 ? (
            <span className="text-muted-foreground text-xs">
              {kase.revisionCount} revisions
            </span>
          ) : null}
        </div>
      </div>
      {kase.execution ? (
        <>
          <Separator className="my-2" />
          <div className="text-muted-foreground flex items-center justify-between text-xs">
            <Link
              to="/executions/$executionId"
              params={{ executionId: kase.execution.id }}
              className="hover:underline"
            >
              View execution
            </Link>
            <span>{formatDuration(kase.execution.durationMs)}</span>
          </div>
        </>
      ) : null}
      {kase.analysis?.failureReason ? (
        <p className="text-muted-foreground mt-2 line-clamp-2 text-xs">
          {kase.analysis.failureReason}
        </p>
      ) : null}
    </div>
  );
}
