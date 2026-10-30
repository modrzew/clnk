import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import type { ChatSummary, ServerMessage } from "../../shared/protocol";
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
      }),
    [client],
  );
  return chats;
}

function sortChats(chats: ChatSummary[]) {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
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

export type Route = { name: "new" } | { name: "chat"; chatId: string };

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (onChange) => {
      window.addEventListener("hashchange", onChange);
      return () => window.removeEventListener("hashchange", onChange);
    },
    () => window.location.hash,
  );
  const match = hash.match(/^#\/chat\/(.+)$/);
  return match
    ? { name: "chat", chatId: decodeURIComponent(match[1]) }
    : { name: "new" };
}

export function navigate(route: Route) {
  window.location.hash =
    route.name === "chat" ? `/chat/${encodeURIComponent(route.chatId)}` : "/";
}
