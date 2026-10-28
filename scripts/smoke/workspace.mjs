import assert from "node:assert/strict";
import { until } from "./cdp.mjs";
export function workspaceChecks({ renderer, invoke, capture, setInput }) {
  async function verifyPanels() {
    const dimensions = () =>
      renderer.evaluate(`(() => {
      const chat = document.querySelector('.conversation').getBoundingClientRect();
      return {width: chat.width, height: chat.height};
    })()`);
    const expanded = await dimensions();
    await setInput(
      'textarea[aria-label="Message"]',
      "Preserve this draft while minimizing panels",
    );
    for (const side of ["left", "right", "top"]) {
      await renderer.evaluate(
        `document.querySelector('button[aria-label="Minimize ${side} panel"]').click()`,
      );
      await until(
        () =>
          renderer.evaluate(
            `!!document.querySelector('button[aria-label="Expand ${side} panel"]')`,
          ),
        `${side} panel minimized`,
      );
    }
    const compact = await dimensions();
    assert(
      compact.width > expanded.width + 200,
      "Minimized side panels give the conversation more width.",
    );
    assert(
      compact.height > expanded.height + 100,
      "Minimizing the top panel gives the conversation more height.",
    );
    assert.equal(
      await renderer.evaluate(
        'getComputedStyle(document.querySelector(".task-history")).display',
      ),
      "none",
    );
    assert.equal(
      await renderer.evaluate(
        'getComputedStyle(document.querySelector(".task-connections")).display',
      ),
      "none",
    );
    assert.equal(
      await renderer.evaluate(
        'document.querySelector("textarea[aria-label=Message]").value',
      ),
      "Preserve this draft while minimizing panels",
    );
    await capture("relay-workspace-minimized");
    await renderer.call("Emulation.setDeviceMetricsOverride", {
      width: 1100,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.equal(
      await renderer.evaluate(
        "document.documentElement.scrollWidth <= innerWidth",
      ),
      true,
      "The minimized workspace fits a smaller window.",
    );
    await capture("relay-workspace-minimized-small");
    await renderer.call("Emulation.clearDeviceMetricsOverride");
    for (const side of ["left", "right", "top"]) {
      await renderer.evaluate(
        `document.querySelector('button[aria-label="Expand ${side} panel"]').click()`,
      );
      await until(
        () =>
          renderer.evaluate(
            `!!document.querySelector('button[aria-label="Minimize ${side} panel"]')`,
          ),
        `${side} panel restored`,
      );
    }
    assert.equal(
      await renderer.evaluate(
        'document.querySelector("textarea[aria-label=Message]").value',
      ),
      "Preserve this draft while minimizing panels",
    );
    await setInput('textarea[aria-label="Message"]', "");
  }
  async function verifyExecution() {
    const before = await invoke({ type: "snapshot" });
    const batch = before.batches.find(
      (batch) =>
        batch.state === "ready" &&
        before.messages.some(
          (message) =>
            message.id === batch.proposalId &&
            message.taskId === before.activeTaskId,
        ),
    );
    assert(batch, "The approved inspection is available beside its message.");
    assert.equal(
      await renderer.evaluate(
        `!!document.querySelector('nav button[aria-label="Execution history"]')`,
      ),
      false,
    );
    await renderer.evaluate(
      'Array.from(document.querySelectorAll(".summary-batch .code-toolbar button")).find(button => button.textContent === "Execute command" && !button.disabled).click()',
    );
    const run = await until(
      async () =>
        (await invoke({ type: "snapshot" })).runs.find(
          (run) => run.batchId === batch.id && run.finished,
        ),
      "inspection execution from message",
    );
    assert.equal(run.exitCode, 0);
    assert(
      run.stdout.trim().length > 0,
      "The inspection captures its actual working directory.",
    );
    await until(
      () =>
        renderer.evaluate(
          `!!document.querySelector('#message-${batch.forwardedId} .questions textarea')?.value.includes(${JSON.stringify(run.stdout.replace(/\r\n/g, "\n"))})`,
        ),
      "inline execution evidence",
    );
    assert(
      await renderer.evaluate(
        `!!Array.from(document.querySelectorAll('#message-${batch.forwardedId} .code-toolbar button')).find(button => button.textContent === "Copy result" && !button.disabled)`,
      ),
      "The original code toolbar offers the completed result.",
    );
    assert(
      await renderer.evaluate(
        'document.querySelector(".execution-result").textContent.includes("Standard output")',
      ),
    );
    await capture("relay-inline-execution");
  }
  return { verifyPanels, verifyExecution };
}
