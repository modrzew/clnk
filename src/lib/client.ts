import type {
  ClientMessage,
  CreateChatRequest,
  CreateChatResponse,
  ErrorResponse,
  HealthResponse,
  ModelsResponse,
  ServerMessage,
} from "../../shared/protocol";

export type ConnectionStatus = "connecting" | "open" | "offline";

const MAX_RETRY_DELAY_MS = 5000;

/** Talks to one backend: REST for commands, a WebSocket for live state. Reconnects on its own. */
export class BackendClient {
  status: ConnectionStatus = "connecting";
  private ws: WebSocket | null = null;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  /** Chat id -> number of active subscribers, re-sent after every reconnect. */
  private subscriptions = new Map<string, number>();
  private messageListeners = new Set<(msg: ServerMessage) => void>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();

  constructor(readonly baseUrl: string) {}

  connect() {
    this.closed = false;
    window.addEventListener("online", this.reconnectNow);
    document.addEventListener("visibilitychange", this.reconnectNow);
    this.open();
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    window.removeEventListener("online", this.reconnectNow);
    document.removeEventListener("visibilitychange", this.reconnectNow);
    this.ws?.close();
    this.ws = null;
  }

  onMessage(listener: (msg: ServerMessage) => void) {
    this.messageListeners.add(listener);
    return () => void this.messageListeners.delete(listener);
  }

  onStatus(listener: (status: ConnectionStatus) => void) {
    this.statusListeners.add(listener);
    return () => void this.statusListeners.delete(listener);
  }

  /** Each (re)subscription is answered with a snapshot of the chat. */
  subscribe(chatId: string) {
    const count = this.subscriptions.get(chatId) ?? 0;
    this.subscriptions.set(chatId, count + 1);
    if (count === 0) this.send({ type: "subscribe", chatId });
    return () => {
      const remaining = (this.subscriptions.get(chatId) ?? 1) - 1;
      if (remaining > 0) return void this.subscriptions.set(chatId, remaining);
      this.subscriptions.delete(chatId);
      this.send({ type: "unsubscribe", chatId });
    };
  }

  getModels() {
    return this.request<ModelsResponse>("/api/models");
  }

  createChat(body: CreateChatRequest) {
    return this.request<CreateChatResponse>("/api/chats", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  sendMessage(chatId: string, message: string) {
    return this.request(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        (body as ErrorResponse | null)?.error ??
          `Request failed (${response.status})`,
      );
    return body as T;
  }

  private open() {
    if (this.closed) return;
    this.setStatus(this.retries === 0 ? "connecting" : "offline");
    const ws = new WebSocket(webSocketUrl(this.baseUrl));
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      for (const chatId of this.subscriptions.keys())
        this.send({ type: "subscribe", chatId });
      this.setStatus("open");
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      for (const listener of this.messageListeners) listener(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus("offline");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    const delay = Math.min(500 * 2 ** this.retries, MAX_RETRY_DELAY_MS);
    this.retries++;
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  /** Mobile browsers drop sockets in the background; retry right away when the app comes back. */
  private reconnectNow = () => {
    if (this.closed || this.ws || document.visibilityState !== "visible")
      return;
    clearTimeout(this.retryTimer);
    this.open();
  };

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(msg));
  }

  private setStatus(status: ConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

function webSocketUrl(baseUrl: string) {
  const url = new URL(`${baseUrl}/api/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Accepts "host:port" or a full URL; returns an origin-like URL without a trailing slash. */
export function normalizeBackendUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  const url = new URL(withScheme);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export async function checkBackend(baseUrl: string): Promise<void> {
  let health: HealthResponse | null = null;
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    health = (await response.json()) as HealthResponse;
  } catch {}
  if (health?.name !== "clnk")
    throw new Error(`Couldn't reach a clnk backend at ${baseUrl}`);
}
