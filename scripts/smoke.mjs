import { fixtures, installFixtures } from "./smoke/fixtures.mjs";
import { workspaceChecks } from "./smoke/workspace.mjs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { connectCDP, until } from "./smoke/cdp.mjs";

const data = await mkdtemp(join(tmpdir(), "relay-smoke-"));
const chromeData = await mkdtemp(join(tmpdir(), "relay-smoke-chrome-"));
const packageInfo = JSON.parse(await readFile("package.json", "utf8"));
const packaged = process.argv[2] === "--packaged";
const executable = packaged
  ? resolve(
      process.env.RELAY_PACKAGED_PATH ??
        join(
          "release",
          `${packageInfo.build.productName} ${packageInfo.version}.exe`,
        ),
    )
  : (await import("electron")).default;
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const environment = { ...process.env, RELAY_TEST_DATA: data };
delete environment.ELECTRON_RUN_AS_NODE;
const app = spawn(
  executable,
  [
    ...(packaged ? [] : ["."]),
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
  ],
  { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
let errors = "";
app.stderr.on("data", (chunk) => {
  errors += chunk;
});
app.on("error", (error) => {
  errors += error.message;
});
let renderer;
let chrome;
let chromeProcess;
async function capture(name) {
  if (!process.env.RELAY_SMOKE_SCREENSHOTS || !renderer) return;
  await mkdir(process.env.RELAY_SMOKE_SCREENSHOTS, { recursive: true });
  const result = await renderer.call("Page.captureScreenshot", {
    format: "png",
  });
  await writeFile(
    resolve(process.env.RELAY_SMOKE_SCREENSHOTS, `${name}.png`),
    Buffer.from(result.data, "base64"),
  );
}
try {
  const target = await until(
    async () => {
      if (app.exitCode !== null)
        throw new Error(`Relay exited ${app.exitCode}. ${errors}`);
      return (
        await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      ).find(
        (target) => target.type === "page" && target.url.startsWith("file:"),
      );
    },
    "Relay renderer",
    packaged ? 90000 : 30000,
  );
  renderer = await connectCDP(target.webSocketDebuggerUrl);
  await until(
    () => renderer.evaluate('typeof window.relay !== "undefined"'),
    "preload",
  );
  const invoke = async (action) => {
    const result = await renderer.evaluate(
      `window.relay.invoke(${JSON.stringify(action)})`,
    );
    assert(result.ok, result.error);
    return result.data;
  };
  let state = await invoke({ type: "snapshot" });
  assert.equal(state.chrome.token.length, 64);
  assert.match(state.chrome.token, /^[a-f0-9]{64}$/);
  await until(
    () =>
      renderer.evaluate(
        'document.querySelector("h1")?.textContent === "Task management"',
      ),
    "task management home",
  );
  assert.equal(
    await renderer.evaluate(
      'document.body.innerText.includes("Manual conversation")',
    ),
    false,
  );

  const chromeExecutable = [
    process.env.RELAY_CHROME_PATH,
    process.env.PROGRAMFILES &&
      join(
        process.env.PROGRAMFILES,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
    process.env["ProgramFiles(x86)"] &&
      join(
        process.env["ProgramFiles(x86)"],
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
    process.env.LOCALAPPDATA &&
      join(
        process.env.LOCALAPPDATA,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
  ].find((candidate) => candidate && existsSync(candidate));
  assert(chromeExecutable, "Install Chrome to run the extension smoke test.");
  chromeProcess = spawn(
    chromeExecutable,
    [
      `--user-data-dir=${chromeData}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--enable-unsafe-extension-debugging",
      "--enable-automation",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  const debug = await until(async () => {
    const [chromePort, browserPath] = (
      await readFile(join(chromeData, "DevToolsActivePort"), "utf8")
    ).split("\n");
    return { chromePort, browserPath };
  }, "isolated Chrome debugging port");
  chrome = await connectCDP(
    `ws://127.0.0.1:${debug.chromePort}${debug.browserPath}`,
  );
  const installed = await chrome.call("Extensions.loadUnpacked", {
    path: state.chrome.extensionPath,
  });
  assert.equal(installed.id, "odnkchaekpalcfckjieeglknfpochnfn");
  const popup = await chrome.call("Target.createTarget", {
    url: `chrome-extension://${installed.id}/popup.html`,
  });
  const popupSession = await chrome.call("Target.attachToTarget", {
    targetId: popup.targetId,
    flatten: true,
  });
  await until(
    () =>
      chrome.evaluate(
        'typeof chrome.storage !== "undefined"',
        popupSession.sessionId,
      ),
    "extension popup",
  );
  await chrome.evaluate(
    `chrome.storage.local.set(${JSON.stringify({ token: state.chrome.token, bridgePort: state.chrome.port })})`,
    popupSession.sessionId,
  );
  await chrome.evaluate(
    `chrome.runtime.sendMessage(${JSON.stringify({ type: "pair", token: state.chrome.token })})`,
    popupSession.sessionId,
  );
  await until(
    async () => (await invoke({ type: "snapshot" })).chrome.connected,
    "actual extension pairing",
  );

  const sessions = await installFixtures(chrome);
  async function showWorkspace() {
    await renderer.evaluate(
      'Array.from(document.querySelectorAll("nav button")).find(button=>button.textContent.includes("Current task")).click()',
    );
    await until(
      () => renderer.evaluate('Boolean(document.getElementById("actor-url"))'),
      "task URL fields",
    );
  }
  async function setInput(selector, value) {
    await renderer.evaluate(
      `(() => { const el=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,"value").set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event("input",{bubbles:true})); })()`,
    );
  }
  const { verifyPanels, verifyExecution } = workspaceChecks({
    renderer,
    invoke,
    capture,
    setInput,
  });
  async function task(title, subset, useURLFields) {
    state = await invoke({
      type: "task",
      kind: "2. Add a feature",
      title,
      operatingSystem:
        process.platform === "win32"
          ? "Windows"
          : process.platform === "darwin"
            ? "macOS"
            : "Linux",
    });
    const taskId = state.activeTaskId;
    await showWorkspace();
    for (const fixture of subset) {
      if (useURLFields) await setInput(`#${fixture.role}-url`, fixture.url);
      else
        await invoke({
          type: "connectChat",
          taskId,
          role: fixture.role,
          url: fixture.url,
        });
      await until(
        async () =>
          (await invoke({ type: "snapshot" })).agents.some(
            (agent) =>
              agent.taskId === taskId &&
              agent.role === fixture.role &&
              agent.connected,
          ),
        `${fixture.id} connection`,
      );
    }
    const watcher = (await invoke({ type: "snapshot" })).agents.find(
      (agent) => agent.taskId === taskId && agent.role === "watcher",
    );
    if (watcher)
      await until(
        () =>
          renderer.evaluate(
            `document.querySelector('.composer small').textContent.includes('Ctrl + Enter sends to watcher')`,
          ),
        "Watcher selected for task startup",
      );
    assert.equal(
      await renderer.evaluate(
        'document.querySelector(".composer .send-actor").disabled',
      ),
      true,
      "The Actor button is disabled until this task has a confirmed Watcher delivery.",
    );
    const startupOrder = [...subset].sort(
      (left, right) =>
        Number(right.role === "watcher") - Number(left.role === "watcher"),
    );
    assert.equal(
      await renderer.evaluate(
        'Array.from(document.querySelectorAll(".protocol-command-actions button")).every(button => button.disabled)',
      ),
      true,
      "All handovers stay disabled before the first task message.",
    );
    for (const fixture of startupOrder) {
      if (fixture.role === "actor")
        assert.equal(
          await renderer.evaluate(
            'Array.from(document.querySelectorAll(".protocol-command-actions button")).find(button => button.textContent.trim() === "handover for new actor").disabled',
          ),
          true,
          "A connected Actor without a project response cannot be replaced via handover.",
        );
      state = await invoke({ type: "snapshot" });
      const agent = state.agents.find(
        (agent) => agent.taskId === taskId && agent.role === fixture.role,
      );
      const briefing =
        title === "Task A" && fixture.role === "actor"
          ? state.messages.findLast(
              (message) =>
                message.taskId === taskId &&
                message.type === "response" &&
                message.role === "watcher" &&
                message.parsed?.recipient === "actor",
            )
          : undefined;
      await setInput(
        'textarea[aria-label="Message"]',
        fixture.id === "chatgpt"
          ? "Task A sends through the real extension"
          : `${title} ${fixture.id} sends through the real extension`,
      );
      await until(
        () =>
          renderer.evaluate(
            `!document.querySelector('.composer .send-${fixture.role}').disabled`,
          ),
        `${fixture.role} send available`,
      );
      await renderer.evaluate(
        briefing
          ? `document.querySelector('#message-${briefing.id} .send-actor').click()`
          : `document.querySelector('.composer .send-${fixture.role}').click()`,
      );
      const delivery = await until(
        async () =>
          (await invoke({ type: "snapshot" })).messages.find(
            (message) =>
              message.agentId === agent.id &&
              message.type === "operator" &&
              message.status !== "pending",
          ),
        `${fixture.id} submission result`,
      );
      assert.notEqual(delivery.status, "failed", delivery.error);
      await until(
        async () =>
          (await invoke({ type: "snapshot" })).messages.some(
            (message) =>
              message.taskId === taskId &&
              message.type === "response" &&
              message.content.includes(`${fixture.id} fixture reply`),
          ),
        `${fixture.id} captured reply`,
      );
      state = await invoke({ type: "snapshot" });
      const outgoing = state.messages.find(
        (message) =>
          message.agentId === agent.id && message.type === "operator",
      );
      assert.equal(outgoing.status, "submitted");
      assert(
        outgoing.content
          .split("\n")
          .at(-1)
          .startsWith(`Relay context check for ${fixture.role}:`),
        "The actual delivered message ends with its agent context check.",
      );
      assert(
        outgoing.content.includes(state.instructions.text),
        "The first message includes full agent.md.",
      );
      assert.equal(
        outgoing.content.split(state.instructions.text).length,
        2,
        "The first message contains one complete protocol copy.",
      );
      if (briefing) {
        assert.equal(outgoing.sourceId, briefing.id);
        assert.equal(outgoing.originalInput, briefing.content);
        assert(
          outgoing.content.includes(briefing.content),
          "The first Actor handoff includes the current Watcher message verbatim.",
        );
      }
      assert(
        !state.messages.some(
          (message) =>
            message.agentId === agent.id &&
            message.type === "response" &&
            message.content.includes("Hi! How can I help you today?"),
        ),
        "A visible old greeting never completes the current delivery.",
      );
      assert.equal(
        await chrome.evaluate("window.submits", sessions.get(fixture.id)),
        1,
      );
      assert.equal(
        await chrome.evaluate("window.lastSubmitted", sessions.get(fixture.id)),
        outgoing.content.replace(/\r\n?/g, "\n"),
      );
      const request = state.messages.find(
        (message) =>
          message.agentId === agent.id && message.type === "response",
      );
      assert.equal(request.parsed.recipient, "operator");
      if (fixture.id === "deepseek") {
        assert(
          request.content.includes("\n`````markdown\n# Reference\n"),
          "Captured Markdown uses a fence longer than every embedded example.",
        );
        assert.equal(
          request.parsed.batches.length,
          1,
          "Reference code cannot become an executable batch.",
        );
        assert.equal(
          request.parsed.questions.length,
          1,
          "Reference questions cannot become live Operator questions.",
        );
        assert(!request.parsed.batches[0].includes("Reference only"));
      }
      await setInput(
        'textarea[aria-label="Message"]',
        "Operator reviewed the reply; continue using the recorded evidence.",
      );
      assert.equal(
        await renderer.evaluate(
          `document.querySelector('.composer .send-${fixture.role === "watcher" ? "actor" : "watcher"}').disabled`,
        ),
        true,
        "Only the agent that addressed the Operator is available.",
      );
      assert.equal(
        await renderer.evaluate(
          'Array.from(document.querySelectorAll(".protocol-command-actions button")).every(button => button.disabled)',
        ),
        true,
      );
      const acknowledgement = `RESPONSE NUMBER 2 | ${fixture.role}->${fixture.role === "watcher" ? "actor" : "watcher"}\nOperator answer received; continue with the recorded evidence.\nCONTEXT CHECK: RESPONSE 1 = ${title === "Task A" ? "UNAVAILABLE" : "READABLE"}\nSummary: Operator answered.`;
      const escapedAcknowledgement = acknowledgement
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\n", "<br>");
      const acknowledgementMarkup = fixture.response
        .replace("BODY", `<p>${escapedAcknowledgement}</p>`)
        .replaceAll(
          `reply-${fixture.id}`,
          `reply-${fixture.id}-operator-answer`,
        );
      await chrome.evaluate(
        `window.nextReply=${JSON.stringify(acknowledgementMarkup)}`,
        sessions.get(fixture.id),
      );
      if (fixture.role === "watcher") {
        await verifyExecution();
        await renderer.evaluate(
          `document.querySelector('#message-${request.id} .questions button.primary').click()`,
        );
      } else {
        await renderer.evaluate(
          `document.querySelector('.composer .send-${fixture.role}').click()`,
        );
      }
      await until(
        async () =>
          (await invoke({ type: "snapshot" })).messages.some(
            (message) =>
              message.replyToId === request.id &&
              message.type !== "response" &&
              message.status === "submitted",
          ),
        `${fixture.id} confirmed Operator answer`,
      );
      await until(
        async () =>
          (await invoke({ type: "snapshot" })).messages.some(
            (message) =>
              message.agentId === agent.id &&
              message.type === "response" &&
              message.content === acknowledgement,
          ),
        `${fixture.id} reply after Operator answer`,
      );
      if (title === "Task A") {
        await until(
          () =>
            renderer.evaluate(
              `Array.from(document.querySelectorAll('.context-alerts [role="alert"]')).some(alert => alert.textContent.includes('onboard a new ${fixture.role}'))`,
            ),
          `${fixture.role} context warning`,
        );
      }
      assert.equal(
        await chrome.evaluate("window.submits", sessions.get(fixture.id)),
        2,
        "The Operator answer is submitted once to its sender.",
      );
    }
    return taskId;
  }
  const taskA = await task("Task A", fixtures.slice(0, 2), true);
  assert(
    await renderer.evaluate(
      "Number(getComputedStyle(document.querySelector('.summary p')).fontWeight) >= 600",
    ),
    "Summary text is emphasized.",
  );
  await renderer.evaluate(`
    const response = [...document.querySelectorAll('.message')].find(element =>
      element.querySelector('.summary')?.textContent.includes('chatgpt completed.'));
    [...response.querySelectorAll('button')].find(button => button.textContent === 'Show complete text').click();
  `);
  assert(
    await renderer.evaluate(
      '!!document.querySelector(".code-block .hljs-built_in")',
    ),
    "Code has syntax colors.",
  );
  assert(
    await renderer.evaluate('!!document.querySelector(".questions textarea")'),
    "Terminal output has a numbered answer field.",
  );
  await renderer.evaluate(
    "document.querySelector('button[aria-label=\"Copy python code\"]').click()",
  );
  await until(
    () =>
      renderer.evaluate(
        'document.querySelector(\'button[aria-label="Copy python code"]\').textContent === "Copied"',
      ),
    "native code copy",
  );
  if (
    process.platform === "win32" &&
    process.env.RELAY_SMOKE_VERIFY_CLIPBOARD === "1"
  ) {
    const command =
      'Add-Type -AssemblyName System.Windows.Forms; $value=[System.Windows.Forms.Clipboard]::GetText(); $hash=[Security.Cryptography.SHA256]::Create(); [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($value))).Replace("-","").ToLowerInvariant()';
    const result = await promisify(execFile)(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", command],
      { windowsHide: true },
    );
    assert.equal(
      result.stdout.trim(),
      createHash("sha256").update('print("Hello, World!")\n').digest("hex"),
      "Clipboard preserves the exact code without fences.",
    );
  }
  await capture("relay-task-workspace");
  await verifyPanels();
  const taskB = await task("Task B", fixtures.slice(2), false);
  assert(
    await renderer.evaluate(
      'document.querySelector(".conversation").innerText.includes("qwen completed.")',
    ),
  );
  assert.equal(
    await renderer.evaluate(
      'document.querySelector(".conversation").innerText.includes("chatgpt completed.")',
    ),
    false,
  );
  await invoke({ type: "activateTask", taskId: taskA });
  await until(
    () =>
      renderer.evaluate(
        'document.querySelector(".conversation").innerText.includes("chatgpt completed.")',
      ),
    "Task A history",
  );
  assert.equal(
    await renderer.evaluate(
      'document.querySelector(".conversation").innerText.includes("qwen completed.")',
    ),
    false,
  );
  const providerTabs = (
    await chrome.call("Target.getTargets")
  ).targetInfos.filter((target) =>
    fixtures.some((fixture) => target.url === fixture.url),
  );
  assert.equal(
    providerTabs.length,
    4,
    "The extension reused the already-open profile tabs.",
  );
  const replacements = [
    {
      ...fixtures[0],
      id: "new-actor",
      url: "https://chatgpt.com/c/relay-fixture-new-actor",
    },
    {
      ...fixtures[1],
      id: "new-watcher",
      url: "https://chat.deepseek.com/a/chat/s/relay-fixture-new-watcher",
    },
  ];
  const replacementSessions = await installFixtures(chrome, replacements);
  const replyMarkup = (fixture, content) => {
    const escaped = content
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\n", "<br>");
    const number = /^RESPONSE NUMBER (\d+)/.exec(content)?.[1] ?? "reply";
    return fixture.response
      .replace("BODY", `<p>${escaped}</p>`)
      .replace(/id="([^"]+)"/g, (_match, id) => `id="${id}-${number}"`);
  };
  const nextReply = async (fixture, session, content) => {
    await chrome.evaluate(
      `window.nextReply=${JSON.stringify(replyMarkup(fixture, content))}`,
      session,
    );
  };
  const beforeManualTransfer = await invoke({ type: "snapshot" });
  const preparingWatcher = beforeManualTransfer.agents.find(
    (agent) => agent.taskId === taskA && agent.role === "watcher",
  );
  const handoverReport = `RESPONSE NUMBER ${preparingWatcher.lastNumber + 1} | watcher->operator\nHANDOVER PACKET\nTask A requirements, architecture, verified inspection with actual exit code 0, tests, documentation, remaining work, both role counters and continuation briefing.\nHistorical examples:\nWorking directory: C:\\history\nWorking directory: C:\\history.\nq1: Historical setup question.\nq1: Historical output question.\nSummary: Complete handover ready for manual copying.`;
  await nextReply(fixtures[1], sessions.get("deepseek"), handoverReport);
  assert.equal(
    await renderer.evaluate(
      'Array.from(document.querySelectorAll(".protocol-command-actions button")).some(button => /onboard/i.test(button.textContent))',
    ),
    false,
    "Automatic onboarding controls are removed.",
  );
  await renderer.evaluate(
    'Array.from(document.querySelectorAll(".protocol-command-actions button")).find(button => button.textContent.trim() === "handover").click()',
  );
  const handoverMessage = await until(
    async () =>
      (await invoke({ type: "snapshot" })).messages.find(
        (message) =>
          message.type === "response" && message.content === handoverReport,
      ),
    "manual handover report",
  );
  assert.equal(handoverMessage.parsed.handover, true);
  assert.deepEqual(
    await renderer.evaluate(
      'Array.from(document.querySelectorAll(".protocol-command-actions button")).map(button => button.textContent.trim())',
    ),
    ["handover", "handover for new actor", "handover for new watcher"],
  );
  const projectPacket = await renderer.evaluate(
    `document.querySelector("#message-${handoverMessage.id} .handover-transfer textarea").value`,
  );
  assert(
    !projectPacket.includes(
      beforeManualTransfer.instructions.text.replace(/\r\n?/g, "\n"),
    ),
    "The project-only handover does not append agent.md.",
  );
  assert(
    !projectPacket.includes("Target role:"),
    "The project-only handover does not assign a replacement role.",
  );
  assert.deepEqual(handoverMessage.parsed.issues, []);
  assert.deepEqual(handoverMessage.parsed.questions, []);

  for (const replacement of replacements) {
    const before = await invoke({ type: "snapshot" });
    const author = before.agents.find(
      (agent) => agent.taskId === taskA && agent.role === "watcher",
    );
    const roleReport = `RESPONSE NUMBER ${author.lastNumber + 1} | watcher->operator\nHANDOVER PACKET\nComplete project handover for the new ${replacement.role}: requirements, evidence, role duties, precise next steps and independent response numbering.\nSummary: Role handover ready.`;
    await nextReply(fixtures[1], sessions.get("deepseek"), roleReport);
    await renderer.evaluate(
      `Array.from(document.querySelectorAll(".protocol-command-actions button")).find(button => button.textContent.trim() === "handover for new ${replacement.role}").click()`,
    );
    const roleMessage = await until(
      async () =>
        (await invoke({ type: "snapshot" })).messages.find(
          (message) =>
            message.type === "response" && message.content === roleReport,
        ),
      "Watcher role handover addressed to Operator",
    );
    assert.equal(roleMessage.agentId, author.id);
    assert.equal(roleMessage.parsed.recipient, "operator");
    assert.equal(roleMessage.handoverRole, replacement.role);
    const snapshot = await invoke({ type: "snapshot" });
    const old = snapshot.agents.find(
      (agent) => agent.taskId === taskA && agent.role === replacement.role,
    );
    const checkpoint = old.lastNumber;
    const nextNumber = checkpoint + 1;
    const transferSelector = `#message-${roleMessage.id} .handover-transfer`;
    const packet = await until(async () => {
      const content = await renderer.evaluate(
        `document.querySelector(${JSON.stringify(transferSelector + " textarea")}).value`,
      );
      return (
        content.includes(`Target role: ${replacement.role}`) &&
        content.includes(
          `Your first actual project reply AFTER the next Relay message must be RESPONSE NUMBER ${nextNumber}`,
        ) &&
        content
      );
    }, "complete role-specific handover packet");
    assert(
      packet.includes(snapshot.instructions.text.replace(/\r\n?/g, "\n")),
      "The manual packet includes the complete active agent.md.",
    );
    assert(
      packet.includes(roleReport),
      "The actual Watcher report is retained.",
    );
    assert(
      packet.includes(
        `From now on you are the ${replacement.role === "actor" ? "Actor" : "Watcher"}`,
      ),
    );
    assert(packet.includes("What RESPONSE NUMBER means"));
    assert(
      packet.includes(
        `Original response number 1 for your ${replacement.role} role`,
      ),
    );
    await renderer.evaluate(
      `document.querySelector(${JSON.stringify(transferSelector + " button")}).click()`,
    );
    await until(
      () =>
        renderer.evaluate(
          `document.querySelector(${JSON.stringify(transferSelector + " button")}).textContent === "Copied"`,
        ),
      "complete handover copied",
    );

    const receipt = /^MANUAL HANDOVER ACK: .+$/m.exec(packet)?.[0];
    assert(receipt, "The complete packet supplies its exact protocol receipt.");
    const acknowledgment = `RESPONSE NUMBER ${checkpoint} | ${replacement.role}->${replacement.role === "actor" ? "watcher" : "actor"}\nManual handover and complete agent.md received; waiting for the next project message.\n${receipt}\nCONTEXT CHECK: RESPONSE 1 = READABLE\nSummary: Ready to continue.`;
    await nextReply(
      replacement,
      replacementSessions.get(replacement.id),
      acknowledgment,
    );
    await chrome.evaluate(
      `(() => { const editor = document.querySelector("textarea,[contenteditable]"); const content = ${JSON.stringify(packet)}; if (editor.tagName === "TEXTAREA") editor.value = content; else editor.textContent = content; editor.dispatchEvent(new Event("input", {bubbles: true})); document.querySelector("form").requestSubmit(); })()`,
      replacementSessions.get(replacement.id),
    );
    await until(
      () =>
        chrome.evaluate(
          `document.getElementById("history").innerText.includes(${JSON.stringify(acknowledgment.split("\n")[0])})`,
          replacementSessions.get(replacement.id),
        ),
      "new chat's manually initiated reply",
    );
    assert.equal(
      await renderer.evaluate(
        `document.querySelector('#${replacement.role}-url').readOnly`,
      ),
      false,
    );
    await setInput(`#${replacement.role}-url`, replacement.url);
    const updated = await until(async () => {
      const state = await invoke({ type: "snapshot" });
      return (
        state.agents.some(
          (agent) =>
            agent.conversation === replacement.url &&
            agent.connected &&
            agent.lastNumber === checkpoint &&
            agent.manualHandover?.reportId === roleMessage.id,
        ) && state
      );
    }, `${replacement.role} replaced by manually pasting its URL`);
    const agent = updated.agents.find(
      (entry) => entry.conversation === replacement.url,
    );
    assert(!updated.agents.some((entry) => entry.id === old.id));
    assert(
      !updated.messages.some(
        (message) =>
          message.agentId === agent.id && message.type !== "response",
      ),
      "Changing a URL does not automatically send any packet or prompt.",
    );
    assert(!agent.contextHealth?.needsOnboarding);
    assert.equal(
      await chrome.evaluate(
        "window.submits",
        replacementSessions.get(replacement.id),
      ),
      1,
      "The new chat has only the user's manual submission.",
    );
    assert.equal(
      await chrome.evaluate(
        "window.lastSubmitted",
        replacementSessions.get(replacement.id),
      ),
      packet,
    );

    const reply = `RESPONSE NUMBER ${nextNumber} | ${replacement.role}->${replacement.role === "actor" ? "watcher" : "actor"}\nContinuing from the manual handover.\nCONTEXT CHECK: RESPONSE 1 = READABLE\nSummary: Continued.`;
    await nextReply(
      replacement,
      replacementSessions.get(replacement.id),
      reply,
    );
    await setInput(
      'textarea[aria-label="Message"]',
      `Continue from my manually pasted ${replacement.role} handover.`,
    );
    await renderer.evaluate(
      `document.querySelector('.composer .send-${replacement.role}').click()`,
    );
    const firstRelayDelivery = await until(
      async () =>
        (await invoke({ type: "snapshot" })).messages.find(
          (message) =>
            message.agentId === agent.id &&
            message.type === "operator" &&
            message.status === "submitted",
        ),
      "first Relay message after manual replacement",
    );
    assert(
      !firstRelayDelivery.content.includes(updated.instructions.text),
      "The same complete protocol is not sent again after a verified manual receipt.",
    );
    await until(
      async () =>
        (await invoke({ type: "snapshot" })).messages.some(
          (message) =>
            message.agentId === agent.id && message.content === reply,
        ),
      "continued reply after manual replacement",
    );
    assert.equal(
      await chrome.evaluate(
        "window.submits",
        replacementSessions.get(replacement.id),
      ),
      2,
      "Only the manual paste and explicit Relay message were submitted.",
    );
  }

  state = await invoke({ type: "snapshot" });
  assert.equal(
    await renderer.evaluate('!!document.querySelector(".context-alerts")'),
    false,
    "Successful replacement clears the retired agents' warnings.",
  );
  const newWatcher = state.agents.find(
    (agent) => agent.taskId === taskA && agent.role === "watcher",
  );
  const report = `RESPONSE NUMBER ${newWatcher.lastNumber + 1} | watcher->operator\nHANDOVER PACKET\nTask A handover: completed inspection with actual exit code 0; architecture, files, tests, remaining work and both response numbers.\nSummary: Complete handover returned.`;
  await nextReply(
    replacements[1],
    replacementSessions.get("new-watcher"),
    report,
  );
  await renderer.evaluate(
    'Array.from(document.querySelectorAll(".protocol-command-actions button")).find(button=>button.textContent.trim() === "handover").click()',
  );
  await until(
    async () =>
      (await invoke({ type: "snapshot" })).messages.some(
        (message) => message.content === report,
      ),
    "complete handover reply",
  );
  assert.equal(
    await renderer.evaluate('!!document.querySelector(".sync-point")'),
    false,
  );
  await capture("relay-replacement-complete");
  const beforeCorrection = await invoke({ type: "snapshot" });
  const revisionActor = beforeCorrection.agents.find(
    (agent) => agent.taskId === taskA && agent.role === "actor",
  );
  const revisionWatcher = beforeCorrection.agents.find(
    (agent) => agent.taskId === taskA && agent.role === "watcher",
  );
  const revisionShell = process.platform === "win32" ? "powershell" : "bash";
  const revisionCommand =
    process.platform === "win32"
      ? "clear\nWrite-Output 'Directory correction fixture'"
      : "clear\nprintf 'Directory correction fixture\\n'";
  const revisionBlock = `\`\`\`${revisionShell}\n${revisionCommand}\n\`\`\``;
  const proposals = [];
  for (const cwd of [resolve(".."), process.cwd()]) {
    const current = (await invoke({ type: "snapshot" })).agents.find(
      (agent) => agent.id === revisionActor.id,
    );
    const content = `RESPONSE NUMBER ${current.lastNumber + 1} | actor->watcher\nWorking directory: ${cwd}\n${revisionBlock}\nCONTEXT CHECK: RESPONSE 1 = READABLE\nSummary: Exact command with the requested starting directory.`;
    await nextReply(
      replacements[0],
      replacementSessions.get("new-actor"),
      content,
    );
    await invoke({
      type: "send",
      agentId: revisionActor.id,
      content: `Propose the same fixture batch with Working directory: ${cwd}`,
    });
    const proposal = await until(
      async () =>
        (await invoke({ type: "snapshot" })).messages.find(
          (message) =>
            message.type === "response" && message.content === content,
        ),
      "Actor directory proposal captured",
    );
    proposals.push(proposal);
  }
  const currentRevisionWatcher = (
    await invoke({ type: "snapshot" })
  ).agents.find((agent) => agent.id === revisionWatcher.id);
  const correctionApproval = `RESPONSE NUMBER ${currentRevisionWatcher.lastNumber + 1} | watcher->operator\nAPPROVED\nWorking directory: ${process.cwd()}\n${revisionBlock}\nq1: Return the actual output.\nCONTEXT CHECK: RESPONSE 1 = READABLE\nSummary: Approving the delivered directory correction.`;
  await nextReply(
    replacements[1],
    replacementSessions.get("new-watcher"),
    correctionApproval,
  );
  await invoke({
    type: "send",
    agentId: revisionWatcher.id,
    sourceId: proposals[1].id,
    content: proposals[1].content,
  });
  const correctedReviewState = await until(async () => {
    const state = await invoke({ type: "snapshot" });
    return (
      state.batches.some(
        (batch) =>
          batch.proposalId === proposals[1].id && batch.state === "ready",
      ) && state
    );
  }, "exact corrected directory approved without matching the obsolete proposal");
  assert.equal(
    correctedReviewState.batches.find(
      (batch) => batch.proposalId === proposals[0].id,
    ).state,
    "rejected",
  );
  assert.equal(
    correctedReviewState.runs.length,
    beforeCorrection.runs.length,
    "Directory review never executes the batch automatically.",
  );
  const correctionMessage = correctedReviewState.messages.find(
    (message) => message.content === correctionApproval,
  );
  assert.deepEqual(correctionMessage.parsed.issues, []);
  await until(
    () =>
      renderer.evaluate(
        `Boolean(document.querySelector('#message-${correctionMessage.id} button[title="Approve and execute this exact batch"]'))`,
      ),
    "corrected review exposes explicit execution approval",
  );
  const beforeTabReuse = await invoke({ type: "snapshot" });
  const oldWatcher = beforeTabReuse.agents.find(
    (agent) => agent.taskId === taskB && agent.role === "watcher",
  );
  const freshURL = "https://chat.z.ai/c/relay-fixture-reused-tab";
  await chrome.call("Page.navigate", { url: freshURL }, sessions.get("glm"));
  await until(
    () =>
      chrome.evaluate(
        "location.href === " +
          JSON.stringify(freshURL) +
          ' && Boolean(document.querySelector("form"))',
        sessions.get("glm"),
      ),
    "different chat URL in the previously assigned tab",
  );
  const freshTask = await invoke({
    type: "task",
    kind: "feature",
    title: "Task C reused tab",
    operatingSystem: "Windows",
  });
  const taskC = freshTask.activeTaskId;
  await invoke({
    type: "connectChat",
    taskId: taskC,
    role: "watcher",
    url: freshURL,
  });
  await until(
    async () =>
      (await invoke({ type: "snapshot" })).agents.some(
        (agent) => agent.taskId === taskC && agent.connected,
      ),
    "new task reuses the navigated tab without a false ownership conflict",
  );
  const afterTabReuse = await invoke({ type: "snapshot" });
  assert.equal(
    afterTabReuse.agents.find((agent) => agent.id === oldWatcher.id)
      .conversation,
    oldWatcher.conversation,
  );
  assert.equal(
    afterTabReuse.agents.find((agent) => agent.id === oldWatcher.id).connected,
    false,
  );
  assert.equal(
    afterTabReuse.messages.length,
    beforeTabReuse.messages.length,
    "Rebinding the tab does not change project history or send a prompt.",
  );
  assert.equal(await chrome.evaluate("window.submits", sessions.get("glm")), 0);
  await chrome.evaluate(
    `chrome.runtime.sendMessage(${JSON.stringify({ type: "pair", token: afterTabReuse.chrome.token })})`,
    popupSession.sessionId,
  );
  await until(async () => {
    const status = await chrome.evaluate(
      'chrome.runtime.sendMessage({type: "status"})',
      popupSession.sessionId,
    );
    const state = await invoke({ type: "snapshot" });
    return (
      status.connected &&
      state.chrome.connected &&
      state.agents.some((agent) => agent.taskId === taskC && agent.connected)
    );
  }, "same-token pairing reconnects the current task without duplicate ownership");
  assert.equal(await chrome.evaluate("window.submits", sessions.get("glm")), 0);
  await invoke({ type: "activateTask", taskId: taskA });
  await showWorkspace();
  await renderer.evaluate(
    'Array.from(document.querySelectorAll("nav button")).find(button=>button.textContent.includes("Tasks")).click()',
  );
  const deleteSelector = JSON.stringify(
    'button[aria-label="Delete task Task A"]',
  );
  await until(
    () =>
      renderer.evaluate(`Boolean(document.querySelector(${deleteSelector}))`),
    "task delete button",
  );
  await capture("relay-task-manager");
  await renderer.evaluate(
    `window.confirm=()=>true;document.querySelector(${deleteSelector}).click()`,
  );
  await until(
    async () =>
      !(await invoke({ type: "snapshot" })).tasks.some(
        (task) => task.id === taskA,
      ),
    "task deletion",
  );
  state = await invoke({ type: "snapshot" });
  assert.equal(
    state.messages.some((message) => message.taskId === taskA),
    false,
  );
  assert.equal(
    state.agents.some((agent) => agent.taskId === taskA),
    false,
  );
  assert(state.messages.some((message) => message.taskId === taskB));
  console.log(
    "Electron + Chrome extension smoke passed: task-first UI, panel minimization, automatic URL connection, reuse of open tabs, exact sends and captured replies for ChatGPT/Qwen/DeepSeek/GLM, inline execution evidence, complete manual handover copying and editable Actor/Watcher URL replacement, handover reports, and task deletion.",
  );
} catch (error) {
  console.error(`Smoke failed: ${error.message}`);
  if (renderer) {
    const diagnostic = await renderer
      .evaluate(
        '(async()=>{const {data:s}=await window.relay.invoke({type:"snapshot"});return {agents:s.agents.map(a=>({role:a.role,connected:a.connected,error:a.error})),messages:s.messages.map(m=>({type:m.type,status:m.status,error:m.error,preview:m.content.slice(-120)})),uiError:document.querySelector("[role=alert]")?.innerText};})()',
      )
      .catch(() => undefined);
    console.error(JSON.stringify(diagnostic));
  }
  if (chrome) {
    const targets = await chrome
      .call("Target.getTargets")
      .catch(() => undefined);
    for (const target of targets?.targetInfos ?? []) {
      if (target.type !== "page" || !target.url.includes("relay-fixture"))
        continue;
      const { sessionId } = await chrome.call("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      console.error(
        JSON.stringify({
          url: target.url,
          page: await chrome.evaluate(
            '({submits:window.submits,submittedLength:window.lastSubmitted?.length,composerText:(document.querySelector("[contenteditable]")?.innerText ?? document.querySelector("textarea")?.value)?.slice(-120),history:document.getElementById("history")?.innerText})',
            sessionId,
          ),
        }),
      );
    }
  }
  if (errors) console.error(errors.slice(-3000));
  throw error;
} finally {
  if (chrome) {
    await chrome.call("Browser.close").catch(() => {});
    chrome.close();
  }
  if (renderer) {
    await renderer.evaluate("window.close()").catch(() => {});
    renderer.close();
  }
  for (const child of [app, chromeProcess]) {
    if (!child?.pid || child.exitCode !== null) continue;
    if (process.platform === "win32") {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      await once(killer, "exit");
    } else child.kill();
  }
  for (const directory of [data, chromeData]) {
    const path = resolve(directory);
    assert(
      path.startsWith(resolve(tmpdir()) + sep) &&
        basename(path).startsWith("relay-smoke-"),
      "Refusing cleanup outside isolated smoke data.",
    );
    await rm(path, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  }
}
