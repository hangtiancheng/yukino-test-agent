/**
 * Server bootstrap hooks.
 *
 * Background work (pipeline runs, case executions, code analyses) lives only
 * in process memory, so a restart leaves their database rows stuck in
 * `pending`/`running`. On the first server request after boot we mark those
 * rows failed (mirroring the legacy startup hook) so the UI never shows a
 * phantom "running" pipeline, execution, or analysis.
 */
import { recoverInterruptedAnalyses } from "#/server/services/analysis";
import { recoverInterruptedExecutions } from "#/server/services/executions";
import { recoverInterruptedIncrementalRuns } from "#/server/services/incremental";
import { recoverInterruptedRuns } from "#/server/services/workflows";

let recovered = false;
let recovering: Promise<void> | null = null;

export function ensureRecovered(): void {
  if (recovered || recovering) return;
  recovering = Promise.all([
    recoverInterruptedRuns(),
    recoverInterruptedExecutions(),
    recoverInterruptedAnalyses(),
    recoverInterruptedIncrementalRuns(),
  ])
    .then(([runs, executions, analyses, incrementalRuns]) => {
      recovered = true;
      if (runs > 0) {
        console.warn(
          `[bootstrap] marked ${runs} interrupted workflow run(s) as failed`,
        );
      }
      if (executions > 0) {
        console.warn(
          `[bootstrap] marked ${executions} interrupted execution(s) as failed`,
        );
      }
      if (analyses > 0) {
        console.warn(
          `[bootstrap] marked ${analyses} interrupted analysis row(s) as failed`,
        );
      }
      if (incrementalRuns > 0) {
        console.warn(
          `[bootstrap] marked ${incrementalRuns} interrupted incremental run(s) as failed`,
        );
      }
    })
    .catch((error) => {
      // Leave the flag unset so a later request can retry.
      recovering = null;
      console.error("[bootstrap] startup recovery failed", error);
    });
}
