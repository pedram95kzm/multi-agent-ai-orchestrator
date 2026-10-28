import { canonicalConversation } from "../../packages/shared/conversation";
/// <reference types="chrome" />
import {
  BRIDGE_PORT,
  tokenPattern,
} from "../../packages/chrome-connection/constants";
import type {
  BridgeCommand,
  ChatBinding,
} from "../../packages/chrome-connection/protocol";
import {
  chatPage,
  isNewTurn,
  matchesExpectedResponse,
  type PageState,
} from "../../packages/chrome-connection/page";
import { adapterForURL } from "../../packages/chrome-connection/adapters";

interface BoundChat extends ChatBinding {
  tabId?: number;
  ready: boolean;
  error?: string;
  frameId?: number;
  pending?: {
    deliveryId: string;
    baseline?: string;
    turnCount: number;
    baselineNumber?: number;
    expectedNumber?: number;
    responseId?: string;
    previous?: string;
    stableSince?: number;
    captured?: {
      type: "response";
      agentId: string;
      taskId: string;
      deliveryId: string;
      content: string;
      sourceId: string;
      url: string;
      lastNumber: number;
    };
  };
}
const chats = new Map<string, BoundChat>();
const connections = new Map<
  string,
  { key: symbol; promise: Promise<unknown> }
>();
let socket: WebSocket | undefined;
let connectionStatus = "Open Relay, then connect with its 64-character token.";
let authenticated = false;
let connecting = false;
let polling = false;
let sending = Promise.resolve();
let pairing = Promise.resolve();
let persisting = Promise.resolve();
let pairingKey: string | undefined;
let connectionEpoch = 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (event: object) => {
  if (authenticated && socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(event));
};
const persist = () => {
  const snapshot = { chats: Array.from(chats.values()), pairingKey };
  const write = persisting.then(() => chrome.storage.session.set(snapshot));
  persisting = write.then(
    () => {},
    () => {},
  );
  return write;
};
async function credentialsKey(token: string, port: number) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${port}:${token}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function status(chat: BoundChat, ready: boolean, error?: string) {
  if (chats.get(chat.agentId) !== chat) return;
  ready = ready && chat.tabId !== undefined;
  chat.ready = ready;
  chat.error = error;
  emit({ type: "status", agentId: chat.agentId, ready, error, url: chat.url });
}
async function inspect(
  chat: BoundChat,
  mode: "inspect" | "fill" | "submit" = "inspect",
  content?: string,
) {
  if (chat.tabId === undefined)
    throw new Error("Reconnect this chat's saved URL in Relay.");
  const results = await chrome.scripting.executeScript({
    target:
      chat.frameId === undefined
        ? { tabId: chat.tabId, allFrames: true }
        : { tabId: chat.tabId, frameIds: [chat.frameId] },
    world: "MAIN",
    func: chatPage,
    args: [
      {
        mode,
        expectedURL: chat.url,
        adapter: adapterForURL(chat.url),
        content,
      },
    ],
  });
  const frames = results.filter((frame) => frame.result?.composerFound);
  if (frames.length > 1)
    throw new Error(
      "Several frames contain a chat composer. Open the conversation directly and reconnect.",
    );
  const frame =
    frames[0] ?? results.find((frame) => frame.frameId === (chat.frameId ?? 0));
  if (!frame?.result)
    throw new Error(
      "Could not inspect the chat page. Reload its tab and reconnect.",
    );
  if (frame.result.composerFound) chat.frameId = frame.frameId;
  return frame.result;
}
async function focus(chat: BoundChat) {
  if (chat.tabId === undefined)
    throw new Error("Reconnect this chat's saved URL in Relay.");
  const tab = await chrome.tabs.update(chat.tabId, { active: true });
  if (tab?.windowId !== undefined)
    await chrome.windows.update(tab.windowId, { focused: true });
}
async function disconnect(agentId: string) {
  connections.delete(agentId);
  const chat = chats.get(agentId);
  chats.delete(agentId);
  if (chat) await persist();
}
async function connectChat(command: ChatBinding, isCurrent: () => boolean) {
  const assertCurrent = () => {
    if (!isCurrent())
      throw new Error(
        "This chat connection was replaced or disconnected. Reconnect its current URL in Relay.",
      );
  };
  assertCurrent();
  if (command.activeAgentIds) {
    const active = new Set(command.activeAgentIds);
    if (!active.has(command.agentId))
      throw new Error("This chat assignment is no longer active in Relay.");
    let removed = false;
    for (const id of new Set([...chats.keys(), ...connections.keys()]))
      if (!active.has(id)) {
        chats.delete(id);
        connections.delete(id);
        removed = true;
      }
    if (removed) {
      await persist();
      assertCurrent();
    }
  }
  const url = new URL(command.url);
  adapterForURL(url.href);
  const existing = chats.get(command.agentId);
  if (existing?.pending && existing.tabId !== undefined)
    return {
      ready: existing.ready,
      url: existing.url,
      lastNumber: existing.lastNumber,
      lastRole: existing.role,
    };
  chats.delete(command.agentId);
  await persist();
  assertCurrent();
  const tabs = (await chrome.tabs.query({})).filter((tab) => {
    try {
      return (
        tab.url &&
        canonicalConversation(tab.url) === canonicalConversation(command.url)
      );
    } catch {
      return false;
    }
  });
  assertCurrent();
  tabs.sort((a, b) => Number(!!b.active) - Number(!!a.active));
  const tab =
    tabs[0] ?? (await chrome.tabs.create({ url: command.url, active: false }));
  assertCurrent();
  if (tab.id === undefined)
    throw new Error("Chrome did not create a chat tab.");
  for (const owner of chats.values()) {
    if (owner.tabId !== tab.id) continue;
    const sameURL =
      canonicalConversation(owner.url) === canonicalConversation(command.url);
    const pendingRedirect =
      owner.pending &&
      ["/", "/new", "/chat"].includes(new URL(owner.url).pathname) &&
      adapterForURL(owner.url).id === adapterForURL(command.url).id;
    if (sameURL || pendingRedirect)
      throw new Error("This tab already belongs to another task or role.");
    // A tab is reusable after the user navigates to a different chat. Keep the
    // old assignment and pending evidence, but release its obsolete tab ID.
    owner.tabId = undefined;
    owner.frameId = undefined;
    connections.delete(owner.agentId);
    status(
      owner,
      false,
      "This tab now shows a different chat. Reconnect the original URL in Relay.",
    );
  }
  const chat: BoundChat = {
    ...command,
    tabId: tab.id,
    ready: false,
    pending: existing?.pending,
  };
  delete chat.activeAgentIds;
  chats.set(command.agentId, chat);
  let page: PageState | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    page = await inspect(chat).catch(() => undefined);
    assertCurrent();
    if (page?.ready) break;
    await sleep(300);
  }
  const error =
    page?.error ??
    (!page ? "Wait for the chat to load, then reconnect." : undefined);
  if (command.resumeDeliveryId && page && !chat.pending) {
    const alreadyArrived = matchesExpectedResponse(
      page.response,
      chat.role,
      command.lastNumber + 1,
    );
    chat.pending = {
      deliveryId: command.resumeDeliveryId,
      baseline: alreadyArrived ? undefined : page.response,
      turnCount: alreadyArrived
        ? Math.max(0, page.turnCount - 1)
        : page.turnCount,
      baselineNumber: command.lastNumber,
      expectedNumber: command.lastNumber + 1,
      responseId: alreadyArrived ? undefined : page.responseId,
    };
  }
  status(chat, page?.ready ?? false, error);
  await persist();
  assertCurrent();
  return {
    ready: page?.ready ?? false,
    url: chat.url,
    lastNumber: page?.lastNumber ?? 0,
    lastRole: page?.lastRole,
    response:
      !command.resumeDeliveryId && !page?.busy ? page?.response : undefined,
    error,
  };
}
async function send(
  command: Extract<BridgeCommand, { type: "send" }>,
  isCurrent: () => boolean,
) {
  const chat = chats.get(command.agentId);
  if (!chat)
    return { status: "failed", error: "Connect this task's chat URL first." };
  if (chat.pending)
    return {
      status: "failed",
      error: "This chat is still waiting for its previous response.",
    };
  let submissionStarted = false;
  const assertCurrent = () => {
    if (!isCurrent() || chats.get(chat.agentId) !== chat)
      throw new Error(
        "The Relay connection changed. Inspect the chat before retrying this delivery.",
      );
  };
  try {
    assertCurrent();
    await focus(chat);
    assertCurrent();
    const prepared = await inspect(chat, "fill", command.content);
    assertCurrent();
    if (!prepared.ready) return { status: "failed", error: prepared.error };
    let verified = await inspect(chat, "inspect", command.content);
    assertCurrent();
    for (
      let attempt = 0;
      (!verified.matches || !verified.sendReady) && attempt < 30;
      attempt++
    ) {
      await sleep(100);
      verified = await inspect(chat, "inspect", command.content);
      assertCurrent();
    }
    if (!verified.ready || !verified.matches || !verified.sendReady)
      return {
        status: "failed",
        error:
          verified.error ??
          "Chrome did not paste the exact message. Nothing was submitted; inspect the draft in Chrome.",
      };
    chat.pending = {
      deliveryId: command.deliveryId,
      baseline: prepared.response,
      turnCount: prepared.turnCount,
      baselineNumber: prepared.lastNumber,
      expectedNumber: command.expectedNumber ?? chat.lastNumber + 1,
      responseId: prepared.responseId,
    };
    await persist();
    assertCurrent();
    submissionStarted = true;
    const submitted = await inspect(chat, "submit", command.content);
    assertCurrent();
    if (!submitted.submitted) {
      chat.pending = undefined;
      await persist();
      return { status: "failed", error: submitted.error };
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(150);
      const page = await inspect(chat);
      assertCurrent();
      if (page.empty || page.busy || page.turnCount > prepared.turnCount)
        return { status: "submitted" };
    }
    return {
      status: "uncertain",
      error:
        "Send was clicked once, but submission could not be confirmed. Inspect this chat before sending again.",
    };
  } catch (error) {
    return {
      status: submissionStarted ? "uncertain" : "failed",
      error: String(error),
    };
  }
}
async function poll() {
  if (!authenticated || polling) return;
  polling = true;
  try {
    for (const chat of chats.values()) {
      try {
        if (
          chat.pending?.captured &&
          !matchesExpectedResponse(
            chat.pending.captured.content,
            chat.role,
            chat.pending.expectedNumber ?? chat.lastNumber + 1,
          )
        ) {
          chat.pending.captured = undefined;
          chat.pending.previous = undefined;
          chat.pending.stableSince = undefined;
          await persist();
        }
        if (chat.pending?.captured) {
          emit(chat.pending.captured);
          continue;
        }
        if (chat.tabId === undefined) continue;
        const tabId = chat.tabId;
        const tab = await chrome.tabs.get(tabId);
        if (chats.get(chat.agentId) !== chat || chat.tabId !== tabId) continue;
        if (
          tab.url &&
          canonicalConversation(tab.url) !== canonicalConversation(chat.url)
        ) {
          if (
            chat.pending &&
            ["/", "/new", "/chat"].includes(new URL(chat.url).pathname) &&
            adapterForURL(tab.url).id === adapterForURL(chat.url).id
          ) {
            chat.url = tab.url;
            chat.frameId = undefined;
            status(chat, true);
            await persist();
          } else {
            status(
              chat,
              false,
              "This tab navigated away. Update its URL in Relay.",
            );
            continue;
          }
        }
        const page = await inspect(chat);
        if (chats.get(chat.agentId) !== chat || chat.tabId !== tabId) continue;
        if (!chat.pending) {
          if (chat.ready !== page.ready) status(chat, page.ready, page.error);
          continue;
        }
        const pending = chat.pending;
        const expectedNumber = pending.expectedNumber ?? chat.lastNumber + 1;
        if (
          page.response &&
          !page.busy &&
          !matchesExpectedResponse(page.response, chat.role, expectedNumber)
        ) {
          pending.stableSince = undefined;
          const error = `Waiting for ${chat.role === "actor" ? "Actor" : "Watcher"} RESPONSE NUMBER ${expectedNumber}. The visible answer does not match this delivery; Relay has not accepted it.`;
          if (chat.ready || chat.error !== error) status(chat, false, error);
          continue;
        }
        const newTurn = isNewTurn(page, {
          ...pending,
          lastNumber: pending.baselineNumber ?? chat.lastNumber,
        });
        if (
          !newTurn ||
          !page.response ||
          !matchesExpectedResponse(page.response, chat.role, expectedNumber) ||
          page.response === pending.baseline ||
          page.busy ||
          !page.ready ||
          (page.response.match(/^\s*```/gm)?.length ?? 0) % 2 !== 0
        ) {
          pending.stableSince = undefined;
          continue;
        }
        if (pending.previous !== page.response || !pending.stableSince) {
          pending.previous = page.response;
          pending.stableSince = Date.now();
          continue;
        }
        if (!pending.stableSince || Date.now() - pending.stableSince < 3000)
          continue;
        const sourceId = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(page.response),
            ),
          ),
        )
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        if (chats.get(chat.agentId) !== chat || chat.tabId !== tabId) continue;
        pending.captured = {
          type: "response",
          agentId: chat.agentId,
          taskId: chat.taskId,
          deliveryId: pending.deliveryId,
          content: page.response,
          sourceId: `${pending.deliveryId}:${sourceId}`,
          url: chat.url,
          lastNumber: page.lastNumber,
        };
        if (!chat.ready || chat.error) status(chat, true);
        await persist();
        if (chats.get(chat.agentId) === chat) emit(pending.captured);
      } catch (error) {
        status(chat, false, String(error));
      }
    }
  } finally {
    polling = false;
  }
}
async function connect() {
  if (connecting || (socket && socket.readyState !== WebSocket.CLOSED)) return;
  connecting = true;
  const epoch = connectionEpoch;
  try {
    await restored;
    const { token, bridgePort = BRIDGE_PORT } = await chrome.storage.local.get([
      "token",
      "bridgePort",
    ]);
    if (typeof token !== "string" || !tokenPattern.test(token)) return;
    if (
      typeof bridgePort !== "number" ||
      !Number.isInteger(bridgePort) ||
      bridgePort < 1 ||
      bridgePort > 65535
    )
      return;
    const key = await credentialsKey(token, bridgePort);
    if (epoch !== connectionEpoch) return;
    if (key !== pairingKey) {
      // Tab ownership is a routing cache for this Relay identity, not another
      // desktop's task assignment. Its pending sends are recovered by that app.
      chats.clear();
      connections.clear();
      pairingKey = key;
      await persist();
      if (epoch !== connectionEpoch) return;
    }
    openSocket(token, bridgePort);
  } catch (error) {
    if (epoch === connectionEpoch)
      connectionStatus = `Could not connect to Relay: ${String(error)}`;
  } finally {
    if (epoch === connectionEpoch) connecting = false;
  }
}
function openSocket(token: string, bridgePort: number) {
  const client = new WebSocket(`ws://127.0.0.1:${bridgePort}`);
  socket = client;
  client.onopen = () => {
    if (socket !== client) return;
    connecting = false;
    client.send(JSON.stringify({ type: "hello", token }));
  };
  client.onerror = () => {
    if (socket === client)
      connectionStatus = "Relay is not available. Keep the desktop app open.";
  };
  client.onclose = (event) => {
    if (socket !== client) return;
    connecting = false;
    authenticated = false;
    connections.clear();
    connectionStatus =
      event.reason || "Relay disconnected. Reconnecting automatically…";
  };
  client.onmessage = async (event) => {
    if (socket !== client) return;
    let command;
    try {
      command = JSON.parse(event.data);
    } catch {
      return;
    }
    if (command.type === "welcome") {
      authenticated = true;
      connectionStatus = "Connected to Relay in this Chrome profile.";
      return;
    }
    if (command.type === "pong") return;
    if (command.type === "responseAck" && authenticated) {
      const chat = chats.get(command.agentId);
      const captured = chat?.pending?.captured;
      if (
        chat &&
        chat.pending &&
        captured &&
        chat.pending.deliveryId === command.deliveryId &&
        captured.sourceId === command.sourceId
      ) {
        chat.lastNumber = captured.lastNumber;
        chat.pending = undefined;
        await persist();
        status(chat, true);
      }
      return;
    }
    if (!authenticated || typeof command.id !== "string") return;
    try {
      let data;
      if (command.type === "connect") {
        let connection = connections.get(command.agentId);
        if (!connection) {
          const key = Symbol();
          const current = () =>
            socket === client && connections.get(command.agentId)?.key === key;
          const promise = Promise.resolve()
            .then(() => connectChat(command, current))
            .finally(() => {
              if (connections.get(command.agentId)?.key === key)
                connections.delete(command.agentId);
            });
          connection = { key, promise };
          connections.set(command.agentId, connection);
        }
        data = await connection.promise;
      } else if (command.type === "send") {
        const run = sending.then(() => send(command, () => socket === client));
        sending = run.then(
          () => {},
          () => {},
        );
        data = await run;
      } else if (command.type === "focus") {
        const chat = chats.get(command.agentId);
        if (!chat) throw new Error("Reconnect this chat URL first.");
        await focus(chat);
      } else if (command.type === "disconnect")
        await disconnect(command.agentId);
      else throw new Error("Unsupported Relay command.");
      if (socket === client)
        emit({ type: "result", id: command.id, ok: true, data });
    } catch (error) {
      if (socket === client)
        emit({
          type: "result",
          id: command.id,
          ok: false,
          error: String(error),
        });
    }
  };
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === "status") {
    respond({ connected: authenticated, message: connectionStatus });
    return;
  }
  if (message.type === "pair") {
    const token = String(message.token ?? "").trim();
    if (!tokenPattern.test(token)) {
      respond({
        connected: false,
        message: "The token must be exactly 64 hexadecimal characters.",
      });
      return;
    }
    const operation = pairing.then(async () => {
      await restored;
      connectionEpoch++;
      const previous = socket;
      socket = undefined;
      connecting = false;
      authenticated = false;
      connections.clear();
      previous?.close();
      await chrome.storage.local.set({ token });
      await connect();
    });
    pairing = operation.then(
      () => {},
      () => {},
    );
    void operation
      .then(() => respond({ connected: authenticated, message: "Connecting…" }))
      .catch((error) =>
        respond({
          connected: false,
          message: `Could not pair with Relay: ${String(error)}`,
        }),
      );
    return true;
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const chat of chats.values())
    if (chat.tabId === tabId) {
      status(
        chat,
        false,
        "This chat tab was closed. Reconnect its URL in Relay.",
      );
      chats.delete(chat.agentId);
    }
  void persist();
});
chrome.alarms.create("relay-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
setInterval(() => {
  emit({ type: "ping" });
  void connect();
}, 20000);
setInterval(() => void poll(), 1000);
const restored = (async () => {
  const saved = await chrome.storage.session.get(["chats", "pairingKey"]);
  // Older unscoped routing caches are rebuilt from the desktop's saved
  // assignments, including pending-delivery recovery, without resending.
  pairingKey =
    typeof saved.pairingKey === "string" ? saved.pairingKey : undefined;
  if (Array.isArray(saved.chats))
    for (const chat of saved.chats) chats.set(chat.agentId, chat);
})();
void connect();
