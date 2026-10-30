/**
 * Writes a `.d.ts` next to each CSS module in src/ that lists its classes, so using a class that
 * doesn't exist is a type error.
 *
 *   bun run css-types           update the declarations
 *   bun run css-types --check   fail if any is out of date (run by `bun run typecheck`)
 *
 * The dev server also updates them as CSS modules change (see vite.config.ts).
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { transform } from "lightningcss";

const SRC_DIR = "src";
const HEADER = "// Generated from the CSS module by `bun run css-types`.";

export const isCssModule = (path: string) => path.endsWith(".module.css");

/** The declaration of a CSS module's classes, as the formatter would print it. */
function declaration(cssPath: string): string {
  const { exports } = transform({
    filename: cssPath,
    code: readFileSync(cssPath),
    cssModules: true,
  });
  const names = Object.keys(exports ?? {}).sort();
  // Hyphenated names would need `styles["a-b"]`.
  const invalid = names.filter((name) => !/^[A-Za-z_]\w*$/.test(name));
  if (invalid.length)
    throw new Error(
      `${cssPath}: use camelCase class names, not ${invalid.join(", ")}`,
    );
  const members = names.length
    ? `{\n${names.map((name) => `  readonly ${name}: string;\n`).join("")}}`
    : "{}";
  return `${HEADER}\ndeclare const styles: ${members};\nexport default styles;\n`;
}

/** Brings the declaration of a CSS module in line with it, or with its deletion. Returns whether it was out of date. */
function sync(cssPath: string, write: boolean): boolean {
  const target = `${cssPath}.d.ts`;
  const current = existsSync(target) ? readFileSync(target, "utf8") : null;
  const wanted = existsSync(cssPath) ? declaration(cssPath) : null;
  if (current === wanted) return false;
  if (write) {
    if (wanted === null) rmSync(target);
    else writeFileSync(target, wanted);
  }
  return true;
}

export const updateCssTypes = (cssPath: string) => sync(cssPath, true);

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const modules = new Set<string>();
  for (const file of readdirSync(SRC_DIR, {
    recursive: true,
    encoding: "utf8",
  })) {
    const path = join(SRC_DIR, file);
    if (isCssModule(path)) modules.add(path);
    // Its CSS module may be gone, and then the declaration goes too.
    else if (path.endsWith(".module.css.d.ts")) modules.add(path.slice(0, -5));
  }
  const outdated = [...modules].sort().filter((path) => sync(path, !check));
  for (const path of outdated)
    console.log(`${check ? "Out of date" : "Updated"}: ${path}.d.ts`);
  if (check && outdated.length) {
    console.error("Run `bun run css-types` to update the CSS module types.");
    process.exit(1);
  }
}
