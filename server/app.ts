import { mkdirSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import packageJson from "../package.json";
import {
  type AbortResponse,
  type ChatsResponse,
  type ClientMessage,
  type CreateChatResponse,
  type CreateProjectResponse,
  type ErrorResponse,
  type HealthResponse,
  type LoginResponse,
  MAX_REQUEST_BYTES,
  type ModelRef,
  type ProjectsResponse,
  type RewindRequest,
  type ServerMessage,
  UNAUTHORIZED_CLOSE_CODE,
  type UpdateChatRequest,
  type UpdateChatResponse,
  type UpdateProjectRequest,
  type UpdateProjectResponse,
  type UploadArtefactResponse,
  type UserInfo,
} from "../shared/protocol";
import { AuthService, type Session } from "./auth";
import {
  ChatService,
  chatTopic,
  errorMessage,
  HttpError,
  userTopic,
} from "./chats";
import type { Config } from "./config";
import { Db, type UserRow } from "./db";
import { listModels, type PiHost } from "./pi";
import { ProjectService } from "./projects";

interface SocketData {
  /** Null without a valid token: the socket is closed as soon as it opens. */
  session: Session | null;
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

// Clients can be served from anywhere (Vite dev server, desktop app). Tokens go in a header rather than a
// cookie, which browsers would send along with requests from any page, so any origin can be allowed.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function startApp({ config, pi, idleTimeoutMs }: AppOptions): App {
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(join(config.dataDir, "clnk.db"));
  const auth = new AuthService(db);
  let server: Server<SocketData> | undefined;
  const sockets = new Set<ServerWebSocket<SocketData>>();
  /** Closes the sockets of sessions that ended. */
  const closeSockets = (ended: (session: Session) => boolean) => {
    for (const ws of sockets)
      if (ws.data.session && ended(ws.data.session))
        ws.close(UNAUTHORIZED_CLOSE_CODE, "Logged out");
  };
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
    const path = url.pathname;
    const method = req.method;

    if (method === "OPTIONS") return new Response(null, { status: 204 });
    if (path === "/api/health" && method === "GET") {
      return json({
        ok: true,
        name: "clnk",
        version: packageJson.version,
      } satisfies HealthResponse);
    }
    if (path === "/api/auth/login" && method === "POST") {
      const body = await readJson(req);
      const { token, user } = await auth.login(
        parseString(body.name, "name"),
        parseString(body.password, "password"),
      );
      return json({ token, user: userInfo(user) } satisfies LoginResponse);
    }

    // Links, images and WebSockets can't send headers. GETs don't change anything, so they can take
    // the token in the URL.
    const token =
      bearerToken(req) ??
      (method === "GET" ? url.searchParams.get("token") : null);
    const session = token ? auth.authenticate(token) : null;
    if (path === "/api/ws" && method === "GET") {
      // Upgraded without a session too, to be closed with a code that tells the client why. Browsers
      // don't show why an upgrade failed.
      if (srv.upgrade(req, { data: { session } })) return undefined;
      throw new HttpError(400, "Expected a WebSocket upgrade");
    }
    if (!session) throw new HttpError(401, "Log in first");
    const userId = session.user.id;

    if (path === "/api/auth/logout" && method === "POST") {
      auth.logout(session);
      closeSockets((s) => s.tokenHash === session.tokenHash);
      return json({ ok: true });
    }
    if (path === "/api/auth/password" && method === "POST") {
      const body = await readJson(req);
      await auth.changePassword(
        session,
        parseString(body.current, "current"),
        parseString(body.password, "password"),
      );
      closeSockets(
        (s) => s.user.id === userId && s.tokenHash !== session.tokenHash,
      );
      return json({ ok: true });
    }
    if (path === "/api/models" && method === "GET")
      return json(await listModels(pi));
    if (path === "/api/chats" && method === "GET")
      return json({ chats: chats.listChats(userId) } satisfies ChatsResponse);
    if (path === "/api/chats" && method === "POST") {
      const { body, files } = await readRequest(req);
      const chat = await chats.createChat(
        userId,
        parseModel(body.model),
        parseString(body.message, "message"),
        body.projectId === undefined
          ? undefined
          : parseString(body.projectId, "projectId"),
        files,
      );
      return json({ chat } satisfies CreateChatResponse, 201);
    }
    const attachmentMatch = path.match(
      /^\/api\/chats\/([^/]+)\/attachments\/([^/]+)$/,
    );
    if (attachmentMatch && method === "GET") {
      const name = decodeSegment(attachmentMatch[2]);
      const file = Bun.file(
        chats.attachmentPath(userId, decodeSegment(attachmentMatch[1]), name),
      );
      return new Response(file, {
        headers: { "Content-Disposition": attachment(name) },
      });
    }
    // The path is one segment, slashes and all, so `..` in it isn't resolved before the server checks it.
    const imageMatch = path.match(/^\/api\/chats\/([^/]+)\/images\/([^/]+)$/);
    if (imageMatch && method === "GET") {
      const image = await chats.imageFile(
        userId,
        decodeSegment(imageMatch[1]),
        decodeSegment(imageMatch[2]),
      );
      return new Response(Bun.file(image.path), {
        headers: {
          "Content-Type": image.type,
          // Pi may draw the image again under the same name.
          "Cache-Control": "private, no-cache",
        },
      });
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
        const { body, files } = await readRequest(req);
        await chats.sendMessage(
          userId,
          chatId,
          parseString(body.message, "message"),
          files,
        );
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
    maxRequestBodySize: MAX_REQUEST_BYTES,
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
        const { session } = ws.data;
        if (!session) return ws.close(UNAUTHORIZED_CLOSE_CODE, "Log in first");
        sockets.add(ws);
        const userId = session.user.id;
        send(ws, { type: "user", user: userInfo(session.user) });
        send(ws, { type: "projects", projects: projects.listProjects(userId) });
        send(ws, { type: "chats", chats: chats.listChats(userId) });
        ws.subscribe(userTopic(userId));
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, raw) {
        const { session } = ws.data;
        if (!session) return;
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          return send(ws, { type: "error", error: "Invalid JSON" });
        }
        if (msg.type === "subscribe") {
          const snapshot = chats.snapshot(session.user.id, msg.chatId);
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

function userInfo(user: UserRow): UserInfo {
  return { id: user.id, name: user.name };
}

function bearerToken(req: Request): string | null {
  return (
    req.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null
  );
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  return jsonObject(await req.text().catch(() => ""));
}

/** A JSON body, or a multipart one with files: the JSON in a `request` field, the files in `files`. */
async function readRequest(
  req: Request,
): Promise<{ body: Record<string, unknown>; files: File[] }> {
  if (!req.headers.get("Content-Type")?.startsWith("multipart/form-data"))
    return { body: await readJson(req), files: [] };
  const form = await req.formData().catch(() => null);
  if (!form) throw new HttpError(400, "Malformed form data");
  const request = form.get("request");
  const files = form.getAll("files");
  if (typeof request !== "string")
    throw new HttpError(400, "Expected the JSON request in a request field");
  if (files.some((file) => typeof file === "string"))
    throw new HttpError(400, "files must be files");
  return { body: jsonObject(request), files: files as File[] };
}

function jsonObject(text: string): Record<string, unknown> {
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body))
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
      body.message === undefined
        ? undefined
        : parseString(body.message, "message"),
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
