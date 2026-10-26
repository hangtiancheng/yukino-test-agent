/**
 * In-process registry for long-running background jobs (analysis,
 * generation, execution batches, pipeline runs).
 *
 * Mutations start a job and return its id immediately; clients poll the
 * job state via tRPC. The durable outcome always lives in the database —
 * the registry only carries progress for the UI.
 */
import { randomUUID } from "node:crypto";

import type { JobState } from "#/lib/types";

const jobs = new Map<string, JobState>();
const MAX_JOBS = 500;

export function createJob(kind: string, total = 0): JobState {
  if (jobs.size > MAX_JOBS) {
    // Evict oldest finished jobs to bound memory.
    const finished = [...jobs.values()]
      .filter((job) => job.status === "completed" || job.status === "failed")
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const job of finished.slice(0, Math.ceil(MAX_JOBS / 2))) {
      jobs.delete(job.id);
    }
  }
  const job: JobState = {
    id: randomUUID().replace(/-/g, ""),
    kind,
    status: "pending",
    message: "Queued",
    current: 0,
    total,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): JobState | undefined {
  return jobs.get(id);
}

export function updateJob(
  id: string,
  patch: Partial<Omit<JobState, "id" | "kind" | "createdAt">>,
): void {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: Date.now() });
}

export function progressJob(
  id: string,
  message: string,
  current?: number,
  total?: number,
): void {
  const job = jobs.get(id);
  if (!job) return;
  job.message = message;
  job.status = "running";
  if (current !== undefined) job.current = current;
  if (total !== undefined) job.total = total;
  job.updatedAt = Date.now();
}

/**
 * Fire-and-forget runner: marks the job running, executes the task, and
 * records completion or failure. Task errors are captured, never thrown.
 */
export function runJob<T>(
  jobId: string,
  task: (
    report: (message: string, current?: number, total?: number) => void,
  ) => Promise<T>,
): void {
  const report = (message: string, current?: number, total?: number) =>
    progressJob(jobId, message, current, total);
  updateJob(jobId, { status: "running", message: "Started" });
  void task(report)
    .then((result) => {
      updateJob(jobId, { status: "completed", message: "Completed", result });
    })
    .catch((error: unknown) => {
      updateJob(jobId, {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        error:
          error instanceof Error ? error.stack || error.message : String(error),
      });
    });
}
