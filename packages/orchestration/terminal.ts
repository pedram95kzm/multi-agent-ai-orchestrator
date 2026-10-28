import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync, statSync, existsSync, createWriteStream } from "node:fs";
import { resolve, basename, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { BatchShell, Run } from "../shared/types";
import { policy } from "./execution-policy";
import { now, type Orchestrator } from "./core";
import { pendingOperatorReply } from "../shared/operator-replies";

export function terminalShell(executable: string): BatchShell {
  if (
    !isAbsolute(executable) ||
    !existsSync(executable) ||
    !statSync(executable).isFile()
  )
    throw new Error(
      "Configure an existing absolute terminal executable path in Settings.",
    );
  const name = basename(executable).toLowerCase();
  if (/^(powershell|pwsh)(\.exe)?$/.test(name)) return "powershell";
  if (/^bash(\.exe)?$/.test(name)) return "bash";
  throw new Error(
    "Choose powershell.exe, pwsh.exe, or bash.exe for the shell selected in chat.",
  );
}
export class Terminal {
  active?: { run: Run; child: ChildProcess; cancel: () => void };
  constructor(
    private core: Orchestrator,
    private logDir: string,
  ) {}
  execute(batchId: string, approved: boolean) {
    if (this.active)
      throw new Error("Only one batch may await execution at a time.");
    const b = this.core.state.batches.find((b) => b.id === batchId);
    if (!b) throw new Error("Unknown batch.");
    const taskId =
      this.core.state.messages.find((message) => message.id === b.proposalId)
        ?.taskId ?? this.core.state.activeTaskId;
    const requiredReply = pendingOperatorReply(this.core.state, taskId);
    if (requiredReply && b.forwardedId !== requiredReply.id)
      throw new Error(
        "Answer the pending Operator request before running an unrelated batch.",
      );
    if (this.core.state.runs.some((r) => r.batchId === b.id))
      throw new Error(
        "This batch already has an execution record. Request a newly reviewed proposal to run it again.",
      );
    const settings = this.core.state.settings;
    policy(b, approved);
    if (!b.cwd || !isAbsolute(b.cwd))
      throw new Error(
        "Confirm an absolute working directory in chat. The Watcher must include Working directory: <absolute path> with the batch.",
      );
    const cwd = realpathSync(b.cwd);
    if (!statSync(cwd).isDirectory())
      throw new Error("The confirmed working directory must be a directory.");
    const shell = terminalShell(settings.shell);
    if (shell !== (b.shell ?? "bash"))
      throw new Error(
        `This batch requires ${b.shell ?? "bash"}. Select its terminal executable in Settings before running it.`,
      );
    const run: Run = {
      id: randomUUID(),
      batchId,
      agentId: b.requesterId,
      taskId:
        this.core.state.messages.find((m) => m.id === b.proposalId)?.taskId ??
        this.core.state.activeTaskId,
      command: b.command,
      cwd,
      started: now(),
      stdout: "",
      stderr: "",
      exitCode: null,
      status: "running",
      truncated: false,
      logPath: "",
    };
    run.logPath = join(this.logDir, run.id);
    const stdout = createWriteStream(`${run.logPath}.stdout.log`, {
      flags: "wx",
    });
    const stderr = createWriteStream(`${run.logPath}.stderr.log`, {
      flags: "wx",
    });
    const logError = (e: Error) => {
      run.stderr += `\nLog write error: ${e.message}`;
      run.status = "failed";
      if (this.active?.run.id === run.id) this.active.cancel();
      this.core.changed();
    };
    stdout.on("error", logError);
    stderr.on("error", logError);
    b.state = "running";
    this.core.state.runs.push(run);
    this.core.changed();
    // The leading clear is a display instruction; captured runs have no screen to clear.
    const command = b.command.split("\n").slice(1).join("\n");
    const script =
      shell === "bash"
        ? `set -o pipefail\n${command}`
        : `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n$PSNativeCommandUseErrorActionPreference = $true\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Console]::OutputEncoding\n$global:LASTEXITCODE = 0\ntry {\n& {\n${command}\n} | Out-Default\n$succeeded = $?\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\nif (-not $succeeded) { exit 1 }\nexit 0\n} catch {\n[Console]::Error.WriteLine($_.ToString())\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\nexit 1\n}`;
    const env = {
      ...process.env,
      TERM: "dumb",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_KEY_2: "core.pager",
      GIT_CONFIG_VALUE_2: "cat",
    } as NodeJS.ProcessEnv;
    for (const key of [
      "BASH_ENV",
      "ENV",
      "NODE_OPTIONS",
      "GIT_EXTERNAL_DIFF",
      "GIT_DIFF_OPTS",
      "GIT_CONFIG_PARAMETERS",
    ])
      delete env[key];
    const child = spawn(
      settings.shell,
      shell === "bash"
        ? ["--noprofile", "--norc", "-e", "-c", script]
        : [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
      {
        cwd: resolve(cwd),
        windowsHide: true,
        detached: process.platform !== "win32",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (!scheduled)
        scheduled = setTimeout(() => {
          scheduled = undefined;
          this.core.changed();
        }, 200);
    };
    const decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    const capture = (key: "stdout" | "stderr", chunk: Buffer) => {
      const file = key === "stdout" ? stdout : stderr;
      if (!file.write(chunk)) {
        child[key]?.pause();
        file.once("drain", () => child[key]?.resume());
      }
      const text = decoders[key].write(chunk);
      const remaining = 131072 - run[key].length;
      if (remaining > 0) run[key] += text.slice(0, remaining);
      if (text.length > remaining) run.truncated = true;
      update();
    };
    child.stdout?.on("data", (chunk) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk) => capture("stderr", chunk));
    const terminate = () => {
      if (!child.pid) return;
      if (process.platform === "win32")
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    this.active = { run, child, cancel: terminate };
    const timer = setTimeout(() => {
      run.status = "timeout";
      terminate();
    }, settings.timeoutMs);
    child.on("error", (error) => {
      run.stderr += `\n${error.message}`;
      run.status = "failed";
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (scheduled) clearTimeout(scheduled);
      stdout.end();
      stderr.end();
      for (const key of ["stdout", "stderr"] as const) {
        const tail = decoders[key].end();
        if (run[key].length + tail.length <= 131072) run[key] += tail;
        else run.truncated = true;
      }
      run.exitCode = code;
      run.signal = signal ?? undefined;
      run.finished = now();
      if (run.status === "running")
        run.status = code === 0 ? "completed" : "failed";
      b.state = "executed";
      this.active = undefined;
      this.core.changed();
    });
    return run;
  }
  cancel(runId: string) {
    if (this.active?.run.id !== runId)
      throw new Error("Run is no longer active.");
    this.active.run.status = "cancelled";
    this.active.cancel();
    this.core.changed();
  }
}
