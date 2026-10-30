import { existsSync } from "node:fs";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  type InlineExtension,
  ModelRuntime,
  type SessionEntry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ChatMessage, ModelRef, ModelsResponse } from "../shared/protocol";

export type AgentMessage = Extract<AgentSessionEvent, { type: "message_end" }>["message"];

/** Pi configuration shared by every chat. Only the chat folder and transcript differ per chat. */
export interface PiHost {
  modelRuntime: ModelRuntime;
  /** Pi's global config dir (~/.pi/agent): settings, models.json, MCP, extensions. */
  agentDir: string;
  /** Load extensions, MCP, codemode and tool search like the CLI does. Tests turn this off. */
  extensions: boolean;
}

export async function createPiHost(): Promise<PiHost> {
  return { modelRuntime: await ModelRuntime.create(), agentDir: getAgentDir(), extensions: true };
}

export async function listModels(host: PiHost): Promise<ModelsResponse> {
  const models = (await host.modelRuntime.getAvailable()).map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
  }));
  const settings = SettingsManager.create(host.agentDir, host.agentDir, { projectTrusted: false });
  const provider = settings.getDefaultProvider();
  const id = settings.getDefaultModel();
  const configured = models.find((model) => model.provider === provider && model.id === id);
  const fallback = configured ?? models[0];
  return { models, defaultModel: fallback ? { provider: fallback.provider, id: fallback.id } : null };
}

export function hasModel(host: PiHost, model: ModelRef): boolean {
  return host.modelRuntime.getModel(model.provider, model.id) !== undefined;
}

export interface ChatSessionOptions {
  chatId: string;
  /** The chat's folder, which Pi is told to stay inside. */
  cwd: string;
  sessionDir: string;
  /** Existing transcript to continue. A new one is started when null or missing. */
  sessionFile: string | null;
  model: ModelRef;
}

export async function openChatSession(host: PiHost, options: ChatSessionOptions): Promise<AgentSession> {
  const model = host.modelRuntime.getModel(options.model.provider, options.model.id);
  if (!model) throw new Error(`Model ${options.model.provider}/${options.model.id} is not available`);

  // Untrusted: the chat folder is Pi's scratch space, so config Pi writes there must not be loaded.
  const settingsManager = SettingsManager.create(options.cwd, host.agentDir, { projectTrusted: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: host.agentDir,
    settingsManager,
    noExtensions: !host.extensions,
    extensionFactories: host.extensions ? builtinExtensions() : [],
    appendSystemPrompt: [chatInstructions(options.cwd)],
  });
  await resourceLoader.reload();
  for (const { path, error } of resourceLoader.getExtensions().errors) {
    console.warn(`Failed to load Pi extension ${path}: ${error}`);
  }

  const sessionManager =
    options.sessionFile && existsSync(options.sessionFile)
      ? SessionManager.open(options.sessionFile, options.sessionDir, options.cwd)
      : SessionManager.create(options.cwd, options.sessionDir, { id: options.chatId });

  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: host.agentDir,
    model,
    modelRuntime: host.modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager,
  });
  // Starts extensions (MCP connects here). Without a UI context, extension dialogs are skipped.
  await session.bindExtensions({});
  return session;
}

/** The SDK doesn't load the CLI's built-in extensions, so register them the same way the CLI does. */
function builtinExtensions(): InlineExtension[] {
  return [
    { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
    { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
    { name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
  ];
}

function chatInstructions(cwd: string): string {
  return [
    "You are running behind clnk, a chat app for Pi. Each chat has its own working directory:",
    cwd,
    "Do not read, create, modify or delete anything outside of this directory.",
    "The directory is scratch space and can be cleared between sessions. If files from earlier in this conversation are missing, tell the user they were lost instead of assuming they still exist.",
  ].join("\n");
}

/** Reads the active branch of a transcript without starting a Pi session. */
export function readTranscript(sessionFile: string, sessionDir: string, cwd: string): ChatMessage[] {
  if (!existsSync(sessionFile)) return [];
  return transcriptFromEntries(SessionManager.open(sessionFile, sessionDir, cwd).getBranch());
}

export function transcriptFromEntries(entries: SessionEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const entry of entries) {
    const message = entryToMessage(entry);
    if (message) messages.push(message);
  }
  return messages;
}

function entryToMessage(entry: SessionEntry): ChatMessage | null {
  switch (entry.type) {
    case "message":
      return toChatMessage(entry.message);
    case "custom_message":
      if (!entry.display) return null;
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: true,
        timestamp: Date.parse(entry.timestamp),
      };
    case "compaction":
      return compactionMarker(entry.summary, entry.tokensBefore, Date.parse(entry.timestamp));
    default:
      return null;
  }
}

/** Messages the UI shows. System prompts and Pi-internal roles are left out. */
export function toChatMessage(message: AgentMessage): ChatMessage | null {
  switch (message.role) {
    case "user":
    case "assistant":
    case "toolResult":
      return message;
    case "custom":
      return message.display ? message : null;
    default:
      return null;
  }
}

export function compactionMarker(summary: string, tokensBefore: number, timestamp: number): ChatMessage {
  return { role: "compaction", summary, tokensBefore, timestamp };
}
