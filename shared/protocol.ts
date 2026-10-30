// Client-server protocol shared by the backend (server/) and the web UI (src/).
//
// Message shapes mirror the subset of Pi's AgentMessage types the UI renders. They are declared here
// instead of imported from the Pi SDK so the client doesn't depend on Pi's packages. Fields the UI
// doesn't use yet (usage, signatures) still arrive over the wire.

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
  stopReason:
    | "pending"
    | "stop"
    | "length"
    | "toolUse"
    | "error"
    | "aborted"
    | "deferred";
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  /** Tool-specific extras, e.g. `{ diff: string }` from the edit tool. */
  details?: unknown;
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

export type ChatMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | CustomMessage
  | CompactionMarker;

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

/** How full the model's context window is. */
export interface ContextUsage {
  /** Null while unknown: after compaction, until the next response. */
  tokens: number | null;
  contextWindow: number;
}

export interface ChatSummary {
  id: string;
  title: string;
  /** The project the chat was started in, for good. Null for chats outside of projects. */
  projectId: string | null;
  model: ModelRef;
  status: ChatStatus;
  archived: boolean;
  /** As of the last response. Null until a session reported it. */
  context: ContextUsage | null;
  createdAt: number;
  updatedAt: number;
}

/** A file of a project, shared by all of its chats. Pi sees them in its chat folder under `artefacts/`. */
export interface ArtefactInfo {
  /** File name, unique within the project. */
  name: string;
  size: number;
  /** When the file was uploaded or saved, or last replaced. */
  updatedAt: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  /** Added to the system prompt of every chat in the project. Empty when there are none. */
  instructions: string;
  /** Archived projects are read-only: no new chats or artefact changes, and their chats can't be continued. */
  archived: boolean;
  /** Sorted by name. */
  artefacts: ArtefactInfo[];
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

/**
 * POST /api/chats: creates the chat and starts a run with the first message. 409 if the project is
 * archived.
 */
export interface CreateChatRequest {
  model: ModelRef;
  message: string;
  /** Starts the chat in this project. */
  projectId?: string;
}

export interface CreateChatResponse {
  chat: ChatSummary;
}

/**
 * POST /api/chats/:id/messages: starts a run. While the chat is running, the message steers the run
 * instead: Pi reads it after its current step. 409 for archived chats and chats of archived projects.
 */
export interface SendMessageRequest {
  message: string;
}

/** POST /api/chats/:id/abort: stops the run. Steering messages Pi hasn't read yet are dropped and returned. */
export interface AbortResponse {
  queued: string[];
}

/** PATCH /api/chats/:id: any subset of the fields. */
export interface UpdateChatRequest {
  model?: ModelRef;
  archived?: boolean;
}

export interface UpdateChatResponse {
  chat: ChatSummary;
}

/**
 * POST /api/chats/:id/rewind: edits or retries a user message, identified by its timestamp. The
 * transcript is cut back to just before it, and it's sent again: as `message` if given, otherwise
 * unchanged. 409 while the chat is running or archived (or its project is), or if the message is no
 * longer in the chat.
 */
export interface RewindRequest {
  timestamp: number;
  message?: string;
}

/** GET /api/projects, sorted by name */
export interface ProjectsResponse {
  projects: ProjectSummary[];
}

/** POST /api/projects */
export interface CreateProjectRequest {
  name: string;
  instructions?: string;
}

export interface CreateProjectResponse {
  project: ProjectSummary;
}

/** PATCH /api/projects/:id: any subset of the fields. Allowed for archived projects too. */
export interface UpdateProjectRequest {
  name?: string;
  instructions?: string;
  archived?: boolean;
}

export interface UpdateProjectResponse {
  project: ProjectSummary;
}

/*
 * Artefacts, with the file name URL-encoded as the last path segment:
 * - GET /api/projects/:id/artefacts/:name downloads the file.
 * - PUT /api/projects/:id/artefacts/:name uploads the request body as the file, replacing one with the
 *   same name. Responds with UploadArtefactResponse.
 * - DELETE /api/projects/:id/artefacts/:name deletes it.
 * Uploads and deletes are refused with 409 while the project is archived.
 */
export interface UploadArtefactResponse {
  artefact: ArtefactInfo;
}

export interface ErrorResponse {
  error: string;
}

// WebSocket: /api/ws, one JSON message per frame.

export type ClientMessage =
  | { type: "subscribe"; chatId: string }
  | { type: "unsubscribe"; chatId: string };

export type ServerMessage =
  /** First message on every connection: all of the user's projects. */
  | { type: "projects"; projects: ProjectSummary[] }
  /** Sent right after `projects` on every connection: all of the user's chats. */
  | { type: "chats"; chats: ChatSummary[] }
  /**
   * Sent to every connected client of the project's owner when a project is created or changes,
   * including its artefacts.
   */
  | { type: "project_updated"; project: ProjectSummary }
  /** Sent to every connected client of the chat's owner when a chat is created or changes. */
  | { type: "chat_updated"; chat: ChatSummary }
  /** Sent to every connected client of the chat's owner, e.g. when creating the chat failed. */
  | { type: "chat_deleted"; chatId: string }
  /**
   * Full state of a chat. Replaces whatever the client had. Sent in reply to subscribe, and to all
   * subscribers when the transcript is rewound.
   */
  | {
      type: "snapshot";
      chat: ChatSummary;
      messages: ChatMessage[];
      streaming: AssistantMessage | null;
      toolOutput: Record<string, string>;
      queued: string[];
      activity: string | null;
    }
  /** A finished message was appended. An assistant message replaces the streaming one. */
  | { type: "message"; chatId: string; message: ChatMessage }
  /** An assistant message started streaming. */
  | { type: "stream_start"; chatId: string; message: AssistantMessage }
  /** A content block of the streaming message was added or finalized. */
  | {
      type: "stream_block";
      chatId: string;
      index: number;
      block: AssistantContent;
    }
  /** Text appended to a text or thinking block of the streaming message. */
  | { type: "stream_delta"; chatId: string; index: number; delta: string }
  /** Output so far of a tool call that is still running. `append` adds to the output sent before. */
  | {
      type: "tool_output";
      chatId: string;
      toolCallId: string;
      text: string;
      append: boolean;
    }
  /** Steering messages Pi hasn't read yet. */
  | { type: "queue"; chatId: string; queued: string[] }
  /** What Pi is doing besides responding, e.g. compacting the context. Null when nothing. */
  | { type: "activity"; chatId: string; activity: string | null }
  /** A run failed without producing an assistant error message. */
  | { type: "run_error"; chatId: string; error: string }
  | { type: "error"; error: string };
