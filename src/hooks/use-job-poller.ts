import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { useTRPC } from "#/integrations/trpc/react";

import type { JobState } from "#/lib/types";

const TERMINAL: JobState["status"][] = ["completed", "failed"];

/**
 * Polls a background job until it reaches a terminal state.
 *
 * Pass `jobId` (or null to disable). Returns the latest job snapshot plus
 * convenience flags. The refetch interval stops automatically once the job
 * is completed or failed so the UI settles without extra requests.
 */
export function useJobPoller(
  jobId: string | null | undefined,
  intervalMs = 1200,
) {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.jobs.get.queryOptions(
      { jobId: jobId ?? "" },
      { enabled: Boolean(jobId) },
    ),
    refetchInterval: (current) => {
      const job = current.state.data;
      if (!job) return intervalMs;
      return TERMINAL.includes(job.status) ? false : intervalMs;
    },
  });

  const job = query.data ?? null;
  const isTerminal = job ? TERMINAL.includes(job.status) : false;
  const isRunning = job
    ? job.status === "running" || job.status === "pending"
    : false;
  const progress = job && job.total > 0 ? job.current / job.total : null;

  return {
    job,
    isRunning,
    isTerminal,
    isCompleted: job?.status === "completed",
    isFailed: job?.status === "failed",
    progress,
    isLoading: query.isLoading && Boolean(jobId),
    error: job?.error ?? null,
    message: job?.message ?? "",
  };
}

/**
 * Fires `onDone` exactly once when a polled job reaches a terminal state.
 * Useful to invalidate queries after a background mutation finishes.
 */
export function useJobCompletion(
  jobId: string | null | undefined,
  onDone: (job: JobState) => void,
) {
  const { job, isTerminal } = useJobPoller(jobId);
  useEffect(() => {
    if (job && isTerminal) onDone(job);
  }, [job?.id, isTerminal]);
}
