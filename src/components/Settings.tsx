import { type FormEvent, type KeyboardEvent, useId, useState } from "react";
import {
  LuAppWindow,
  LuBell,
  LuListCollapse,
  LuPalette,
  LuPlug,
  LuUserRound,
} from "react-icons/lu";
import type { ExpandMode, Theme, UserInfo } from "../../shared/protocol";
import {
  APP_ICONS,
  type AppIcon,
  appIconSupport,
  setAppIcon,
  useAppIcon,
} from "../lib/appIcon";
import type { BackendClient } from "../lib/client";
import {
  notificationSupport,
  setNotificationsEnabled,
  useNotificationsEnabled,
} from "../lib/notifications";
import { DEFAULT_ACCENT } from "../lib/palette";
import { EXPAND_MODES, OUTPUT_KINDS, setExpandMode } from "../lib/prefs";
import { useSettings } from "../lib/settings";
import { setAccent, setTheme, THEMES } from "../lib/theme";
import { Button, LinkButton } from "./Button";
import { Dialog } from "./Dialog";
import { ErrorMessage } from "./ErrorMessage";
import { McpServers } from "./McpServers";
import styles from "./Settings.module.css";

const SECTIONS = (
  [
    { id: "account", label: "Account", Icon: LuUserRound },
    { id: "mcp", label: "MCP servers", Icon: LuPlug },
    { id: "notifications", label: "Notifications", Icon: LuBell },
    { id: "appearance", label: "Appearance", Icon: LuPalette },
    { id: "icon", label: "App icon", Icon: LuAppWindow },
    { id: "display", label: "Display", Icon: LuListCollapse },
  ] as const
).filter(
  // Left out where there's nothing to set, e.g. notifications in the Android app, or the icon in a browser.
  (section) =>
    (section.id !== "notifications" || notificationSupport !== "unsupported") &&
    (section.id !== "icon" || appIconSupport !== "unsupported"),
);

type Section = (typeof SECTIONS)[number]["id"];

const ARROW_STEPS: Partial<Record<string, number>> = {
  ArrowUp: -1,
  ArrowLeft: -1,
  ArrowDown: 1,
  ArrowRight: 1,
};

/** The settings, a section at a time: picked in a list beside it, or in tabs above it on narrow screens. */
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
  const [section, setSection] = useState<Section>("account");
  const baseId = useId();
  const tabId = (tab: Section) => `${baseId}-${tab}`;
  const panelId = `${baseId}-panel`;
  const current = SECTIONS.find((each) => each.id === section);

  // Arrow keys move between the tabs, which are a single stop for Tab.
  function moveTab(event: KeyboardEvent) {
    const step = ARROW_STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    const index = SECTIONS.findIndex((each) => each.id === section);
    const next = SECTIONS[(index + step + SECTIONS.length) % SECTIONS.length];
    setSection(next.id);
    document.getElementById(tabId(next.id))?.focus();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Settings"
      size="large"
      closeButton
    >
      <div className={styles.body}>
        <div
          role="tablist"
          aria-label="Sections"
          className={styles.tabs}
          onKeyDown={moveTab}
        >
          {SECTIONS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={tabId(id)}
              aria-selected={id === section}
              aria-controls={id === section ? panelId : undefined}
              tabIndex={id === section ? 0 : -1}
              className={styles.tab}
              onClick={(event) => {
                setSection(id);
                // Tabs scrolled partly out of view on narrow screens.
                event.currentTarget.scrollIntoView({
                  block: "nearest",
                  inline: "nearest",
                });
              }}
            >
              <Icon size={16} aria-hidden />
              {label}
            </button>
          ))}
        </div>
        <section
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabId(section)}
          className={styles.panel}
        >
          <h3 className={styles.title}>{current?.label}</h3>
          {section === "account" && (
            <AccountSettings client={client} user={user} onLogOut={onLogOut} />
          )}
          {section === "mcp" && (
            <>
              <p className={styles.text}>
                Tools Pi can use in your chats. Shared ones are set up on the
                server for everyone, and signing in to one signs everyone in.
                The ones you add are only yours.
              </p>
              {/* Fetched each time, since the shared ones come from a file on the server. */}
              {open && <McpServers client={client} />}
            </>
          )}
          {section === "notifications" && <NotificationSettings />}
          {section === "appearance" && <AppearanceSettings />}
          {section === "icon" && <AppIconSettings />}
          {section === "display" && <DisplaySettings />}
        </section>
      </div>
    </Dialog>
  );
}

function AppearanceSettings() {
  const { theme, accent } = useSettings();

  return (
    <>
      <p className={styles.text}>The same on all your devices.</p>
      <div className={styles.settings}>
        <label className={styles.setting}>
          <span className={styles.settingText}>
            <span className={styles.settingLabel}>Theme</span>
            <span className={styles.settingHint}>
              System follows this device's setting
            </span>
          </span>
          <select
            value={theme}
            onChange={(event) => setTheme(event.target.value as Theme)}
          >
            {THEMES.map(({ theme, label }) => (
              <option key={theme} value={theme}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.setting}>
          <span className={styles.settingText}>
            <span className={styles.settingLabel}>Accent colour</span>
            <span className={styles.settingHint}>
              All the app's colours are derived from it, and it's adjusted where
              it would be hard to read
            </span>
          </span>
          <span className={styles.settingActions}>
            {accent !== DEFAULT_ACCENT && (
              <LinkButton onClick={() => setAccent(DEFAULT_ACCENT)}>
                Reset
              </LinkButton>
            )}
            <input
              type="color"
              aria-label="Accent colour"
              value={accent}
              onChange={(event) => setAccent(event.target.value)}
            />
          </span>
        </div>
      </div>
    </>
  );
}

function AppIconSettings() {
  const icon = useAppIcon();
  const hint =
    appIconSupport === "android"
      ? "On the home screen and in the app drawer. Your launcher may take a moment to update."
      : "Shown in the Dock. Finder and Launchpad keep the default.";

  return (
    <>
      <p className={styles.text}>Saved on this device.</p>
      <label className={styles.setting}>
        <span className={styles.settingText}>
          <span className={styles.settingLabel}>Icon</span>
          <span className={styles.settingHint}>{hint}</span>
        </span>
        <select
          value={icon}
          onChange={(event) => setAppIcon(event.target.value as AppIcon)}
        >
          {APP_ICONS.map(({ icon, label }) => (
            <option key={icon} value={icon}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function DisplaySettings() {
  const settings = useSettings();

  return (
    <>
      <p className={styles.text}>
        What's expanded in chats. Click any of it to expand or collapse it
        anyway. The same on all your devices.
      </p>
      <div className={styles.settings}>
        {OUTPUT_KINDS.map(({ kind, label, hint }) => (
          <label key={kind} className={styles.setting}>
            <span className={styles.settingText}>
              <span className={styles.settingLabel}>{label}</span>
              <span className={styles.settingHint}>{hint}</span>
            </span>
            <select
              value={settings[kind]}
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
    </>
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
    <>
      <p className={styles.text}>Saved on this device.</p>
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
    </>
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
    <>
      <div className={styles.setting}>
        <span className={styles.settingText}>
          <span className={styles.settingLabel}>{user?.name}</span>
          <span className={styles.settingHint}>
            {changed
              ? "Password changed. Your other devices were logged out."
              : "Logged in on this device"}
          </span>
        </span>
        <span className={styles.settingActions}>
          {!changing && (
            <LinkButton onClick={() => setChanging(true)}>
              Change password
            </LinkButton>
          )}
          <Button variant="secondary" onClick={onLogOut}>
            Log out
          </Button>
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
    </>
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
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className={styles.formActions}>
        <Button variant="secondary" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={saving || !current || !password || !repeated}
        >
          Change password
        </Button>
      </div>
    </form>
  );
}
