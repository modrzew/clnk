import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type {
  ChatMessage,
  ChatStatus,
  ChatSummary,
  ContextUsage,
  ModelRef,
  RewindRequest,
  ServerMessage,
  UpdateChatRequest,
} from "../shared/protocol";
import {
  applyServerMessage,
  emptyTranscript,
  type TranscriptState,
} from "../shared/transcript";
import type { ChatRow, Db } from "./db";
import {
  compactionMarker,
  hasModel,
  openChatSession,
  type PiHost,
  readTranscript,
  toChatMessage,
  transcriptFromEntries,
} from "./pi";
import { streamMessage, toolOutputMessage } from "./stream";

export type Publish = (topic: string, message: ServerMessage) => void;

export const userTopic = (userId: string) => `user:${userId}`;
export const chatTopic = (chatId: string) => `chat:${chatId}`;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A chat whose Pi session is loaded in memory. */
interface Runtime {
  session: AgentSession;
  /** The transcript clients see: the published events applied with the clients' own reducer. */
  transcript: TranscriptState;
  /** Between Pi's agent_start and agent_settled. Covers runs Pi or an extension starts on its own. */
  agentActive: boolean;
  unsubscribe: () => void;
  idleTimer?: ReturnType<typeof setTimeout>;
}

type Snapshot = Extract<ServerMessage, { type: "snapshot" }>;

export interface ChatServiceOptions {
  db: Db;
  pi: PiHost;
  dataDir: string;
  publish: Publish;
  /** How long an idle chat keeps its Pi session loaded. */
  idleTimeoutMs?: number;
}

const TITLE_LENGTH = 80;

/**
 * Owns the Pi sessions behind chats. Runs continue whether or not any client is connected; clients
 * subscribe to a chat topic and get a snapshot followed by live events.
 */
export class ChatService {
  private runtimes = new Map<string, Runtime>();
  private loading = new Map<string, Promise<Runtime>>();
  /** Number of prompt() calls in flight per chat, including while its session is still loading. */
  private prompting = new Map<string, number>();
  /** Chats whose transcript is being cut back for an edit or retry. */
  private rewinding = new Set<string>();
  private runs = new Set<Promise<void>>();
  private closing = false;
  private publishedStatus = new Map<string, ChatStatus>();
  private idleTimeoutMs: number;

  constructor(private options: ChatServiceOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
  }

  listChats(userId: string): ChatSummary[] {
    return this.options.db.listChats(userId).map((chat) => this.summary(chat));
  }

  async createChat(
    userId: string,
    model: ModelRef,
    message: string,
  ): Promise<ChatSummary> {
    if (!message.trim()) throw new HttpError(400, "Message is empty");
    if (!hasModel(this.options.pi, model))
      throw new HttpError(
        400,
        `Model ${model.provider}/${model.id} is not available`,
      );
    const now = Date.now();
    const chat: ChatRow = {
      id: randomUUID(),
      userId,
      title: titleFrom(message),
      model,
      sessionFile: null,
      archivedAt: null,
      context: null,
      createdAt: now,
      updatedAt: now,
    };
    this.options.db.insertChat(chat);
    try {
      await this.startRun(chat, message);
    } catch (error) {
      this.unload(chat.id);
      const { sessionFile } = this.getChat(userId, chat.id);
      this.options.db.deleteChat(chat.id);
      this.options.publish(userTopic(userId), {
        type: "chat_deleted",
        chatId: chat.id,
      });
      try {
        if (sessionFile)
          rmSync(join(this.options.dataDir, sessionFile), { force: true });
        rmSync(this.workspaceDir(chat), { recursive: true, force: true });
      } catch {}
      throw error;
    }
    return this.summary(this.getChat(userId, chat.id));
  }

  /** Starts a run, or steers the one in progress: Pi reads the message after its current step. */
  async sendMessage(
    userId: string,
    chatId: string,
    message: string,
  ): Promise<void> {
    const chat = this.getOpenChat(userId, chatId);
    if (this.rewinding.has(chatId)) throw busy();
    await this.startRun(chat, message);
  }

  /** Stops the chat's run. Returns the steering messages Pi hadn't read yet, which are dropped. */
  async abort(userId: string, chatId: string): Promise<string[]> {
    this.getChat(userId, chatId);
    const runtime = await this.loadedRuntime(chatId);
    if (!runtime) return [];
    const { steering, followUp } = runtime.session.clearQueue();
    await runtime.session.abort();
    return [...steering, ...followUp];
  }

  async updateChat(
    userId: string,
    chatId: string,
    update: UpdateChatRequest,
  ): Promise<ChatSummary> {
    const chat = this.getChat(userId, chatId);
    if (update.model) await this.switchModel(chat, update.model);
    if (update.archived !== undefined)
      this.options.db.setArchived(
        chatId,
        update.archived ? (chat.archivedAt ?? Date.now()) : null,
      );
    this.publishChat(chatId);
    return this.summary(this.getChat(userId, chatId));
  }

  /**
   * Edits or retries a user message: cuts the transcript back to just before it and sends it again.
   * Pi keeps the cut-off messages on another branch of the session, which clnk doesn't show.
   */
  async rewind(
    userId: string,
    chatId: string,
    { timestamp, message }: RewindRequest,
  ): Promise<void> {
    const chat = this.getOpenChat(userId, chatId);
    if (message !== undefined && !message.trim())
      throw new HttpError(400, "Message is empty");
    if (this.closing) throw new HttpError(503, "Server is shutting down");
    if (this.status(chatId) === "running") throw busy();

    this.rewinding.add(chatId);
    this.refreshStatus(chatId);
    try {
      const text = await this.cutBefore(chat, timestamp, message);
      this.rewinding.delete(chatId);
      await this.startRun(chat, text);
    } finally {
      this.rewinding.delete(chatId);
      this.refreshStatus(chatId);
    }
  }

  /** Current state of a chat for a client that just subscribed, or null if the user has no such chat. */
  snapshot(userId: string, chatId: string): Snapshot | null {
    const chat = this.options.db.getChat(userId, chatId);
    if (!chat) return null;
    const runtime = this.runtimes.get(chatId);
    if (runtime) return this.snapshotOf(chat, runtime.transcript);
    const messages = chat.sessionFile
      ? readTranscript(
          join(this.options.dataDir, chat.sessionFile),
          this.sessionDir(chat.userId),
          this.workspaceDir(chat),
        )
      : [];
    return this.snapshotOf(chat, { ...emptyTranscript, messages });
  }

  /** Aborts runs in progress and disposes every Pi session. */
  async shutdown() {
    this.closing = true;
    await Promise.allSettled(this.loading.values());
    await Promise.allSettled(
      [...this.runtimes.values()].map((runtime) => runtime.session.abort()),
    );
    await Promise.allSettled(this.runs);
    for (const chatId of [...this.runtimes.keys()]) this.unload(chatId);
  }

  /**
   * Sends a message to the chat's session. Resolves once Pi has accepted it, and rejects if Pi refused
   * it (e.g. no API key). Failures after that are published as run errors.
   */
  private async startRun(chat: ChatRow, message: string) {
    if (!message.trim()) throw new HttpError(400, "Message is empty");
    if (this.closing) throw new HttpError(503, "Server is shutting down");
    this.addPrompting(chat.id, 1);
    this.options.db.touchChat(chat.id);
    this.refreshStatus(chat.id, true);

    let runtime: Runtime;
    try {
      runtime = await this.getRuntime(chat);
    } catch (error) {
      this.addPrompting(chat.id, -1);
      this.refreshStatus(chat.id);
      throw error;
    }

    let accepted = false;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const run = runtime.session
      .prompt(message, {
        // Slash commands and prompt templates are out of scope, so send the text to the model as written.
        expandPromptTemplates: false,
        // While a run is in progress, queue the message for it instead of failing.
        streamingBehavior: "steer",
        preflightResult: () => {
          accepted = true;
          resolve();
        },
      })
      .catch((error: unknown) => {
        if (!accepted) return reject(new HttpError(409, errorMessage(error)));
        this.emit(chat.id, runtime, {
          type: "run_error",
          chatId: chat.id,
          error: errorMessage(error),
        });
      })
      .finally(() => {
        resolve();
        this.runs.delete(run);
        this.addPrompting(chat.id, -1);
        this.options.db.touchChat(chat.id);
        this.refreshStatus(chat.id, true);
      });
    this.runs.add(run);
    return promise;
  }

  /** Moves the session back to just before a user message. Returns the text to send in its place. */
  private async cutBefore(
    chat: ChatRow,
    timestamp: number,
    replacement: string | undefined,
  ): Promise<string> {
    const runtime = await this.getRuntime(chat);
    if (runtime.agentActive || this.prompting.has(chat.id)) throw busy();
    // User messages are told apart by timestamp. A stale client may ask for one that's been cut off.
    const target = runtime.transcript.messages.find(
      (message) => message.role === "user" && message.timestamp === timestamp,
    );
    const entry = runtime.session.sessionManager
      .getBranch()
      .find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.timestamp === timestamp,
      );
    if (target?.role !== "user" || !entry)
      throw new HttpError(409, "The message is no longer in this chat");

    const original = contentText(target.content);
    const text = replacement ?? original;
    if (!text.trim()) throw new HttpError(400, "Message is empty");
    const { cancelled } = await runtime.session.navigateTree(entry.id);
    if (cancelled) throw new HttpError(409, "A Pi extension cancelled this");

    // Retitle when the first message changes, unless the title came from somewhere else.
    const first = runtime.transcript.messages.find((m) => m.role === "user");
    if (first === target && chat.title === titleFrom(original))
      this.options.db.setTitle(chat.id, titleFrom(text));

    const messages = transcriptFromEntries(
      runtime.session.sessionManager.getBranch(),
    );
    this.emit(
      chat.id,
      runtime,
      this.snapshotOf(this.options.db.getChatById(chat.id) ?? chat, {
        ...emptyTranscript,
        messages,
      }),
    );
    this.refreshContext(chat.id, runtime);
    return text;
  }

  private async switchModel(chat: ChatRow, ref: ModelRef) {
    const model = this.options.pi.modelRuntime.getModel(ref.provider, ref.id);
    if (!model)
      throw new HttpError(
        400,
        `Model ${ref.provider}/${ref.id} is not available`,
      );
    const runtime = await this.loadedRuntime(chat.id);
    if (runtime) {
      try {
        await runtime.session.setModel(model);
      } catch (error) {
        throw new HttpError(400, errorMessage(error));
      }
    }
    this.options.db.setModel(chat.id, ref);
    if (runtime) this.refreshContext(chat.id, runtime);
    else if (chat.context)
      this.options.db.setContext(
        chat.id,
        model.contextWindow > 0
          ? { tokens: chat.context.tokens, contextWindow: model.contextWindow }
          : null,
      );
  }

  private getRuntime(chat: ChatRow): Promise<Runtime> {
    const loaded = this.runtimes.get(chat.id);
    if (loaded) return Promise.resolve(loaded);
    let loading = this.loading.get(chat.id);
    if (!loading) {
      loading = this.loadRuntime(chat).finally(() =>
        this.loading.delete(chat.id),
      );
      this.loading.set(chat.id, loading);
    }
    return loading;
  }

  /** The chat's session if it is loaded or loading. Doesn't load it otherwise. */
  private async loadedRuntime(chatId: string): Promise<Runtime | undefined> {
    return (
      this.runtimes.get(chatId) ??
      (await this.loading.get(chatId)?.catch(() => undefined))
    );
  }

  private async loadRuntime(chat: ChatRow): Promise<Runtime> {
    const { dataDir } = this.options;
    // Chat folders may have been pruned; Pi gets an empty one and is told files can go missing.
    const cwd = this.workspaceDir(chat);
    const sessionDir = this.sessionDir(chat.userId);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    const session = await openChatSession(this.options.pi, {
      chatId: chat.id,
      cwd,
      sessionDir,
      sessionFile: chat.sessionFile ? join(dataDir, chat.sessionFile) : null,
      model: chat.model,
    });
    if (session.sessionFile) {
      const sessionFile = relative(dataDir, session.sessionFile);
      if (sessionFile !== chat.sessionFile)
        this.options.db.setSessionFile(chat.id, sessionFile);
    }

    const runtime: Runtime = {
      session,
      transcript: {
        ...emptyTranscript,
        loaded: true,
        messages: transcriptFromEntries(session.sessionManager.getBranch()),
      },
      agentActive: false,
      unsubscribe: () => {},
    };
    runtime.unsubscribe = session.subscribe((event) =>
      this.handleEvent(chat.id, runtime, event),
    );
    this.runtimes.set(chat.id, runtime);
    this.refreshContext(chat.id, runtime);
    return runtime;
  }

  private handleEvent(
    chatId: string,
    runtime: Runtime,
    event: AgentSessionEvent,
  ) {
    switch (event.type) {
      case "agent_start":
        runtime.agentActive = true;
        this.refreshStatus(chatId);
        break;
      case "agent_settled":
        runtime.agentActive = false;
        this.setActivity(chatId, runtime, null);
        this.refreshContext(chatId, runtime);
        this.refreshStatus(chatId);
        break;
      case "message_start":
      case "message_update": {
        const msg = streamMessage(chatId, event);
        if (msg) this.emit(chatId, runtime, msg);
        break;
      }
      case "message_end": {
        const message = toChatMessage(event.message);
        if (message)
          this.emit(chatId, runtime, { type: "message", chatId, message });
        break;
      }
      case "turn_end":
        // The turn's messages are in the session by now, so Pi's estimate includes them.
        this.refreshContext(chatId, runtime);
        break;
      case "tool_execution_update": {
        const msg = toolOutputMessage(
          chatId,
          event,
          runtime.transcript.toolOutput[event.toolCallId],
        );
        if (msg) this.emit(chatId, runtime, msg);
        break;
      }
      case "queue_update":
        this.emit(chatId, runtime, {
          type: "queue",
          chatId,
          queued: [...event.steering, ...event.followUp],
        });
        break;
      case "compaction_start":
        this.setActivity(chatId, runtime, "Compacting the context…");
        break;
      case "compaction_end":
        this.setActivity(chatId, runtime, null);
        if (event.result) {
          const message = compactionMarker(
            event.result.summary,
            event.result.tokensBefore,
            Date.now(),
          );
          this.emit(chatId, runtime, { type: "message", chatId, message });
        } else if (event.errorMessage && !event.aborted) {
          this.emit(chatId, runtime, {
            type: "run_error",
            chatId,
            error: `Compaction failed: ${event.errorMessage}`,
          });
        }
        this.refreshContext(chatId, runtime);
        break;
      case "auto_retry_start":
        this.setActivity(
          chatId,
          runtime,
          `Retrying after an error (attempt ${event.attempt} of ${event.maxAttempts})…`,
        );
        break;
      case "auto_retry_end":
        this.setActivity(chatId, runtime, null);
        break;
      case "session_info_changed":
        // Set by extensions that name sessions.
        if (event.name) {
          this.options.db.setTitle(chatId, event.name);
          this.publishChat(chatId);
        }
        break;
    }
  }

  /** Updates the runtime's copy of the transcript exactly as subscribed clients will, then publishes. */
  private emit(chatId: string, runtime: Runtime, message: ServerMessage) {
    runtime.transcript = applyServerMessage(runtime.transcript, message);
    this.options.publish(chatTopic(chatId), message);
  }

  private setActivity(
    chatId: string,
    runtime: Runtime,
    activity: string | null,
  ) {
    if (runtime.transcript.activity !== activity)
      this.emit(chatId, runtime, { type: "activity", chatId, activity });
  }

  /** Stores the context usage Pi reports and publishes the chat if it changed. */
  private refreshContext(chatId: string, runtime: Runtime) {
    const usage = runtime.session.getContextUsage();
    const context: ContextUsage | null = usage
      ? {
          tokens: usage.tokens === null ? null : Math.round(usage.tokens),
          contextWindow: usage.contextWindow,
        }
      : null;
    const stored = this.options.db.getChatById(chatId)?.context ?? null;
    if (
      stored?.tokens === context?.tokens &&
      stored?.contextWindow === context?.contextWindow
    )
      return;
    this.options.db.setContext(chatId, context);
    this.publishChat(chatId);
  }

  private addPrompting(chatId: string, delta: number) {
    const count = (this.prompting.get(chatId) ?? 0) + delta;
    if (count > 0) this.prompting.set(chatId, count);
    else this.prompting.delete(chatId);
  }

  private status(chatId: string): ChatStatus {
    return this.prompting.has(chatId) ||
      this.rewinding.has(chatId) ||
      this.runtimes.get(chatId)?.agentActive
      ? "running"
      : "idle";
  }

  /** Publishes the chat if its status changed (or always, with force) and manages idle unloading. */
  private refreshStatus(chatId: string, force = false) {
    const status = this.status(chatId);
    if (force || this.publishedStatus.get(chatId) !== status)
      this.publishChat(chatId);

    const runtime = this.runtimes.get(chatId);
    if (!runtime) return;
    clearTimeout(runtime.idleTimer);
    if (status === "idle")
      runtime.idleTimer = setTimeout(
        () => this.unload(chatId),
        this.idleTimeoutMs,
      );
  }

  private unload(chatId: string) {
    const runtime = this.runtimes.get(chatId);
    if (!runtime) return;
    clearTimeout(runtime.idleTimer);
    runtime.unsubscribe();
    runtime.session.dispose();
    this.runtimes.delete(chatId);
  }

  private publishChat(chatId: string) {
    const chat = this.options.db.getChatById(chatId);
    if (!chat) return;
    const summary = this.summary(chat);
    this.publishedStatus.set(chatId, summary.status);
    this.options.publish(userTopic(chat.userId), {
      type: "chat_updated",
      chat: summary,
    });
  }

  private getChat(userId: string, chatId: string): ChatRow {
    const chat = this.options.db.getChat(userId, chatId);
    if (!chat) throw new HttpError(404, "Chat not found");
    return chat;
  }

  /** A chat that isn't archived, so it can be continued. */
  private getOpenChat(userId: string, chatId: string): ChatRow {
    const chat = this.getChat(userId, chatId);
    if (chat.archivedAt !== null)
      throw new HttpError(409, "Unarchive the chat to continue it");
    return chat;
  }

  private snapshotOf(chat: ChatRow, transcript: TranscriptState): Snapshot {
    return {
      type: "snapshot",
      chat: this.summary(chat),
      messages: transcript.messages,
      streaming: transcript.streaming,
      toolOutput: transcript.toolOutput,
      queued: transcript.queued,
      activity: transcript.activity,
    };
  }

  private summary(chat: ChatRow): ChatSummary {
    return {
      id: chat.id,
      title: chat.title,
      model: chat.model,
      status: this.status(chat.id),
      archived: chat.archivedAt !== null,
      context: chat.context,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    };
  }

  private workspaceDir(chat: ChatRow) {
    return join(this.options.dataDir, "workspaces", chat.userId, chat.id);
  }

  private sessionDir(userId: string) {
    return join(this.options.dataDir, "sessions", userId);
  }
}

const busy = () => new HttpError(409, "Pi is still working on this chat");

function titleFrom(message: string): string {
  const line = message.trim().split("\n")[0].trim();
  return line.length > TITLE_LENGTH
    ? `${line.slice(0, TITLE_LENGTH - 1)}…`
    : line;
}

function contentText(
  content: Extract<ChatMessage, { role: "user" }>["content"],
) {
  if (typeof content === "string") return content;
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
