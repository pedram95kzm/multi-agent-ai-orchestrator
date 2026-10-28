import { WebSocket } from "ws";
import { once } from "node:events";

export async function connectCDP(url) {
  const socket = new WebSocket(url);
  await once(socket, "open");
  let sequence = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.on("message", (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.id) {
      const command = pending.get(event.id);
      if (!command) return;
      clearTimeout(command.timeout);
      pending.delete(event.id);
      if (event.error) command.reject(new Error(event.error.message));
      else command.resolve(event.result ?? {});
    } else for (const listener of listeners) listener(event);
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    for (const command of pending.values()) {
      clearTimeout(command.timeout);
      command.reject(new Error("CDP connection closed."));
    }
    pending.clear();
  });
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out: ${method}`));
      }, 20000);
      pending.set(id, { resolve, reject, timeout });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  return {
    call,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async evaluate(expression, sessionId) {
      const result = await call(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (result.exceptionDetails)
        throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    },
    close() {
      socket.close();
    },
  };
}
export async function until(check, description, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Timed out waiting for ${description}.${lastError ? ` ${lastError.message}` : ""}`,
  );
}
