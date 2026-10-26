import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Clapperboard,
  ListOrdered,
  PlayCircle,
  Sparkles,
  XCircle,
} from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { StatusBadge } from "#/components/StatusBadge";
import { ScreenshotViewer } from "#/components/executions/ScreenshotViewer";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Label } from "#/components/ui/label";
import { Skeleton } from "#/components/ui/skeleton";
import { Textarea } from "#/components/ui/textarea";
import { Separator } from "#/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  AI_REVIEW_VERDICT_META,
  CASE_EXECUTION_STATUS_META,
  ERROR_CATEGORY_META,
  meta,
} from "#/lib/enums";
import { formatDate, formatDuration } from "#/lib/format";

import type { ExecutionDict } from "#/server/services/executions";
import type { ExecutionStepRecord } from "#/lib/types";

export const Route = createFileRoute("/executions/$executionId")({
  component: ExecutionDetailPage,
});

function ExecutionDetailPage() {
  const { executionId } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [reviewDialog, setReviewDialog] = useState<"passed" | "failed" | null>(
    null,
  );
  const [note, setNote] = useState("");

  const { data, isLoading } = useQuery(
    trpc.executions.get.queryOptions({ eid: executionId }),
  );
  const stepsQuery = useQuery(
    trpc.executions.steps.queryOptions({ eid: executionId }),
  );
  const execution = data ?? null;
  const steps = (stepsQuery.data ?? []) as ExecutionStepRecord[];

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: trpc.executions.get.queryKey() });
    queryClient.invalidateQueries({
      queryKey: trpc.executions.list.queryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: trpc.executions.forCase.queryKey(),
    });
  }

  const manualReviewMutation = useMutation(
    trpc.executions.manualReview.mutationOptions({
      onSuccess: () => {
        toast.success("Review saved");
        setReviewDialog(null);
        setNote("");
        invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const llmReviewMutation = useMutation(
    trpc.executions.llmReview.mutationOptions({
      onSuccess: () => {
        toast.success("AI review refreshed");
        invalidate();
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

  if (!execution) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 py-20 text-center">
        <PlayCircle className="text-muted-foreground size-10" aria-hidden />
        <h1 className="text-lg font-semibold">Execution not found</h1>
        <Button
          render={<Link to="/executions" />}
          nativeButton={false}
          variant="outline"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to executions
        </Button>
      </div>
    );
  }

  const statusMeta = meta(CASE_EXECUTION_STATUS_META, execution.status);
  const errorMeta = execution.errorCategory
    ? meta(ERROR_CATEGORY_META, execution.errorCategory)
    : null;
  const review = execution.review;
  const reviewMeta = review
    ? meta(AI_REVIEW_VERDICT_META, review.verdict)
    : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div>
        <Button
          render={
            <Link to="/executions" search={{ pid: execution.projectId }} />
          }
          nativeButton={false}
          variant="ghost"
          size="sm"
          className="text-muted-foreground mb-2 -ml-2"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Executions
        </Button>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              tone={statusMeta.tone}
              label={statusMeta.label}
              dot
              pulse={execution.status === "running"}
            />
            {errorMeta ? (
              <StatusBadge tone={errorMeta.tone} label={errorMeta.label} />
            ) : null}
            {reviewMeta && review ? (
              <StatusBadge
                tone={reviewMeta.tone}
                label={`AI: ${reviewMeta.label}`}
              />
            ) : null}
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            {execution.testCaseTitle}
          </h1>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span>Duration {formatDuration(execution.durationMs)}</span>
            <span>
              Steps {execution.passedSteps}/{execution.totalSteps}
            </span>
            {execution.startTime ? (
              <span>{formatDate(execution.startTime)}</span>
            ) : null}
            {execution.targetUrl ? (
              <span className="font-mono text-xs">{execution.targetUrl}</span>
            ) : null}
          </div>
          {execution.errorMessage ? (
            <p className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm">
              {execution.errorMessage}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => setReviewDialog("passed")}
              disabled={manualReviewMutation.isPending}
            >
              <CheckCircle2 className="size-4" aria-hidden />
              Mark passed
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setReviewDialog("failed")}
              disabled={manualReviewMutation.isPending}
            >
              <XCircle className="size-4" aria-hidden />
              Mark failed
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => llmReviewMutation.mutate({ eid: executionId })}
              disabled={llmReviewMutation.isPending}
            >
              <Sparkles className="size-4" aria-hidden />
              {llmReviewMutation.isPending ? "Reviewing…" : "Re-run AI review"}
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {execution.videoPath ? (
            <Card>
              <CardHeader className="flex-row items-center gap-2 space-y-0 pb-3">
                <Clapperboard
                  className="text-muted-foreground size-4"
                  aria-hidden
                />
                <CardTitle className="text-base">Recording</CardTitle>
              </CardHeader>
              <CardContent>
                <video
                  src={execution.videoPath}
                  controls
                  className="border-border/60 w-full rounded-lg border bg-black"
                />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader className="flex-row items-center gap-2 space-y-0 pb-3">
              <ListOrdered
                className="text-muted-foreground size-4"
                aria-hidden
              />
              <CardTitle className="text-base">
                Steps ({steps.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {stepsQuery.isLoading ? (
                <Skeleton className="h-40 rounded-lg" />
              ) : steps.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No step records.
                </p>
              ) : (
                <ol className="flex flex-col gap-3">
                  {steps.map((step) => (
                    <StepItem key={step.stepIndex} step={step} />
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <ReviewCard execution={execution} />
        </div>
      </div>

      <Dialog
        open={reviewDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setReviewDialog(null);
            setNote("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {reviewDialog === "passed" ? "Mark as passed" : "Mark as failed"}
            </DialogTitle>
            <DialogDescription>
              A manual verdict overrides the AI review and updates the case
              status.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="review-note">Note (optional)</Label>
            <Textarea
              id="review-note"
              value={note}
              rows={3}
              placeholder="Why are you overriding the verdict?"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setReviewDialog(null)}
              disabled={manualReviewMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant={reviewDialog === "failed" ? "destructive" : "default"}
              onClick={() =>
                reviewDialog &&
                manualReviewMutation.mutate({
                  eid: executionId,
                  verdict: reviewDialog,
                  note,
                })
              }
              disabled={manualReviewMutation.isPending}
            >
              {manualReviewMutation.isPending ? "Saving…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StepItem({ step }: { step: ExecutionStepRecord }) {
  const resultMeta = meta(CASE_EXECUTION_STATUS_META, step.result);
  const hasShot = Boolean(step.screenshotBefore || step.screenshotAfter);
  return (
    <li className="border-border/60 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            <span className="text-muted-foreground mr-2 font-mono text-xs">
              #{step.stepIndex}
            </span>
            {step.action}
          </p>
          {step.target ? (
            <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
              {step.target}
            </p>
          ) : null}
          {step.error ? (
            <p className="text-destructive mt-1 text-xs">{step.error}</p>
          ) : null}
        </div>
        <StatusBadge tone={resultMeta.tone} label={resultMeta.label} />
      </div>
      {hasShot ? (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {step.screenshotBefore ? (
            <div>
              <p className="text-muted-foreground mb-1 text-xs">Before</p>
              <ScreenshotViewer
                src={step.screenshotBefore}
                alt={`Step ${step.stepIndex} before`}
              />
            </div>
          ) : null}
          {step.screenshotAfter ? (
            <div>
              <p className="text-muted-foreground mb-1 text-xs">After</p>
              <ScreenshotViewer
                src={step.screenshotAfter}
                alt={`Step ${step.stepIndex} after`}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function ReviewCard({ execution }: { execution: ExecutionDict }) {
  const review = execution.review;
  const reviewMeta = review
    ? meta(AI_REVIEW_VERDICT_META, review.verdict)
    : null;

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0 pb-3">
        <Bot className="text-muted-foreground size-4" aria-hidden />
        <CardTitle className="text-base">AI review</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!review || !reviewMeta ? (
          <p className="text-muted-foreground text-sm">
            No review yet. Run the AI review to analyze the screenshots.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <StatusBadge tone={reviewMeta.tone} label={reviewMeta.label} />
              {review.reviewer ? (
                <span className="text-muted-foreground text-xs">
                  by {review.reviewer}
                </span>
              ) : null}
            </div>
            {review.reason ? <p className="text-sm">{review.reason}</p> : null}
            {review.recommendedAction ? (
              <div className="border-border/60 bg-muted/40 rounded-lg border px-3 py-2">
                <p className="text-muted-foreground text-xs font-medium">
                  Recommended action
                </p>
                <p className="mt-0.5 text-sm">{review.recommendedAction}</p>
              </div>
            ) : null}

            {review.issues.length > 0 ? (
              <>
                <Separator />
                <p className="text-muted-foreground text-xs font-medium">
                  Issues ({review.issues.length})
                </p>
                <div className="flex flex-col gap-3">
                  {review.issues.map((issue, i) => (
                    <div key={i} className="flex flex-col gap-2">
                      <p className="text-destructive text-sm">
                        {issue.problem}
                      </p>
                      {issue.screenshot ? (
                        <ScreenshotViewer
                          src={issue.screenshot}
                          alt={`Review issue ${i + 1}`}
                          bbox={issue.bbox}
                        />
                      ) : null}
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {review.imageReviews.length > 0 ? (
              <>
                <Separator />
                <p className="text-muted-foreground text-xs font-medium">
                  Per-image analysis ({review.imageReviews.length})
                </p>
                <div className="flex flex-col gap-3">
                  {review.imageReviews.map((imageReview) => (
                    <div
                      key={imageReview.imageIndex}
                      className="flex flex-col gap-2"
                    >
                      {imageReview.screenshot ? (
                        <ScreenshotViewer
                          src={imageReview.screenshot}
                          alt={`Image ${imageReview.imageIndex}`}
                          bbox={imageReview.bbox}
                        />
                      ) : null}
                      {imageReview.analysis ? (
                        <p className="text-muted-foreground text-xs">
                          {imageReview.analysis}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
