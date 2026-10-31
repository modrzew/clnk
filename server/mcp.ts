import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  McpAuthRequiredError,
  McpClient,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import {
  authorizeMcp,
  McpOAuthProvider,
  type McpOAuthState,
  type OAuthClientInformationMixed,
} from "@earendil-works/pi-mcp/oauth";
import packageJson from "../package.json";
import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpServerInfo,
} from "../shared/protocol";
import { errorMessage, HttpError, type Publish, userTopic } from "./chats";
import type { Db, McpServerRow } from "./db";
import type { McpCredentials, McpServerCredentials, UserMcp } from "./pi";

const NAME_LENGTH = 40;
const DESCRIPTION_LENGTH = 500;
const EXPOSURES = ["codemode", "deferred", "direct", "hidden"];
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Where the browser is sent after signing in. Nothing listens there: the user pastes the address. */
const CALLBACK_URL = "http://127.0.0.1/callback";
/** How long a sign-in waits for the address the browser was sent to. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** Bounds each step of signing in. */
const OAUTH_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
/** How long to remember whether a server asks to sign in. */
const PROBE_TTL_MS = 10 * 60_000;
/** Owner of the sign-ins to global servers, which every user shares. */
const SHARED = "";

/** An MCP server in a user's chats: a global one, or one of the user's own. */
interface ServerEntry {
  name: string;
  global: boolean;
  description: string;
  enabled: boolean;
  /** Of the user's own servers. */
  config: McpServerConfig | null;
  /** For servers Pi signs in to with OAuth: remote ones without an Authorization header. */
  oauth: OAuthTarget | null;
  hidden: boolean;
}

interface OAuthTarget {
  url: string;
  /** The `oauth` settings of a global server in mcp.json. */
  settings: Record<string, unknown>;
  /** Credentials go in headers, so the server isn't expected to ask to sign in. */
  hasHeaders: boolean;
}

/** OAuth client settings, as Pi reads them from mcp.json. */
interface OAuthSettings {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  callbackUrl?: string;
  scope?: string;
  clientName?: string;
  authServerMetadataUrl?: URL;
}

/** A sign-in waiting for the address the browser was sent to. */
interface SignIn {
  /** To a global server, for everyone. */
  global: boolean;
  url: string;
  settings: OAuthSettings;
  redirectUrl: string;
  /** Where the authorization server sends the browser: the redirect URI it was given. */
  callback: URL;
  state: string;
  expiresAt: number;
}

export interface McpServiceOptions {
  db: Db;
  /** Pi's config dir, with the mcp.json of the global servers. */
  agentDir: string;
  dataDir: string;
  publish: Publish;
}

/**
 * MCP servers in users' chats: the global ones from Pi's mcp.json, which Pi reads itself, and each
 * user's own, which are added to their chats' sessions. Any user can sign in to a global server, for
 * everyone; users sign in to their own servers just for themselves. Signing in runs in the backend; the
 * browser is sent to a loopback address that doesn't load, and the user pastes it.
 */
export class McpService {
  /** Open chat sessions of each user, to tell about changes to the user's servers. */
  private listeners = new Map<string, Set<() => void>>();
  /** By user and server name. */
  private signIns = new Map<string, SignIn>();
  /** Whether a server asks to sign in, by URL. */
  private probes = new Map<string, { asks: Promise<boolean>; at: number }>();
  private locks = new Locks();

  constructor(private options: McpServiceOptions) {}

  async listServers(userId: string): Promise<McpServerInfo[]> {
    return Promise.all(
      this.entries(userId).map(async (entry) => ({
        name: entry.name,
        global: entry.global,
        description: entry.description,
        enabled: entry.enabled,
        config: entry.config,
        signedIn: entry.hidden ? null : await this.signedIn(userId, entry),
        hidden: entry.hidden,
      })),
    );
  }

  async createServer(
    userId: string,
    name: string,
    config: unknown,
  ): Promise<McpServerInfo> {
    const valid = serverName(name);
    const parsed = parseConfig(config);
    const taken = this.entries(userId).find(
      (entry) => namespace(entry.name) === namespace(valid),
    );
    if (taken)
      throw new HttpError(
        409,
        taken.global
          ? `There already is a shared server named ${taken.name}`
          : `You already have a server named ${taken.name}`,
      );
    const now = Date.now();
    this.options.db.insertMcpServer({
      userId,
      name: valid,
      config: parsed,
      createdAt: now,
      updatedAt: now,
    });
    return this.serversChanged(userId, valid);
  }

  async updateServer(
    userId: string,
    name: string,
    config: unknown,
  ): Promise<McpServerInfo> {
    const server = this.getServer(userId, name);
    const parsed = parseConfig(config);
    // A sign-in belongs to the server's URL.
    const url = serverUrl(server.config);
    if (url && url !== serverUrl(parsed)) this.forgetSignIn(userId, name, url);
    this.options.db.updateMcpServer({
      ...server,
      config: parsed,
      updatedAt: Date.now(),
    });
    return this.serversChanged(userId, name);
  }

  async deleteServer(userId: string, name: string) {
    const server = this.getServer(userId, name);
    const url = serverUrl(server.config);
    if (url) this.forgetSignIn(userId, name, url);
    this.options.db.deleteMcpServer(userId, name);
    await this.serversChanged(userId, null);
  }

  /**
   * Starts signing in to a server, the user's own or a global one. Returns the authorization URL to
   * open, or null when the stored sign-in could be renewed instead.
   */
  async startSignIn(userId: string, name: string): Promise<string | null> {
    const { global, oauth } = this.oauthTarget(userId, name);
    const settings = oauthSettings(name, oauth.settings);
    const store = this.credentials(userId, global).forServer(name, oauth.url);
    // Like Pi's own sign-in, minus the callback server.
    const stored = await store.load();
    const registered = redirectUrls(stored?.clientInformation)[0];
    const redirectUrl = redirectUrlFor(settings, registered);
    if (stored) {
      const next = { ...stored };
      delete next.oauthState;
      // A registered client can't use another redirect URI, and its tokens belong to it.
      if (
        !settings.clientId &&
        !redirectUrls(stored.clientInformation).includes(redirectUrl)
      ) {
        delete next.clientInformation;
        delete next.tokens;
        delete next.tokensExpireAt;
      }
      await store.save(next);
    }
    let authorizationUrl: URL | undefined;
    const provider = createProvider(
      oauth.url,
      store,
      settings,
      redirectUrl,
      (url) => {
        authorizationUrl = url;
      },
    );
    if ((await authorize(provider, oauth.url, settings)) === "AUTHORIZED") {
      await this.signInChanged(userId, global);
      return null;
    }
    if (!authorizationUrl)
      throw new HttpError(502, "The server gave no address to sign in at");
    this.signIns.set(signInKey(userId, name), {
      global,
      url: oauth.url,
      settings,
      redirectUrl,
      callback: new URL(
        authorizationUrl.searchParams.get("redirect_uri") ?? redirectUrl,
      ),
      state: await provider.state(),
      expiresAt: Date.now() + SIGN_IN_TIMEOUT_MS,
    });
    return authorizationUrl.href;
  }

  /** Finishes signing in with the address the browser was sent to. */
  async finishSignIn(userId: string, name: string, address: string) {
    const key = signInKey(userId, name);
    const signIn = this.signIns.get(key);
    if (!signIn || signIn.expiresAt < Date.now()) {
      this.signIns.delete(key);
      throw new HttpError(409, "The sign-in expired. Start it again.");
    }
    const { code, iss } = authorizationResponse(address, signIn);
    const provider = createProvider(
      signIn.url,
      this.credentials(userId, signIn.global).forServer(name, signIn.url),
      signIn.settings,
      signIn.redirectUrl,
      () => {},
    );
    await authorize(provider, signIn.url, signIn.settings, {
      authorizationCode: code,
      iss,
    });
    this.signIns.delete(key);
    await this.signInChanged(userId, signIn.global);
  }

  async signOut(userId: string, name: string) {
    const { global, oauth } = this.oauthTarget(userId, name);
    this.credentials(userId, global).remove(name, oauth.url);
    this.signIns.delete(signInKey(userId, name));
    await this.signInChanged(userId, global);
  }

  /** What a chat session of the user needs. */
  forUser(userId: string): UserMcp {
    return {
      servers: () =>
        new Map(
          this.options.db
            .listMcpServers(userId)
            .map((server) => [server.name, piConfig(server.config)]),
        ),
      onChange: (listener) => {
        let listeners = this.listeners.get(userId);
        if (!listeners) this.listeners.set(userId, (listeners = new Set()));
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          if (!listeners.size && this.listeners.get(userId) === listeners)
            this.listeners.delete(userId);
        };
      },
      credentials: this.sessionCredentials(userId),
      logPath: join(this.options.dataDir, "mcp-logs", `${userId}.log`),
    };
  }

  /** The user's sign-ins to their own servers, or the shared ones to global servers. */
  private credentials(userId: string, global: boolean): Credentials {
    return new Credentials(
      this.options.db,
      global ? SHARED : userId,
      this.locks,
    );
  }

  /** For the user's chats, where Pi signs in to global servers and the user's own alike. */
  private sessionCredentials(userId: string): McpCredentials {
    // A global server takes precedence over a user's with the same name, in Pi too.
    const pick = (name: string) =>
      this.credentials(
        userId,
        readGlobalServers(this.options.agentDir).some(
          (entry) => namespace(entry.name) === namespace(name),
        ),
      );
    return {
      forServer: (name, url) => pick(name).forServer(name, url),
      tokens: (name, url) => pick(name).tokens(name, url),
      remove: (name, url) => pick(name).remove(name, url),
    };
  }

  /** The global servers, then the user's own, each sorted by name. */
  private entries(userId: string): ServerEntry[] {
    const global = readGlobalServers(this.options.agentDir).sort(byName);
    const globalNames = new Set(global.map((entry) => namespace(entry.name)));
    const own = this.options.db
      .listMcpServers(userId)
      .map(({ name, config }): ServerEntry => ({
        name,
        global: false,
        description: config.description ?? "",
        enabled: config.enabled !== false,
        config,
        oauth:
          "url" in config && usesOAuth(config.headers)
            ? {
                url: config.url,
                settings: {},
                hasHeaders: Object.keys(config.headers ?? {}).length > 0,
              }
            : null,
        hidden: globalNames.has(namespace(name)),
      }))
      .sort(byName);
    return [...global, ...own];
  }

  private getServer(userId: string, name: string): McpServerRow {
    const server = this.options.db.getMcpServer(userId, name);
    if (!server) throw new HttpError(404, "MCP server not found");
    return server;
  }

  private oauthTarget(
    userId: string,
    name: string,
  ): { global: boolean; oauth: OAuthTarget } {
    const entry = this.entries(userId).find(
      (entry) => entry.name === name && !entry.hidden,
    );
    if (!entry) throw new HttpError(404, "MCP server not found");
    if (!entry.oauth)
      throw new HttpError(
        400,
        `${name} doesn't sign in: it isn't a remote server, or has an Authorization header`,
      );
    return { global: entry.global, oauth: entry.oauth };
  }

  private async signedIn(
    userId: string,
    { name, global, oauth }: ServerEntry,
  ): Promise<boolean | null> {
    if (!oauth) return null;
    if (this.credentials(userId, global).tokens(name, oauth.url)) return true;
    if (oauth.hasHeaders) return null;
    return (await this.asksToSignIn(oauth.url)) ? false : null;
  }

  /** Whether the server refuses to connect without signing in. Unreachable ones might. */
  private asksToSignIn(url: string): Promise<boolean> {
    const probe = this.probes.get(url);
    if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.asks;
    const asks = connectsWithout(url).then(
      (connects) => !connects,
      () => {
        this.probes.delete(url);
        return true;
      },
    );
    this.probes.set(url, { asks, at: Date.now() });
    return asks;
  }

  /** Of a server of the user's. */
  private forgetSignIn(userId: string, name: string, url: string) {
    this.credentials(userId, false).remove(name, url);
    this.signIns.delete(signInKey(userId, name));
  }

  /** Changes the user's open chats, and tells their clients. Returns the user's own server of that name. */
  private async serversChanged(
    userId: string,
    name: string | null,
  ): Promise<McpServerInfo> {
    for (const listener of this.listeners.get(userId) ?? []) listener();
    const servers = await this.publish(userId);
    return servers.find((server) => !server.global && server.name === name)!;
  }

  /** Tells the clients of whoever it concerns. Open chats pick up sign-ins on their next turn by themselves. */
  private async signInChanged(userId: string, global: boolean) {
    const users = global
      ? this.options.db.listUsers().map((user) => user.id)
      : [userId];
    await Promise.all(users.map((user) => this.publish(user)));
  }

  private async publish(userId: string): Promise<McpServerInfo[]> {
    const servers = await this.listServers(userId);
    this.options.publish(userTopic(userId), { type: "mcp_servers", servers });
    return servers;
  }
}

/**
 * OAuth state for MCP servers, of a user or the shared one, in the database. Keyed by server name and
 * URL like Pi keys its own, so that servers sharing a URL keep separate accounts.
 */
class Credentials implements McpCredentials {
  constructor(
    private db: Db,
    private owner: string,
    private locks: Locks,
  ) {}

  forServer(name: string, serverUrl: string): McpServerCredentials {
    const key = credentialKey(name, serverUrl);
    return {
      load: () => this.load(key),
      save: (state) =>
        this.db.setMcpAuth(this.owner, key, JSON.stringify(state)),
      withRefreshLock: (fn) => this.locks.run(`${this.owner} ${key}`, fn),
    };
  }

  tokens(name: string, serverUrl: string) {
    return this.load(credentialKey(name, serverUrl))?.tokens;
  }

  remove(name: string, serverUrl: string): boolean {
    return this.db.deleteMcpAuth(this.owner, credentialKey(name, serverUrl));
  }

  private load(key: string): McpOAuthState | undefined {
    const state = this.db.getMcpAuth(this.owner, key);
    return state === null ? undefined : (JSON.parse(state) as McpOAuthState);
  }
}

/** Runs functions one at a time per key. */
class Locks {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

/**
 * The servers in Pi's mcp.json, as far as listing them and signing in to them goes. Pi reads and checks
 * the file itself.
 */
function readGlobalServers(agentDir: string): ServerEntry[] {
  const path = join(agentDir, "mcp.json");
  let file: unknown;
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn(`Failed to read ${path}: ${errorMessage(error)}`);
    return [];
  }
  const servers =
    isRecord(file) && isRecord(file.mcpServers) ? file.mcpServers : {};
  return Object.entries(servers).flatMap(([name, entry]): ServerEntry[] => {
    if (!isRecord(entry)) return [];
    const { url, headers } = entry;
    const oauth =
      typeof url === "string" &&
      URL.canParse(url) &&
      !entry.auth &&
      usesOAuth(isRecord(headers) ? headers : undefined);
    return [
      {
        name,
        global: true,
        description:
          typeof entry.description === "string" ? entry.description : "",
        enabled: entry.enabled !== false,
        config: null,
        oauth: oauth
          ? {
              url,
              settings: isRecord(entry.oauth) ? entry.oauth : {},
              hasHeaders: isRecord(headers) && Object.keys(headers).length > 0,
            }
          : null,
        hidden: false,
      },
    ];
  });
}

/** Pi signs in to remote servers that have no Authorization header. */
function usesOAuth(headers: Record<string, unknown> | undefined): boolean {
  return !Object.keys(headers ?? {}).some(
    (header) => header.toLowerCase() === "authorization",
  );
}

/** Whether the server lets the backend connect without signing in. */
async function connectsWithout(url: string): Promise<boolean> {
  const client = new McpClient({
    name: "clnk",
    version: packageJson.version,
    requestTimeoutMs: PROBE_TIMEOUT_MS,
  });
  try {
    await client.connect(
      new StreamableHttpTransport({ url, openGetStream: false }),
    );
    return true;
  } catch (error) {
    if (error instanceof McpAuthRequiredError) return false;
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
}

function oauthSettings(
  name: string,
  oauth: Record<string, unknown>,
): OAuthSettings {
  const string = (key: string) =>
    typeof oauth[key] === "string" ? oauth[key] : undefined;
  if (oauth.clientRegistration === "cimd")
    throw new HttpError(
      400,
      `Signing in to ${name} needs oauth.clientRegistration "cimd", which clnk doesn't support`,
    );
  const secret = string("clientSecret");
  const metadataUrl = string("authServerMetadataUrl");
  return {
    clientId: string("clientId"),
    clientSecret:
      secret === undefined
        ? undefined
        : resolveValue(secret, `oauth.clientSecret of ${name}`),
    callbackPort:
      typeof oauth.callbackPort === "number" ? oauth.callbackPort : undefined,
    callbackUrl: string("callbackUrl"),
    scope: string("scope"),
    clientName: string("clientName"),
    authServerMetadataUrl: metadataUrl ? new URL(metadataUrl) : undefined,
  };
}

/** A value from mcp.json, resolved like Pi does: `!command` runs it, `${NAME}` and `$NAME` read the environment. */
function resolveValue(value: string, what: string): string {
  if (value.startsWith("!")) {
    const result = Bun.spawnSync(["sh", "-c", value.slice(1)], {
      stderr: "ignore",
    });
    const output = result.stdout.toString().trim();
    if (!result.success || !output)
      throw new Error(`Failed to resolve ${what} from its command`);
    return output;
  }
  return value.replace(
    /\$(?:([$!])|\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g,
    (_, escaped?: string, braced?: string, bare?: string) => {
      if (escaped) return escaped;
      const variable = (braced ?? bare)!;
      const resolved = process.env[variable];
      if (!resolved)
        throw new Error(`Failed to resolve ${what}: ${variable} isn't set`);
      return resolved;
    },
  );
}

/**
 * The redirect URI to sign in with: the one the settings fix for a registered client, else the one
 * the client was registered with before, else the loopback callback on a random port.
 */
function redirectUrlFor(
  settings: OAuthSettings,
  registered: string | undefined,
): string {
  const url = new URL(settings.callbackUrl ?? CALLBACK_URL);
  // Sent exactly as written, since servers compare it as a string.
  if (url.port) return settings.callbackUrl!;
  if (settings.callbackPort !== undefined) {
    url.port = String(settings.callbackPort);
    return url.href;
  }
  if (registered) return registered;
  url.port = String(randomInt(49152, 65536));
  return url.href;
}

function redirectUrls(client: OAuthClientInformationMixed | undefined) {
  return client && "redirect_uris" in client ? client.redirect_uris : [];
}

function createProvider(
  serverUrl: string,
  store: McpServerCredentials,
  settings: OAuthSettings,
  redirectUrl: string,
  onRedirect: (url: URL) => void,
) {
  return new McpOAuthProvider({
    serverUrl,
    redirectUrl,
    clientMetadata: { client_name: settings.clientName ?? "clnk" },
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    store,
    onRedirect,
  });
}

async function authorize(
  provider: McpOAuthProvider,
  serverUrl: string,
  settings: OAuthSettings,
  response?: { authorizationCode: string; iss?: string },
) {
  try {
    return await authorizeMcp(provider, {
      serverUrl,
      authorizationServerMetadataUrl: settings.authServerMetadataUrl,
      scope: settings.scope,
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      ...response,
    });
  } catch (error) {
    throw new HttpError(502, `Signing in failed: ${errorMessage(error)}`);
  }
}

/** The authorization code in the address the browser was sent to. */
function authorizationResponse(
  address: string,
  signIn: SignIn,
): { code: string; iss?: string } {
  const trimmed = address.trim();
  let url: URL;
  try {
    // Browsers tend to leave the scheme out of the address bar.
    url = new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`,
    );
  } catch {
    throw new HttpError(400, "Paste the whole address from the browser");
  }
  if (
    url.origin !== signIn.callback.origin ||
    url.pathname !== signIn.callback.pathname
  )
    throw new HttpError(
      400,
      `That isn't the address signing in sent the browser to. It starts with ${signIn.callback.href}`,
    );
  const error = url.searchParams.get("error");
  if (error)
    throw new HttpError(
      400,
      `Signing in failed: ${url.searchParams.get("error_description") ?? error}`,
    );
  if (url.searchParams.get("state") !== signIn.state)
    throw new HttpError(400, "That address is from another sign-in");
  const code = url.searchParams.get("code");
  if (!code) throw new HttpError(400, "That address has no authorization code");
  return { code, iss: url.searchParams.get("iss") ?? undefined };
}

/** Checks a config from a client, and leaves out defaults. */
function parseConfig(value: unknown): McpServerConfig {
  if (!isRecord(value)) throw invalid("config must be an object");
  const base: Omit<McpHttpServerConfig, "url"> = {};
  if (value.description !== undefined) {
    if (typeof value.description !== "string")
      throw invalid("description must be a string");
    const description = value.description.trim();
    if (description.length > DESCRIPTION_LENGTH)
      throw invalid(
        `Descriptions can be at most ${DESCRIPTION_LENGTH} characters long`,
      );
    if (description) base.description = description;
  }
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean")
      throw invalid("enabled must be a boolean");
    if (!value.enabled) base.enabled = false;
  }
  if (value.exposure !== undefined) {
    if (!EXPOSURES.includes(value.exposure as string))
      throw invalid(`exposure must be one of ${EXPOSURES.join(", ")}`);
    base.exposure = value.exposure as McpServerConfig["exposure"];
  }

  const { url, command, args } = value;
  if ((url === undefined) === (command === undefined))
    throw invalid("A server needs either a url or a command");
  if (url !== undefined) {
    const trimmed = typeof url === "string" ? url.trim() : "";
    if (!/^https?:\/\//i.test(trimmed) || !URL.canParse(trimmed))
      throw invalid("The URL must start with http:// or https://");
    const headers = parseValues(value.headers, "headers", HEADER_NAME);
    if (headers && Object.values(headers).some((v) => /[\r\n]/.test(v)))
      throw invalid("Header values can't span lines");
    return { url: trimmed, ...(headers && { headers }), ...base };
  }
  if (typeof command !== "string" || !command.trim())
    throw invalid("The command is empty");
  if (
    args !== undefined &&
    (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
  )
    throw invalid("args must be a list of strings");
  const env = parseValues(value.env, "env", ENV_NAME);
  return {
    command: command.trim(),
    ...(args?.length && { args: args as string[] }),
    ...(env && { env }),
    ...base,
  };
}

function parseValues(
  value: unknown,
  field: string,
  names: RegExp,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalid(`${field} must be an object`);
  const entries = Object.entries(value);
  for (const [name, text] of entries) {
    if (typeof text !== "string")
      throw invalid(`${field} values must be strings`);
    if (!names.test(name)) throw invalid(`${name} isn't a valid name`);
  }
  return entries.length ? (value as Record<string, string>) : undefined;
}

function serverName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw invalid("The name is empty");
  if (trimmed.length > NAME_LENGTH)
    throw invalid(`Names can be at most ${NAME_LENGTH} characters long`);
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed))
    throw invalid("Names can only have letters, digits, - and _");
  return trimmed;
}

/** The config as Pi takes it. Values it would read as `${NAME}` or `!command` are escaped. */
function piConfig(config: McpServerConfig): McpServerConfig {
  if ("url" in config)
    return config.headers
      ? { ...config, headers: mapValues(config.headers, literal) }
      : config;
  return config.env
    ? { ...config, env: mapValues(config.env, literal) }
    : config;
}

/** Escapes a value so that Pi takes it literally. */
function literal(value: string): string {
  return value.replace(/\$/g, "$$$$").replace(/^!/, "$!");
}

function mapValues(
  values: Record<string, string>,
  fn: (value: string) => string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, fn(value)]),
  );
}

function serverUrl(config: McpServerConfig): string | null {
  return "url" in config ? config.url : null;
}

/** Pi counts names that differ only in - and _ as the same server. */
function namespace(name: string): string {
  return name.replace(/-/g, "_");
}

function credentialKey(name: string, serverUrl: string): string {
  return `${namespace(name)}|${new URL(serverUrl).href}`;
}

function signInKey(userId: string, name: string): string {
  return `${userId} ${name}`;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): HttpError {
  return new HttpError(400, message);
}
