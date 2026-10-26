import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  CircleDashed,
  ShieldCheck,
} from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { EmptyState } from "#/components/EmptyState";
import { StatusBadge } from "#/components/StatusBadge";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
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
import { formatPercent } from "#/lib/format";

import type { CaseExecutionStats, CoverageBlock } from "#/server/lib/coverage";

const ALL = "__all__";

export function CoverageTab({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const [requirementId, setRequirementId] = useState<string>(ALL);

  const requirementsQuery = useQuery(
    trpc.requirements.list.queryOptions({ pid: projectId }),
  );
  const { data, isLoading } = useQuery(
    trpc.coverage.matrix.queryOptions({
      pid: projectId,
      requirementId: requirementId === ALL ? null : requirementId,
    }),
  );
  const matrix = data ?? null;
  const requirements = requirementsQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground max-w-xl text-sm">
          Planned coverage counts cases that reference a real endpoint, verified
          transition, or business rule. Executed coverage counts only passed
          runs.
        </p>
        <Select
          value={requirementId}
          onValueChange={(v) => v !== null && setRequirementId(v)}
        >
          <SelectTrigger className="w-52">
            <SelectValue placeholder="Scope" />
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
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-56 rounded-xl" />
          ))}
        </div>
      ) : !matrix ? (
        <EmptyState
          icon={ShieldCheck}
          title="No coverage data"
          description="Run code analysis and generate cases to build the coverage matrix."
        />
      ) : (
        <>
          <div className="text-muted-foreground flex flex-wrap gap-2 text-xs">
            <StatusBadge
              tone="info"
              label={`${matrix.scoped.cases} cases in scope`}
            />
            <StatusBadge
              tone="success"
              label={`${matrix.scoped.passedExecutions} passed executions`}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <CoverageCard
              title="API endpoints"
              icon={<CircleDashed className="size-4" aria-hidden />}
              block={matrix.apiEndpoint}
            />
            <CoverageCard
              title="State transitions"
              icon={<ShieldCheck className="size-4" aria-hidden />}
              block={matrix.stateTransition}
            />
            <CoverageCard
              title="Business rules"
              icon={<CheckCircle2 className="size-4" aria-hidden />}
              block={matrix.businessRule}
            />
          </div>
          <CaseExecutionCard stats={matrix.caseExecution} />
        </>
      )}
    </div>
  );
}

function CaseExecutionCard({ stats }: { stats: CaseExecutionStats }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4" aria-hidden />
          Execution pass matrix
        </CardTitle>
        <span className="text-muted-foreground text-xs">
          Pass rate {formatPercent(stats.passRate, 1)}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <StatusBadge tone="info" label={`${stats.total} live cases`} />
          <StatusBadge tone="success" label={`${stats.passed} passed`} />
          <StatusBadge tone="danger" label={`${stats.failed} failed`} />
          <StatusBadge
            tone="warning"
            label={`${stats.needsReview} need review`}
          />
          <StatusBadge tone="info" label={`${stats.notRun} not run`} />
          {stats.running > 0 ? (
            <StatusBadge tone="info" label={`${stats.running} running`} />
          ) : null}
          {stats.skipped > 0 ? (
            <StatusBadge tone="info" label={`${stats.skipped} skipped`} />
          ) : null}
        </div>
        <p className="text-muted-foreground text-xs">{stats.note}</p>
        {stats.modules.length > 0 ? (
          <div className="border-border/60 overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Module</TableHead>
                  <TableHead className="w-20 text-right">Cases</TableHead>
                  <TableHead className="w-20 text-right">Passed</TableHead>
                  <TableHead className="w-20 text-right">Failed</TableHead>
                  <TableHead className="hidden w-28 text-right sm:table-cell">
                    Needs review
                  </TableHead>
                  <TableHead className="w-20 text-right">Not run</TableHead>
                  <TableHead className="w-28 text-right">Pass rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.modules.map((module) => (
                  <TableRow key={module.module}>
                    <TableCell className="max-w-48 truncate font-medium">
                      {module.module}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {module.total}
                    </TableCell>
                    <TableCell className="text-success text-right tabular-nums">
                      {module.passed}
                    </TableCell>
                    <TableCell className="text-destructive text-right tabular-nums">
                      {module.failed}
                    </TableCell>
                    <TableCell className="text-warning hidden text-right tabular-nums sm:table-cell">
                      {module.needsReview}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right tabular-nums">
                      {module.notRun}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPercent(module.passRate, 1)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            No live cases in this scope yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function CoverageCard({
  title,
  icon,
  block,
}: {
  title: string;
  icon: React.ReactNode;
  block: CoverageBlock;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
        <span className="text-muted-foreground text-xs">
          {block.total} total
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <RateRow
          label="Planned"
          covered={block.plannedCovered}
          total={block.total}
          rate={block.plannedRate}
          tone="bg-info"
        />
        <RateRow
          label="Executed"
          covered={block.executedCovered}
          total={block.total}
          rate={block.executedRate}
          tone="bg-success"
        />

        <div className="border-border/60 border-t pt-3">
          <p className="text-muted-foreground mb-2 text-xs font-medium">
            Uncovered ({block.uncoveredCount})
          </p>
          {block.uncovered.length === 0 ? (
            <p className="text-success text-xs">Fully covered.</p>
          ) : (
            <ul className="flex max-h-40 flex-col gap-1 overflow-auto">
              {block.uncovered.map((item) => (
                <li
                  key={item.id}
                  className="text-muted-foreground truncate font-mono text-xs"
                  title={item.label}
                >
                  {item.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function RateRow({
  label,
  covered,
  total,
  rate,
  tone,
}: {
  label: string;
  covered: number;
  total: number;
  rate: number;
  tone: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">
          {covered}/{total} · {formatPercent(rate, 0)}
        </span>
      </div>
      <div className="bg-muted h-2 overflow-hidden rounded-full">
        <div
          className={`h-full rounded-full ${tone} transition-all`}
          style={{ width: `${Math.min(100, rate * 100)}%` }}
        />
      </div>
    </div>
  );
}

export default CoverageTab;
