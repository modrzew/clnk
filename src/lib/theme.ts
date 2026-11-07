import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSyncExternalStore } from "react";
import { DEFAULT_ACCENT, palette } from "./palette";

export type Theme = "system" | "light" | "dark";

export const THEMES: { theme: Theme; label: string }[] = [
  { theme: "system", label: "System" },
  { theme: "light", label: "Light" },
  { theme: "dark", label: "Dark" },
];

export interface Appearance {
  theme: Theme;
  accent: string;
}

declare global {
  interface Window {
    /** The Android app's MainActivity. */
    clnkSystemBars?: { update(background: string, dark: boolean): void };
  }
}

// Per device, like the display preferences. index.html reads the theme too, before the first paint.
const THEME_KEY = "clnk.theme";
const ACCENT_KEY = "clnk.accent";
const listeners = new Set<() => void>();
const systemDark = matchMedia("(prefers-color-scheme: dark)");
let current = load();
let windowTheme: Theme | null = null;

function load(): Appearance {
  const stored = localStorage.getItem(THEME_KEY);
  const accent = localStorage.getItem(ACCENT_KEY) ?? "";
  return {
    theme: THEMES.find((each) => each.theme === stored)?.theme ?? "system",
    accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent : DEFAULT_ACCENT,
  };
}

/** Puts the colours on the page, and on the parts of the app around it that it can't reach. */
function apply() {
  const { theme, accent } = current;
  const dark = theme === "system" ? systemDark.matches : theme === "dark";
  const scheme = dark ? "dark" : "light";
  const colours = palette(accent, scheme);
  const root = document.documentElement;
  root.style.colorScheme = scheme;
  for (const [name, colour] of Object.entries(colours))
    root.style.setProperty(name, colour);

  if (!isTauri()) return;
  if (/android/i.test(navigator.userAgent))
    window.clnkSystemBars?.update(colours["--bg"], dark);
  // Not for every colour the picker is dragged over, as this goes through the app.
  else if (theme !== windowTheme) {
    windowTheme = theme;
    void getCurrentWindow().setTheme(theme === "system" ? null : theme);
  }
}

function changed() {
  apply();
  for (const listener of listeners) listener();
}

window.addEventListener("storage", (event) => {
  if (event.key !== THEME_KEY && event.key !== ACCENT_KEY) return;
  current = load();
  changed();
});

systemDark.addEventListener("change", apply);
apply();

export function useAppearance(): Appearance {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => current,
  );
}

export function setTheme(theme: Theme) {
  current = { ...current, theme };
  localStorage.setItem(THEME_KEY, theme);
  changed();
}

export function setAccent(accent: string) {
  current = { ...current, accent };
  localStorage.setItem(ACCENT_KEY, accent);
  changed();
}
