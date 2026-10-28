import type { AppState, Run } from "./types";

export const directoryMismatchIssue =
  "The forwarded working directory differs from the Actor proposal. Request a corrected proposal or forward its exact directory.";

export function executionResult(run: Run): string {
  return [
    `Execution result for batch ${run.batchId}`,
    `Run ${run.id}`,
    `Status: ${run.status}`,
    `Working directory: ${run.cwd}`,
    `Exit code: ${run.exitCode ?? "UNKNOWN"}`,
    `Signal: ${run.signal ?? "none"}`,
    ...(run.truncated
      ? [
          `OUTPUT TRUNCATED: full output is saved at ${run.logPath}.stdout.log and ${run.logPath}.stderr.log.`,
        ]
      : []),
    `\nSTDOUT:\n${run.stdout || "(empty)"}`,
    `\nSTDERR:\n${run.stderr || "(empty)"}`,
  ].join("\n");
}
export function runningBatchIds(
  state: Pick<AppState, "batches" | "runs">,
): Set<string> {
  const running = new Set(
    state.runs
      .filter((run) => run.status === "running")
      .map((run) => run.batchId),
  );
  for (const batch of state.batches)
    if (batch.state === "running") running.add(batch.id);
  return running;
}
