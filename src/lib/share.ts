import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import {
  type ChatSummary,
  MAX_REQUEST_BYTES,
  type ProjectSummary,
} from "../../shared/protocol";
import { type Route, routeHref } from "./hooks";

declare global {
  interface Window {
    /** The Android app's MainActivity, which other apps share files to. */
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
  /** Size is -1 when the other app doesn't say. */
  files: { id: string; name: string; type: string; size: number }[];
}

/** Files another app shared to this one, for a composer to attach. */
export interface Share {
  files: File[];
  /** Why some files aren't there. */
  errors: string[];
}

interface PendingShare extends Share {
  launch: boolean;
  /** The href of the page whose composer gets it, once the app picked one. */
  target: string | null;
}

const listeners = new Set<() => void>();
let pending: PendingShare | null = null;
/** The href of the page whose composer has something in it: a message being written, or a share. */
let draft: string | null = null;

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

/** Takes what was shared to the Android app. A second share before the first is attached joins it. */
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
            errors: [...pending.errors, ...errors],
            // Picked again, in case the first one's page had no composer for it.
            target: null,
          }
        : { files, errors, launch: received.launch, target: null },
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

if (window.clnkShare) {
  // From MainActivity, when something is shared while the page runs. What was shared while it was
  // loading, or that started the app, is waiting for the first take.
  window.addEventListener("clnkshare", () => void takeShared());
  void takeShared();
}

/**
 * Opens a page for what's shared to the app: the one with a draft, so the files join what the user is
 * writing. Without one, a new chat if the share started the app, or else the most recently updated chat
 * that can take a message.
 */
export function useShareRouting(
  chats: ChatSummary[] | null,
  projects: ProjectSummary[] | null,
) {
  const share = usePendingShare();
  useEffect(() => {
    if (!share || share.target || pending !== share) return;
    const target = pickTarget(share.launch, chats, projects);
    if (!target) return;
    setPending({ ...share, target });
    window.location.hash = target;
  }, [share, chats, projects]);
}

/** The href of the page for a share, or undefined until the chats are known. */
function pickTarget(
  launch: boolean,
  chats: ChatSummary[] | null,
  projects: ProjectSummary[] | null,
): string | undefined {
  if (draft) return draft;
  if (launch) return routeHref({ name: "new" });
  if (!chats || !projects) return;
  const archivedProjects = new Set(
    projects.filter((project) => project.archived).map(({ id }) => id),
  );
  const chat = chats.find(
    (chat) =>
      !chat.archived &&
      !(chat.projectId && archivedProjects.has(chat.projectId)),
  );
  return routeHref(chat ? { name: "chat", chatId: chat.id } : { name: "new" });
}

/**
 * Calls `receive` with what's shared to the app, when it's for the page at `target`. While `hasDraft`,
 * it's for that page whatever else is open.
 */
export function useReceiveShare(
  target: Route | undefined,
  hasDraft: boolean,
  receive: (share: Share) => void,
) {
  const share = usePendingShare();
  const href = target && routeHref(target);
  const onReceive = useEffectEvent(receive);
  useEffect(() => {
    // Also not twice, when the effect runs again before the store's change rendered.
    if (!share?.target || share.target !== href || pending !== share) return;
    setPending(null);
    onReceive(share);
  }, [share, href]);
  useEffect(() => {
    if (!href || !hasDraft) return;
    draft = href;
    return () => {
      if (draft === href) draft = null;
    };
  }, [href, hasDraft]);
}
