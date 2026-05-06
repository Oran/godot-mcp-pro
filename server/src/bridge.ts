import { IncomingMessage } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type WsRawData = Buffer | ArrayBuffer | Buffer[];

interface WsSocket {
  readyState: number;
  close(code?: number, data?: string): void;
  send(data: string, cb?: (error?: Error) => void): void;
  on(event: "message", listener: (raw: WsRawData) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

interface WsServer {
  once(event: "listening", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  on(event: "connection", listener: (socket: WsSocket, request: IncomingMessage) => void): this;
  close(cb: (error?: Error) => void): void;
}

interface WsModule {
  OPEN: number;
  WebSocketServer: new (options: { host: string; port: number }) => WsServer;
}

const WS = require("ws") as WsModule;

export interface GodotRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface GodotRpcResponse {
  result?: Record<string, unknown>;
  error?: GodotRpcError;
}

interface PendingRequest {
  method: string;
  resolve: (value: GodotRpcResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface JsonRpcEnvelope {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface GodotBridgeOptions {
  host: string;
  port: number;
  timeoutMs: number;
  logger?: (message: string) => void;
}

export class GodotBridge {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly logger: (message: string) => void;
  private readonly pending = new Map<string, PendingRequest>();

  private server?: WsServer;
  private socket?: WsSocket;
  private nextId = 1;

  constructor(options: GodotBridgeOptions) {
    this.host = options.host;
    this.port = options.port;
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger ?? (() => {});
  }

  get address(): string {
    return `ws://${this.host}:${this.port}`;
  }

  isConnected(): boolean {
    return this.socket?.readyState === WS.OPEN;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const server = new WS.WebSocketServer({ host: this.host, port: this.port });

      server.once("listening", () => {
        this.server = server;
        this.logger(`Listening for Godot plugin on ${this.address}`);
        resolve();
      });

      server.once("error", (error: Error) => {
        reject(error);
      });

      server.on("connection", (socket: WsSocket, request: IncomingMessage) => {
        this.attachSocket(socket, request.socket.remoteAddress ?? "unknown");
      });
    });
  }

  async close(): Promise<void> {
    this.rejectPending("Bridge shutting down.");

    if (this.socket) {
      const active = this.socket;
      this.socket = undefined;
      active.close(1000, "Bridge shutting down");
    }

    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = undefined;

    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  async request(method: string, params: Record<string, unknown>): Promise<GodotRpcResponse> {
    const socket = this.socket;

    if (!socket || socket.readyState !== WS.OPEN) {
      throw new Error(
        `Godot plugin is not connected on ${this.address}. Open the Godot project and enable the godot_mcp plugin first.`,
      );
    }

    const id = String(this.nextId++);
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    return await new Promise<GodotRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for '${method}' after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);

      this.pending.set(id, { method, resolve, reject, timeout });

      socket.send(payload, (error?: Error) => {
        if (!error) {
          return;
        }

        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private attachSocket(socket: WsSocket, remoteAddress: string): void {
    if (this.socket && this.socket.readyState === WS.OPEN) {
      this.logger(`Replacing existing Godot connection with ${remoteAddress}`);
      this.socket.close(1000, "Replaced by newer Godot connection");
    }

    this.socket = socket;
    this.logger(`Godot plugin connected from ${remoteAddress}`);

    socket.on("message", (raw: WsRawData) => {
      this.handleMessage(this.rawDataToString(raw));
    });

    socket.on("close", () => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = undefined;
      this.logger("Godot plugin disconnected");
      this.rejectPending("Godot plugin disconnected while a request was in flight.");
    });

    socket.on("error", (error: Error) => {
      this.logger(`WebSocket error: ${error.message}`);
    });
  }

  private handleMessage(text: string): void {
    let message: JsonRpcEnvelope;

    try {
      message = JSON.parse(text) as JsonRpcEnvelope;
    } catch {
      this.logger(`Ignoring invalid JSON from Godot plugin: ${text}`);
      return;
    }

    if (message.method === "ping") {
      this.sendNotification({ jsonrpc: "2.0", method: "pong", params: {} });
      return;
    }

    if (message.method === "pong") {
      return;
    }

    if (message.id === undefined || message.id === null) {
      this.logger(`Ignoring JSON-RPC notification from Godot plugin: ${text}`);
      return;
    }

    const requestId = String(message.id);
    const pending = this.pending.get(requestId);

    if (!pending) {
      this.logger(`Ignoring response for unknown request id ${requestId}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(requestId);

    if (message.error) {
      const error = message.error as GodotRpcError;
      pending.resolve({
        error: {
          code: Number(error.code ?? -32603),
          message: String(error.message ?? `Unknown Godot error while running '${pending.method}'.`),
          data: error.data,
        },
      });
      return;
    }

    pending.resolve({ result: (message.result ?? {}) as Record<string, unknown> });
  }

  private rawDataToString(raw: WsRawData): string {
    if (Array.isArray(raw)) {
      return Buffer.concat(raw).toString("utf8");
    }

    if (raw instanceof ArrayBuffer) {
      return Buffer.from(new Uint8Array(raw)).toString("utf8");
    }

    return raw.toString("utf8");
  }

  private sendNotification(message: JsonRpcEnvelope): void {
    if (!this.socket || this.socket.readyState !== WS.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(message));
  }

  private rejectPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
