import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import {
  connectionToken,
  ExtensionBridge,
} from "../../apps/desktop/electron/chrome/extension-bridge";
import { EXTENSION_ID } from "../../packages/chrome-connection/constants";

let bridge: ExtensionBridge;
const origin = `chrome-extension://${EXTENSION_ID}`;
afterEach(async () => {
  await bridge?.close();
});
async function paired() {
  const connected = vi.fn();
  const events = vi.fn();
  const token = connectionToken();
  bridge = new ExtensionBridge(token, connected, events);
  const port = await bridge.listen(0);
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
  await once(socket, "open");
  const welcome = once(socket, "message");
  socket.send(JSON.stringify({ type: "hello", token }));
  expect(JSON.parse((await welcome)[0].toString()).type).toBe("welcome");
  return { socket, port, connected, events };
}
describe("Chrome extension bridge", () => {
  it("generates, retains, and repairs tokens to exactly 64 hexadecimal characters", () => {
    for (const old of [
      undefined,
      "too short",
      "a".repeat(86),
      "x".repeat(64),
      "a".repeat(64) + "\n",
    ])
      expect(connectionToken(old)).toMatch(/^[a-f0-9]{64}$/);
    const token = connectionToken();
    expect(connectionToken(token)).toBe(token);
  });
  it("keeps its allowed extension ID consistent with the manifest public key", () => {
    const manifest = JSON.parse(
      readFileSync("apps/chrome-extension/manifest.json", "utf8"),
    );
    const id = Array.from(
      createHash("sha256")
        .update(Buffer.from(manifest.key, "base64"))
        .digest()
        .subarray(0, 16),
    )
      .flatMap((byte) => [byte >> 4, byte & 15])
      .map((value) => String.fromCharCode(97 + value))
      .join("");
    expect(id).toBe(EXTENSION_ID);
  });
  it("exchanges one correlated command and routes a response event", async () => {
    const { socket, connected, events } = await paired();
    const next = once(socket, "message");
    const request = bridge.request({ type: "focus", agentId: "actor" });
    const command = JSON.parse((await next)[0].toString());
    expect(command).toMatchObject({ type: "focus", agentId: "actor" });
    socket.send(
      JSON.stringify({
        type: "result",
        id: command.id,
        ok: true,
        data: { ready: true },
      }),
    );
    await expect(request).resolves.toEqual({ ready: true });
    const acknowledgement = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "response",
        agentId: "actor",
        taskId: "task",
        deliveryId: "sent",
        sourceId: "reply",
        content: "answer",
        url: "https://chatgpt.com/c/test",
      }),
    );
    expect(JSON.parse((await acknowledgement)[0].toString())).toMatchObject({
      type: "responseAck",
      deliveryId: "sent",
      sourceId: "reply",
    });
    await vi.waitFor(() =>
      expect(events).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task", deliveryId: "sent" }),
      ),
    );
    expect(connected).toHaveBeenCalledWith(true);
    socket.close();
    await vi.waitFor(() => expect(connected).toHaveBeenCalledWith(false));
  });
  it("rejects a wrong token before exposing commands", async () => {
    bridge = new ExtensionBridge(connectionToken(), vi.fn(), vi.fn());
    const port = await bridge.listen(0);
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "hello", token: "0".repeat(64) }));
    expect((await closed)[0]).toBe(1008);
    expect(bridge.connected).toBe(false);
  });
  it("does not acknowledge a response rejected by the desktop, keeping the delivery recoverable", async () => {
    const { socket, events } = await paired();
    events.mockReturnValue(false);
    const next = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "response",
        agentId: "actor",
        taskId: "task",
        deliveryId: "sent",
        sourceId: "old-greeting",
        content: "Hi!",
        url: "https://chatgpt.com/c/test",
      }),
    );
    socket.send(JSON.stringify({ type: "ping" }));
    expect(JSON.parse((await next)[0].toString())).toEqual({ type: "pong" });
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "old-greeting" }),
    );
    socket.close();
  });
  it("rejects web page origins and disconnects pending requests without replaying them", async () => {
    const { socket, port } = await paired();
    const intruder = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: "https://example.com",
    });
    await expect(once(intruder, "open")).rejects.toThrow("403");
    const request = bridge.request({ type: "focus", agentId: "actor" });
    const rejected = expect(request).rejects.toThrow("disconnected");
    socket.close();
    await rejected;
  });
});
