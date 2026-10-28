import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  BRIDGE_PORT,
  EXTENSION_ID,
  extensionEventSchema,
  tokenPattern,
  type BridgeCommand,
  type BridgeResult,
  type ExtensionEvent,
} from "../../../../packages/chrome-connection/protocol";

export function connectionToken(previous?: string) {
  return previous && tokenPattern.test(previous)
    ? previous
    : randomBytes(32).toString("hex");
}

export class ExtensionBridge {
  private server?: WebSocketServer;
  private socket?: WebSocket;
  private pending = new Map<
    string,
    {
      resolve: (value: BridgeResult) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    readonly token: string,
    private readonly onConnection: (connected: boolean) => void,
    private readonly onEvent: (event: ExtensionEvent) => boolean | void,
  ) {
    if (!tokenPattern.test(token))
      throw new Error(
        "Chrome connection token must be exactly 64 hexadecimal characters.",
      );
  }
  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
  async listen(port = BRIDGE_PORT) {
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port,
      maxPayload: 8_100_000,
      verifyClient: ({ origin }, done) =>
        done(origin === `chrome-extension://${EXTENSION_ID}`, 403),
    });
    this.server = server;
    server.on("connection", (socket) => {
      const authentication = setTimeout(
        () => socket.close(1008, "Pairing required"),
        3000,
      );
      socket.on("error", () => {});
      socket.on("message", (raw) => {
        let parsed;
        try {
          parsed = extensionEventSchema.safeParse(JSON.parse(raw.toString()));
        } catch {
          socket.close(1008, "Invalid message");
          return;
        }
        if (!parsed.success) {
          socket.close(1008, "Invalid message");
          return;
        }
        const event = parsed.data;
        if (this.socket !== socket) {
          if (
            event.type !== "hello" ||
            !timingSafeEqual(Buffer.from(event.token), Buffer.from(this.token))
          ) {
            socket.close(1008, "Wrong connection token");
            return;
          }
          if (this.connected) {
            socket.close(1008, "Another Chrome profile is already connected");
            return;
          }
          clearTimeout(authentication);
          this.socket = socket;
          socket.send(JSON.stringify({ type: "welcome" }));
          this.onConnection(true);
          return;
        }
        if (event.type === "ping") {
          socket.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (event.type === "result") {
          const command = this.pending.get(event.id);
          if (!command) return;
          clearTimeout(command.timeout);
          this.pending.delete(event.id);
          if (event.ok) command.resolve(event.data);
          else
            command.reject(
              new Error(
                event.error ??
                  "Chrome extension could not complete the request.",
              ),
            );
          return;
        }
        try {
          const accepted = this.onEvent(event);
          if (event.type === "response" && accepted !== false)
            socket.send(
              JSON.stringify({
                type: "responseAck",
                agentId: event.agentId,
                deliveryId: event.deliveryId,
                sourceId: event.sourceId,
              }),
            );
        } catch {
          socket.close(1011, "Could not store the extension event");
        }
      });
      socket.on("close", () => {
        clearTimeout(authentication);
        if (this.socket !== socket) return;
        this.socket = undefined;
        for (const request of this.pending.values()) {
          clearTimeout(request.timeout);
          request.reject(
            new Error(
              "Chrome extension disconnected. Check the chat before retrying.",
            ),
          );
        }
        this.pending.clear();
        this.onConnection(false);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    return typeof address === "object" && address ? address.port : port;
  }
  request(command: BridgeCommand, timeoutMs = 30000) {
    const socket = this.socket;
    if (!socket || !this.connected)
      return Promise.reject(new Error("Connect the Chrome extension first."));
    const id = randomUUID();
    return new Promise<BridgeResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            "Chrome extension timed out. Inspect the chat before retrying.",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, ...command }), (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  async close() {
    this.socket?.terminate();
    for (const socket of this.server?.clients ?? []) socket.terminate();
    if (this.server)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
