import { useState } from "react";
import type { ExpandMode, OutputKind } from "../../shared/protocol";
import { updateSettings, useSetting } from "./settings";

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

export function setExpandMode(kind: OutputKind, mode: ExpandMode) {
  updateSettings({ [kind]: mode });
}

/**
 * Open state of a collapsible block of the given kind. `active` while it streams or runs. Follows the
 * display preference until the user toggles it.
 */
export function useExpandable(
  kind: OutputKind,
  active: boolean,
): [open: boolean, toggle: () => void] {
  const mode = useSetting(kind);
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open =
    toggled ?? (mode === "expanded" || (mode === "running" && active));
  return [open, () => setToggled(!open)];
}
