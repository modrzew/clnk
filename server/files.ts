import { lstatSync, realpathSync, statSync } from "node:fs";
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

/**
 * The image at `path`, if it is one and is inside one of `dirs` once symlinks are resolved. Pi can
 * link to anything, so where a path leads is what counts.
 */
export async function imageFile(
  path: string,
  dirs: string[],
): Promise<{ path: string; type: string } | null> {
  let real: string;
  try {
    real = realpathSync(path);
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  const inside = dirs.some((dir) => {
    try {
      return isInside(realpathSync(dir), real);
    } catch {
      return false;
    }
  });
  if (!inside) return null;
  const type = imageType(await Bun.file(real).slice(0, 12).bytes());
  return type ? { path: real, type } : null;
}

/** The image formats models take, told by their first bytes rather than by what the browser said. */
export function imageType(bytes: Uint8Array): string | null {
  const startsWith = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return "image/png";
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  return null;
}
