import { type FormEvent, useState } from "react";
import { checkBackend, login, normalizeBackendUrl } from "../lib/client";
import styles from "./Setup.module.css";

interface SetupProps {
  initialUrl: string;
  onConnect: (url: string) => void;
  onCancel?: () => void;
}

export function Setup({ initialUrl, onConnect, onCancel }: SetupProps) {
  const [url, setUrl] = useState(initialUrl);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setChecking(true);
    setError(null);
    try {
      const normalized = normalizeBackendUrl(url);
      await checkBackend(normalized);
      onConnect(normalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className={styles.setup}>
      <form className={styles.card} onSubmit={(event) => void submit(event)}>
        <h1>clnk</h1>
        <p>Enter the address of the backend that runs Pi.</p>
        <input
          type="text"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="http://192.168.1.10:8787"
          value={url}
          autoFocus
          onChange={(event) => setUrl(event.target.value)}
        />
        {error && <div className={styles.error}>{error}</div>}
        <div className={styles.actions}>
          {onCancel && (
            <button
              type="button"
              className={styles.secondary}
              onClick={onCancel}
            >
              Cancel
            </button>
          )}
          <button type="submit" disabled={checking || !url.trim()}>
            {checking ? "Connecting…" : "Connect"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface LoginProps {
  backendUrl: string;
  onLogin: (token: string) => void;
  onChangeBackend: () => void;
}

export function Login({ backendUrl, onLogin, onChangeBackend }: LoginProps) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setChecking(true);
    setError(null);
    try {
      const { token } = await login(backendUrl, { name, password });
      onLogin(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setChecking(false);
    }
  }

  return (
    <div className={styles.setup}>
      <form className={styles.card} onSubmit={(event) => void submit(event)}>
        <h1>clnk</h1>
        <p>Log in to {backendUrl.replace(/^https?:\/\//, "")}.</p>
        <input
          type="text"
          name="username"
          autoComplete="username"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Name"
          value={name}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error && <div className={styles.error}>{error}</div>}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={onChangeBackend}
          >
            Change backend
          </button>
          <button
            type="submit"
            disabled={checking || !name.trim() || !password}
          >
            {checking ? "Logging in…" : "Log in"}
          </button>
        </div>
      </form>
    </div>
  );
}
