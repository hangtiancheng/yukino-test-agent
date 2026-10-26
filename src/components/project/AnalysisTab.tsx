import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Play, ScanSearch } from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { useJobPoller } from "#/hooks/use-job-poller";
import { EmptyState } from "#/components/EmptyState";
import { StatusBadge } from "#/components/StatusBadge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Progress } from "#/components/ui/progress";
import { Skeleton } from "#/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { ANALYSIS_STATUS_META, meta } from "#/lib/enums";
import { formatDate } from "#/lib/format";

import type {
  BackendResult,
  FrontendResult,
  StateMachineSpec,
} from "#/lib/types";

interface LatestAnalysis {
  id: string;
  status: string;
  createdAt: string | null;
  backendResult: BackendResult | null;
  frontendResult: FrontendResult | null;
  stateMachines: StateMachineSpec[];
  warnings: string[];
  errorMessage: string | null;
}

export function AnalysisTab({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJobPoller(jobId);
  const finishedRef = useRef<string | null>(null);

  const { data, isLoading } = useQuery(
    trpc.analysis.latest.queryOptions({ pid: projectId }),
  );
  const analysis = (data ?? null) as LatestAnalysis | null;

  useEffect(() => {
    if (job.isTerminal && jobId && finishedRef.current !== jobId) {
      finishedRef.current = jobId;
      if (job.isFailed) toast.error(job.error ?? "Analysis failed");
      else toast.success("Code analysis complete");
      queryClient.invalidateQueries({
        queryKey: trpc.analysis.latest.queryKey(),
      });
      setJobId(null);
    }
  }, [job.isTerminal, job.isFailed, job.error, jobId]);

  const triggerMutation = useMutation(
    trpc.analysis.trigger.mutationOptions({
      onSuccess: (result) => {
        setJobId(result.jobId);
        toast.info("Analysis started");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const running = triggerMutation.isPending || job.isRunning;
  const statusMeta = meta(ANALYSIS_STATUS_META, analysis?.status);
  const backend = analysis?.backendResult;
  const frontend = analysis?.frontendResult;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <div className="flex items-center gap-3">
            <CardTitle className="text-base">Static code analysis</CardTitle>
            {analysis ? (
              <StatusBadge
                tone={statusMeta.tone}
                label={statusMeta.label}
                dot
                pulse={running}
              />
            ) : null}
          </div>
          <Button
            size="sm"
            onClick={() => triggerMutation.mutate({ pid: projectId })}
            disabled={running}
          >
            <Play className="size-4" aria-hidden />
            {running
              ? "Analyzing…"
              : analysis
                ? "Re-run analysis"
                : "Run analysis"}
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-muted-foreground text-sm">
            Scans the configured source for API endpoints, entities, business
            rules, UI forms, and state machines. These facts ground
            deterministic case generation and coverage.
          </p>
          {running && job.progress !== null ? (
            <div className="flex items-center gap-3">
              <Progress value={job.progress * 100} className="flex-1" />
              <span className="text-muted-foreground text-xs">
                {job.message}
              </span>
            </div>
          ) : null}
          {analysis?.createdAt ? (
            <p className="text-muted-foreground text-xs">
              Last analyzed {formatDate(analysis.createdAt)}
            </p>
          ) : null}
          {analysis?.errorMessage ? (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" aria-hidden />
              <AlertTitle>Analysis failed</AlertTitle>
              <AlertDescription>{analysis.errorMessage}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : !analysis || analysis.status === "pending" ? (
        <EmptyState
          icon={ScanSearch}
          title="No analysis yet"
          description="Run the analysis to extract endpoints, entities, rules, and state machines from the source code."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Metric label="Endpoints" value={backend?.endpoints.length ?? 0} />
            <Metric label="Entities" value={backend?.entities.length ?? 0} />
            <Metric
              label="Business rules"
              value={backend?.businessRules.length ?? 0}
            />
            <Metric label="Pages" value={frontend?.pages.length ?? 0} />
          </div>

          {analysis.warnings.length > 0 ? (
            <Alert>
              <AlertTriangle className="size-4" aria-hidden />
              <AlertTitle>{analysis.warnings.length} warning(s)</AlertTitle>
              <AlertDescription>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {analysis.warnings.slice(0, 8).map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          <EndpointsCard endpoints={backend?.endpoints ?? []} />
          <RulesCard rules={backend?.businessRules ?? []} />
          <StateMachinesCard machines={analysis.stateMachines} />
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
        <p className="text-muted-foreground text-xs">{label}</p>
      </CardContent>
    </Card>
  );
}

function EndpointsCard({
  endpoints,
}: {
  endpoints: BackendResult["endpoints"];
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          API endpoints ({endpoints.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {endpoints.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No endpoints detected.
          </p>
        ) : (
          <div className="border-border/60 max-h-80 overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-20">Method</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead className="hidden md:table-cell">
                    Controller
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.slice(0, 200).map((endpoint) => (
                  <TableRow key={endpoint.id}>
                    <TableCell>
                      <StatusBadge tone="info" label={endpoint.method} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {endpoint.path}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden truncate md:table-cell">
                      {endpoint.controller}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RulesCard({ rules }: { rules: BackendResult["businessRules"] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          Business rules ({rules.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rules.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No business rules detected.
          </p>
        ) : (
          <ul className="flex max-h-80 flex-col gap-2 overflow-auto">
            {rules.slice(0, 100).map((rule) => (
              <li
                key={rule.id}
                className="border-border/60 bg-muted/30 rounded-lg border px-3 py-2"
              >
                <p className="text-sm font-medium">{rule.description}</p>
                {rule.guard ? (
                  <code className="text-muted-foreground mt-1 block truncate font-mono text-xs">
                    {rule.guard}
                  </code>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function StateMachinesCard({ machines }: { machines: StateMachineSpec[] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          State machines ({machines.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {machines.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No state machines detected.
          </p>
        ) : (
          machines.map((machine) => (
            <div
              key={machine.id ?? machine.name}
              className="flex flex-col gap-2"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">{machine.name}</span>
                <StatusBadge
                  tone={machine.confidence >= 0.7 ? "success" : "warning"}
                  label={`${Math.round(machine.confidence * 100)}% confidence`}
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {machine.states.map((state) => (
                  <StatusBadge
                    key={state.name}
                    tone="info"
                    label={state.label || state.name}
                  />
                ))}
              </div>
              <div className="border-border/60 overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead>From</TableHead>
                      <TableHead>To</TableHead>
                      <TableHead>Trigger</TableHead>
                      <TableHead className="w-24">Verified</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {machine.transitions.map((transition) => (
                      <TableRow key={transition.id}>
                        <TableCell className="font-mono text-xs">
                          {transition.from}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {transition.to}
                        </TableCell>
                        <TableCell className="text-xs">
                          {transition.trigger}
                        </TableCell>
                        <TableCell>
                          <StatusBadge
                            tone={transition.verified ? "success" : "warning"}
                            label={
                              transition.verified ? "Verified" : "Inferred"
                            }
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
