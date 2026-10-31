import { type FormEvent, useState } from "react";
import type { UserInfo } from "../../shared/protocol";
import type { BackendClient } from "../lib/client";
import { cx } from "../lib/cx";
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
import { McpServers } from "./McpServers";
import styles from "./Settings.module.css";
import ui from "./ui.module.css";

export function Settings({
  open,
  client,
  user,
  onClose,
  onLogOut,
}: {
  open: boolean;
  client: BackendClient;
  user: UserInfo | null;
  onClose: () => void;
  onLogOut: () => void;
}) {
  const prefs = useDisplayPrefs();

  return (
    <Dialog open={open} onClose={onClose} title="Settings">
      <AccountSettings client={client} user={user} onLogOut={onLogOut} />
      <section className={styles.section}>
        <h3 className={styles.heading}>MCP servers</h3>
        <p className={styles.text}>
          Tools Pi can use in your chats. Shared ones are set up on the server
          for everyone, and signing in to one signs everyone in. The ones you
          add are only yours.
        </p>
        {/* Fetched each time, since the shared ones come from a file on the server. */}
        {open && <McpServers client={client} />}
      </section>
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
        <span className={styles.settingHint}>
          Notifications and display are saved on this device.
        </span>
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

function AccountSettings({
  client,
  user,
  onLogOut,
}: {
  client: BackendClient;
  user: UserInfo | null;
  onLogOut: () => void;
}) {
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState(false);

  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>Account</h3>
      <div className={styles.setting}>
        <span className={styles.settingText}>
          <span className={styles.settingLabel}>{user?.name}</span>
          <span className={styles.settingHint}>
            {changed
              ? "Password changed. Your other devices were logged out."
              : "Logged in on this device"}
          </span>
        </span>
        <span className={styles.accountActions}>
          {!changing && (
            <button
              type="button"
              className={ui.linkButton}
              onClick={() => setChanging(true)}
            >
              Change password
            </button>
          )}
          <button
            type="button"
            className={cx(ui.button, ui.secondary)}
            onClick={onLogOut}
          >
            Log out
          </button>
        </span>
      </div>
      {changing && (
        <PasswordForm
          client={client}
          onDone={(done) => {
            setChanging(false);
            setChanged(done);
          }}
        />
      )}
    </section>
  );
}

function PasswordForm({
  client,
  onDone,
}: {
  client: BackendClient;
  onDone: (changed: boolean) => void;
}) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [repeated, setRepeated] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== repeated) return setError("The new passwords don't match");
    setSaving(true);
    setError(null);
    try {
      await client.changePassword({ current, password });
      onDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <form
      className={styles.passwordForm}
      onSubmit={(event) => void submit(event)}
    >
      <input
        type="password"
        autoComplete="current-password"
        placeholder="Current password"
        aria-label="Current password"
        value={current}
        autoFocus
        onChange={(event) => setCurrent(event.target.value)}
      />
      <input
        type="password"
        autoComplete="new-password"
        placeholder="New password"
        aria-label="New password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <input
        type="password"
        autoComplete="new-password"
        placeholder="New password again"
        aria-label="New password again"
        value={repeated}
        onChange={(event) => setRepeated(event.target.value)}
      />
      {error && <div className={ui.errorText}>{error}</div>}
      <div className={styles.formActions}>
        <button
          type="button"
          className={cx(ui.button, ui.secondary)}
          onClick={() => onDone(false)}
        >
          Cancel
        </button>
        <button
          type="submit"
          className={ui.button}
          disabled={saving || !current || !password || !repeated}
        >
          Change password
        </button>
      </div>
    </form>
  );
}
