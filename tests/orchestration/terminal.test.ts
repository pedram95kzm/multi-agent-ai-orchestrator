import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Terminal, terminalShell } from "../../packages/orchestration/terminal";
import { policy } from "../../packages/orchestration/execution-policy";
import { makeCore, register, response, temp, cleanup } from "../helpers";
import type { Batch } from "../../packages/shared/types";
const batch = (command: string, inspection = false): Batch => ({
  id: "test",
  command,
  requesterId: "a",
  proposalId: "m",
  state: "ready",
  inspection,
});
describe("execution authorization", () => {
  it("requires explicit approval for both Watcher and Actor commands", () => {
    expect(() => policy(batch("clear\npwd", true), false)).toThrow("approval");
    expect(() => policy(batch("clear\necho test"), false)).toThrow("approval");
    expect(policy(batch("clear\npwd", true), true)).toBeDefined();
  });
  it.each([true, false])(
    "allows approved changes for either batch origin (Watcher: %s), preserving shared safeguards",
    (watcher) => {
      for (const command of [
        "clear\nprintf 'hello' > result.txt\ncat result.txt",
        "clear\nSet-Content -LiteralPath result.txt -Value 'hello'",
        "clear\npwd && ls",
        "clear\nGet-ChildItem -LiteralPath . -Force |\n    Select-Object Mode, Length, LastWriteTime, Name |\n    Format-Table -AutoSize\nGet-Command python | Format-List Name, CommandType, Source, Version",
      ]) {
        expect(policy(batch(command, watcher), true)).toBeDefined();
        expect(() => policy(batch(command, watcher), false)).toThrow(
          "approval",
        );
      }
      expect(() =>
        policy(batch("clear\nsudo rm -rf /", watcher), true),
      ).toThrow("blocked");
    },
  );
  it.each([
    "format C:",
    "FORMAT C: /Q",
    "format.com C:",
    "format.exe C:",
    "sudo rm -rf /",
    "diskpart",
    "mkfs.ext4 /dev/test",
    "reg delete HKCU\\Software\\RelayTest",
    "git reset --hard",
  ])("continues to block destructive or privileged commands: %s", (command) => {
    expect(() => policy(batch(`clear\n${command}`), true)).toThrow("blocked");
  });
  it("requires a reviewed, forwarded batch and permits approved Bash chains while blocking broad staging", () => {
    const b = batch("clear\npwd");
    b.state = "proposed";
    expect(() => policy(b, true)).toThrow("exact watcher");
    expect(() => policy(batch("clear\ngit add ."), true)).toThrow("Broad");
    expect(policy(batch("clear\npwd && ls"), true)).toBeDefined();
    expect(() => policy(batch("clear\npwd && ls"), false)).toThrow("approval");
    expect(policy(batch("clear\npwd && ls", true), true)).toBeDefined();
  });
});
describe("real terminal service", () => {
  async function run(command: string, timeoutMs = 5000, cancel = false) {
    const c = makeCore();
    if (!existsSync(c.state.settings.shell)) return undefined;
    const dir = temp(),
      w = register(c, "watcher");
    c.receive(
      w.id,
      "watcher-command",
      response(
        1,
        "watcher->operator",
        `Working directory: ${dir}\n\`\`\`bash\nclear\n${command}\n\`\`\`\nq1: Return the actual command output.`,
      ),
    );
    const b = c.state.batches[0];
    expect(b.inspection).toBe(true);
    c.state.settings.timeoutMs = timeoutMs;
    const terminal = new Terminal(c, dir);
    const finished = new Promise<void>((resolve) => {
      c.onChange = () => {
        if (c.state.runs[0]?.finished) resolve();
      };
    });
    const r = terminal.execute(b.id, true);
    if (cancel) setTimeout(() => terminal.cancel(r.id), 150);
    await finished;
    await new Promise((r) => setTimeout(r, 50));
    const stdout = readFileSync(`${r.logPath}.stdout.log`, "utf8");
    expect(() => terminal.execute(b.id, true)).toThrow();
    cleanup(dir);
    return { r, stdout, c };
  }
  it("captures stdout, stderr, and exit code separately using actual Bash", async () => {
    const result = await run("printf 'out\\n'\nprintf 'err\\n' >&2\nexit 7");
    expect(result).toBeDefined();
    expect(result!.r.stdout).toBe("out\n");
    expect(result!.r.stderr).toBe("err\n");
    expect(result!.r.exitCode).toBe(7);
    expect(result!.stdout).toBe("out\n");
    const returned = result!.c.returnRun(result!.r);
    expect(returned.content).toContain("Exit code: 7");
    result!.c.delivery(returned.id, "submitted");
    expect(() => result!.c.returnRun(result!.r)).toThrow(
      "already been returned",
    );
  });
  it("runs a Watcher's own Bash file changes after user approval", async () => {
    const result = await run(
      "printf 'watcher wrote this' > approved-watcher.txt\ncat approved-watcher.txt",
    );
    expect(result!.r.status).toBe("completed");
    expect(result!.r.exitCode).toBe(0);
    expect(result!.r.stdout).toBe("watcher wrote this");
  });
  it("times out and cancels the actual process tree", async () => {
    expect((await run("sleep 20", 1000))?.r.status).toBe("timeout");
    expect((await run("sleep 20", 5000, true))?.r.status).toBe("cancelled");
  });
  it("records a nonzero status when an earlier command fails", async () => {
    const result = await run("false\nprintf 'must not run'");
    expect(result!.r.exitCode).not.toBe(0);
    expect(result!.r.stdout).toBe("");
  });
  it("runs standard Bash conditional chains without protocol errors", async () => {
    const success = await run("printf 'first' && printf 'second'");
    expect(success!.r.exitCode).toBe(0);
    expect(success!.r.stdout).toBe("firstsecond");
    const failure = await run("false && printf 'must not run'");
    expect(failure!.r.exitCode).not.toBe(0);
    expect(failure!.r.stdout).toBe("");
  });
  it("preserves UTF-8 characters split across separate output chunks", async () => {
    const result = await run("printf '\\342'\nsleep 0.1\nprintf '\\202\\254'");
    expect(result!.r.stdout).toBe("€");
    expect(result!.stdout).toBe("€");
  });
});

const powershell =
  process.platform === "win32"
    ? join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "/usr/bin/pwsh";

describe.skipIf(!existsSync(powershell))("native PowerShell execution", () => {
  async function run(command: string) {
    const core = makeCore();
    const dir = temp();
    const watcher = register(core, "watcher");
    core.receive(
      watcher.id,
      "watcher-command",
      response(
        1,
        "watcher->operator",
        `Working directory: ${dir}\n\`\`\`powershell\nclear\n${command}\n\`\`\`\nq1: Return the actual command output.`,
      ),
    );
    const b = core.state.batches[0];
    expect(b.inspection).toBe(true);
    core.state.settings.shell = powershell;
    const terminal = new Terminal(core, dir);
    const finished = new Promise<void>((resolve) => {
      core.onChange = () => {
        if (core.state.runs[0]?.finished) resolve();
      };
    });
    try {
      const result = terminal.execute(b.id, true);
      await finished;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(readFileSync(`${result.logPath}.stdout.log`, "utf8")).toBe(
        result.stdout,
      );
      expect(result.cwd).toBe(realpathSync(dir));
      return result;
    } finally {
      cleanup(dir);
    }
  }

  it("uses the configured executable and chat directory, preserving UTF-8 and separate error output", async () => {
    const result = await run(
      "Write-Output 'hello € سلام'\n[Console]::Error.WriteLine('error details')\n(Get-Location).Path\nexit 7",
    );
    expect(result.stdout).toContain("hello € سلام");
    expect(result.stdout).toContain(result.cwd);
    expect(result.stderr.trim()).toBe("error details");
    expect(result.exitCode).toBe(7);
    expect(result.status).toBe("failed");
  });

  it("records success and stops on PowerShell errors without running later commands", async () => {
    expect((await run("Write-Output 'done'")).exitCode).toBe(0);
    const location = await run("Get-Location");
    expect(location.exitCode).toBe(0);
    expect(location.stdout).toContain(location.cwd);
    const result = await run(
      "Get-Item -LiteralPath './missing-relay-file'\nWrite-Output 'must not run'",
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("must not run");
    expect(result.stderr).toContain("missing-relay-file");
  });

  it("propagates the exit code from a native program", async () => {
    const node = process.execPath.replace(/'/g, "''");
    const result = await run(`& '${node}' -e 'process.exit(9)'`);
    expect(result.exitCode).toBe(9);
    expect(result.status).toBe("failed");
  });
  it("runs a Watcher's own PowerShell file changes after user approval", async () => {
    const result = await run(
      "Set-Content -LiteralPath approved-watcher.txt -Value 'watcher wrote this'\nGet-Content -LiteralPath approved-watcher.txt",
    );
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("watcher wrote this");
  });
  it("captures PowerShell table and list formatting without treating it as disk formatting", async () => {
    const result = await run(
      "$item = [pscustomobject]@{ Name = 'relay-format'; Value = 42 }\n$item | Format-Table -AutoSize\n$item | Format-List Name, Value",
    );
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("relay-format");
    expect(result.stdout).toContain("42");
  });
});

it("rejects missing directories and mismatched shell executables before recording or starting a run", () => {
  const core = makeCore();
  const b = batch("clear\npwd");
  core.state.batches.push(b);
  const terminal = new Terminal(core, "unused");
  expect(() => terminal.execute(b.id, true)).toThrow("working directory");
  expect(() => terminalShell(process.execPath)).toThrow("Choose");
  if (existsSync(powershell)) {
    b.cwd = process.cwd();
    core.state.settings.shell = powershell;
    expect(() => terminal.execute(b.id, true)).toThrow("requires bash");
  }
  expect(core.state.runs).toEqual([]);
  expect(b.state).toBe("ready");
});
