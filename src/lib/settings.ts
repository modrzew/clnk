import { useSyncExternalStore } from "react";
import type { ServerMessage, UserSettings } from "../../shared/protocol";
import { validSettings } from "../../shared/settings";
import { DEFAULT_ACCENT } from "./palette";

type Changes = Partial<UserSettings>;

/** What this needs of a BackendClient. */
interface Backend {
  onMessage(listener: (msg: ServerMessage) => void): () => void;
  updateSettings(changes: Changes): Promise<unknown>;
}

const DEFAULTS: UserSettings = {
  theme: "system",
  accent: DEFAULT_ACCENT,
  thinking: "running",
  commands: "running",
  changes: "expanded",
  reads: "collapsed",
  tools: "collapsed",
};

// The settings are the backend's. This is a copy to start with until it answers, whoever logs in then.
// index.html reads the theme from it too, before the first paint.
const STORAGE_KEY = "clnk.settings";
// Where they were when each device had its own.
const DISPLAY_KEY = "clnk.display";
const THEME_KEY = "clnk.theme";
const ACCENT_KEY = "clnk.accent";
/** The accent changes all the time while its picker is dragged. */
const SAVE_DELAY_MS = 300;
const RETRY_DELAY_MS = 5000;

const listeners = new Set<() => void>();
/** This device's own settings, from before the backend had them, until the backend is heard from. */
let local = loadLocal();
/** What the backend has, as far as this device knows. */
let saved = load();
/** Changes the backend hasn't confirmed yet. Until it has, they win over what it says. */
let unsaved: Changes = {};
let current = merged();
let client: Backend | null = null;
let saving = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function parse(json: string | null): Record<string, unknown> {
  try {
    return (JSON.parse(json ?? "{}") ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function load(): Changes {
  return validSettings(parse(localStorage.getItem(STORAGE_KEY)));
}

function loadLocal(): Changes {
  return validSettings({
    ...parse(localStorage.getItem(DISPLAY_KEY)),
    theme: localStorage.getItem(THEME_KEY),
    accent: localStorage.getItem(ACCENT_KEY),
  });
}

function merged(): UserSettings {
  return { ...DEFAULTS, ...local, ...saved, ...unsaved };
}

function without(
  changes: Changes,
  drop: (key: keyof UserSettings) => boolean,
): Changes {
  const kept = { ...changes };
  for (const key of Object.keys(kept) as (keyof UserSettings)[])
    if (drop(key)) delete kept[key];
  return kept;
}

function changed() {
  current = merged();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  for (const listener of listeners) listener();
}

function received(settings: Changes) {
  saved = settings;
  // The first device to connect brings what it had. Those after it get that instead of their own.
  unsaved = { ...without(local, (key) => key in settings), ...unsaved };
  local = {};
  for (const key of [DISPLAY_KEY, THEME_KEY, ACCENT_KEY])
    localStorage.removeItem(key);
  changed();
  saveSoon();
}

/** Only a change puts off a save that's coming up. Other devices' changes could keep it from happening. */
function saveSoon(delayMs = SAVE_DELAY_MS) {
  saveTimer ??= setTimeout(() => {
    saveTimer = undefined;
    void save();
  }, delayMs);
}

function cancelSave() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
}

/** One request at a time, so that the last change is the last to reach the backend. */
async function save() {
  const sender = client;
  if (!sender || saving || !Object.keys(unsaved).length) return;
  const sent = unsaved;
  saving = true;
  try {
    await sender.updateSettings(sent);
  } catch {
    // They stay unsaved. The WebSocket can outlive a failed request, so this can't wait for it to reconnect.
    saveSoon(RETRY_DELAY_MS);
    return;
  } finally {
    saving = false;
  }
  if (sender !== client) return;
  saved = { ...saved, ...sent };
  unsaved = without(unsaved, (key) => unsaved[key] === sent[key]);
  saveSoon();
}

/** Keeps the settings in step with the backend while logged in, until the function it returns is called. */
export function syncSettings(backend: Backend) {
  client = backend;
  const stop = backend.onMessage((msg) => {
    if (msg.type === "settings") received(msg.settings);
  });
  return () => {
    stop();
    cancelSave();
    client = null;
    // They're not for whoever logs in next.
    unsaved = {};
  };
}

export function updateSettings(changes: Changes) {
  unsaved = { ...unsaved, ...changes };
  changed();
  cancelSave();
  saveSoon();
}

export function getSettings(): UserSettings {
  return current;
}

export function onSettingsChange(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useSettings(): UserSettings {
  return useSyncExternalStore(onSettingsChange, getSettings);
}

/** For components there can be many of, which only change along with this setting. */
export function useSetting<K extends keyof UserSettings>(
  key: K,
): UserSettings[K] {
  return useSyncExternalStore(onSettingsChange, () => current[key]);
}
