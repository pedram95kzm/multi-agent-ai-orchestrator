// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  const html = readFileSync("apps/chrome-extension/popup.html", "utf8");
  document.body.innerHTML = new DOMParser().parseFromString(
    html,
    "text/html",
  ).body.innerHTML;
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("pairs on a valid pasted token without a second click or duplicate request", async () => {
  const sendMessage = vi.fn(async (message: { type: string }) => ({
    connected: message.type === "pair",
    message: message.type === "pair" ? "Connecting…" : "Open Relay",
  }));
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  await import("../../apps/chrome-extension/popup");
  const token = document.getElementById("token") as HTMLInputElement;
  token.value = "a".repeat(63);
  token.dispatchEvent(new Event("input"));
  expect(
    sendMessage.mock.calls.filter(([message]) => message.type === "pair"),
  ).toHaveLength(0);
  token.value += "a";
  token.dispatchEvent(new Event("input"));
  token.dispatchEvent(new Event("input"));
  await vi.advanceTimersByTimeAsync(0);
  expect(
    sendMessage.mock.calls.filter(([message]) => message.type === "pair"),
  ).toHaveLength(1);
  expect(sendMessage).toHaveBeenCalledWith({
    type: "pair",
    token: "a".repeat(64),
  });
});

it("shows ready status without asking a connected profile to pair again", async () => {
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn(async () => ({
        connected: true,
        message: "Connected to Relay in this Chrome profile.",
      })),
    },
  });
  await import("../../apps/chrome-extension/popup");
  await vi.advanceTimersByTimeAsync(0);
  expect(document.getElementById("pair")!.hidden).toBe(true);
  expect(document.getElementById("ready")!.hidden).toBe(false);
  document.getElementById("change")!.click();
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.getElementById("pair")!.hidden).toBe(false);
});
