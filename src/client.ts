import { on } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadProjection,
  WsRpcGroup,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type { FromServerEncoded } from "effect/rpc/RpcMessage";
import { T3Error } from "./errors.ts";

/** The JSON form of a schema's encoded type. Effect types encoded timestamps as DateTime; on the wire they are ISO strings. */
type Jsonify<T> = T extends DateTime.DateTime ? string : T extends object ? { [K in keyof T]: Jsonify<T[K]> } : T;
export type Wire<S extends { readonly Encoded: unknown }> = Jsonify<S["Encoded"]>;

// Every WebSocket method, typed from upstream's RpcGroup in its wire form.
type Rpcs = RpcGroup.Rpcs<typeof WsRpcGroup>;
export type RpcTag = Rpcs extends infer R ? (R extends { readonly _tag: infer T extends string } ? (string extends T ? never : T) : never) : never;
type ByTag<T extends RpcTag> = Rpc.ExtractTag<Rpcs, T>;
export type RpcInput<T extends RpcTag> = Wire<ByTag<T>["payloadSchema"]>;
export type RpcOutput<T extends RpcTag> = Wire<Rpc.SuccessExitSchema<ByTag<T>>>;

export type Command = RpcInput<"orchestration.dispatchCommand">;
/** A command minus the `commandId` that `dispatch` stamps on. */
export type CommandFields = Command extends infer C ? (C extends Command ? Omit<C, "commandId"> : never) : never;
export type ShellSnapshot = Wire<typeof OrchestrationV2ShellSnapshot>;
export type ThreadProjection = Wire<typeof OrchestrationV2ThreadProjection>;

/** The orchestration protocol the pinned contracts speak. Bumping contracts to a new protocol fails typecheck here. */
const PROTOCOL: typeof ORCHESTRATION_PROTOCOL_VERSION = 2;

/** One authenticated connection to a T3 Code environment. Opens a single WebSocket lazily and multiplexes requests over it. */
export class T3Client {
  readonly origin: string;
  readonly #token: string;
  #socket: Promise<WebSocket> | undefined;
  #nextId = 0;

  constructor(origin: string, token: string) {
    this.origin = origin;
    this.#token = token;
  }

  shell(): Promise<ShellSnapshot> {
    return this.http("GET", "/api/orchestration/shell") as Promise<ShellSnapshot>;
  }

  async thread(threadId: string): Promise<ThreadProjection> {
    const { projection } = (await this.http("GET", `/api/orchestration/threads/${encodeURIComponent(threadId)}`)) as { projection: ThreadProjection };
    return projection;
  }

  async dispatch(fields: CommandFields): Promise<{ commandId: string; sequence: number }> {
    const commandId = randomUUID();
    return { commandId, ...(await this.call("orchestration.dispatchCommand", { ...fields, commandId } as Command)) };
  }

  /** A unary method: resolves with its single result. */
  async call<T extends RpcTag>(tag: T, payload: RpcInput<T>): Promise<RpcOutput<T>> {
    for await (const message of this.#request(tag, payload)) {
      if (message._tag === "Exit" && message.exit._tag === "Success") return message.exit.value as RpcOutput<T>;
    }
    throw new T3Error(`${tag}: connection closed before a result`);
  }

  /** A streaming method: yields each item, acking every chunk (the server withholds the next chunk until then). Ends quietly when `signal` aborts. */
  async *stream<T extends RpcTag>(tag: T, payload: RpcInput<T>, signal?: AbortSignal): AsyncGenerator<RpcOutput<T>> {
    for await (const message of this.#request(tag, payload, signal)) {
      if (message._tag !== "Chunk") continue;
      yield* message.values as readonly RpcOutput<T>[];
      this.#send({ _tag: "Ack", requestId: message.requestId });
    }
  }

  async *#request(tag: RpcTag, payload: unknown, signal?: AbortSignal): AsyncGenerator<FromServerEncoded> {
    const socket = await this.#connect();
    const id = String(++this.#nextId);
    // Subscribe before sending so no reply is missed.
    const messages = on(socket, "message", { close: ["close"], ...(signal ? { signal } : {}) });
    this.#send({ _tag: "Request", id, tag, payload, headers: [] });
    let done = false;
    try {
      for await (const [event] of messages) {
        const message = JSON.parse(String((event as MessageEvent).data)) as FromServerEncoded;
        if (message._tag === "Defect") throw new T3Error(`${tag}: server defect: ${JSON.stringify(message.defect)}`);
        if (!("requestId" in message) || String(message.requestId) !== id) continue;
        if (message._tag === "Exit") {
          done = true;
          if (message.exit._tag === "Failure") throw new T3Error(`${tag} failed: ${describeCause(message.exit.cause)}`);
        }
        yield message;
        if (done) return;
      }
      if (!signal?.aborted) throw new T3Error(`${tag}: websocket closed`);
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    } finally {
      if (!done && socket.readyState === WebSocket.OPEN) this.#send({ _tag: "Interrupt", requestId: id });
    }
  }

  #send(message: object): void {
    void this.#socket?.then((socket) => socket.send(JSON.stringify(message)));
  }

  #connect(): Promise<WebSocket> {
    this.#socket ??= (async () => {
      const { ticket } = (await this.http("POST", "/api/auth/websocket-ticket")) as { ticket: string };
      const url = new URL("/ws", this.origin.replace(/^http/, "ws"));
      url.searchParams.set("wsTicket", ticket);
      url.searchParams.set("clientSurface", "cli");
      url.searchParams.set("orchestrationProtocol", String(PROTOCOL));
      const socket = new WebSocket(url);
      const opened = await new Promise((resolve) => {
        socket.addEventListener("open", () => resolve(true), { once: true });
        socket.addEventListener("error", () => resolve(false), { once: true });
      });
      if (opened) return socket;
      const { orchestrationProtocolVersion = 1, serverVersion } = await fetchEnvironment(this.origin);
      if (orchestrationProtocolVersion !== PROTOCOL) {
        throw new T3Error(`server ${serverVersion} speaks orchestration protocol ${orchestrationProtocolVersion}; this t3c speaks ${PROTOCOL}. Update t3c.`);
      }
      throw new T3Error(`websocket connect failed: ${url.origin}`);
    })();
    return this.#socket;
  }

  close(): void {
    void this.#socket?.then((socket) => socket.close(), () => {});
  }

  /** Authenticated HTTP for the few endpoints that have no WebSocket method. */
  async http(method: "GET" | "POST", path: string, body?: { json: unknown } | { bytes: Uint8Array; mimeType: string }): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}`, "x-t3-orchestration-protocol": String(PROTOCOL) };
    let payload: string | Uint8Array | undefined;
    if (body && "json" in body) [headers["content-type"], payload] = ["application/json", JSON.stringify(body.json)];
    if (body && "bytes" in body) [headers["content-type"], payload] = [body.mimeType, body.bytes];
    const response = await fetch(this.origin + path, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
    const text = await response.text();
    if (!response.ok) throw new T3Error(`${method} ${path} -> ${response.status}: ${describeHttpError(text)}`);
    return text ? JSON.parse(text) : undefined;
  }
}

function describeHttpError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: string; issue?: unknown };
    return parsed.message ?? (parsed.issue ? JSON.stringify(parsed.issue) : text);
  } catch {
    return text;
  }
}

function describeCause(cause: readonly { _tag: string; error?: unknown; defect?: unknown }[]): string {
  return cause
    .map((entry) => {
      const detail = entry.error ?? entry.defect;
      if (detail && typeof detail === "object" && "message" in detail) return String(detail.message);
      return JSON.stringify(detail ?? entry._tag);
    })
    .join("; ");
}

export async function fetchEnvironment(origin: string, timeoutMs = 2500): Promise<ExecutionEnvironmentDescriptor> {
  const response = await fetch(`${origin}/.well-known/t3/environment`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new T3Error(`${origin} is not a T3 Code server (${response.status})`);
  return (await response.json()) as ExecutionEnvironmentDescriptor;
}
