import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Theme } from "../../shared/protocol";
import { palette } from "./palette";
import { getSettings, onSettingsChange, updateSettings } from "./settings";

export const THEMES: { theme: Theme; label: string }[] = [
  { theme: "system", label: "System" },
  { theme: "light", label: "Light" },
  { theme: "dark", label: "Dark" },
];

declare global {
  interface Window {
    /** The Android app's MainActivity. */
    clnkSystemBars?: { update(background: string, dark: boolean): void };
  }
}

const systemDark = matchMedia("(prefers-color-scheme: dark)");
let windowTheme: Theme | null = null;

/** Puts the colours on the page, and on the parts of the app around it that it can't reach. */
function apply() {
  const { theme, accent } = getSettings();
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

onSettingsChange(apply);
systemDark.addEventListener("change", apply);
apply();

export function setTheme(theme: Theme) {
  updateSettings({ theme });
}

export function setAccent(accent: string) {
  updateSettings({ accent });
}
