import { validateBatch } from "../protocol/parser";
import type { Batch } from "../shared/types";

export function policy(batch: Batch, approved: boolean) {
  const errors = validateBatch(batch.command);
  if (errors.length) throw new Error(errors.join(" "));
  if (batch.state !== "ready")
    throw new Error(
      "Batch must have an exact watcher review and operator forwarding before execution.",
    );
  const lines = batch.command
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error("Batch contains no executable commands.");
  // Match the format executable without rejecting PowerShell's Format-* cmdlets.
  if (
    /\b(?:sudo|runas|shutdown|reboot|diskpart|(?<![\w.-])format(?:\.(?:com|exe))?(?![\w.-])|mkfs|reg\s+delete)\b|\brm\s+[^\n]*(?:\s\/\s*$|--no-preserve-root)|\bgit\s+(?:reset\s+--hard|clean\s+-|push\s+[^\n]*--force)\b/im.test(
      batch.command,
    )
  )
    throw new Error(
      "Destructive or privileged operation is blocked. Review and run it separately outside the orchestrator if explicitly authorized.",
    );
  if (!approved)
    throw new Error(
      "Explicit operator approval is required: inspect and approve the exact batch.",
    );
  return { lines };
}
