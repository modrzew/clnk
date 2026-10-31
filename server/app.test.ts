import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  LoginResponse,
  ModelRef,
  ProjectSummary,
  ServerMessage,
} from "../shared/protocol";
import {
  applyServerMessage,
  emptyTranscript,
  type TranscriptState,
} from "../shared/transcript";
import { type App, startApp } from "./app";
import { AuthService } from "./auth";
import { Db } from "./db";
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
    models: [
      { id: "faux-1", reasoning: true, contextWindow: 100_000 },
      { id: "faux-2", contextWindow: 200_000 },
    ],
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
  // A restarted server has the account already.
  if (!options.dataDir) await addUser(dataDir, "alice");
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
  const { token, user } = await login(app, "alice");
  return {
    app,
    faux,
    dataDir,
    stop,
    token,
    userId: user.id,
    api: (path: string, init?: RequestInit) => request(app, path, init, token),
    connect: () => TestClient.connect(app, token),
    /** Fetches a file the way links do, with the token in the URL. */
    download: (path: string) => fetch(withToken(new URL(path, app.url), token)),
  };
}

/** Creates an account, like `bun users add`. */
async function addUser(dataDir: string, name: string, password = "secret") {
  mkdirSync(dataDir, { recursive: true });
  const db = new Db(join(dataDir, "clnk.db"));
  try {
    return await new AuthService(db).createUser(name, password);
  } finally {
    db.close();
  }
}

async function login(app: App, name: string, password = "secret") {
  const { status, body } = await request(
    app,
    "/api/auth/login",
    post({ name, password }),
  );
  if (status !== 200) throw new Error(body.error);
  return body as LoginResponse;
}

async function request(
  app: App,
  path: string,
  init?: RequestInit,
  token?: string,
) {
  const response = await fetch(new URL(path, app.url), {
    ...init,
    headers: {
      // Multipart requests get their Content-Type, with the boundary, from fetch.
      ...(!(init?.body instanceof FormData) && {
        "Content-Type": "application/json",
      }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...init?.headers,
    },
  });
  return { status: response.status, body: (await response.json()) as any };
}

function withToken(url: URL, token: string): URL {
  url.searchParams.set("token", token);
  return url;
}

function post(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

/** A request with files, as the web UI sends it. */
function postFiles(body: unknown, files: File[]): RequestInit {
  const form = new FormData();
  form.append("request", JSON.stringify(body));
  for (const file of files) form.append("files", file);
  return { method: "POST", body: form };
}

/** A 1x1 PNG. */
const PNG = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
);

function put(body: string): RequestInit {
  return {
    method: "PUT",
    body,
    headers: { "Content-Type": "application/octet-stream" },
  };
}

/** A WebSocket client that keeps a transcript for every chat it subscribes to, like the web UI does. */
class TestClient {
  received: ServerMessage[] = [];
  closeCode: number | null = null;
  transcripts = new Map<string, TranscriptState>();
  chats = new Map<string, ChatSummary>();
  projects = new Map<string, ProjectSummary>();
  private listeners = new Set<() => void>();

  private constructor(private ws: WebSocket) {
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      this.received.push(msg);
      if (msg.type === "chats")
        for (const chat of msg.chats) this.chats.set(chat.id, chat);
      if (msg.type === "chat_updated" || msg.type === "snapshot")
        this.chats.set(msg.chat.id, msg.chat);
      if (msg.type === "chat_deleted") this.chats.delete(msg.chatId);
      if (msg.type === "projects")
        for (const project of msg.projects)
          this.projects.set(project.id, project);
      if (msg.type === "project_updated")
        this.projects.set(msg.project.id, msg.project);
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
    ws.onclose = (event) => {
      this.closeCode = event.code;
      for (const listener of this.listeners) listener();
    };
  }

  static async connect(app: App, token?: string): Promise<TestClient> {
    const url = new URL("/api/ws", app.url);
    url.protocol = "ws:";
    if (token) withToken(url, token);
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

/** Text of each user message and each assistant message's text blocks. */
function texts(state: TranscriptState) {
  return state.messages.flatMap((message) => {
    if (message.role === "user")
      return typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) =>
            part.type === "text" ? [part.text] : [],
          );
    if (message.role === "assistant")
      return message.content.flatMap((block) =>
        block.type === "text" ? [block.text] : [],
      );
    return [];
  });
}

function userTimestamp(state: TranscriptState, text: string): number {
  const message = state.messages.find(
    (message) =>
      message.role === "user" &&
      texts({ ...state, messages: [message] })[0] === text,
  );
  if (!message) throw new Error(`No user message "${text}"`);
  return message.timestamp;
}

/** Creates a chat and waits until its first run is done. */
async function startChat(
  { connect, api }: Awaited<ReturnType<typeof setup>>,
  message = "Hi",
) {
  const client = await connect();
  const { body } = await api("/api/chats", post({ model: MODEL, message }));
  const chatId = body.chat.id as string;
  client.send({ type: "subscribe", chatId });
  await client.waitForStatus(chatId, "idle");
  await client.waitFor(() => client.transcript(chatId).loaded);
  return { client, chatId };
}

/** Waits for a run to end with the given reply. */
async function waitForReply(client: TestClient, chatId: string, text: string) {
  await client.waitFor(() => texts(client.transcript(chatId)).at(-1) === text);
  await client.waitForStatus(chatId, "idle");
}

function patch(body: unknown): RequestInit {
  return { method: "PATCH", body: JSON.stringify(body) };
}

/** Everything the model is told up front, and told later when it changes. */
function systemText(context: {
  messages: { role: string }[];
  systemPrompt?: string;
}) {
  return (
    (context.systemPrompt ?? "") +
    JSON.stringify(
      context.messages.filter((message) => message.role === "system"),
    )
  );
}

async function createProject(
  api: Awaited<ReturnType<typeof setup>>["api"],
  name: string,
  instructions?: string,
) {
  const { body } = await api("/api/projects", post({ name, instructions }));
  return body.project.id as string;
}

const SLOW_REPLY = "A reply that takes a little while to stream out. ".repeat(
  6,
);

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
    const { connect, faux, api } = await setup();
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
    const client = await connect();

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
      archived: false,
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
    const { connect, faux, api } = await setup({ tokensPerSecond: 400 });
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
    const early = await connect();

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

    const late = await connect();
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

  test("a message sent while the chat is running steers the run", async () => {
    const { connect, faux, api } = await setup({ tokensPerSecond: 400 });
    faux.setResponses([
      fauxAssistantMessage(SLOW_REPLY),
      fauxAssistantMessage("Changed course."),
    ]);
    const client = await connect();
    const { body } = await api(
      "/api/chats",
      post({ model: MODEL, message: "First" }),
    );
    const chatId = body.chat.id as string;
    client.send({ type: "subscribe", chatId });
    await client.waitFor(() => client.transcript(chatId).streaming !== null);

    const steer = await api(
      `/api/chats/${chatId}/messages`,
      post({ message: "Change of plans" }),
    );
    expect(steer.status).toBe(202);
    await client.waitFor(
      () => client.transcript(chatId).queued[0] === "Change of plans",
    );

    await client.waitForStatus(chatId, "idle");
    await client.waitFor(() => client.transcript(chatId).messages.length === 4);
    expect(texts(client.transcript(chatId))).toEqual([
      "First",
      SLOW_REPLY,
      "Change of plans",
      "Changed course.",
    ]);
    expect(client.transcript(chatId).queued).toEqual([]);
  });

  test("stops a run and hands back the steering messages Pi hadn't read", async () => {
    const { connect, faux, api } = await setup({ tokensPerSecond: 200 });
    faux.setResponses([fauxAssistantMessage(SLOW_REPLY)]);
    const client = await connect();
    const { body } = await api(
      "/api/chats",
      post({ model: MODEL, message: "First" }),
    );
    const chatId = body.chat.id as string;
    client.send({ type: "subscribe", chatId });
    await client.waitFor(() => client.transcript(chatId).streaming !== null);
    await api(`/api/chats/${chatId}/messages`, post({ message: "Also this" }));

    const stopped = await api(`/api/chats/${chatId}/abort`, post({}));
    expect(stopped.body).toEqual({ queued: ["Also this"] });
    await client.waitForStatus(chatId, "idle");
    const transcript = client.transcript(chatId);
    expect(transcript.queued).toEqual([]);
    expect(transcript.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "aborted",
    });
    expect(roles(transcript)).toEqual(["user", "assistant"]);
  });

  test("tells clients when Pi is done with a chat, unless the run was stopped", async () => {
    const setupResult = await setup({ tokensPerSecond: 200 });
    const { faux, api } = setupResult;
    faux.setResponses([
      fauxAssistantMessage(
        [fauxText("Running it."), fauxToolCall("bash", { command: "echo hi" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("All   done.\nBye."),
    ]);
    const { client, chatId } = await startChat(setupResult, "First\nline");
    const finished = () =>
      client.received.filter((msg) => msg.type === "chat_finished");
    await client.waitFor(() => finished().length === 1);
    expect(finished()).toEqual([
      {
        type: "chat_finished",
        chatId,
        title: "First",
        failed: false,
        text: "All done. Bye.",
      },
    ]);

    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "Boom" }),
    ]);
    await api(`/api/chats/${chatId}/messages`, post({ message: "Again" }));
    await client.waitFor(() => finished().length === 2);
    expect(finished()[1]).toMatchObject({ failed: true, text: "Boom" });

    faux.setResponses([fauxAssistantMessage(SLOW_REPLY)]);
    await api(`/api/chats/${chatId}/messages`, post({ message: "Slow" }));
    await client.waitFor(() => client.transcript(chatId).streaming !== null);
    await api(`/api/chats/${chatId}/abort`, post({}));
    await client.waitForStatus(chatId, "idle");
    await Bun.sleep(20);
    expect(finished()).toHaveLength(2);
  });

  test("switches the chat's model and reports how full the context is", async () => {
    const setupResult = await setup();
    const { faux, api } = setupResult;
    faux.setResponses([fauxAssistantMessage("Hello!")]);
    const { client, chatId } = await startChat(setupResult);
    await client.waitFor(() => client.chats.get(chatId)?.context !== null);
    const context = client.chats.get(chatId)?.context;
    expect(context?.contextWindow).toBe(100_000);
    expect(context?.tokens).toBeGreaterThan(0);

    const switched = await api(
      `/api/chats/${chatId}`,
      patch({ model: { provider: "faux", id: "faux-2" } }),
    );
    expect(switched.status).toBe(200);
    expect(switched.body.chat).toMatchObject({
      model: { provider: "faux", id: "faux-2" },
      context: { contextWindow: 200_000, tokens: context?.tokens },
    });

    faux.setResponses([fauxAssistantMessage("Hello from faux-2!")]);
    await api(`/api/chats/${chatId}/messages`, post({ message: "Again" }));
    await client.waitForStatus(chatId, "idle");
    await client.waitFor(() => client.transcript(chatId).messages.length === 4);
    expect(client.transcript(chatId).messages[3]).toMatchObject({
      role: "assistant",
      model: "faux-2",
    });

    // Once the idle session is unloaded, switching only updates the chat.
    await Bun.sleep(100);
    const back = await api(`/api/chats/${chatId}`, patch({ model: MODEL }));
    expect(back.body.chat.model).toEqual(MODEL);
    expect(back.body.chat.context.contextWindow).toBe(100_000);
    expect(
      (
        await api(
          `/api/chats/${chatId}`,
          patch({ model: { provider: "faux", id: "nope" } }),
        )
      ).status,
    ).toBe(400);
  });

  test("archived chats can't be continued until they're unarchived", async () => {
    const setupResult = await setup();
    const { faux, api } = setupResult;
    faux.setResponses([fauxAssistantMessage("Hello!")]);
    const { client, chatId } = await startChat(setupResult);

    const archived = await api(
      `/api/chats/${chatId}`,
      patch({ archived: true }),
    );
    expect(archived.body.chat.archived).toBe(true);
    await client.waitFor(() => client.chats.get(chatId)?.archived === true);
    expect((await api("/api/chats")).body.chats[0].archived).toBe(true);
    expect(
      (await api(`/api/chats/${chatId}/messages`, post({ message: "Hi" })))
        .status,
    ).toBe(409);
    const timestamp = userTimestamp(client.transcript(chatId), "Hi");
    expect(
      (await api(`/api/chats/${chatId}/rewind`, post({ timestamp }))).status,
    ).toBe(409);

    await api(`/api/chats/${chatId}`, patch({ archived: false }));
    faux.setResponses([fauxAssistantMessage("Welcome back.")]);
    expect(
      (await api(`/api/chats/${chatId}/messages`, post({ message: "Hi" })))
        .status,
    ).toBe(202);
    await client.waitForStatus(chatId, "idle");
  });

  test("editing or retrying a message replaces it and everything after it", async () => {
    const setupResult = await setup();
    const { faux, api, stop, dataDir } = setupResult;
    faux.setResponses([fauxAssistantMessage("One.")]);
    const { client, chatId } = await startChat(setupResult, "First");
    faux.setResponses([fauxAssistantMessage("Two.")]);
    await api(`/api/chats/${chatId}/messages`, post({ message: "Second" }));
    await waitForReply(client, chatId, "Two.");

    // What the model is sent: the cut-off messages are gone from its context.
    let seen: string[] = [];
    faux.setResponses([
      (context) => {
        seen = context.messages.flatMap((message) =>
          message.role === "system"
            ? []
            : typeof message.content === "string"
              ? [message.content]
              : message.content.flatMap((part) =>
                  part.type === "text" ? [part.text] : [],
                ),
        );
        return fauxAssistantMessage("Two, edited.");
      },
    ]);
    const second = userTimestamp(client.transcript(chatId), "Second");
    const edited = await api(
      `/api/chats/${chatId}/rewind`,
      post({ timestamp: second, message: "Second, edited" }),
    );
    expect(edited.status).toBe(202);
    await waitForReply(client, chatId, "Two, edited.");
    expect(texts(client.transcript(chatId))).toEqual([
      "First",
      "One.",
      "Second, edited",
      "Two, edited.",
    ]);
    expect(seen).toEqual(["First", "One.", "Second, edited"]);

    // The cut-off message can't be rewound to anymore.
    expect(
      (await api(`/api/chats/${chatId}/rewind`, post({ timestamp: second })))
        .status,
    ).toBe(409);

    // Retrying sends the same message again.
    faux.setResponses([fauxAssistantMessage("One, retried.")]);
    const first = userTimestamp(client.transcript(chatId), "First");
    await api(`/api/chats/${chatId}/rewind`, post({ timestamp: first }));
    await waitForReply(client, chatId, "One, retried.");
    expect(texts(client.transcript(chatId))).toEqual([
      "First",
      "One, retried.",
    ]);
    expect(client.chats.get(chatId)?.title).toBe("First");

    // Editing the first message renames the chat.
    faux.setResponses([fauxAssistantMessage("A fresh start.")]);
    await api(
      `/api/chats/${chatId}/rewind`,
      post({
        timestamp: userTimestamp(client.transcript(chatId), "First"),
        message: "Brand new start",
      }),
    );
    await waitForReply(client, chatId, "A fresh start.");
    expect(client.chats.get(chatId)?.title).toBe("Brand new start");

    // The session file continues from the edited branch.
    await stop();
    const restarted = await setup({ dataDir });
    const reconnected = await restarted.connect();
    reconnected.send({ type: "subscribe", chatId });
    await reconnected.waitFor(() => reconnected.transcript(chatId).loaded);
    expect(texts(reconnected.transcript(chatId))).toEqual([
      "Brand new start",
      "A fresh start.",
    ]);
  });

  test("streams a tool's output while it runs", async () => {
    const setupResult = await setup();
    const { faux } = setupResult;
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: "for i in 1 2 3; do echo line$i; sleep 0.25; done",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Done."),
    ]);
    const { client, chatId } = await startChat(setupResult, "Count");
    await client.waitFor(() => client.transcript(chatId).messages.length === 4);
    const outputs = client.received.filter((msg) => msg.type === "tool_output");
    expect(outputs.length).toBeGreaterThan(1);
    expect(
      outputs.some((msg) => msg.append && msg.text.includes("line1")),
    ).toBe(true);
    const transcript = client.transcript(chatId);
    expect(transcript.toolOutput).toEqual({});
    expect(transcript.messages[2]).toMatchObject({
      role: "toolResult",
      content: [{ type: "text", text: "line1\nline2\nline3\n" }],
    });
  });

  test("a chat whose first run can't start is deleted again", async () => {
    const { connect, api, dataDir } = await setup();
    const client = await connect();
    // A file where the transcripts go makes loading the Pi session fail.
    writeFileSync(join(dataDir, "sessions"), "");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    cleanup.push(() => logged.mockRestore());
    const created = await api(
      "/api/chats",
      post({ model: MODEL, message: "Hi" }),
    );
    expect(created.status).toBe(500);
    expect((await api("/api/chats")).body.chats).toEqual([]);
    await client.waitFor(() =>
      client.received.some((msg) => msg.type === "chat_deleted"),
    );
    expect(client.chats.size).toBe(0);
  });

  test("validates requests", async () => {
    const { connect, api } = await setup();
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

    const client = await connect();
    client.send({ type: "subscribe", chatId: "missing" });
    await client.waitFor(() =>
      client.received.some((msg) => msg.type === "error"),
    );
  });

  test("chats survive a restart and pruned chat folders are recreated", async () => {
    const first = await setup();
    first.faux.setResponses([fauxAssistantMessage("Hello!")]);
    const client = await first.connect();
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

    const reconnected = await second.connect();
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
    expect(existsSync(join(workspaces, first.userId, chatId))).toBe(true);
  });

  test("attaches files to messages, and images for the model to see", async () => {
    const { faux, api, connect, download, dataDir, userId } = await setup();
    const seen: unknown[] = [];
    const reply = (text: string) => (context: { messages: unknown[] }) => {
      seen.push(context.messages.at(-1));
      return fauxAssistantMessage(text);
    };
    faux.setResponses([reply("A dot."), reply("Noted."), reply("A pixel.")]);
    const client = await connect();
    const created = await api(
      "/api/chats",
      postFiles({ model: MODEL, message: "What's this?" }, [
        new File([PNG], "dot.png", { type: "image/png" }),
        new File(["Buy milk"], "notes.txt", { type: "text/plain" }),
      ]),
    );
    expect(created.status).toBe(201);
    const chatId = created.body.chat.id as string;
    expect(created.body.chat.title).toBe("What's this?");
    client.send({ type: "subscribe", chatId });
    await waitForReply(client, chatId, "A dot.");

    const dot = {
      name: "dot.png",
      mimeType: "image/png",
      size: PNG.length,
      inline: true,
    };
    const notes = {
      name: "notes.txt",
      mimeType: "text/plain;charset=utf-8",
      size: 8,
      inline: false,
    };
    const image = {
      type: "image",
      mimeType: "image/png",
      data: expect.any(String),
    };
    expect(client.transcript(chatId).messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "What's this?" }, image],
      attachments: [dot, notes],
    });
    // The model gets the image, and the files listed after the text.
    expect(seen[0]).toMatchObject({
      role: "user",
      content: [
        {
          type: "text",
          text: expect.stringMatching(
            /^What's this\?\n\n<attachments>\n.*path="attachments\/dot\.png".*inline="true".*\n.*path="attachments\/notes\.txt"/,
          ),
        },
        image,
      ],
    });
    const folder = join(dataDir, "workspaces", userId, chatId);
    expect(existsSync(join(folder, "attachments", "dot.png"))).toBe(true);

    const file = await download(`/api/chats/${chatId}/attachments/notes.txt`);
    expect(await file.text()).toBe("Buy milk");
    expect(file.headers.get("Content-Disposition")).toStartWith("attachment;");
    for (const name of ["missing.txt", "..", "%2E%2E%2Fclnk.db"])
      expect(
        (await api(`/api/chats/${chatId}/attachments/${name}`)).status,
      ).toBe(404);

    // Only a file, with a name that's taken.
    expect(
      (
        await api(
          `/api/chats/${chatId}/messages`,
          postFiles({ message: "" }, [new File(["Eggs"], "notes.txt")]),
        )
      ).status,
    ).toBe(202);
    await waitForReply(client, chatId, "Noted.");
    expect(client.transcript(chatId).messages[2]).toMatchObject({
      content: [{ type: "text", text: "" }],
      attachments: [
        expect.objectContaining({ name: "notes (1).txt", inline: false }),
      ],
    });

    // An edit keeps the attachments, and the title follows the new text.
    const timestamp = client.transcript(chatId).messages[0].timestamp;
    expect(
      (
        await api(
          `/api/chats/${chatId}/rewind`,
          post({ timestamp, message: "And now?" }),
        )
      ).status,
    ).toBe(202);
    await waitForReply(client, chatId, "A pixel.");
    expect(client.transcript(chatId).messages).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: "And now?" }, image],
        attachments: [dot, notes],
      },
      { role: "assistant" },
    ]);
    expect(seen[2]).toMatchObject({ content: [{ type: "text" }, image] });
    expect(client.chats.get(chatId)?.title).toBe("And now?");

    // Clients that subscribe later get the same transcript from the session file.
    await Bun.sleep(100);
    const later = await connect();
    later.send({ type: "subscribe", chatId });
    await later.waitFor(() => later.transcript(chatId).loaded);
    expect(later.transcript(chatId).messages).toEqual(
      client.transcript(chatId).messages,
    );
  });

  test("files sent while Pi is running are shown by name until it reads them", async () => {
    const { faux, api, connect } = await setup({ tokensPerSecond: 200 });
    faux.setResponses([fauxAssistantMessage(SLOW_REPLY)]);
    const client = await connect();
    const { body } = await api(
      "/api/chats",
      postFiles({ model: MODEL, message: "" }, [new File(["x"], "a.txt")]),
    );
    const chatId = body.chat.id as string;
    expect(body.chat.title).toBe("a.txt");
    client.send({ type: "subscribe", chatId });
    await client.waitFor(() => client.transcript(chatId).streaming !== null);

    await api(
      `/api/chats/${chatId}/messages`,
      postFiles({ message: "" }, [new File(["y"], "b.txt")]),
    );
    await api(
      `/api/chats/${chatId}/messages`,
      postFiles({ message: "Also" }, [new File(["z"], "c.txt")]),
    );
    await client.waitFor(() => client.transcript(chatId).queued.length === 2);
    expect(client.transcript(chatId).queued).toEqual(["b.txt", "Also"]);
    const stopped = await api(`/api/chats/${chatId}/abort`, post({}));
    expect(stopped.body).toEqual({ queued: ["", "Also"] });
  });

  test("validates requests with files", async () => {
    const { api } = await setup();
    const form = new FormData();
    form.append("files", new File(["x"], "a.txt"));
    expect(
      (await api("/api/chats", { method: "POST", body: form })).status,
    ).toBe(400);
    expect(
      (await api("/api/chats", postFiles({ model: MODEL, message: " " }, [])))
        .status,
    ).toBe(400);
    const models = (await api("/api/models")).body.models;
    expect(models[0]).toMatchObject({ id: "faux-1", images: true });
  });

  test("creates, edits and archives projects", async () => {
    const { connect, api } = await setup();
    const client = await connect();

    const created = await api(
      "/api/projects",
      post({ name: "  Thesis  ", instructions: "Cite sources.\n" }),
    );
    expect(created.status).toBe(201);
    expect(created.body.project).toMatchObject({
      name: "Thesis",
      instructions: "Cite sources.",
      archived: false,
      artefacts: [],
    });
    const projectId = created.body.project.id as string;
    await client.waitFor(() => client.projects.has(projectId));

    const edited = await api(
      `/api/projects/${projectId}`,
      patch({ name: "Thesis, take two", instructions: "" }),
    );
    expect(edited.body.project).toMatchObject({
      name: "Thesis, take two",
      instructions: "",
    });
    await client.waitFor(
      () => client.projects.get(projectId)?.name === "Thesis, take two",
    );
    expect((await api("/api/projects")).body.projects).toEqual([
      expect.objectContaining({ id: projectId, name: "Thesis, take two" }),
    ]);

    // Archived projects take no new chats or artefacts, but can still be edited and unarchived.
    await api(`/api/projects/${projectId}`, patch({ archived: true }));
    await client.waitFor(
      () => client.projects.get(projectId)?.archived === true,
    );
    expect(
      (
        await api(
          "/api/chats",
          post({ model: MODEL, message: "Hi", projectId }),
        )
      ).status,
    ).toBe(409);
    expect(
      (await api(`/api/projects/${projectId}/artefacts/a.txt`, put("A")))
        .status,
    ).toBe(409);
    expect(
      (await api(`/api/projects/${projectId}`, patch({ name: "Thesis" })))
        .status,
    ).toBe(200);
    await api(`/api/projects/${projectId}`, patch({ archived: false }));
    expect(
      (await api(`/api/projects/${projectId}/artefacts/a.txt`, put("A")))
        .status,
    ).toBe(200);

    // Projects come before chats on a new connection, so chats can be grouped right away.
    const late = await connect();
    await late.waitFor(() => late.received.length >= 3);
    expect(late.received.map((msg) => msg.type).slice(0, 3)).toEqual([
      "user",
      "projects",
      "chats",
    ]);
    expect(late.projects.get(projectId)).toMatchObject({
      name: "Thesis",
      artefacts: [expect.objectContaining({ name: "a.txt", size: 1 })],
    });
  });

  test("uploads, downloads, replaces and deletes artefacts", async () => {
    const { connect, api, download } = await setup();
    const client = await connect();
    const projectId = await createProject(api, "Docs");
    const name = "Notes (draft) ż.md";
    const path = `/api/projects/${projectId}/artefacts/${encodeURIComponent(name)}`;

    const uploaded = await api(path, put("# Notes\n"));
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.artefact).toMatchObject({ name, size: 8 });
    await client.waitFor(
      () => client.projects.get(projectId)?.artefacts.length === 1,
    );

    const downloaded = await download(path);
    expect(await downloaded.text()).toBe("# Notes\n");
    expect(downloaded.headers.get("Content-Disposition")).toBe(
      `attachment; filename="Notes (draft) _.md"; filename*=UTF-8''Notes%20%28draft%29%20%C5%BC.md`,
    );

    await api(path, put("# Notes, v2\n"));
    expect(await (await download(path)).text()).toBe("# Notes, v2\n");
    expect((await api("/api/projects")).body.projects[0].artefacts).toEqual([
      expect.objectContaining({ name, size: 12 }),
    ]);

    expect((await api(path, { method: "DELETE" })).status).toBe(200);
    await client.waitFor(
      () => client.projects.get(projectId)?.artefacts.length === 0,
    );
    expect((await download(path)).status).toBe(404);
    expect((await api(path, { method: "DELETE" })).status).toBe(404);

    // Names that would leave the project's folder.
    expect(
      (await api(`/api/projects/${projectId}/artefacts/a%2Fb`, put("x")))
        .status,
    ).toBe(400);
    expect(
      (await api(`/api/projects/${projectId}/artefacts/%00`, put("x"))).status,
    ).toBe(400);
    expect(
      (await api(`/api/projects/missing/artefacts/a.txt`, put("x"))).status,
    ).toBe(404);
  });

  test("chats in a project see its instructions and artefacts, and Pi can save new ones", async () => {
    const { connect, faux, api, dataDir, userId, download } = await setup();
    const client = await connect();
    const projectId = await createProject(
      api,
      "Pirates",
      "Answer like a pirate.",
    );
    await api(
      `/api/projects/${projectId}/artefacts/map.txt`,
      put("X marks the spot"),
    );

    let system = "";
    faux.setResponses([
      (context) => {
        system = systemText(context);
        return fauxAssistantMessage(
          fauxToolCall("bash", { command: "cat artefacts/map.txt" }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage(
        fauxToolCall("write", { path: "artefacts/map.txt", content: "Nope" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("write", { path: "treasure.md", content: "Gold" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("save_artefact", { path: "treasure.md" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("save_artefact", { path: "treasure.md" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("save_artefact", { path: "artefacts/map.txt" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Arr, saved."),
    ]);
    const created = await api(
      "/api/chats",
      post({ model: MODEL, message: "Find the treasure", projectId }),
    );
    expect(created.body.chat.projectId).toBe(projectId);
    const chatId = created.body.chat.id as string;
    client.send({ type: "subscribe", chatId });
    await waitForReply(client, chatId, "Arr, saved.");

    expect(system).toContain("Answer like a pirate.");
    expect(system).toContain("map.txt");
    expect(system).toContain("save_artefact");
    const link = join(dataDir, "workspaces", userId, chatId, "artefacts");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    const results = client
      .transcript(chatId)
      .messages.filter((message) => message.role === "toolResult");
    expect(results.map((result) => [result.toolName, result.isError])).toEqual([
      ["bash", false],
      // Artefacts are read-only, though not for root.
      ["write", process.getuid?.() !== 0],
      ["write", false],
      ["save_artefact", false],
      // Artefacts can't be replaced, and are artefacts already.
      ["save_artefact", true],
      ["save_artefact", true],
    ]);
    expect(results[0].content).toEqual([
      { type: "text", text: "X marks the spot" },
    ]);
    await client.waitFor(() =>
      client.projects
        .get(projectId)!
        .artefacts.some((artefact) => artefact.name === "treasure.md"),
    );
    const saved = await download(
      `/api/projects/${projectId}/artefacts/treasure.md`,
    );
    expect(await saved.text()).toBe("Gold");

    // Changed instructions apply to the next run.
    await api(
      `/api/projects/${projectId}`,
      patch({ instructions: "Answer like a parrot." }),
    );
    faux.setResponses([
      (context) => {
        system = systemText(context);
        return fauxAssistantMessage("Squawk.");
      },
    ]);
    await api(`/api/chats/${chatId}/messages`, post({ message: "Again" }));
    await waitForReply(client, chatId, "Squawk.");
    expect(system).toContain("Answer like a parrot.");

    // Chats outside of projects know nothing of them.
    faux.setResponses([
      (context) => {
        system = systemText(context);
        return fauxAssistantMessage("Hello.");
      },
    ]);
    const other = await api(
      "/api/chats",
      post({ model: MODEL, message: "Hi" }),
    );
    expect(other.body.chat.projectId).toBeNull();
    await client.waitForStatus(other.body.chat.id, "idle");
    expect(system).not.toContain("save_artefact");

    // Archiving the project stops its chats.
    await api(`/api/projects/${projectId}`, patch({ archived: true }));
    expect(
      (await api(`/api/chats/${chatId}/messages`, post({ message: "Hi" })))
        .status,
    ).toBe(409);
    const timestamp = userTimestamp(client.transcript(chatId), "Again");
    expect(
      (await api(`/api/chats/${chatId}/rewind`, post({ timestamp }))).status,
    ).toBe(409);
  });
});

describe("accounts", () => {
  test("requests need a valid token", async () => {
    const { app, api, token } = await setup();
    const url = (path: string) => new URL(path, app.url);

    expect((await request(app, "/api/health")).status).toBe(200);
    expect((await request(app, "/api/chats")).status).toBe(401);
    expect((await request(app, "/api/chats", {}, "nope")).status).toBe(401);
    expect((await api("/api/chats")).status).toBe(200);
    expect((await fetch(withToken(url("/api/chats"), token))).status).toBe(200);
    // Only GETs take the token in the URL.
    const posted = await fetch(withToken(url("/api/projects"), token), {
      ...post({ name: "Sneaky" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(posted.status).toBe(401);

    const anonymous = await TestClient.connect(app);
    await anonymous.waitFor(() => anonymous.closeCode === 4401);
    const forged = await TestClient.connect(app, "nope");
    await forged.waitFor(() => forged.closeCode === 4401);
    expect([...anonymous.received, ...forged.received]).toEqual([]);
  });

  test("logs in by name, ignoring case", async () => {
    const { app, connect, userId } = await setup();
    const wrong = await request(
      app,
      "/api/auth/login",
      post({ name: "alice", password: "wrong" }),
    );
    expect(wrong).toEqual({
      status: 401,
      body: { error: "Wrong name or password" },
    });
    expect(
      (
        await request(
          app,
          "/api/auth/login",
          post({ name: "nobody", password: "secret" }),
        )
      ).status,
    ).toBe(401);
    expect((await login(app, " ALICE ")).user).toEqual({
      id: userId,
      name: "alice",
    });

    const client = await connect();
    await client.waitFor(() => client.received.length > 0);
    expect(client.received[0]).toEqual({
      type: "user",
      user: { id: userId, name: "alice" },
    });
  });

  test("logging out ends the session and closes its sockets", async () => {
    const { app, api, connect } = await setup();
    const other = await login(app, "alice");
    const client = await connect();
    const otherClient = await TestClient.connect(app, other.token);

    expect((await api("/api/auth/logout", post({}))).status).toBe(200);
    await client.waitFor(() => client.closeCode === 4401);
    expect((await api("/api/chats")).status).toBe(401);

    expect((await request(app, "/api/chats", {}, other.token)).status).toBe(
      200,
    );
    expect(otherClient.closeCode).toBeNull();
  });

  test("changing the password logs out the user's other sessions", async () => {
    const { app, api, connect } = await setup();
    const other = await login(app, "alice");
    const client = await connect();
    const otherClient = await TestClient.connect(app, other.token);

    const wrong = await api(
      "/api/auth/password",
      post({ current: "wrong", password: "better" }),
    );
    expect(wrong.status).toBe(403);
    const changed = await api(
      "/api/auth/password",
      post({ current: "secret", password: "better" }),
    );
    expect(changed.status).toBe(200);

    await otherClient.waitFor(() => otherClient.closeCode === 4401);
    expect((await request(app, "/api/chats", {}, other.token)).status).toBe(
      401,
    );
    expect((await api("/api/chats")).status).toBe(200);
    expect(client.closeCode).toBeNull();
    expect(login(app, "alice")).rejects.toThrow();
    await login(app, "alice", "better");
  });

  test("users only see their own chats and projects", async () => {
    const alice = await setup();
    alice.faux.setResponses([fauxAssistantMessage("Hello!")]);
    const { chatId } = await startChat(alice);
    const projectId = await createProject(alice.api, "Secret");
    const artefact = `/api/projects/${projectId}/artefacts/a.txt`;
    await alice.api(artefact, put("A"));

    await addUser(alice.dataDir, "bob");
    const { token } = await login(alice.app, "bob");
    const bob = (path: string, init?: RequestInit) =>
      request(alice.app, path, init, token);
    const bobClient = await TestClient.connect(alice.app, token);
    await bobClient.waitFor(() =>
      bobClient.received.some((msg) => msg.type === "chats"),
    );
    expect(bobClient.chats.size).toBe(0);
    expect(bobClient.projects.size).toBe(0);

    expect((await bob("/api/chats")).body.chats).toEqual([]);
    expect((await bob("/api/projects")).body.projects).toEqual([]);
    const refused = [
      await bob(`/api/chats/${chatId}`, patch({ archived: true })),
      await bob(`/api/chats/${chatId}/messages`, post({ message: "Hi" })),
      await bob(`/api/chats/${chatId}/abort`, post({})),
      await bob(`/api/chats/${chatId}/rewind`, post({ timestamp: 1 })),
      await bob("/api/chats", post({ model: MODEL, message: "Hi", projectId })),
      await bob(`/api/projects/${projectId}`, patch({ name: "Mine" })),
      await bob(artefact),
      await bob(artefact, put("B")),
      await bob(artefact, { method: "DELETE" }),
    ];
    expect(refused.map((response) => response.status)).toEqual(
      refused.map(() => 404),
    );
    expect(await (await alice.download(artefact)).text()).toBe("A");

    bobClient.send({ type: "subscribe", chatId });
    await bobClient.waitFor(() =>
      bobClient.received.some((msg) => msg.type === "error"),
    );

    // Nothing of Alice's reaches Bob's clients.
    const aliceClient = await alice.connect();
    alice.faux.setResponses([fauxAssistantMessage("Again!")]);
    await alice.api(`/api/chats/${chatId}/messages`, post({ message: "Hi" }));
    await alice.api(`/api/projects/${projectId}`, patch({ name: "Renamed" }));
    await aliceClient.waitFor(
      () => aliceClient.projects.get(projectId)?.name === "Renamed",
    );
    await aliceClient.waitForStatus(chatId, "idle");
    expect(bobClient.received.map((msg) => msg.type)).toEqual([
      "user",
      "projects",
      "chats",
      "error",
    ]);
  });
});
