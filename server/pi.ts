import { existsSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  type InlineExtension,
  ModelRuntime,
  type SessionEntry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ArtefactInfo,
  ChatMessage,
  ModelRef,
  ModelsResponse,
} from "../shared/protocol";
import { ATTACHMENTS_DIR, toUserMessage } from "./attachments";

export type AgentMessage = Extract<
  AgentSessionEvent,
  { type: "message_end" }
>["message"];

/** Where a project chat's folder links to the project's artefacts. */
export const ARTEFACTS_LINK = "artefacts";

/** Pi configuration shared by every chat. Only the chat folder and transcript differ per chat. */
export interface PiHost {
  modelRuntime: ModelRuntime;
  /** Pi's global config dir (~/.pi/agent): settings, models.json, MCP, extensions. */
  agentDir: string;
  /** Load extensions, MCP, codemode and tool search like the CLI does. Tests turn this off. */
  extensions: boolean;
}

export async function createPiHost(): Promise<PiHost> {
  return {
    modelRuntime: await ModelRuntime.create(),
    agentDir: getAgentDir(),
    extensions: true,
  };
}

export async function listModels(host: PiHost): Promise<ModelsResponse> {
  const models = (await host.modelRuntime.getAvailable()).map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    images: model.input.includes("image"),
    contextWindow: model.contextWindow,
  }));
  const settings = SettingsManager.create(host.agentDir, host.agentDir, {
    projectTrusted: false,
  });
  const provider = settings.getDefaultProvider();
  const id = settings.getDefaultModel();
  const configured = models.find(
    (model) => model.provider === provider && model.id === id,
  );
  const fallback = configured ?? models[0];
  return {
    models,
    defaultModel: fallback
      ? { provider: fallback.provider, id: fallback.id }
      : null,
  };
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
  /** For chats in a project. */
  project?: ProjectHooks;
}

/** What a chat's session needs from its project. */
export interface ProjectHooks {
  /** The project's part of the system prompt. Read before every run, so changes apply to the next one. */
  prompt(): string | null;
  /** Saves a file as a project artefact. `path` is as Pi gave it. Throws errors worded for Pi. */
  saveArtefact(path: string, name: string | undefined): Promise<ArtefactInfo>;
}

export async function openChatSession(
  host: PiHost,
  options: ChatSessionOptions,
): Promise<AgentSession> {
  const model = host.modelRuntime.getModel(
    options.model.provider,
    options.model.id,
  );
  if (!model)
    throw new Error(
      `Model ${options.model.provider}/${options.model.id} is not available`,
    );

  // Untrusted: the chat folder is Pi's scratch space, so config Pi writes there must not be loaded.
  const settingsManager = SettingsManager.create(options.cwd, host.agentDir, {
    projectTrusted: false,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: host.agentDir,
    settingsManager,
    noExtensions: !host.extensions,
    extensionFactories: [
      ...(host.extensions ? builtinExtensions() : []),
      ...(options.project ? [projectExtension(options.project)] : []),
    ],
    appendSystemPrompt: [chatInstructions(options.cwd)],
  });
  await resourceLoader.reload();
  for (const { path, error } of resourceLoader.getExtensions().errors) {
    console.warn(`Failed to load Pi extension ${path}: ${error}`);
  }

  const sessionManager =
    options.sessionFile && existsSync(options.sessionFile)
      ? SessionManager.open(
          options.sessionFile,
          options.sessionDir,
          options.cwd,
        )
      : SessionManager.create(options.cwd, options.sessionDir, {
          id: options.chatId,
        });

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
    {
      name: "codemode",
      factory: createCodemodeExtension(),
      replaceable: true,
      builtin: true,
    },
    {
      name: "tool-search",
      factory: createToolSearchExtension(),
      replaceable: true,
      builtin: true,
    },
    {
      name: "mcp",
      factory: createMcpExtension(),
      replaceable: true,
      builtin: true,
    },
  ];
}

/** Adds the project to the system prompt and lets Pi save artefacts. Loaded even when other extensions aren't. */
function projectExtension(project: ProjectHooks): InlineExtension {
  const saveArtefact = defineTool({
    name: "save_artefact",
    label: "Save artefact",
    description:
      "Saves a file from your working directory as an artefact of the project, so that every chat in the project can use it. Artefacts can't be changed or replaced once saved.",
    promptSnippet: "Save a file as an artefact of the project",
    parameters: Type.Object({
      path: Type.String({
        description: "The file to save, relative to your working directory",
      }),
      name: Type.Optional(
        Type.String({
          description:
            "File name of the artefact, if it should differ from the file's own name",
        }),
      ),
    }),
    async execute(_toolCallId, { path, name }) {
      const artefact = await project.saveArtefact(path, name);
      return {
        content: [
          {
            type: "text",
            text: `Saved as the artefact ${artefact.name}. Every chat in the project has it at ${ARTEFACTS_LINK}/${artefact.name}.`,
          },
        ],
        details: { artefact },
      };
    },
  });
  return {
    name: "clnk-project",
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        const prompt = project.prompt();
        if (prompt) event.systemPromptOptions.sections.clnk_project = prompt;
      });
      pi.registerTool(saveArtefact);
    },
  };
}

function chatInstructions(cwd: string): string {
  return [
    "You are running behind clnk, a chat app for Pi. Each chat has its own working directory:",
    cwd,
    "Do not read, create, modify or delete anything outside of this directory.",
    "The directory is scratch space and can be cleared between sessions. If files from earlier in this conversation are missing, tell the user they were lost instead of assuming they still exist.",
    `Files the user attaches to a message are saved in ${ATTACHMENTS_DIR}/ in your working directory, and listed in an <attachments> block at the end of the message. Images marked inline="true" are also included in the message itself. Treat the files as the user's, and leave them unchanged unless asked to change them.`,
  ].join("\n");
}

/** Reads the active branch of a transcript without starting a Pi session. */
export function readTranscript(
  sessionFile: string,
  sessionDir: string,
  cwd: string,
): ChatMessage[] {
  if (!existsSync(sessionFile)) return [];
  return transcriptFromEntries(
    SessionManager.open(sessionFile, sessionDir, cwd).getBranch(),
  );
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
      return compactionMarker(
        entry.summary,
        entry.tokensBefore,
        Date.parse(entry.timestamp),
      );
    default:
      return null;
  }
}

/** Messages the UI shows. System prompts and Pi-internal roles are left out. */
export function toChatMessage(message: AgentMessage): ChatMessage | null {
  switch (message.role) {
    case "user":
      return toUserMessage(message);
    case "assistant":
    case "toolResult":
      return message;
    case "custom":
      return message.display ? message : null;
    default:
      return null;
  }
}

export function compactionMarker(
  summary: string,
  tokensBefore: number,
  timestamp: number,
): ChatMessage {
  return { role: "compaction", summary, tokensBefore, timestamp };
}
