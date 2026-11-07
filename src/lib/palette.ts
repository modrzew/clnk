/** What every colour of the UI is derived from, until the user picks their own. */
export const DEFAULT_ACCENT = "#2f6f5e";

export type Scheme = "light" | "dark";

/** Lightness, chroma, hue. Unlike in RGB or HSL, a lightness looks the same across hues. */
interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** Lightness of the greys, which take the accent's hue and a little of its chroma. */
const NEUTRALS: Record<Scheme, Record<string, number>> = {
  light: {
    "--bg": 0.988,
    "--pattern": 0.962,
    "--bg-sidebar": 0.958,
    "--bg-raised": 1,
    "--bg-user": 0.94,
    "--bg-hover": 0.922,
    "--border": 0.894,
    "--text": 0.23,
    "--text-muted": 0.531,
    "--accent-text": 1,
    "--code-bg": 0.949,
  },
  dark: {
    "--bg": 0.225,
    "--pattern": 0.262,
    "--bg-sidebar": 0.199,
    "--bg-raised": 0.263,
    "--bg-user": 0.298,
    "--bg-hover": 0.29,
    "--border": 0.334,
    "--text": 0.924,
    "--text-muted": 0.685,
    "--accent-text": 0.206,
    "--code-bg": 0.274,
  },
};

/**
 * Colours with a meaning of their own. They keep their hue, as danger has to stay red whatever the
 * accent, and scale their chroma with it. These are their values under the default accent.
 */
const SIGNALS: Record<Scheme, Record<string, Oklch>> = {
  light: {
    "--danger": { l: 0.501, c: 0.178, h: 29 },
    "--danger-bg": { l: 0.955, c: 0.016, h: 22 },
    "--ok": { l: 0.564, c: 0.125, h: 152 },
    "--warn": { l: 0.544, c: 0.117, h: 71 },
    "--diff-add": { l: 0.478, c: 0.111, h: 151 },
    "--diff-add-bg": { l: 0.949, c: 0.023, h: 153 },
    "--diff-del": { l: 0.467, c: 0.154, h: 28 },
    "--diff-del-bg": { l: 0.948, c: 0.02, h: 25 },
  },
  dark: {
    "--danger": { l: 0.743, c: 0.124, h: 25 },
    "--danger-bg": { l: 0.285, c: 0.036, h: 22 },
    "--ok": { l: 0.777, c: 0.133, h: 153 },
    "--warn": { l: 0.784, c: 0.12, h: 81 },
    "--diff-add": { l: 0.821, c: 0.102, h: 154 },
    "--diff-add-bg": { l: 0.299, c: 0.036, h: 156 },
    "--diff-del": { l: 0.791, c: 0.095, h: 25 },
    "--diff-del-bg": { l: 0.285, c: 0.036, h: 22 },
  },
};

/** The most a light scheme's accent may be, and the least a dark scheme's, to stay readable. */
const ACCENT_LIGHTNESS: Record<Scheme, number> = { light: 0.52, dark: 0.73 };
const SCRIM_LIGHTNESS = 0.15;

/** Every colour of the UI as CSS custom properties, from the accent as `#rrggbb`. */
export function palette(
  accent: string,
  scheme: Scheme,
): Record<string, string> {
  const base = fromHex(accent);
  const neutralChroma = Math.min(base.c, 0.15) * 0.08;
  const signalScale = clamp(base.c / fromHex(DEFAULT_ACCENT).c, 0.7, 1.3);
  const limit = ACCENT_LIGHTNESS[scheme];
  const scrim = toHex({ ...base, l: SCRIM_LIGHTNESS, c: neutralChroma });

  const colours: Record<string, string> = {
    "--accent": toHex({
      ...base,
      l: scheme === "light" ? Math.min(base.l, limit) : Math.max(base.l, limit),
    }),
    "--scrim": `${scrim}59`,
    "--scrim-strong": `${scrim}cc`,
  };
  for (const [name, l] of Object.entries(NEUTRALS[scheme]))
    colours[name] = toHex({ l, c: neutralChroma, h: base.h });
  for (const [name, signal] of Object.entries(SIGNALS[scheme]))
    colours[name] = toHex({ ...signal, c: signal.c * signalScale });
  return colours;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function fromHex(hex: string): Oklch {
  const value = parseInt(hex.slice(1), 16);
  const [r, g, b] = [value >> 16, value >> 8, value].map((channel) => {
    const v = (channel & 255) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    l: lightness,
    c: Math.hypot(a, bb),
    h: (Math.atan2(bb, a) * 180) / Math.PI,
  };
}

function toLinearRgb({ l, c, h }: Oklch): number[] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const long = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ];
}

function toHex(colour: Oklch): string {
  // Past what the screen can show a colour clips to another hue, so it gives up chroma instead.
  let c = colour.c;
  let rgb = toLinearRgb(colour);
  while (c > 0 && rgb.some((v) => v < -0.0001 || v > 1.0001)) {
    c = Math.max(c - 0.002, 0);
    rgb = toLinearRgb({ ...colour, c });
  }
  const channels = rgb.map((linear) => {
    const v = clamp(linear, 0, 1);
    const gamma = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(gamma * 255)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}
