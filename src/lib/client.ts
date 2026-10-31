import {
  type AbortResponse,
  type ChangePasswordRequest,
  type ClientMessage,
  type CreateChatRequest,
  type CreateChatResponse,
  type CreateMcpServerRequest,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type ErrorResponse,
  type FinishMcpLoginRequest,
  type HealthResponse,
  type LoginRequest,
  type LoginResponse,
  type McpServerResponse,
  type McpServersResponse,
  type ModelsResponse,
  type RewindRequest,
  type ServerMessage,
  type StartMcpLoginResponse,
  UNAUTHORIZED_CLOSE_CODE,
  type UpdateChatRequest,
  type UpdateChatResponse,
  type UpdateMcpServerRequest,
  type UpdateProjectRequest,
  type UpdateProjectResponse,
  type UploadArtefactResponse,
} from "../../shared/protocol";

export type ConnectionStatus = "connecting" | "open" | "offline";

const MAX_RETRY_DELAY_MS = 5000;

/**
 * Talks to one backend as one logged-in user: REST for commands, a WebSocket for live state. Reconnects
 * on its own, until the backend says the session is over.
 */
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

  constructor(
    readonly baseUrl: string,
    private token: string,
    /** Called when the backend refuses the token: the user logged out elsewhere, or it changed. */
    private onUnauthorized: () => void,
  ) {}

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

  createChat(body: CreateChatRequest, files: File[] = []) {
    return this.request<CreateChatResponse>("/api/chats", {
      method: "POST",
      body: withFiles(body, files),
    });
  }

  sendMessage(chatId: string, message: string, files: File[] = []) {
    return this.request(`${chatPath(chatId)}/messages`, {
      method: "POST",
      body: withFiles({ message }, files),
    });
  }

  abort(chatId: string) {
    return this.request<AbortResponse>(`${chatPath(chatId)}/abort`, {
      method: "POST",
    });
  }

  updateChat(chatId: string, body: UpdateChatRequest) {
    return this.request<UpdateChatResponse>(chatPath(chatId), {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  /** Ends the session on the backend. */
  logout() {
    return this.request("/api/auth/logout", { method: "POST" });
  }

  changePassword(body: ChangePasswordRequest) {
    return this.request("/api/auth/password", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  rewind(chatId: string, body: RewindRequest) {
    return this.request(`${chatPath(chatId)}/rewind`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  createProject(body: CreateProjectRequest) {
    return this.request<CreateProjectResponse>("/api/projects", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  updateProject(projectId: string, body: UpdateProjectRequest) {
    return this.request<UpdateProjectResponse>(projectPath(projectId), {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  /** Replaces the artefact with the file's name, if there is one. */
  uploadArtefact(projectId: string, file: File) {
    return this.request<UploadArtefactResponse>(
      artefactPath(projectId, file.name),
      {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      },
    );
  }

  deleteArtefact(projectId: string, name: string) {
    return this.request(artefactPath(projectId, name), { method: "DELETE" });
  }

  /** Downloads the artefact when opened. */
  artefactUrl(projectId: string, name: string) {
    return this.fileUrl(artefactPath(projectId, name));
  }

  /** Downloads a file attached to a message of the chat when opened. */
  attachmentUrl(chatId: string, name: string) {
    return this.fileUrl(
      `${chatPath(chatId)}/attachments/${encodeURIComponent(name)}`,
    );
  }

  getMcpServers() {
    return this.request<McpServersResponse>("/api/mcp");
  }

  createMcpServer(body: CreateMcpServerRequest) {
    return this.request<McpServerResponse>("/api/mcp/servers", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  updateMcpServer(name: string, body: UpdateMcpServerRequest) {
    return this.request<McpServerResponse>(mcpServerPath(name), {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  deleteMcpServer(name: string) {
    return this.request(mcpServerPath(name), { method: "DELETE" });
  }

  startMcpLogin(name: string) {
    return this.request<StartMcpLoginResponse>(`${mcpServerPath(name)}/login`, {
      method: "POST",
    });
  }

  finishMcpLogin(name: string, body: FinishMcpLoginRequest) {
    return this.request(`${mcpServerPath(name)}/redirect`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  mcpLogout(name: string) {
    return this.request(`${mcpServerPath(name)}/logout`, { method: "POST" });
  }

  /** An image in the chat's folder, which Pi embeds in a reply by its path. */
  imageUrl(chatId: string, path: string) {
    return this.fileUrl(
      `${chatPath(chatId)}/images/${encodeURIComponent(path)}`,
    );
  }

  /** URL of a GET endpoint for links and images, which can't send the token in a header. */
  private fileUrl(path: string) {
    return `${this.baseUrl}${path}?token=${encodeURIComponent(this.token)}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      ...init,
      headers: {
        // Form data gets its Content-Type, with the boundary, from fetch.
        ...(init?.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        Authorization: `Bearer ${this.token}`,
        ...init?.headers,
      },
    });
    if (response.status === 401) this.unauthorized();
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        (body as ErrorResponse | null)?.error ??
          (response.status === 413
            ? "That's too large to upload"
            : `Request failed (${response.status})`),
      );
    return body as T;
  }

  private open() {
    if (this.closed) return;
    this.setStatus(this.retries === 0 ? "connecting" : "offline");
    const ws = new WebSocket(
      `${webSocketUrl(this.baseUrl)}?token=${encodeURIComponent(this.token)}`,
    );
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
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (event.code === UNAUTHORIZED_CLOSE_CODE) return this.unauthorized();
      this.setStatus("offline");
      this.scheduleReconnect();
    };
  }

  private unauthorized() {
    if (this.closed) return;
    this.close();
    this.onUnauthorized();
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

const chatPath = (chatId: string) => `/api/chats/${encodeURIComponent(chatId)}`;
const projectPath = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}`;
const artefactPath = (projectId: string, name: string) =>
  `${projectPath(projectId)}/artefacts/${encodeURIComponent(name)}`;
const mcpServerPath = (name: string) =>
  `/api/mcp/servers/${encodeURIComponent(name)}`;

/** A JSON request body, or with files, a multipart one with the JSON in its `request` field. */
function withFiles(body: object, files: File[]): string | FormData {
  if (!files.length) return JSON.stringify(body);
  const form = new FormData();
  form.append("request", JSON.stringify(body));
  for (const file of files) form.append("files", file, file.name);
  return form;
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

/** Logs in, for a token to make a BackendClient with. */
export async function login(
  baseUrl: string,
  body: LoginRequest,
): Promise<LoginResponse> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Couldn't reach the backend at ${baseUrl}`);
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      (result as ErrorResponse | null)?.error ??
        `Logging in failed (${response.status})`,
    );
  return result as LoginResponse;
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
