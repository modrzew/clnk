import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import type {
  ChatSummary,
  ModelsResponse,
  ProjectSummary,
  ServerMessage,
  UserInfo,
} from "../../shared/protocol";
import {
  applyServerMessage,
  emptyTranscript,
  type TranscriptState,
} from "../../shared/transcript";
import type { BackendClient, ConnectionStatus } from "./client";

export function useConnectionStatus(client: BackendClient): ConnectionStatus {
  return useSyncExternalStore(
    (onChange) => client.onStatus(onChange),
    () => client.status,
  );
}

/** Who is logged in. Null until the first connection. */
export function useUser(client: BackendClient): UserInfo | null {
  const [user, setUser] = useState<UserInfo | null>(null);
  useEffect(
    () =>
      client.onMessage((msg) => {
        if (msg.type === "user") setUser(msg.user);
      }),
    [client],
  );
  return user;
}

/** All chats of the user, most recently updated first. Null until the first connection. */
export function useChats(client: BackendClient): ChatSummary[] | null {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  useEffect(
    () =>
      client.onMessage((msg) => {
        if (msg.type === "chats") setChats(sortChats(msg.chats));
        if (msg.type === "chat_updated" || msg.type === "snapshot") {
          const chat = msg.chat;
          setChats(
            (prev) =>
              prev &&
              sortChats([chat, ...prev.filter((c) => c.id !== chat.id)]),
          );
        }
        if (msg.type === "chat_deleted")
          setChats((prev) => prev && prev.filter((c) => c.id !== msg.chatId));
      }),
    [client],
  );
  return chats;
}

/** All projects of the user, sorted by name. Null until the first connection. */
export function useProjects(client: BackendClient): ProjectSummary[] | null {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  useEffect(
    () =>
      client.onMessage((msg) => {
        if (msg.type === "projects") setProjects(sortProjects(msg.projects));
        if (msg.type === "project_updated") {
          const project = msg.project;
          setProjects(
            (prev) =>
              prev &&
              sortProjects([
                project,
                ...prev.filter((p) => p.id !== project.id),
              ]),
          );
        }
      }),
    [client],
  );
  return projects;
}

export interface Models {
  models: ModelsResponse | null;
  error: string | null;
}

/** The backend's models, fetched again whenever the connection opens in case its Pi config changed. */
export function useModels(client: BackendClient): Models {
  const connection = useConnectionStatus(client);
  const [state, setState] = useState<Models>({ models: null, error: null });
  useEffect(() => {
    if (connection !== "open") return;
    let cancelled = false;
    client
      .getModels()
      .then((models) => !cancelled && setState({ models, error: null }))
      .catch(
        (err: Error) =>
          !cancelled && setState((prev) => ({ ...prev, error: err.message })),
      );
    return () => {
      cancelled = true;
    };
  }, [client, connection]);
  return state;
}

function sortChats(chats: ChatSummary[]) {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
}

function sortProjects(projects: ProjectSummary[]) {
  return [...projects].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, {
      sensitivity: "base",
      numeric: true,
    }),
  );
}

/** Live transcript of one chat. Updates are applied once per animation frame while streaming. */
export function useTranscript(
  client: BackendClient,
  chatId: string,
): TranscriptState {
  const [state, dispatch] = useReducer(
    (current: TranscriptState, batch: ServerMessage[]) =>
      batch.reduce(applyServerMessage, current),
    emptyTranscript,
  );
  useEffect(() => {
    let queue: ServerMessage[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = queue;
      queue = [];
      dispatch(batch);
    };
    const offMessage = client.onMessage((msg) => {
      const id =
        msg.type === "snapshot"
          ? msg.chat.id
          : "chatId" in msg
            ? msg.chatId
            : null;
      if (id !== chatId) return;
      queue.push(msg);
      if (!frame) frame = requestAnimationFrame(flush);
    });
    const unsubscribe = client.subscribe(chatId);
    return () => {
      cancelAnimationFrame(frame);
      offMessage();
      unsubscribe();
    };
  }, [client, chatId]);
  return state;
}

export type Route =
  | { name: "new" }
  | { name: "chat"; chatId: string }
  | { name: "project"; projectId: string };

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (onChange) => {
      window.addEventListener("hashchange", onChange);
      return () => window.removeEventListener("hashchange", onChange);
    },
    () => window.location.hash,
  );
  const chat = hash.match(/^#\/chat\/(.+)$/);
  if (chat) return { name: "chat", chatId: decodeURIComponent(chat[1]) };
  const project = hash.match(/^#\/project\/(.+)$/);
  if (project)
    return { name: "project", projectId: decodeURIComponent(project[1]) };
  return { name: "new" };
}

export function routeHref(route: Route): string {
  switch (route.name) {
    case "chat":
      return `#/chat/${encodeURIComponent(route.chatId)}`;
    case "project":
      return `#/project/${encodeURIComponent(route.projectId)}`;
    default:
      return "#/";
  }
}

export function navigate(route: Route) {
  window.location.hash = routeHref(route);
}
