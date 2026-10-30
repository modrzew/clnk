import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  ChatSummary,
  ClientMessage,
  ModelRef,
  ServerMessage,
} from "../shared/protocol";
import {
  applyServerMessage,
  emptyTranscript,
  type TranscriptState,
} from "../shared/transcript";
import { type App, startApp } from "./app";
import type { PiHost } from "./pi";

const MODEL: ModelRef = { provider: "faux", id: "faux-1" };

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function createHost(
  dir: string,
  tokensPerSecond = 5000,
): Promise<{ host: PiHost; faux: FauxProviderHandle }> {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", reasoning: true }],
    tokensPerSecond,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey("faux", "test");
  return {
    host: { modelRuntime, agentDir: join(dir, "agent"), extensions: false },
    faux,
  };
}

async function setup(
  options: { dataDir?: string; tokensPerSecond?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "clnk-test-"));
  const dataDir = options.dataDir ?? join(dir, "data");
  const { host, faux } = await createHost(dir, options.tokensPerSecond);
  const app = startApp({
    config: { host: "127.0.0.1", port: 0, dataDir, webDir: null },
    pi: host,
    idleTimeoutMs: 50,
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await app.stop();
  };
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }), stop);
  return {
    app,
    faux,
    dataDir,
    stop,
    api: (path: string, init?: RequestInit) => request(app, path, init),
  };
}

async function request(app: App, path: string, init?: RequestInit) {
  const response = await fetch(new URL(path, app.url), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  return { status: response.status, body: (await response.json()) as any };
}

function post(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

/** A WebSocket client that keeps a transcript for every chat it subscribes to, like the web UI does. */
class TestClient {
  received: ServerMessage[] = [];
  transcripts = new Map<string, TranscriptState>();
  chats = new Map<string, ChatSummary>();
  private listeners = new Set<() => void>();

  private constructor(private ws: WebSocket) {
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      this.received.push(msg);
      if (msg.type === "chats")
        for (const chat of msg.chats) this.chats.set(chat.id, chat);
      if (msg.type === "chat_updated" || msg.type === "snapshot")
        this.chats.set(msg.chat.id, msg.chat);
      const chatId =
        msg.type === "snapshot"
          ? msg.chat.id
          : "chatId" in msg
            ? msg.chatId
            : null;
      if (chatId)
        this.transcripts.set(
          chatId,
          applyServerMessage(this.transcript(chatId), msg),
        );
      for (const listener of this.listeners) listener();
    };
  }

  static async connect(app: App): Promise<TestClient> {
    const url = new URL("/api/ws", app.url);
    url.protocol = "ws:";
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const client = new TestClient(ws);
    cleanup.push(() => ws.close());
    return client;
  }

  send(msg: ClientMessage) {
    this.ws.send(JSON.stringify(msg));
  }

  transcript(chatId: string): TranscriptState {
    return this.transcripts.get(chatId) ?? emptyTranscript;
  }

  waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!predicate()) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error("Timed out waiting for server messages"));
      }, timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  waitForStatus(chatId: string, status: ChatSummary["status"]) {
    return this.waitFor(() => this.chats.get(chatId)?.status === status);
  }
}

function roles(state: TranscriptState) {
  return state.messages.map((message) => message.role);
}

describe("backend", () => {
  test("reports health and the available models", async () => {
    const { api } = await setup();
    expect((await api("/api/health")).body).toMatchObject({
      ok: true,
      name: "clnk",
    });
    const models = await api("/api/models");
    expect(models.body.models).toContainEqual(
      expect.objectContaining({
        provider: "faux",
        id: "faux-1",
        reasoning: true,
      }),
    );
    expect(models.body.defaultModel).toEqual(MODEL);
  });

  test("creates a chat and streams the run to subscribers", async () => {
    const { app, faux, api } = await setup();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxThinking("Let me check."),
          fauxText("Running it."),
          fauxToolCall("bash", { command: "echo hi" }),
        ],
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage("All done."),
    ]);
    const client = await TestClient.connect(app);

    const created = await api(
      "/api/chats",
      post({ model: MODEL, message: "Say hi\nwith bash" }),
    );
    expect(created.status).toBe(201);
    const chat = created.body.chat as ChatSummary;
    expect(chat).toMatchObject({
      title: "Say hi",
      model: MODEL,
      status: "running",
    });

    client.send({ type: "subscribe", chatId: chat.id });
    await client.waitForStatus(chat.id, "idle");
    await client.waitFor(
      () => client.transcript(chat.id).messages.length === 4,
    );

    const transcript = client.transcript(chat.id);
    expect(roles(transcript)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(transcript.streaming).toBeNull();
    const [, first, result, last] = transcript.messages;
    expect(
      first.role === "assistant" && first.content.map((block) => block.type),
    ).toEqual(["thinking", "text", "toolCall"]);
    expect(result).toMatchObject({
      role: "toolResult",
      toolName: "bash",
      isError: false,
    });
    expect(last).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "All done." }],
    });

    const list = await api("/api/chats");
    expect(list.body.chats).toEqual([
      expect.objectContaining({ id: chat.id, status: "idle" }),
    ]);
  });

  test("a client that joins mid-stream catches up with the same transcript", async () => {
    const { app, faux, api } = await setup({ tokensPerSecond: 400 });
    const text =
      "This answer streams slowly so a second client can join half way through. ".repeat(
        6,
      );
    faux.setResponses([
      fauxAssistantMessage([
        fauxThinking("Thinking it over first."),
        fauxText(text),
      ]),
    ]);
    const early = await TestClient.connect(app);

    const { body } = await api(
      "/api/chats",
      post({ model: MODEL, message: "Tell me something long" }),
    );
    const chatId = body.chat.id as string;
    early.send({ type: "subscribe", chatId });
    await early.waitFor(
      () =>
        early.received.filter((msg) => msg.type === "stream_delta").length > 5,
    );

    const late = await TestClient.connect(app);
    late.send({ type: "subscribe", chatId });
    await late.waitFor(() => late.transcript(chatId).loaded);
    expect(late.transcript(chatId).streaming).not.toBeNull();

    await Promise.all([
      early.waitForStatus(chatId, "idle"),
      late.waitForStatus(chatId, "idle"),
    ]);
    await late.waitFor(() => late.transcript(chatId).messages.length === 2);
    expect(late.transcript(chatId)).toEqual(early.transcript(chatId));
    expect(late.transcript(chatId).messages[1]).toMatchObject({
      content: [{ type: "thinking" }, { type: "text", text }],
    });
  });

  test("rejects a new message while the chat is running", async () => {
    const { app, faux, api } = await setup({ tokensPerSecond: 400 });
    faux.setResponses([
      fauxAssistantMessage(
        "A reply that takes a little while to stream out. ".repeat(4),
      ),
    ]);
    const client = await TestClient.connect(app);
    const { body } = await api(
      "/api/chats",
      post({ model: MODEL, message: "First" }),
    );
    const chatId = body.chat.id as string;

    const busy = await api(
      `/api/chats/${chatId}/messages`,
      post({ message: "Second" }),
    );
    expect(busy.status).toBe(409);

    await client.waitForStatus(chatId, "idle");
    faux.setResponses([fauxAssistantMessage("Second reply.")]);
    expect(
      (await api(`/api/chats/${chatId}/messages`, post({ message: "Second" })))
        .status,
    ).toBe(202);
  });

  test("validates requests", async () => {
    const { app, api } = await setup();
    expect(
      (
        await api(
          "/api/chats",
          post({ model: { provider: "nope", id: "x" }, message: "hi" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await api("/api/chats", post({ model: MODEL, message: "  " }))).status,
    ).toBe(400);
    expect(
      (await api("/api/chats/missing/messages", post({ message: "hi" })))
        .status,
    ).toBe(404);
    expect((await api("/api/chats")).body.chats).toEqual([]);

    const client = await TestClient.connect(app);
    client.send({ type: "subscribe", chatId: "missing" });
    await client.waitFor(() =>
      client.received.some((msg) => msg.type === "error"),
    );
  });

  test("chats survive a restart and pruned chat folders are recreated", async () => {
    const first = await setup();
    first.faux.setResponses([fauxAssistantMessage("Hello!")]);
    const client = await TestClient.connect(first.app);
    const { body } = await first.api(
      "/api/chats",
      post({ model: MODEL, message: "Hi" }),
    );
    const chatId = body.chat.id as string;
    await client.waitForStatus(chatId, "idle");
    await first.stop();

    const workspaces = join(first.dataDir, "workspaces");
    rmSync(workspaces, { recursive: true, force: true });

    const second = await setup({ dataDir: first.dataDir });
    const chats = (await second.api("/api/chats")).body.chats as ChatSummary[];
    expect(chats).toEqual([
      expect.objectContaining({ id: chatId, title: "Hi", status: "idle" }),
    ]);

    const reconnected = await TestClient.connect(second.app);
    await reconnected.waitFor(() => reconnected.chats.has(chatId));
    reconnected.send({ type: "subscribe", chatId });
    await reconnected.waitFor(() => reconnected.transcript(chatId).loaded);
    expect(roles(reconnected.transcript(chatId))).toEqual([
      "user",
      "assistant",
    ]);

    second.faux.setResponses([fauxAssistantMessage("Hello again!")]);
    expect(
      (
        await second.api(
          `/api/chats/${chatId}/messages`,
          post({ message: "Again" }),
        )
      ).status,
    ).toBe(202);
    await reconnected.waitForStatus(chatId, "idle");
    await reconnected.waitFor(
      () => reconnected.transcript(chatId).messages.length === 4,
    );
    expect(existsSync(join(workspaces, "default", chatId))).toBe(true);
  });
});
