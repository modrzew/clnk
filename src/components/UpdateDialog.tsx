import { useEffect, useState } from "react";
import { cx } from "../lib/cx";
import { formatDate } from "../lib/format";
import {
  currentVersion,
  downloadApk,
  fetchReleaseLog,
  startUpdate,
  type AvailableUpdate,
  type ReleaseInfo,
} from "../lib/updates";
import { Dialog } from "./Dialog";
import { Markdown } from "./Markdown";
import styles from "./UpdateDialog.module.css";
import ui from "./ui.module.css";

interface UpdateDialogProps {
  /** The latest release. */
  update: AvailableUpdate;
  onClose: () => void;
}

type Phase =
  | { name: "loading" }
  | { name: "ready" }
  | { name: "downloading"; receivedBytes: number; totalBytes: number | null }
  | { name: "installing" };

/**
 * The releases since the running version, with their release logs, and the download and
 * install flow: in place on the desktop app, through the browser on Android. Open while
 * mounted; closing is blocked while the update runs.
 */
export function UpdateDialog({ update, onClose }: UpdateDialogProps) {
  const { version, apkUrl } = update;
  const [current, setCurrent] = useState<string | null>(null);
  const [releases, setReleases] = useState<ReleaseInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const running = await currentVersion();
        const log = await fetchReleaseLog(running);
        if (!cancelled) {
          setCurrent(running);
          setReleases(log);
          setPhase({ name: "ready" });
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setPhase({ name: "ready" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function install() {
    if (phase.name !== "ready") return;
    setError(null);
    if (apkUrl) {
      try {
        // The browser takes it from here.
        await downloadApk(apkUrl);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    setPhase({ name: "downloading", receivedBytes: 0, totalBytes: null });
    try {
      // The install succeeds and the app is closing when this resolves.
      await startUpdate(
        (receivedBytes, totalBytes) =>
          setPhase({ name: "downloading", receivedBytes, totalBytes }),
        () => setPhase({ name: "installing" }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase({ name: "ready" });
    }
  }

  const busy = phase.name === "downloading" || phase.name === "installing";
  const progress =
    phase.name === "downloading" && phase.totalBytes
      ? Math.round((phase.receivedBytes / phase.totalBytes) * 100)
      : null;

  const label =
    phase.name === "downloading"
      ? progress !== null
        ? `Downloading… ${progress}%`
        : "Downloading…"
      : phase.name === "installing"
        ? "Installing…"
        : apkUrl
          ? "Download"
          : "Update";

  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={`Update to ${version}`}
    >
      <p className={styles.intro}>
        Version {version} is available.
        {current && <> You are running {current}.</>}
      </p>
      {releases ? (
        <div className={styles.releases}>
          {releases.map((release) => (
            <section key={release.version} className={styles.release}>
              <h3>
                {release.version}
                <span className={styles.date}>
                  {formatDate(release.publishedAt)}
                </span>
              </h3>
              {release.notes ? (
                <Markdown text={release.notes} />
              ) : (
                <p className={styles.noNotes}>No release notes.</p>
              )}
            </section>
          ))}
          {releases.length === 0 && (
            <p className={styles.noNotes}>No release notes.</p>
          )}
        </div>
      ) : (
        !error && <p className={styles.noNotes}>Loading release notes…</p>
      )}
      {error && <div className={ui.errorText}>{error}</div>}
      {progress !== null && (
        <div className={styles.progress}>
          <div
            className={styles.progressFill}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
      <p className={styles.hint}>
        {apkUrl
          ? "The new APK downloads in your browser. Open it to install the update over this app."
          : "clnk closes, replaces itself with the new version and opens again."}
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className={cx(ui.button, ui.secondary)}
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className={ui.button}
          disabled={phase.name !== "ready"}
          onClick={() => void install()}
        >
          {label}
        </button>
      </div>
    </Dialog>
  );
}
