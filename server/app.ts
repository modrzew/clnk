import { mkdirSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import packageJson from "../package.json";
import type {
  AbortResponse,
  ChatsResponse,
  ClientMessage,
  CreateChatResponse,
  CreateProjectResponse,
  ErrorResponse,
  HealthResponse,
  ModelRef,
  ProjectsResponse,
  RewindRequest,
  ServerMessage,
  UpdateChatRequest,
  UpdateChatResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
  UploadArtefactResponse,
} from "../shared/protocol";
import {
  ChatService,
  chatTopic,
  errorMessage,
  HttpError,
  userTopic,
} from "./chats";
import type { Config } from "./config";
import { DEFAULT_USER_ID, Db } from "./db";
import { listModels, type PiHost } from "./pi";
import { ProjectService } from "./projects";

interface SocketData {
  userId: string;
}

export interface AppOptions {
  config: Config;
  pi: PiHost;
  idleTimeoutMs?: number;
}

export interface App {
  server: Server<SocketData>;
  url: URL;
  stop(): Promise<void>;
}

// Clients can be served from anywhere (Vite dev server, desktop app), and there is no auth to protect yet.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function startApp({ config, pi, idleTimeoutMs }: AppOptions): App {
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(join(config.dataDir, "clnk.db"));
  let server: Server<SocketData> | undefined;
  const publish = (topic: string, message: ServerMessage) =>
    server?.publish(topic, JSON.stringify(message));
  const projects = new ProjectService({
    db,
    dataDir: config.dataDir,
    publish,
  });
  const chats = new ChatService({
    db,
    pi,
    projects,
    dataDir: config.dataDir,
    idleTimeoutMs,
    publish,
  });

  async function handleApi(
    req: Request,
    url: URL,
    srv: Server<SocketData>,
  ): Promise<Response | undefined> {
    // Until there's a login flow, whoever sends a request is the default user.
    const userId = DEFAULT_USER_ID;
    const path = url.pathname;
    const method = req.method;

    if (method === "OPTIONS") return new Response(null, { status: 204 });
    if (path === "/api/ws" && method === "GET") {
      if (srv.upgrade(req, { data: { userId } })) return undefined;
      throw new HttpError(400, "Expected a WebSocket upgrade");
    }
    if (path === "/api/health" && method === "GET") {
      return json({
        ok: true,
        name: "clnk",
        version: packageJson.version,
      } satisfies HealthResponse);
    }
    if (path === "/api/models" && method === "GET")
      return json(await listModels(pi));
    if (path === "/api/chats" && method === "GET")
      return json({ chats: chats.listChats(userId) } satisfies ChatsResponse);
    if (path === "/api/chats" && method === "POST") {
      const body = await readJson(req);
      const chat = await chats.createChat(
        userId,
        parseModel(body.model),
        parseMessage(body.message),
        body.projectId === undefined
          ? undefined
          : parseString(body.projectId, "projectId"),
      );
      return json({ chat } satisfies CreateChatResponse, 201);
    }
    const chatMatch = path.match(/^\/api\/chats\/([^/]+)(\/[a-z]+)?$/);
    if (chatMatch) {
      const chatId = decodeSegment(chatMatch[1]);
      const route = `${method} ${chatMatch[2] ?? ""}`;
      if (route === "PATCH ") {
        const chat = await chats.updateChat(
          userId,
          chatId,
          parseUpdate(await readJson(req)),
        );
        return json({ chat } satisfies UpdateChatResponse);
      }
      if (route === "POST /messages") {
        const body = await readJson(req);
        await chats.sendMessage(userId, chatId, parseMessage(body.message));
        return json({ ok: true }, 202);
      }
      if (route === "POST /abort") {
        const queued = await chats.abort(userId, chatId);
        return json({ queued } satisfies AbortResponse);
      }
      if (route === "POST /rewind") {
        await chats.rewind(userId, chatId, parseRewind(await readJson(req)));
        return json({ ok: true }, 202);
      }
    }
    if (path === "/api/projects" && method === "GET") {
      return json({
        projects: projects.listProjects(userId),
      } satisfies ProjectsResponse);
    }
    if (path === "/api/projects" && method === "POST") {
      const body = await readJson(req);
      const project = projects.createProject(
        userId,
        parseString(body.name, "name"),
        body.instructions === undefined
          ? ""
          : parseString(body.instructions, "instructions"),
      );
      return json({ project } satisfies CreateProjectResponse, 201);
    }
    const projectMatch = path.match(
      /^\/api\/projects\/([^/]+)(?:\/artefacts\/([^/]+))?$/,
    );
    if (projectMatch) {
      const projectId = decodeSegment(projectMatch[1]);
      const name =
        projectMatch[2] === undefined
          ? undefined
          : decodeSegment(projectMatch[2]);
      if (name === undefined && method === "PATCH") {
        const project = projects.updateProject(
          userId,
          projectId,
          parseProjectUpdate(await readJson(req)),
        );
        return json({ project } satisfies UpdateProjectResponse);
      }
      if (name !== undefined && method === "GET") {
        const file = Bun.file(projects.artefactPath(userId, projectId, name));
        return new Response(file, {
          headers: { "Content-Disposition": attachment(name) },
        });
      }
      if (name !== undefined && method === "PUT") {
        const artefact = await projects.uploadArtefact(
          userId,
          projectId,
          name,
          req.body,
        );
        return json({ artefact } satisfies UploadArtefactResponse);
      }
      if (name !== undefined && method === "DELETE") {
        projects.deleteArtefact(userId, projectId, name);
        return json({ ok: true });
      }
    }
    throw new HttpError(404, "Not found");
  }

  server = Bun.serve<SocketData>({
    hostname: config.host,
    port: config.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/api/"))
        return serveWeb(config.webDir, url);
      let response: Response | undefined;
      try {
        response = await handleApi(req, url, srv);
        if (!response) return undefined;
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error(error);
        response = json(
          { error: errorMessage(error) } satisfies ErrorResponse,
          status,
        );
      }
      for (const [name, value] of Object.entries(CORS_HEADERS))
        response.headers.set(name, value);
      return response;
    },
    websocket: {
      open(ws) {
        send(ws, {
          type: "projects",
          projects: projects.listProjects(ws.data.userId),
        });
        send(ws, { type: "chats", chats: chats.listChats(ws.data.userId) });
        ws.subscribe(userTopic(ws.data.userId));
      },
      message(ws, raw) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          return send(ws, { type: "error", error: "Invalid JSON" });
        }
        if (msg.type === "subscribe") {
          const snapshot = chats.snapshot(ws.data.userId, msg.chatId);
          if (!snapshot)
            return send(ws, { type: "error", error: "Chat not found" });
          // Snapshot first, then live events: both happen in this tick, so nothing falls in between.
          send(ws, snapshot);
          ws.subscribe(chatTopic(msg.chatId));
        } else if (msg.type === "unsubscribe") {
          ws.unsubscribe(chatTopic(msg.chatId));
        }
      },
    },
  });

  return {
    server,
    url: server.url,
    async stop() {
      await chats.shutdown();
      await server?.stop(true);
      db.close();
    },
  };
}

function send(ws: ServerWebSocket<SocketData>, message: ServerMessage) {
  ws.send(JSON.stringify(message));
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object")
      return body as Record<string, unknown>;
  } catch {}
  throw new HttpError(400, "Expected a JSON object body");
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "Malformed URL");
  }
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== "string")
    throw new HttpError(400, `${field} must be a string`);
  return value;
}

function parseMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new HttpError(400, "message must be a non-empty string");
  return value;
}

function parseModel(value: unknown): ModelRef {
  const model = value as Record<string, unknown> | null;
  if (typeof model?.provider !== "string" || typeof model?.id !== "string") {
    throw new HttpError(400, "model must be { provider, id }");
  }
  return { provider: model.provider, id: model.id };
}

function parseUpdate(body: Record<string, unknown>): UpdateChatRequest {
  const update: UpdateChatRequest = {};
  if (body.model !== undefined) update.model = parseModel(body.model);
  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean")
      throw new HttpError(400, "archived must be a boolean");
    update.archived = body.archived;
  }
  return update;
}

function parseProjectUpdate(
  body: Record<string, unknown>,
): UpdateProjectRequest {
  const update: UpdateProjectRequest = {};
  if (body.name !== undefined) update.name = parseString(body.name, "name");
  if (body.instructions !== undefined)
    update.instructions = parseString(body.instructions, "instructions");
  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean")
      throw new HttpError(400, "archived must be a boolean");
    update.archived = body.archived;
  }
  return update;
}

function parseRewind(body: Record<string, unknown>): RewindRequest {
  if (typeof body.timestamp !== "number")
    throw new HttpError(400, "timestamp must be a number");
  return {
    timestamp: body.timestamp,
    message:
      body.message === undefined ? undefined : parseMessage(body.message),
  };
}

/** Content-Disposition that downloads the file under its own name, whatever characters it has. */
function attachment(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function serveWeb(webDir: string | null, url: URL): Promise<Response> {
  if (!webDir) {
    return new Response(
      "Web UI is not built. Run `bun run build`, or use the Vite dev server (`bun run dev`).",
      {
        status: 404,
      },
    );
  }
  const path = normalize(join(webDir, decodeURIComponent(url.pathname)));
  if (path.startsWith(webDir + sep)) {
    const file = Bun.file(path);
    if (await file.exists()) return new Response(file);
  }
  // Single-page app: unknown paths get the shell.
  return new Response(Bun.file(join(webDir, "index.html")));
}
