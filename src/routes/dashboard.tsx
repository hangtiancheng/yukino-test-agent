import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  FlaskConical,
  FolderKanban,
  Gauge,
  ListChecks,
  Workflow,
} from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { PageHeader } from "#/components/PageHeader";
import { EmptyState } from "#/components/EmptyState";
import { StatusBadge } from "#/components/StatusBadge";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";
import {
  CASE_EXECUTION_STATUS_META,
  CASE_TYPE_META,
  WORKFLOW_STATUS_META,
  meta,
} from "#/lib/enums";
import type { EnumMeta } from "#/lib/enums";
import { formatDuration, formatPercent, timeAgo } from "#/lib/format";
import { cn } from "#/lib/utils";

import type { LucideIcon } from "lucide-react";
import type { StatsOverview } from "#/server/services/stats";

export const Route = createFileRoute("/dashboard")({
  component: DashboardPage,
});

function DashboardPage() {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(trpc.stats.overview.queryOptions());
  const overview = data ?? null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description="A live overview of projects, generated cases, executions, and pipeline runs."
        actions={
          <Button render={<Link to="/projects" />} nativeButton={false}>
            Open projects
            <ArrowRight className="size-4" aria-hidden />
          </Button>
        }
      />

      {isLoading ? (
        <DashboardSkeleton />
      ) : overview ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              icon={FolderKanban}
              label="Projects"
              value={String(overview.projects)}
              hint="Workspaces under test"
            />
            <StatCard
              icon={ListChecks}
              label="Test Cases"
              value={String(overview.testCases)}
              hint="Generated, imported, and manual"
            />
            <StatCard
              icon={FlaskConical}
              label="Executions"
              value={String(overview.executions)}
              hint="Browser runs recorded"
            />
            <StatCard
              icon={Gauge}
              label="Pass Rate"
              value={formatPercent(overview.passRate, 1)}
              hint="Of all recorded executions"
              accent
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <DistributionCard
              title="Execution status"
              description="Breakdown of every recorded execution."
              counts={overview.executionStatuses}
              metaMap={CASE_EXECUTION_STATUS_META}
              total={overview.executions}
              emptyIcon={Activity}
              emptyText="No executions yet"
            />
            <DistributionCard
              title="Case types"
              description="How the current test cases are classified."
              counts={overview.caseTypes}
              metaMap={CASE_TYPE_META}
              total={overview.testCases}
              emptyIcon={ListChecks}
              emptyText="No test cases yet"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <RecentExecutionsCard overview={overview} />
            <RecentRunsCard overview={overview} />
          </div>
        </>
      ) : null}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  accent = false,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-4 p-5">
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-lg",
            accent
              ? "bg-success/12 text-success"
              : "bg-primary/10 text-primary",
          )}
        >
          <Icon className="size-5" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="text-muted-foreground text-sm">{label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
          {hint ? (
            <p className="text-muted-foreground mt-0.5 truncate text-xs">
              {hint}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function DistributionCard({
  title,
  description,
  counts,
  metaMap,
  total,
  emptyIcon,
  emptyText,
}: {
  title: string;
  description: string;
  counts: Record<string, number>;
  metaMap: Record<string, EnumMeta>;
  total: number;
  emptyIcon: LucideIcon;
  emptyText: string;
}) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-muted-foreground text-sm">{description}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {entries.length === 0 ? (
          <EmptyState icon={emptyIcon} title={emptyText} className="py-8" />
        ) : (
          entries.map(([code, count]) => {
            const m = meta(metaMap, code);
            const ratio = total > 0 ? count / total : 0;
            return (
              <div key={code} className="flex items-center gap-3">
                <div className="w-32 shrink-0">
                  <StatusBadge tone={m.tone} label={m.label} />
                </div>
                <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
                  <div
                    className="bg-primary/70 h-full rounded-full transition-all"
                    style={{ width: `${Math.max(2, ratio * 100)}%` }}
                  />
                </div>
                <span className="text-muted-foreground w-14 shrink-0 text-right text-sm tabular-nums">
                  {count}
                </span>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function RecentExecutionsCard({ overview }: { overview: StatsOverview }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="text-muted-foreground size-4" aria-hidden />
          Recent executions
        </CardTitle>
        <Button
          render={<Link to="/executions" />}
          nativeButton={false}
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
        >
          View all
          <ArrowRight className="size-3.5" aria-hidden />
        </Button>
      </CardHeader>
      <CardContent>
        {overview.recentExecutions.length === 0 ? (
          <EmptyState
            icon={FlaskConical}
            title="No executions yet"
            description="Run a case from a project to see results here."
            className="py-8"
          />
        ) : (
          <ul className="divide-border/60 flex flex-col divide-y">
            {overview.recentExecutions.map((execution) => {
              const m = meta(CASE_EXECUTION_STATUS_META, execution.status);
              return (
                <li
                  key={execution.id}
                  className="flex items-center gap-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <Link
                      to="/executions/$executionId"
                      params={{ executionId: execution.id }}
                      className="block truncate text-sm font-medium hover:underline"
                    >
                      {execution.testCaseTitle}
                    </Link>
                    <p className="text-muted-foreground text-xs">
                      {formatDuration(execution.durationMs)} ·{" "}
                      {timeAgo(execution.startTime)}
                    </p>
                  </div>
                  <StatusBadge tone={m.tone} label={m.label} />
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RecentRunsCard({ overview }: { overview: StatsOverview }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Workflow className="text-muted-foreground size-4" aria-hidden />
          Recent pipeline runs
        </CardTitle>
        <Button
          render={<Link to="/pipeline" />}
          nativeButton={false}
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
        >
          View all
          <ArrowRight className="size-3.5" aria-hidden />
        </Button>
      </CardHeader>
      <CardContent>
        {overview.recentRuns.length === 0 ? (
          <EmptyState
            icon={Workflow}
            title="No pipeline runs yet"
            description="Start a pipeline from a requirement to generate and run cases."
            className="py-8"
          />
        ) : (
          <ul className="divide-border/60 flex flex-col divide-y">
            {overview.recentRuns.map((run) => {
              const m = meta(WORKFLOW_STATUS_META, run.status);
              return (
                <li key={run.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <Link
                      to="/pipeline/$runId"
                      params={{ runId: run.id }}
                      className="block truncate text-sm font-medium hover:underline"
                    >
                      {run.projectName}
                      {run.requirementVersion
                        ? ` · ${run.requirementVersion}`
                        : ""}
                    </Link>
                    <p className="text-muted-foreground text-xs">
                      {timeAgo(run.createdAt)}
                    </p>
                  </div>
                  <StatusBadge tone={m.tone} label={m.label} />
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
