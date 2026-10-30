import { useState, useSyncExternalStore } from "react";

/** When a kind of output in the transcript is expanded, until it's toggled by hand. */
export type ExpandMode = "expanded" | "running" | "collapsed";

export type OutputKind =
  "thinking" | "commands" | "changes" | "reads" | "tools";

export const OUTPUT_KINDS: { kind: OutputKind; label: string; hint: string }[] =
  [
    { kind: "thinking", label: "Thinking", hint: "The model's reasoning" },
    {
      kind: "commands",
      label: "Commands",
      hint: "Shell commands and their output",
    },
    {
      kind: "changes",
      label: "File changes",
      hint: "Diffs of edits and contents of written files",
    },
    { kind: "reads", label: "File reads", hint: "Contents of files Pi read" },
    {
      kind: "tools",
      label: "Other tools",
      hint: "Search, MCP and any other tools",
    },
  ];

export const EXPAND_MODES: { mode: ExpandMode; label: string }[] = [
  { mode: "expanded", label: "Expanded" },
  { mode: "running", label: "While running" },
  { mode: "collapsed", label: "Collapsed" },
];

export type DisplayPrefs = Record<OutputKind, ExpandMode>;

const DEFAULTS: DisplayPrefs = {
  thinking: "running",
  commands: "running",
  changes: "expanded",
  reads: "collapsed",
  tools: "collapsed",
};

// Per device: a phone may want less expanded than a desktop.
const STORAGE_KEY = "clnk.display";
const listeners = new Set<() => void>();
let current = load();

function load(): DisplayPrefs {
  let stored: Record<string, unknown> = {};
  try {
    stored = (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") ??
      {}) as Record<string, unknown>;
  } catch {}
  const prefs = { ...DEFAULTS };
  for (const { kind } of OUTPUT_KINDS) {
    const mode = EXPAND_MODES.find((m) => m.mode === stored[kind]);
    if (mode) prefs[kind] = mode.mode;
  }
  return prefs;
}

function notify() {
  for (const listener of listeners) listener();
}

window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY) return;
  current = load();
  notify();
});

export function useDisplayPrefs(): DisplayPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => current,
  );
}

export function setExpandMode(kind: OutputKind, mode: ExpandMode) {
  current = { ...current, [kind]: mode };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  notify();
}

/**
 * Open state of a collapsible block of the given kind. `active` while it streams or runs. Follows the
 * display preference until the user toggles it.
 */
export function useExpandable(
  kind: OutputKind,
  active: boolean,
): [open: boolean, toggle: () => void] {
  const mode = useDisplayPrefs()[kind];
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open =
    toggled ?? (mode === "expanded" || (mode === "running" && active));
  return [open, () => setToggled(!open)];
}
