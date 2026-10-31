import { lstatSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

/** A regular file, not a symlink: Pi could point one anywhere. */
export function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}
