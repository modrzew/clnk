import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_ACCENT, palette, type Scheme } from "./palette";

const ROOT = join(import.meta.dir, "..", "..");
const SCHEMES: Scheme[] = ["light", "dark"];

/** A grid of RGB colours, so every hue at every lightness, plus the extremes of each. */
const ACCENTS: string[] = [];
for (const r of [0, 64, 128, 192, 255])
  for (const g of [0, 64, 128, 192, 255])
    for (const b of [0, 64, 128, 192, 255])
      ACCENTS.push(
        `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`,
      );

function luminance(hex: string) {
  const channels = [1, 3, 5].map((start) => {
    const v = parseInt(hex.slice(start, start + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string) {
  const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (light + 0.05) / (dark + 0.05);
}

/** How far apart two colours are, in the largest difference of an RGB channel. */
function distance(a: string, b: string) {
  return Math.max(
    ...[1, 3, 5].map((start) =>
      Math.abs(
        parseInt(a.slice(start, start + 2), 16) -
          parseInt(b.slice(start, start + 2), 16),
      ),
    ),
  );
}

/** Text and what it's shown on across the UI, with the contrast it needs. */
const PAIRS: [text: string, background: string, ratio: number][] = [
  ["--text", "--bg", 7],
  ["--text", "--pattern", 7],
  ["--text", "--bg-sidebar", 7],
  ["--text", "--bg-raised", 7],
  ["--text", "--bg-user", 7],
  ["--text", "--bg-hover", 7],
  ["--text", "--code-bg", 7],
  ["--text-muted", "--bg", 4.5],
  ["--text-muted", "--pattern", 4.5],
  ["--text-muted", "--bg-raised", 4.5],
  ["--accent", "--bg", 4.5],
  ["--accent", "--pattern", 4.5],
  ["--accent", "--bg-raised", 4.5],
  ["--accent-text", "--accent", 4.5],
  ["--bg-raised", "--danger", 4.5],
  ["--danger", "--bg", 4.5],
  ["--danger", "--pattern", 4.5],
  ["--danger", "--danger-bg", 4.5],
  ["--warn", "--bg", 4.5],
  ["--warn", "--pattern", 4.5],
  ["--diff-add", "--diff-add-bg", 4.5],
  ["--diff-del", "--diff-del-bg", 4.5],
];

describe("palette", () => {
  test("keeps the UI readable under any accent", () => {
    for (const accent of ACCENTS)
      for (const scheme of SCHEMES) {
        const colours = palette(accent, scheme);
        for (const [text, background, ratio] of PAIRS) {
          const actual = contrast(colours[text], colours[background]);
          if (actual < ratio)
            throw new Error(
              `${text} on ${background} under ${accent} (${scheme}): ${actual.toFixed(2)}`,
            );
        }
      }
  });

  test("only gives valid colours", () => {
    for (const accent of ACCENTS)
      for (const scheme of SCHEMES)
        for (const colour of Object.values(palette(accent, scheme)))
          expect(colour).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
  });

  test("uses a readable accent as it is", () => {
    expect(palette(DEFAULT_ACCENT, "light")["--accent"]).toBe(DEFAULT_ACCENT);
    expect(palette("#7fd1ff", "dark")["--accent"]).toBe("#7fd1ff");
  });

  test("tints the neutrals with the accent", () => {
    const red = palette("#d0342c", "light");
    const blue = palette("#2c5fd0", "light");
    expect(red["--bg-hover"]).not.toBe(blue["--bg-hover"]);
    // A grey accent has no hue to give them.
    expect(palette("#808080", "light")["--bg-hover"]).toMatch(/^#(..)\1\1$/);
  });

  test("scales the signal colours with the accent but keeps them apart", () => {
    const muted = palette("#808080", "light");
    const vivid = palette("#ff0000", "light");
    expect(muted["--danger"]).not.toBe(vivid["--danger"]);
    // Still red under a green accent, and still green under a red one.
    const green = palette("#00a000", "light");
    const [r, g] = [1, 3].map((i) =>
      parseInt(green["--danger"].slice(i, i + 2), 16),
    );
    expect(r).toBeGreaterThan(g * 2);
    expect(vivid["--ok"].slice(3, 5) > vivid["--ok"].slice(1, 3)).toBe(true);
  });

  test("looks like it always did under the default accent", () => {
    const before = {
      light: {
        "--bg": "#fbfbfa",
        "--bg-raised": "#ffffff",
        "--text": "#1d1d1b",
        "--text-muted": "#6d6c67",
        "--accent": "#2f6f5e",
        "--danger": "#b3261e",
        "--ok": "#2f8a4f",
        "--warn": "#9a6200",
        "--diff-add-bg": "#e3f3e7",
      },
      dark: {
        "--bg": "#1b1c1b",
        "--text": "#e6e6e3",
        "--accent": "#6fb8a2",
        "--accent-text": "#0f1a16",
        "--danger": "#f08b84",
        "--diff-del-bg": "#3a2322",
      },
    };
    for (const scheme of SCHEMES)
      for (const [name, colour] of Object.entries(before[scheme]))
        expect(
          distance(palette(DEFAULT_ACCENT, scheme)[name], colour),
        ).toBeLessThan(10);
  });
});

describe("Android resources", () => {
  // They're read before the page loads, so they can't come from the palette at runtime.
  test("start on the page's background under the default accent", async () => {
    for (const [scheme, folder] of [
      ["light", "values"],
      ["dark", "values-night"],
    ] as const) {
      const xml = await Bun.file(
        join(
          ROOT,
          `src-tauri/gen/android/app/src/main/res/${folder}/colors.xml`,
        ),
      ).text();
      const colour = /name="background">#FF(\w{6})</.exec(xml)?.[1];
      expect(`#${colour?.toLowerCase()}`).toBe(
        palette(DEFAULT_ACCENT, scheme)["--bg"],
      );
    }
  });
});

describe("stylesheets", () => {
  // A colour written out in CSS wouldn't follow the accent. Add it to the palette instead.
  test("take all their colours from the palette", async () => {
    const literal =
      /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(|:\s*(white|black)\b/i;
    const known = new Set(Object.keys(palette(DEFAULT_ACCENT, "light")));
    const layout = new Set(["--radius", "--sidebar-width"]);
    const glob = new Bun.Glob("src/**/*.css");
    for await (const path of glob.scan(ROOT)) {
      const css = await Bun.file(join(ROOT, path)).text();
      const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(`${path}: ${literal.exec(code)?.[0]}`).toBe(`${path}: undefined`);
      for (const [, name] of code.matchAll(/var\((--[a-z-]+)/g))
        if (!layout.has(name)) expect(known).toContain(name);
    }
  });
});
