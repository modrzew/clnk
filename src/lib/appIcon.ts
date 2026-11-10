import { invoke, isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

export type AppIcon = "default" | "waifu";

export const APP_ICONS: { icon: AppIcon; label: string }[] = [
  { icon: "default", label: "Default" },
  { icon: "waifu", label: "Waifu" },
];

declare global {
  interface Window {
    /** The Android app's MainActivity. */
    clnkAppIcon?: { set(icon: AppIcon): void };
  }
}

function detectSupport(): "android" | "macos" | "unsupported" {
  if (!isTauri()) return "unsupported";
  if (/android/i.test(navigator.userAgent)) return "android";
  return /Macintosh/.test(navigator.userAgent) ? "macos" : "unsupported";
}

/**
 * Where the app can change its own icon: on Android's home screen, and in the Mac's Dock. Browsers
 * can't, nor can the desktop apps for the other systems.
 */
export const appIconSupport = detectSupport();

// Per device, as each one has its own icon.
const STORAGE_KEY = "clnk.appIcon";
const listeners = new Set<() => void>();
let current = load();

function load(): AppIcon {
  const stored = localStorage.getItem(STORAGE_KEY);
  return APP_ICONS.find(({ icon }) => icon === stored)?.icon ?? "default";
}

/** Android keeps the icon it was given, but the Dock goes back to the app's own at every start. */
function apply() {
  if (appIconSupport === "android") window.clnkAppIcon?.set(current);
  else if (appIconSupport === "macos")
    void invoke("set_app_icon", { icon: current });
}

apply();

export function setAppIcon(icon: AppIcon) {
  current = icon;
  localStorage.setItem(STORAGE_KEY, icon);
  apply();
  for (const listener of listeners) listener();
}

export function useAppIcon(): AppIcon {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => current,
  );
}
