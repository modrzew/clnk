import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import type { BackendClient } from "./client";
import { navigate } from "./hooks";

/**
 * Whether notifications can be shown here at all. Browsers only have the API over HTTPS and on
 * localhost. The desktop app gets it from Tauri's notification plugin; the Android app doesn't have it.
 */
export const notificationSupport: "supported" | "insecure" | "unsupported" =
  typeof Notification !== "undefined"
    ? "supported"
    : !isTauri() && !window.isSecureContext
      ? "insecure"
      : "unsupported";

// Per device, like the display preferences.
const STORAGE_KEY = "clnk.notifications";
const listeners = new Set<() => void>();
let enabled = load();

function load() {
  return localStorage.getItem(STORAGE_KEY) === "on";
}

function notify() {
  for (const listener of listeners) listener();
}

window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY) return;
  enabled = load();
  notify();
});

/** Whether this device asked for notifications. They also need the browser's permission. */
export function useNotificationsEnabled(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => enabled,
  );
}

/** Turning them on asks for the browser's permission first, and fails without it. */
export async function setNotificationsEnabled(on: boolean): Promise<boolean> {
  if (on && (await Notification.requestPermission()) !== "granted")
    return false;
  enabled = on;
  localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  notify();
  return true;
}

/** Notifies when Pi is done with a chat, unless that chat is on screen. */
export function useChatNotifications(
  client: BackendClient,
  openChatId: string | null,
) {
  const on = useNotificationsEnabled();
  useEffect(() => {
    if (!on || notificationSupport !== "supported") return;
    return client.onMessage((msg) => {
      if (msg.type !== "chat_finished" || Notification.permission !== "granted")
        return;
      if (
        msg.chatId === openChatId &&
        document.visibilityState === "visible" &&
        document.hasFocus()
      )
        return;
      const notification = new Notification(msg.title, {
        body: msg.failed
          ? `Failed: ${msg.text || "unknown error"}`
          : msg.text || "Pi is done.",
        // Other tabs get the same message; a notification with the same tag replaces theirs.
        tag: msg.chatId,
      });
      // Browsers only. The desktop app comes to the front on a click, but stays where it is.
      notification.onclick = () => {
        window.focus();
        navigate({ name: "chat", chatId: msg.chatId });
        notification.close();
      };
    });
  }, [client, on, openChatId]);
}
