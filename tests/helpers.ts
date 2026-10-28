import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { Orchestrator } from "../packages/orchestration/core";
import { initialState } from "../packages/orchestration/initial-state";
import type { Role } from "../packages/shared/types";
export const protocol = readFileSync("agent.md", "utf8");
export const makeCore = () => {
  const core = new Orchestrator(
    initialState(
      resolve("agent.md"),
      protocol,
      process.platform === "win32"
        ? "C:\\Program Files\\Git\\bin\\bash.exe"
        : "/bin/bash",
    ),
    () => {},
  );
  core.transport = () => true;
  return core;
};
export function register(core: Orchestrator, role: Role, n = 1) {
  return core.register({
    role,
    name: `${role}-${n}`,
    provider: "browser",
    conversation: `https://example.com/${role}/${n}`,
    lastNumber: 0,
    automation: "Chrome extension test",
  });
}
export function response(n: number, route: string, body = "Evidence") {
  return `RESPONSE NUMBER ${n} | ${route}\n${body}\n\nSummary\nTest summary.`;
}
export const block = (command = "pwd") =>
  `\`\`\`bash\nclear\n${command}\n\`\`\``;
export function temp() {
  return mkdtempSync(join(tmpdir(), "relay-test-"));
}
export function cleanup(path: string) {
  if (
    resolve(path).startsWith(resolve(tmpdir())) &&
    basename(path).startsWith("relay-test-")
  )
    rmSync(path, { recursive: true, force: true });
  else throw new Error("Refusing cleanup outside test temp directory.");
}
