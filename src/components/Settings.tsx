import { useState } from "react";
import {
  notificationSupport,
  setNotificationsEnabled,
  useNotificationsEnabled,
} from "../lib/notifications";
import {
  EXPAND_MODES,
  type ExpandMode,
  OUTPUT_KINDS,
  setExpandMode,
  useDisplayPrefs,
} from "../lib/prefs";
import { Dialog } from "./Dialog";
import styles from "./Settings.module.css";
import ui from "./ui.module.css";

export function Settings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const prefs = useDisplayPrefs();

  return (
    <Dialog open={open} onClose={onClose} title="Settings">
      {notificationSupport !== "unsupported" && <NotificationSettings />}
      <section className={styles.section}>
        <h3 className={styles.heading}>Display</h3>
        <p className={styles.text}>
          What's expanded in chats. Click any of it to expand or collapse it
          anyway.
        </p>
        <div className={styles.settings}>
          {OUTPUT_KINDS.map(({ kind, label, hint }) => (
            <label key={kind} className={styles.setting}>
              <span className={styles.settingText}>
                <span className={styles.settingLabel}>{label}</span>
                <span className={styles.settingHint}>{hint}</span>
              </span>
              <select
                value={prefs[kind]}
                onChange={(event) =>
                  setExpandMode(kind, event.target.value as ExpandMode)
                }
              >
                {EXPAND_MODES.map(({ mode, label }) => (
                  <option key={mode} value={mode}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>
      <div className={styles.actions}>
        <span className={styles.settingHint}>Saved on this device.</span>
        <button type="button" className={ui.button} onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}

function NotificationSettings() {
  const enabled = useNotificationsEnabled();
  const [refused, setRefused] = useState(false);
  const supported = notificationSupport === "supported";
  const blocked =
    supported && (refused || Notification.permission === "denied");

  let hint = "When Pi is done with a chat that isn't on screen";
  if (!supported) hint = "Browsers only allow them over HTTPS or on localhost";
  else if (blocked) hint = "Blocked in the browser's settings for this site";

  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>Notifications</h3>
      <label className={styles.setting}>
        <span className={styles.settingText}>
          <span className={styles.settingLabel}>Chat finished</span>
          <span className={styles.settingHint}>{hint}</span>
        </span>
        <input
          type="checkbox"
          checked={supported && enabled && !blocked}
          disabled={!supported}
          onChange={(event) => {
            const on = event.target.checked;
            void setNotificationsEnabled(on).then((done) => setRefused(!done));
          }}
        />
      </label>
    </section>
  );
}
