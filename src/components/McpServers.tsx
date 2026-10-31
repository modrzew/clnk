import { type FormEvent, useEffect, useState } from "react";
import type { McpServerInfo } from "../../shared/protocol";
import type { BackendClient } from "../lib/client";
import { cx } from "../lib/cx";
import { McpServerDialog } from "./McpServerDialog";
import styles from "./McpServers.module.css";
import { Spinner } from "./Spinner";
import ui from "./ui.module.css";

/** The MCP servers in the user's chats: global ones, and the user's own to add, edit and sign in to. */
export function McpServers({ client }: { client: BackendClient }) {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The server being edited, or "new" while adding one. */
  const [editing, setEditing] = useState<McpServerInfo | "new" | null>(null);
  const [signIn, setSignIn] = useState<{
    name: string;
    authorizationUrl: string;
  } | null>(null);
  /** Server whose sign-in or sign-out is under way. */
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .getMcpServers()
      .then((response) => !cancelled && setServers(response.servers))
      .catch((err: Error) => !cancelled && setError(err.message));
    const stop = client.onMessage((msg) => {
      if (msg.type === "mcp_servers") setServers(msg.servers);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [client]);

  async function startSignIn(name: string) {
    setBusy(name);
    setError(null);
    try {
      const { authorizationUrl } = await client.startMcpLogin(name);
      setSignIn(authorizationUrl ? { name, authorizationUrl } : null);
    } catch (err) {
      setError(`Couldn't sign in to ${name}: ${(err as Error).message}`);
    }
    setBusy(null);
  }

  async function signOut(name: string) {
    setBusy(name);
    setError(null);
    try {
      await client.mcpLogout(name);
    } catch (err) {
      setError(`Couldn't sign out of ${name}: ${(err as Error).message}`);
    }
    setBusy(null);
  }

  if (!servers)
    return error ? (
      <div className={ui.errorText}>{error}</div>
    ) : (
      <Spinner label="Loading" />
    );
  return (
    <>
      {servers.length > 0 && (
        <ul className={styles.servers}>
          {servers.map((server) => (
            <li key={`${server.global} ${server.name}`}>
              <div className={styles.server}>
                <span className={styles.text}>
                  <span className={styles.name}>
                    {server.name}
                    {server.global && (
                      <span className={styles.badge}>Shared</span>
                    )}
                  </span>
                  <span className={styles.hint}>{hint(server)}</span>
                </span>
                <span className={styles.actions}>
                  {server.signedIn === false && (
                    <button
                      type="button"
                      className={cx(ui.button, ui.secondary)}
                      disabled={busy === server.name}
                      onClick={() => void startSignIn(server.name)}
                    >
                      Sign in
                    </button>
                  )}
                  {server.signedIn && (
                    <button
                      type="button"
                      className={ui.linkButton}
                      disabled={busy === server.name}
                      onClick={() => void signOut(server.name)}
                    >
                      Sign out
                    </button>
                  )}
                  {!server.global && (
                    <button
                      type="button"
                      className={ui.linkButton}
                      onClick={() => setEditing(server)}
                    >
                      Edit
                    </button>
                  )}
                </span>
              </div>
              {signIn?.name === server.name && (
                <SignInForm
                  client={client}
                  name={server.name}
                  authorizationUrl={signIn.authorizationUrl}
                  onDone={() => setSignIn(null)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <div className={ui.errorText}>{error}</div>}
      <div>
        <button
          type="button"
          className={cx(ui.button, ui.secondary)}
          onClick={() => setEditing("new")}
        >
          Add server
        </button>
      </div>
      {editing && (
        <McpServerDialog
          client={client}
          server={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function hint(server: McpServerInfo): string {
  if (server.hidden) return "Replaced by a shared server with the same name";
  const { config } = server;
  let what = server.description;
  if (!what && config)
    what =
      "url" in config
        ? config.url
        : [config.command, ...(config.args ?? [])].join(" ");
  const signedIn = server.global ? "Signed in for everyone" : "Signed in";
  return [what, !server.enabled && "Off", server.signedIn && signedIn]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Finishes signing in: the server sends the browser to a page on 127.0.0.1 that doesn't load, and the
 * user pastes its address.
 */
function SignInForm({
  client,
  name,
  authorizationUrl,
  onDone,
}: {
  client: BackendClient;
  name: string;
  authorizationUrl: string;
  onDone: () => void;
}) {
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await client.finishMcpLogin(name, { url: address });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <form className={styles.signIn} onSubmit={(event) => void submit(event)}>
      <ol className={styles.steps}>
        <li>
          <a href={authorizationUrl} target="_blank" rel="noreferrer">
            Open the sign-in page
          </a>{" "}
          and allow access.
        </li>
        <li>
          Your browser then opens a page on 127.0.0.1 that doesn't load. Copy
          its address and paste it here.
        </li>
      </ol>
      <input
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="http://127.0.0.1:…/callback?code=…"
        aria-label="Address of the page"
        value={address}
        onChange={(event) => setAddress(event.target.value)}
      />
      {error && <div className={ui.errorText}>{error}</div>}
      <div className={styles.formActions}>
        <button
          type="button"
          className={cx(ui.button, ui.secondary)}
          onClick={onDone}
        >
          Cancel
        </button>
        <button
          type="submit"
          className={ui.button}
          disabled={!address.trim() || saving}
        >
          Finish signing in
        </button>
      </div>
    </form>
  );
}
