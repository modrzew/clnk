import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import {
  type ChatSummary,
  MAX_REQUEST_BYTES,
  type ProjectSummary,
} from "../../shared/protocol";
import { navigate, type Route, routeHref } from "./hooks";

declare global {
  interface Window {
    /** The Android app's MainActivity, which other apps share files and text to. */
    clnkShare?: {
      /** What was shared since the last call, as a JSON array of `Received`. */
      take(): string;
      /** The next part of a file in base64, "" at its end, or null if it can't be read. */
      read(id: string): string | null | undefined;
      /** Done with a file before its end. */
      close(id: string): void;
    };
  }
}

interface Received {
  /** Whether it started the app, rather than reaching it while it ran. */
  launch: boolean;
  text: string;
  /** Size is -1 when the other app doesn't say. */
  files: { id: string; name: string; type: string; size: number }[];
}

/** What another app shared to this one, for a composer to attach. */
export interface Share {
  files: File[];
  text: string;
  /** Why some files aren't there. */
  errors: string[];
}

interface PendingShare extends Share {
  launch: boolean;
  /** The page whose composer gets it, once the app picked one. */
  target: Route | null;
}

const listeners = new Set<() => void>();
let pending: PendingShare | null = null;

function setPending(share: PendingShare | null) {
  pending = share;
  for (const listener of listeners) listener();
}

function usePendingShare(): PendingShare | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => pending,
  );
}

/** Takes what was shared from the Android app. A second share before the first is attached joins it. */
async function takeShared() {
  const bridge = window.clnkShare;
  if (!bridge) return;
  for (const received of JSON.parse(bridge.take()) as Received[]) {
    const files: File[] = [];
    const errors: string[] = [];
    for (const file of received.files) {
      const result = await readFile(bridge, file);
      if (typeof result === "string") errors.push(result);
      else files.push(result);
    }
    setPending(
      pending
        ? {
            ...pending,
            files: [...pending.files, ...files],
            text: joinText(pending.text, received.text),
            errors: [...pending.errors, ...errors],
            // Picked again, in case the first one's page had no composer for it.
            target: null,
          }
        : {
            files,
            text: received.text,
            errors,
            launch: received.launch,
            target: null,
          },
    );
  }
}

/** A shared file, or why it can't be attached. */
async function readFile(
  bridge: NonNullable<Window["clnkShare"]>,
  { id, name, type, size }: Received["files"][number],
): Promise<File | string> {
  // Nothing larger could be sent, so it's not read.
  const tooLarge = `${name} is too large to attach.`;
  if (size > MAX_REQUEST_BYTES) {
    bridge.close(id);
    return tooLarge;
  }
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let read = 0;
  for (;;) {
    const part = bridge.read(id);
    if (part == null) return `Couldn't read ${name}.`;
    if (!part) return new File(parts, name, { type });
    const bytes = decodeBase64(part);
    read += bytes.length;
    if (read > MAX_REQUEST_BYTES) {
      bridge.close(id);
      return tooLarge;
    }
    parts.push(bytes);
    // Each part blocks the page while it's read, so it gets to render in between.
    await new Promise((resolve) => setTimeout(resolve));
  }
}

function decodeBase64(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function joinText(...parts: string[]): string {
  return parts.filter((part) => part.trim()).join("\n\n");
}

if (window.clnkShare) {
  // From MainActivity, when something is shared while the page runs. What was shared while it was
  // loading, or that started the app, is waiting for the first take.
  window.addEventListener("clnkshare", () => void takeShared());
  void takeShared();
}

/**
 * Opens a page for what's shared to the app: a new chat if the share started the app, or else the most
 * recently updated chat that can take a message.
 */
export function useShareRouting(
  chats: ChatSummary[] | null,
  projects: ProjectSummary[] | null,
) {
  const share = usePendingShare();
  useEffect(() => {
    if (!share || share.target || pending !== share) return;
    let target: Route = { name: "new" };
    if (!share.launch) {
      if (!chats || !projects) return;
      const archivedProjects = new Set(
        projects.filter((project) => project.archived).map(({ id }) => id),
      );
      const chat = chats.find(
        (chat) =>
          !chat.archived &&
          !(chat.projectId && archivedProjects.has(chat.projectId)),
      );
      if (chat) target = { name: "chat", chatId: chat.id };
    }
    setPending({ ...share, target });
    navigate(target);
  }, [share, chats, projects]);
}

/** Calls `receive` with what's shared to the app, when it's for the page at `target`. */
export function useReceiveShare(
  target: Route | undefined,
  receive: (share: Share) => void,
) {
  const share = usePendingShare();
  const href = target && routeHref(target);
  const onReceive = useEffectEvent(receive);
  useEffect(() => {
    // Also not twice, when the effect runs again before the store's change rendered.
    if (!share?.target || routeHref(share.target) !== href || pending !== share)
      return;
    setPending(null);
    onReceive(share);
  }, [share, href]);
}
