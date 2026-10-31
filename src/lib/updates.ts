import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { useEffect, useState } from "react";

/** Where the app downloads new versions from. */
export const UPDATE_REPO = "modrzew/clnk";

/** The apps keep running in the background, so they keep looking for releases. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How this app gets new versions: the desktop app (macOS) installs them itself with the
 * updater plugin, the Android app has no updater and hands the new APK to the browser,
 * and the browser isn't Tauri at all.
 */
function updateMethod(): "updater" | "apk" | null {
  if (!isTauri()) return null;
  return /android/i.test(navigator.userAgent) ? "apk" : "updater";
}

/** A release newer than this app. */
export interface AvailableUpdate {
  version: string;
  /**
   * The release's APK on Android, else null. The browser downloads it and the system
   * installs it over this app, which keeps its data as every APK has the same signing key.
   */
  apkUrl: string | null;
}

/** The version of this app. */
export async function currentVersion(): Promise<string> {
  return getVersion();
}

/** The latest release when it is newer than this app, else null. */
export function useUpdateCheck(): AvailableUpdate | null {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  useEffect(() => {
    const method = updateMethod();
    if (!method) return;
    let cancelled = false;
    const run = async () => {
      try {
        const found =
          method === "updater" ? await checkUpdater() : await checkApk();
        if (!cancelled) setUpdate(found);
      } catch (err) {
        // GitHub may be unreachable, or the latest release lacks the updater manifest yet; the
        // prompt stays as it was.
        console.warn("Update check failed", err);
      }
    };
    void run();
    const timer = setInterval(() => void run(), CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return update;
}

async function checkUpdater(): Promise<AvailableUpdate | null> {
  const update = await check();
  if (!update) return null;
  // Only the version is needed here; the install checks again.
  await update.close();
  return { version: update.version, apkUrl: null };
}

async function checkApk(): Promise<AvailableUpdate | null> {
  const response = await fetch(
    `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
  );
  if (!response.ok)
    throw new Error(
      `Latest release: ${response.status} ${response.statusText}`,
    );
  const release = (await response.json()) as GitHubRelease;
  // The APK is attached a few minutes after the release is published; until then it isn't offered.
  const apk = release.assets.find((asset) => asset.name.endsWith(".apk"));
  if (!apk || compareVersions(release.tag_name, await getVersion()) <= 0)
    return null;
  return {
    version: release.tag_name.replace(/^v/, ""),
    apkUrl: apk.browser_download_url,
  };
}

/** Opens the APK in the browser, which downloads it and offers to install it. */
export async function downloadApk(url: string): Promise<void> {
  await openUrl(url);
}

export interface ReleaseInfo {
  version: string;
  publishedAt: number;
  notes: string;
}

interface GitHubRelease {
  tag_name: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  assets: { name: string; browser_download_url: string }[];
}

/** The releases newer than `currentVersion`, newest first. */
export async function fetchReleaseLog(
  currentVersion: string,
): Promise<ReleaseInfo[]> {
  const response = await fetch(
    `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=100`,
  );
  if (!response.ok)
    throw new Error(`Release log: ${response.status} ${response.statusText}`);
  const releases = (await response.json()) as GitHubRelease[];
  return releases
    .filter(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        compareVersions(release.tag_name, currentVersion) > 0,
    )
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))
    .map((release) => ({
      version: release.tag_name.replace(/^v/, ""),
      publishedAt: Date.parse(release.published_at),
      notes: release.body ?? "",
    }));
}

/** -1, 0 or 1 for a, `v`-prefixed or not. */
function compareVersions(a: string, b: string): number {
  const parts = (version: string) =>
    version.replace(/^v/, "").split(".").map(Number);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/**
 * Downloads the latest release, installs it over the running app and relaunches into it.
 * The updater doesn't restart the app on macOS, hence the final `relaunch`.
 */
export async function startUpdate(
  onProgress: (receivedBytes: number, totalBytes: number | null) => void,
  onInstallStarted: () => void,
): Promise<void> {
  const update = await check();
  if (!update) throw new Error("No update available");
  let receivedBytes = 0;
  let totalBytes: number | null = null;
  try {
    await update.download((event) => {
      if (event.event === "Started") {
        totalBytes = event.data.contentLength ?? null;
      } else if (event.event === "Progress") {
        receivedBytes += event.data.chunkLength;
        onProgress(receivedBytes, totalBytes);
      } else {
        onInstallStarted();
      }
    });
    await update.install();
  } catch (err) {
    await update.close().catch(() => {});
    throw err;
  }
  await relaunch();
}
