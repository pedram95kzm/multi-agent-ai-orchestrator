import { createHash } from "node:crypto";
export function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
export function validateInstructions(text: string) {
  const required = [
    "## 1. Roles",
    "## 2. Communication Prefixes",
    "## 5. Standard Task Lifecycle",
    "generate handover",
    "RESPONSE NUMBER n | watcher->operator",
    "RESPONSE NUMBER n | actor->watcher",
  ];
  const missing = required.filter((t) => !text.includes(t));
  if (
    !/^## 12\. (?:Manual Chat Replacement|Onboarding a New Agent)\s*$/m.test(
      text,
    )
  )
    missing.push("## 12. Manual Chat Replacement");
  if (!/^## 6\. (?:Bash )?Command Rules\s*$/m.test(text))
    missing.push("## 6. Command Rules");
  if (missing.length)
    throw new Error(
      `Unsupported protocol version. Missing: ${missing.join(", ")}. Previous instructions remain active.`,
    );
  if (text.length > 500000 || text.includes("\0"))
    throw new Error("Instructions contain invalid content or exceed 500 KB.");
  return hash(text);
}
