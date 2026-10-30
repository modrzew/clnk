import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  host: string;
  port: number;
  /** Database, transcripts and chat folders. */
  dataDir: string;
  /** Built web UI to serve at /, if it exists. */
  webDir: string | null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const webDir = resolve(env.CLNK_WEB_DIR || join(import.meta.dir, "..", "dist"));
  return {
    // No auth yet and Pi can run commands, so only listen on loopback unless told otherwise.
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 8787),
    dataDir: resolve(env.CLNK_DATA_DIR || join(dataHome, "clnk")),
    webDir: existsSync(join(webDir, "index.html")) ? webDir : null,
  };
}
