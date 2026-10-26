import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  History,
  Layers,
  ListChecks,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
} from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { StatusBadge } from "#/components/StatusBadge";
import { CaseEditDialog } from "#/components/project/CaseEditDialog";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Skeleton } from "#/components/ui/skeleton";
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
import { formatDate, formatDuration, timeAgo } from "#/lib/format";

export const Route = createFileRoute("/projects/$projectId/cases/$caseId")({
  component: CaseDetailPage,
});

function CaseDetailPage() {
  const { projectId, caseId } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const { data, isLoading } = useQuery(
    trpc.testcases.get.queryOptions({ cid: caseId }),
  );
  const kase = data ?? null;

  const historyQuery = useQuery(
    trpc.executions.forCase.queryOptions({ pid: projectId, cid: caseId }),
  );
  const versionsQuery = useQuery(
    trpc.testcases.versions.queryOptions({ cid: caseId }),
  );
  const executions = historyQuery.data ?? [];
  const versions = (versionsQuery.data ?? []) as {
    id: string;
    version: number;
    changeNote: string | null;
    createdAt: string | null;
  }[];

  const runMutation = useMutation(
    trpc.executions.runSingle.mutationOptions({
      onSuccess: () => {
        toast.info("Execution started");
        queryClient.invalidateQueries({
          queryKey: trpc.executions.forCase.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const deleteMutation = useMutation(
    trpc.testcases.delete.mutationOptions({
      onSuccess: () => {
        toast.success("Case deleted");
        queryClient.invalidateQueries({
          queryKey: trpc.testcases.list.queryKey(),
        });
        navigate({
          to: "/projects/$projectId",
          params: { projectId },
          search: { tab: "cases" },
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const rollbackMutation = useMutation(
    trpc.testcases.rollback.mutationOptions({
      onSuccess: () => {
        toast.success("Rolled back to version");
        queryClient.invalidateQueries({
          queryKey: trpc.testcases.get.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.testcases.versions.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  if (isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (!kase) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 py-20 text-center">
        <ListChecks className="text-muted-foreground size-10" aria-hidden />
        <h1 className="text-lg font-semibold">Case not found</h1>
        <Button
          render={
            <Link
              to="/projects/$projectId"
              params={{ projectId }}
              search={{ tab: "cases" }}
            />
          }
          nativeButton={false}
          variant="outline"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to cases
        </Button>
      </div>
    );
  }

  const typeMeta = meta(CASE_TYPE_META, kase.type);
  const priorityMeta = meta(PRIORITY_META, kase.priority);
  const sourceMeta = meta(CASE_SOURCE_META, kase.source);
  const statusMeta = meta(CASE_EXECUTION_STATUS_META, kase.executionStatus);
  const structuredSteps = kase.structuredSteps;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div>
        <Button
          render={
            <Link
              to="/projects/$projectId"
              params={{ projectId }}
              search={{ tab: "cases" }}
            />
          }
          nativeButton={false}
          variant="ghost"
          size="sm"
          className="text-muted-foreground mb-2 -ml-2"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Cases
        </Button>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground font-mono text-sm">
              {kase.projectSeq}
            </span>
            <StatusBadge tone={typeMeta.tone} label={typeMeta.label} />
            <StatusBadge tone={priorityMeta.tone} label={priorityMeta.label} />
            <StatusBadge tone={sourceMeta.tone} label={sourceMeta.label} />
            <StatusBadge tone={statusMeta.tone} label={statusMeta.label} dot />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{kase.title}</h1>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() =>
                runMutation.mutate({ pid: projectId, cid: caseId })
              }
              disabled={runMutation.isPending}
            >
              <Play className="size-4" aria-hidden />
              {runMutation.isPending ? "Starting…" : "Run case"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditOpen(true)}
            >
              <Pencil className="size-4" aria-hidden />
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="size-4" aria-hidden />
              Delete
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Steps & expectations</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {kase.module ? (
                <div>
                  <p className="text-muted-foreground text-xs font-medium">
                    Module
                  </p>
                  <p className="text-sm">{kase.module}</p>
                </div>
              ) : null}
              {kase.preconditions.length > 0 ? (
                <ListSection title="Preconditions" items={kase.preconditions} />
              ) : null}
              <ListSection title="Steps" items={kase.steps} ordered />
              <ListSection
                title="Expected results"
                items={kase.expectedResults}
              />
              {Object.keys(kase.testData).length > 0 ? (
                <div>
                  <p className="text-muted-foreground mb-2 text-xs font-medium">
                    Test data
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(kase.testData).map(([key, value]) => (
                      <StatusBadge
                        key={key}
                        tone="info"
                        label={`${key} = ${value}`}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
              {kase.lintIssues.length > 0 ? (
                <div>
                  <p className="text-muted-foreground mb-2 text-xs font-medium">
                    Quality notes
                  </p>
                  <ul className="text-warning list-disc space-y-0.5 pl-4 text-xs">
                    {kase.lintIssues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {structuredSteps.length > 0 ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Structured steps</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="border-border/60 overflow-hidden rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableHead className="w-12">#</TableHead>
                        <TableHead className="w-28">Type</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead className="hidden md:table-cell">
                          Target
                        </TableHead>
                        <TableHead className="hidden lg:table-cell">
                          Expected / Input
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {structuredSteps.map((step) => (
                        <TableRow key={step.order}>
                          <TableCell className="text-muted-foreground font-mono text-xs">
                            {step.order}
                          </TableCell>
                          <TableCell>
                            <StatusBadge tone="info" label={step.type} />
                          </TableCell>
                          <TableCell className="text-sm">
                            {step.action}
                          </TableCell>
                          <TableCell className="text-muted-foreground hidden max-w-40 truncate font-mono text-xs md:table-cell">
                            {step.target}
                          </TableCell>
                          <TableCell className="text-muted-foreground hidden max-w-48 truncate text-xs lg:table-cell">
                            {step.expected ?? step.inputValue ?? "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="flex-row items-center gap-2 space-y-0 pb-3">
              <History className="text-muted-foreground size-4" aria-hidden />
              <CardTitle className="text-base">Execution history</CardTitle>
            </CardHeader>
            <CardContent>
              {executions.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No executions yet.
                </p>
              ) : (
                <ul className="divide-border/60 flex flex-col divide-y">
                  {executions.slice(0, 8).map((execution) => {
                    const execMeta = meta(
                      CASE_EXECUTION_STATUS_META,
                      execution.status,
                    );
                    return (
                      <li
                        key={execution.id}
                        className="flex items-center gap-2 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <Link
                            to="/executions/$executionId"
                            params={{ executionId: execution.id }}
                            className="block truncate text-sm font-medium hover:underline"
                          >
                            {execution.id.slice(0, 12)}
                          </Link>
                          <p className="text-muted-foreground text-xs">
                            {formatDuration(execution.durationMs)} ·{" "}
                            {timeAgo(execution.startTime)}
                          </p>
                        </div>
                        <StatusBadge
                          tone={execMeta.tone}
                          label={execMeta.label}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center gap-2 space-y-0 pb-3">
              <Layers className="text-muted-foreground size-4" aria-hidden />
              <CardTitle className="text-base">Versions</CardTitle>
            </CardHeader>
            <CardContent>
              {versions.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No versions recorded.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {versions.map((version) => (
                    <li
                      key={version.id}
                      className="border-border/60 flex items-center gap-2 rounded-lg border px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">
                          v{version.version}
                        </p>
                        <p className="text-muted-foreground truncate text-xs">
                          {version.changeNote || "No note"} ·{" "}
                          {formatDate(version.createdAt)}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={`Roll back to v${version.version}`}
                        onClick={() =>
                          rollbackMutation.mutate({
                            cid: caseId,
                            vid: version.id,
                          })
                        }
                        disabled={rollbackMutation.isPending}
                      >
                        <RotateCcw className="size-3.5" aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <CaseEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        projectId={projectId}
        caseData={kase}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this case?</AlertDialogTitle>
            <AlertDialogDescription>
              “{kase.title}” and its version history will be permanently
              removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate({ cid: caseId })}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ListSection({
  title,
  items,
  ordered = false,
}: {
  title: string;
  items: string[];
  ordered?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-muted-foreground mb-2 text-xs font-medium">{title}</p>
      {ordered ? (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
