// Client-server protocol shared by the backend (server/) and the web UI (src/).
//
// Message shapes mirror the subset of Pi's AgentMessage types the UI renders. They are declared here
// instead of imported from the Pi SDK so the client doesn't depend on Pi's packages. Fields the UI
// doesn't use yet (usage, signatures, tool details) still arrive over the wire.

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCall;

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  provider: string;
  model: string;
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  timestamp: number;
}

/** A message injected by a Pi extension. Only messages with `display: true` are sent. */
export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  timestamp: number;
}

/** Marks the point where Pi compacted the context. Earlier messages stay in the transcript. */
export interface CompactionMarker {
  role: "compaction";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export type ChatMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage | CompactionMarker;

export type ChatStatus = "idle" | "running";

export interface ModelRef {
  provider: string;
  id: string;
}

export interface ModelInfo extends ModelRef {
  name: string;
  reasoning: boolean;
  contextWindow: number;
}

export interface ChatSummary {
  id: string;
  title: string;
  model: ModelRef;
  status: ChatStatus;
  createdAt: number;
  updatedAt: number;
}

// REST: JSON bodies under /api. Failed requests return ErrorResponse with a 4xx/5xx status.

/** GET /api/health */
export interface HealthResponse {
  ok: true;
  name: "clnk";
  version: string;
}

/** GET /api/models */
export interface ModelsResponse {
  models: ModelInfo[];
  defaultModel: ModelRef | null;
}

/** GET /api/chats, sorted by most recently updated */
export interface ChatsResponse {
  chats: ChatSummary[];
}

/** POST /api/chats: creates the chat and starts a run with the first message. */
export interface CreateChatRequest {
  model: ModelRef;
  message: string;
}

export interface CreateChatResponse {
  chat: ChatSummary;
}

/** POST /api/chats/:id/messages: starts a run. 409 while the chat is already running. */
export interface SendMessageRequest {
  message: string;
}

export interface ErrorResponse {
  error: string;
}

// WebSocket: /api/ws, one JSON message per frame.

export type ClientMessage = { type: "subscribe"; chatId: string } | { type: "unsubscribe"; chatId: string };

export type ServerMessage =
  /** First message on every connection: all of the user's chats. */
  | { type: "chats"; chats: ChatSummary[] }
  /** Sent to every connected client of the chat's owner when a chat is created or changes. */
  | { type: "chat_updated"; chat: ChatSummary }
  /** Full state of a chat, sent in reply to subscribe. Replaces whatever the client had. */
  | { type: "snapshot"; chat: ChatSummary; messages: ChatMessage[]; streaming: AssistantMessage | null }
  /** A finished message was appended. An assistant message replaces the streaming one. */
  | { type: "message"; chatId: string; message: ChatMessage }
  /** An assistant message started streaming. */
  | { type: "stream_start"; chatId: string; message: AssistantMessage }
  /** A content block of the streaming message was added or finalized. */
  | { type: "stream_block"; chatId: string; index: number; block: AssistantContent }
  /** Text appended to a text or thinking block of the streaming message. */
  | { type: "stream_delta"; chatId: string; index: number; delta: string }
  /** A run failed without producing an assistant error message. */
  | { type: "run_error"; chatId: string; error: string }
  | { type: "error"; error: string };
