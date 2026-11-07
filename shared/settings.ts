import type { ExpandMode, Theme, UserSettings } from "./protocol";

const THEMES: Theme[] = ["system", "light", "dark"];
const EXPAND_MODES: ExpandMode[] = ["expanded", "running", "collapsed"];

const isExpandMode = (value: unknown) =>
  EXPAND_MODES.includes(value as ExpandMode);

/** For each setting, whether a value is valid for it. */
export const SETTING_CHECKS: Record<
  keyof UserSettings,
  (value: unknown) => boolean
> = {
  theme: (value) => THEMES.includes(value as Theme),
  accent: (value) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value),
  thinking: isExpandMode,
  commands: isExpandMode,
  changes: isExpandMode,
  reads: isExpandMode,
  tools: isExpandMode,
};

/** The valid settings among the fields of `value`. */
export function validSettings(
  value: Record<string, unknown>,
): Partial<UserSettings> {
  const valid = Object.entries(SETTING_CHECKS).filter(([key, check]) =>
    check(value[key]),
  );
  return Object.fromEntries(valid.map(([key]) => [key, value[key]]));
}
