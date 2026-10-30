import {
  EXPAND_MODES,
  type ExpandMode,
  OUTPUT_KINDS,
  setExpandMode,
  useDisplayPrefs,
} from "../lib/prefs";
import { Dialog } from "./Dialog";
import styles from "./DisplaySettings.module.css";
import ui from "./ui.module.css";

export function DisplaySettings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const prefs = useDisplayPrefs();

  return (
    <Dialog open={open} onClose={onClose} title="Display">
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
      <div className={styles.actions}>
        <span className={styles.settingHint}>Saved on this device.</span>
        <button type="button" className={ui.button} onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
