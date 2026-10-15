import { on } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  WsRpcGroup,
} from "@t3tools/contracts";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import type { FromServerEncoded } from "effect/unstable/rpc/RpcMessage";
import { T3Error, TimeoutError } from "./errors.ts";

// Every WebSocket method, typed from upstream's RpcGroup. Payloads are what goes on
// the wire (Encoded); results are the decoded shapes, which for these schemas are
// plain JSON with branded strings.
type Rpcs = RpcGroup.Rpcs<typeof WsRpcGroup>;
export type RpcTag = Rpcs extends infer R ? (R extends { readonly _tag: infer T extends string } ? (string extends T ? never : T) : never) : never;
type ByTag<T extends RpcTag> = Rpc.ExtractTag<Rpcs, T>;
export type RpcInput<T extends RpcTag> = ByTag<T>["payloadSchema"]["Encoded"];
export type RpcOutput<T extends RpcTag> = Rpc.SuccessExitSchema<ByTag<T>>["Type"];

export type Command = RpcInput<"orchestration.dispatchCommand">;
/** A command minus the `commandId` and `createdAt` that `dispatch` stamps on. */
export type CommandFields = Command extends infer C ? (C extends Command ? Omit<C, "commandId" | "createdAt"> : never) : never;

/** The orchestration protocol the pinned contracts speak. Bumping contracts to a new protocol fails typecheck here. */
const PROTOCOL: typeof ORCHESTRATION_PROTOCOL_VERSION = 1;

/**
 * One authenticated connection to a T3 Code environment. Opens a single WebSocket lazily and multiplexes requests over it.
 * Once `deadline` aborts, every request, including connecting, fails with a TimeoutError.
 */
export class T3Client {
  readonly origin: string;
  readonly #token: string;
  readonly #deadline: AbortSignal | undefined;
  #socket: Promise<WebSocket> | undefined;
  #nextId = 0;

  constructor(origin: string, token: string, deadline?: AbortSignal) {
    this.origin = origin;
    this.#token = token;
    this.#deadline = deadline;
  }

  shell(): Promise<OrchestrationShellSnapshot> {
    return this.http("GET", "/api/orchestration/shell") as Promise<OrchestrationShellSnapshot>;
  }

  thread(threadId: string, turnLimit?: number): Promise<OrchestrationThreadDetailSnapshot> {
    const query = turnLimit ? `?turnLimit=${turnLimit}` : "";
    return this.http("GET", `/api/orchestration/threads/${encodeURIComponent(threadId)}${query}`) as Promise<OrchestrationThreadDetailSnapshot>;
  }

  /** Stamps and dispatches a command over the WebSocket, the only path that runs `bootstrap`. */
  async dispatch(fields: CommandFields): Promise<{ commandId: string; sequence: number }> {
    const commandId = randomUUID();
    const command = { ...fields, commandId, createdAt: new Date().toISOString() } as Command;
    return { commandId, ...(await this.call("orchestration.dispatchCommand", command)) };
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
    const abort = [signal, this.#deadline].filter((each) => each !== undefined);
    // Subscribe before sending so no reply is missed.
    const messages = on(socket, "message", { close: ["close"], ...(abort.length ? { signal: AbortSignal.any(abort) } : {}) });
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
      throw new T3Error(`${tag}: websocket closed`);
    } catch (error) {
      if (this.#deadline?.aborted) throw new TimeoutError(`timed out during ${tag}`);
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
        this.#deadline?.addEventListener("abort", () => resolve(false), { once: true });
      });
      if (opened) return socket;
      socket.close();
      if (this.#deadline?.aborted) throw new TimeoutError("timed out connecting the websocket");
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
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}` };
    let payload: string | Uint8Array | undefined;
    if (body && "json" in body) [headers["content-type"], payload] = ["application/json", JSON.stringify(body.json)];
    if (body && "bytes" in body) [headers["content-type"], payload] = [body.mimeType, body.bytes];
    let response: Response, text: string;
    try {
      response = await fetch(this.origin + path, { method, headers, signal: this.#deadline ?? null, ...(payload === undefined ? {} : { body: payload }) });
      text = await response.text();
    } catch (error) {
      if (this.#deadline?.aborted) throw new TimeoutError(`timed out during ${method} ${path}`);
      throw error;
    }
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
