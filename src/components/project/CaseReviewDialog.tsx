import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Sparkles, Wrench } from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { StatusBadge } from "#/components/StatusBadge";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Separator } from "#/components/ui/separator";

import type { CaseReviewResult } from "#/server/services/case-review";

const VERDICT_TONE: Record<string, "success" | "warning" | "danger" | "info"> =
  {
    pass: "success",
    suspect: "warning",
    fail: "danger",
    unavailable: "info",
  };

const VERDICT_LABEL: Record<string, string> = {
  pass: "Pass",
  suspect: "Needs work",
  fail: "Reject",
  unavailable: "AI unavailable",
};

const SEVERITY_TONE: Record<string, "danger" | "warning" | "info"> = {
  blocker: "danger",
  warning: "warning",
  info: "info",
};

interface CaseReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  results: CaseReviewResult[];
  summary: { total: number; reviewed: number; problems: number } | null;
}

export function CaseReviewDialog({
  open,
  onOpenChange,
  projectId,
  results,
  summary,
}: CaseReviewDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const fixMutation = useMutation(
    trpc.testcases.aiFix.mutationOptions({
      onSuccess: (result) => {
        toast.success(result.summary || "Case repaired");
        queryClient.invalidateQueries({
          queryKey: trpc.testcases.list.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.testcases.get.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="text-muted-foreground size-4" aria-hidden />
            AI case review
          </DialogTitle>
          <DialogDescription>
            {summary
              ? `${summary.reviewed} of ${summary.total} reviewed · ${summary.problems} with problems`
              : "Deterministic checks plus an advisory AI verdict."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-1">
          {results.length === 0 ? (
            <p className="text-muted-foreground text-sm">No results yet.</p>
          ) : (
            results.map((result) => (
              <div
                key={result.caseId}
                className="border-border/60 rounded-lg border p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {result.title}
                    </p>
                    <p className="text-muted-foreground font-mono text-xs">
                      {result.caseId} · score {result.qualityScore}
                      {result.model ? ` · ${result.model}` : ""}
                    </p>
                  </div>
                  <StatusBadge
                    tone={VERDICT_TONE[result.verdict] ?? "info"}
                    label={VERDICT_LABEL[result.verdict] ?? result.verdict}
                  />
                </div>

                <p className="text-muted-foreground mt-2 text-xs">
                  {result.reason}
                </p>

                {result.issues.length > 0 ? (
                  <>
                    <Separator className="my-2" />
                    <ul className="flex flex-col gap-1.5">
                      {result.issues.map((issue, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <StatusBadge
                            tone={SEVERITY_TONE[issue.severity] ?? "info"}
                            label={issue.severity}
                            className="mt-0.5 shrink-0"
                          />
                          <div className="min-w-0 text-xs">
                            <p>{issue.problem}</p>
                            {issue.suggestion ? (
                              <p className="text-muted-foreground">
                                Suggestion: {issue.suggestion}
                              </p>
                            ) : null}
                            {issue.evidence ? (
                              <p className="text-muted-foreground">
                                Evidence: {issue.evidence}
                              </p>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}

                {result.missingCoverage.length > 0 ? (
                  <p className="text-muted-foreground mt-2 text-xs">
                    Missing coverage: {result.missingCoverage.join(", ")}
                  </p>
                ) : null}

                {result.verdict === "suspect" || result.verdict === "fail" ? (
                  <div className="mt-2 flex justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        fixMutation.mutate({
                          pid: projectId,
                          cid: result.caseId,
                          issues: result.issues,
                        })
                      }
                      disabled={fixMutation.isPending}
                    >
                      <Wrench className="size-3.5" aria-hidden />
                      {fixMutation.isPending &&
                      fixMutation.variables.cid === result.caseId
                        ? "Repairing…"
                        : "AI repair"}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default CaseReviewDialog;
