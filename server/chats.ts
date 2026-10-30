import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatStatus, ChatSummary, ModelRef, ServerMessage } from "../shared/protocol";
import { applyServerMessage, type TranscriptState } from "../shared/transcript";
import type { ChatRow, Db } from "./db";
import { compactionMarker, hasModel, openChatSession, type PiHost, readTranscript, toChatMessage, transcriptFromEntries } from "./pi";
import { streamMessage } from "./stream";

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
  /** Chats with a prompt() call in flight, including while their session is still loading. */
  private prompting = new Set<string>();
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

  async createChat(userId: string, model: ModelRef, message: string): Promise<ChatSummary> {
    if (!message.trim()) throw new HttpError(400, "Message is empty");
    if (!hasModel(this.options.pi, model)) throw new HttpError(400, `Model ${model.provider}/${model.id} is not available`);
    const now = Date.now();
    const chat: ChatRow = {
      id: randomUUID(),
      userId,
      title: titleFrom(message),
      model,
      sessionFile: null,
      createdAt: now,
      updatedAt: now,
    };
    this.options.db.insertChat(chat);
    try {
      await this.startRun(chat, message);
    } catch (error) {
      this.options.db.deleteChat(chat.id);
      rmSync(this.workspaceDir(chat), { recursive: true, force: true });
      throw error;
    }
    return this.summary(this.getChat(userId, chat.id));
  }

  async sendMessage(userId: string, chatId: string, message: string): Promise<void> {
    const chat = this.getChat(userId, chatId);
    if (this.status(chatId) === "running") throw new HttpError(409, "Pi is still working on this chat");
    await this.startRun(chat, message);
  }

  /** Current state of a chat for a client that just subscribed, or null if the user has no such chat. */
  snapshot(userId: string, chatId: string): Extract<ServerMessage, { type: "snapshot" }> | null {
    const chat = this.options.db.getChat(userId, chatId);
    if (!chat) return null;
    const runtime = this.runtimes.get(chatId);
    const messages = runtime
      ? runtime.transcript.messages
      : chat.sessionFile
        ? readTranscript(join(this.options.dataDir, chat.sessionFile), this.sessionDir(chat.userId), this.workspaceDir(chat))
        : [];
    return { type: "snapshot", chat: this.summary(chat), messages, streaming: runtime?.transcript.streaming ?? null };
  }

  /** Aborts runs in progress and disposes every Pi session. */
  async shutdown() {
    this.closing = true;
    await Promise.allSettled(this.loading.values());
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.session.abort()));
    await Promise.allSettled(this.runs);
    for (const chatId of [...this.runtimes.keys()]) this.unload(chatId);
  }

  private async startRun(chat: ChatRow, message: string) {
    if (!message.trim()) throw new HttpError(400, "Message is empty");
    if (this.closing) throw new HttpError(503, "Server is shutting down");
    this.prompting.add(chat.id);
    this.options.db.touchChat(chat.id);
    this.refreshStatus(chat.id, true);

    let runtime: Runtime;
    try {
      runtime = await this.getRuntime(chat);
    } catch (error) {
      this.prompting.delete(chat.id);
      this.refreshStatus(chat.id);
      throw error;
    }

    // Slash commands and prompt templates are out of scope, so send the text to the model as written.
    const run = runtime.session
      .prompt(message, { expandPromptTemplates: false })
      .catch((error: unknown) => {
        this.emit(chat.id, runtime, { type: "run_error", chatId: chat.id, error: errorMessage(error) });
      })
      .finally(() => {
        this.runs.delete(run);
        this.prompting.delete(chat.id);
        this.options.db.touchChat(chat.id);
        this.refreshStatus(chat.id, true);
      });
    this.runs.add(run);
  }

  private getRuntime(chat: ChatRow): Promise<Runtime> {
    const loaded = this.runtimes.get(chat.id);
    if (loaded) return Promise.resolve(loaded);
    let loading = this.loading.get(chat.id);
    if (!loading) {
      loading = this.loadRuntime(chat).finally(() => this.loading.delete(chat.id));
      this.loading.set(chat.id, loading);
    }
    return loading;
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
      if (sessionFile !== chat.sessionFile) this.options.db.setSessionFile(chat.id, sessionFile);
    }

    const runtime: Runtime = {
      session,
      transcript: {
        loaded: true,
        messages: transcriptFromEntries(session.sessionManager.getBranch()),
        streaming: null,
        error: null,
      },
      agentActive: false,
      unsubscribe: () => {},
    };
    runtime.unsubscribe = session.subscribe((event) => this.handleEvent(chat.id, runtime, event));
    this.runtimes.set(chat.id, runtime);
    return runtime;
  }

  private handleEvent(chatId: string, runtime: Runtime, event: AgentSessionEvent) {
    switch (event.type) {
      case "agent_start":
        runtime.agentActive = true;
        this.refreshStatus(chatId);
        break;
      case "agent_settled":
        runtime.agentActive = false;
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
        if (message) this.emit(chatId, runtime, { type: "message", chatId, message });
        break;
      }
      case "compaction_end":
        if (event.result) {
          const message = compactionMarker(event.result.summary, event.result.tokensBefore, Date.now());
          this.emit(chatId, runtime, { type: "message", chatId, message });
        }
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

  private status(chatId: string): ChatStatus {
    return this.prompting.has(chatId) || this.runtimes.get(chatId)?.agentActive ? "running" : "idle";
  }

  /** Publishes the chat if its status changed (or always, with force) and manages idle unloading. */
  private refreshStatus(chatId: string, force = false) {
    const status = this.status(chatId);
    if (force || this.publishedStatus.get(chatId) !== status) this.publishChat(chatId);

    const runtime = this.runtimes.get(chatId);
    if (!runtime) return;
    clearTimeout(runtime.idleTimer);
    if (status === "idle") runtime.idleTimer = setTimeout(() => this.unload(chatId), this.idleTimeoutMs);
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
    this.options.publish(userTopic(chat.userId), { type: "chat_updated", chat: summary });
  }

  private getChat(userId: string, chatId: string): ChatRow {
    const chat = this.options.db.getChat(userId, chatId);
    if (!chat) throw new HttpError(404, "Chat not found");
    return chat;
  }

  private summary(chat: ChatRow): ChatSummary {
    return {
      id: chat.id,
      title: chat.title,
      model: chat.model,
      status: this.status(chat.id),
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

function titleFrom(message: string): string {
  const line = message.trim().split("\n")[0].trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
