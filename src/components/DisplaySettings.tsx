import { useEffect, useRef } from "react";
import {
  EXPAND_MODES,
  type ExpandMode,
  OUTPUT_KINDS,
  setExpandMode,
  useDisplayPrefs,
} from "../lib/prefs";

export function DisplaySettings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const prefs = useDisplayPrefs();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="display-settings-title"
      onClose={onClose}
      // A click on the dialog itself, not its content, is on the backdrop.
      onClick={(event) => event.target === ref.current && onClose()}
    >
      <div className="dialog-content">
        <h2 id="display-settings-title">Display</h2>
        <p className="dialog-text">
          What's expanded in chats. Click any of it to expand or collapse it
          anyway.
        </p>
        <div className="settings">
          {OUTPUT_KINDS.map(({ kind, label, hint }) => (
            <label key={kind} className="setting">
              <span className="setting-text">
                <span className="setting-label">{label}</span>
                <span className="setting-hint">{hint}</span>
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
        <div className="dialog-actions">
          <span className="setting-hint">Saved on this device.</span>
          <button type="button" className="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
