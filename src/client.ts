import type {
  ClientCommand,
  DispatchResult,
  EnvironmentDescriptor,
  ServerConfig,
  ShellSnapshot,
  ThreadDetailSnapshot,
  WebSocketTicketResult,
} from "./contracts.ts";

export class T3Error extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

type RpcExit =
  | { _tag: "Success"; value: unknown }
  | { _tag: "Failure"; cause: { _tag: string; error?: unknown; defect?: unknown }[] };
type RpcFromServer =
  | { _tag: "Chunk"; requestId: string; values: unknown[] }
  | { _tag: "Exit"; requestId: string; exit: RpcExit }
  | { _tag: "Pong" }
  | { _tag: "Defect"; defect: unknown }
  | { _tag: string; [key: string]: unknown };

export class T3Client {
  readonly origin: string;
  private readonly token: string;
  constructor(origin: string, token: string) {
    this.origin = origin;
    this.token = token;
  }

  async environment(): Promise<EnvironmentDescriptor> {
    return fetchEnvironment(this.origin);
  }

  shell(): Promise<ShellSnapshot> {
    return this.get("/api/orchestration/shell");
  }

  thread(threadId: string, turnLimit?: number): Promise<ThreadDetailSnapshot> {
    const query = turnLimit ? `?turnLimit=${turnLimit}` : "";
    return this.get(`/api/orchestration/threads/${encodeURIComponent(threadId)}${query}`);
  }

  dispatch(command: ClientCommand): Promise<DispatchResult> {
    if ("bootstrap" in command && command.bootstrap) return this.rpc("orchestration.dispatchCommand", command) as Promise<DispatchResult>;
    return this.post("/api/orchestration/dispatch", command);
  }

  config(): Promise<ServerConfig> {
    return this.rpc("server.getConfig", {}) as Promise<ServerConfig>;
  }

  async uploadBytes(relativeUrl: string, mimeType: string, bytes: Uint8Array): Promise<void> {
    const response = await fetch(this.origin + relativeUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": mimeType },
      body: bytes,
    });
    if (!response.ok) throw new T3Error(`upload failed: ${response.status} ${await response.text()}`);
  }

  async rpc(tag: string, payload: unknown): Promise<unknown> {
    const values: unknown[] = [];
    for await (const value of this.subscribe(tag, payload)) values.push(value);
    return values.length === 1 ? values[0] : values;
  }

  async *subscribe(tag: string, payload: unknown, signal?: AbortSignal): AsyncGenerator<unknown> {
    const socket = await this.openSocket();
    const requestId = "1";
    const queue: RpcFromServer[] = [];
    let wake: (() => void) | null = null;
    let closed: Error | null | undefined;
    const settle = (error: Error | null) => {
      closed = error;
      wake?.();
    };
    socket.addEventListener("message", (event) => {
      queue.push(JSON.parse(String(event.data)) as RpcFromServer);
      wake?.();
    });
    socket.addEventListener("close", () => settle(null));
    socket.addEventListener("error", () => settle(new T3Error("websocket error")));
    signal?.addEventListener("abort", () => {
      socket.send(JSON.stringify({ _tag: "Interrupt", requestId }));
      socket.close();
    });
    socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
    try {
      while (true) {
        const message = queue.shift();
        if (!message) {
          if (closed !== undefined) {
            if (closed) throw closed;
            return;
          }
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
          continue;
        }
        if (message._tag === "Chunk") {
          for (const value of (message as { values: unknown[] }).values) yield value;
          socket.send(JSON.stringify({ _tag: "Ack", requestId }));
        } else if (message._tag === "Exit") {
          const exit = (message as { exit: RpcExit }).exit;
          if (exit._tag === "Failure") throw new T3Error(`${tag} failed: ${describeCause(exit.cause)}`);
          if (exit.value !== undefined) yield exit.value;
          return;
        } else if (message._tag === "Defect") {
          throw new T3Error(`${tag} defect: ${JSON.stringify(message.defect)}`);
        }
      }
    } finally {
      if (socket.readyState === WebSocket.OPEN) socket.close();
    }
  }

  private async openSocket(): Promise<WebSocket> {
    const ticket: WebSocketTicketResult = await this.post("/api/auth/websocket-ticket", {});
    const url = new URL("/ws", this.origin.replace(/^http/, "ws"));
    url.searchParams.set("wsTicket", ticket.ticket);
    url.searchParams.set("clientSurface", "cli");
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new T3Error(`websocket connect failed: ${url.origin}`)), { once: true });
    });
    return socket;
  }

  private async get<T>(path: string): Promise<T> {
    return this.request("GET", path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request("POST", path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.origin + path, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new T3Error(`${method} ${path} -> ${response.status}: ${describeHttpError(text)}`);
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }
}

function describeHttpError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: string; _tag?: string; issue?: unknown };
    if (parsed.message) return parsed.message;
    if (parsed.issue) return JSON.stringify(parsed.issue);
    return text;
  } catch {
    return text;
  }
}

function describeCause(cause: { _tag: string; error?: unknown; defect?: unknown }[]): string {
  return cause
    .map((entry) => {
      const detail = entry.error ?? entry.defect;
      if (detail && typeof detail === "object" && "message" in detail) return String((detail as { message: unknown }).message);
      return JSON.stringify(detail ?? entry._tag);
    })
    .join("; ");
}

export async function fetchEnvironment(origin: string, timeoutMs = 2500): Promise<EnvironmentDescriptor> {
  const response = await fetch(`${origin}/.well-known/t3/environment`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new T3Error(`${origin} is not a T3 Code server (${response.status})`);
  return (await response.json()) as EnvironmentDescriptor;
}
