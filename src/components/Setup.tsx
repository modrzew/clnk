import { type FormEvent, useState } from "react";
import { checkBackend, normalizeBackendUrl } from "../lib/client";
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
