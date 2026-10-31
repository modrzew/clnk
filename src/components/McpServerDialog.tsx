import { type FormEvent, useState } from "react";
import { LuX } from "react-icons/lu";
import type { McpServerConfig, McpServerInfo } from "../../shared/protocol";
import type { BackendClient } from "../lib/client";
import { cx } from "../lib/cx";
import { Dialog } from "./Dialog";
import styles from "./McpServerDialog.module.css";
import ui from "./ui.module.css";

interface Pair {
  name: string;
  value: string;
}

interface McpServerDialogProps {
  client: BackendClient;
  /** The server to edit. Without one, the dialog adds a server. */
  server?: McpServerInfo;
  onClose: () => void;
}

/** A server of the user's: a URL with headers, or a command with arguments and environment. Open while mounted. */
export function McpServerDialog({
  client,
  server,
  onClose,
}: McpServerDialogProps) {
  const config = server?.config;
  const http = config && "url" in config ? config : undefined;
  const stdio = config && "command" in config ? config : undefined;
  const [name, setName] = useState(server?.name ?? "");
  const [description, setDescription] = useState(config?.description ?? "");
  const [kind, setKind] = useState<"url" | "command">(
    stdio ? "command" : "url",
  );
  const [url, setUrl] = useState(http?.url ?? "");
  const [headers, setHeaders] = useState(pairs(http?.headers));
  const [command, setCommand] = useState(stdio?.command ?? "");
  const [args, setArgs] = useState(stdio?.args?.join("\n") ?? "");
  const [env, setEnv] = useState(pairs(stdio?.env));
  const [enabled, setEnabled] = useState(config?.enabled !== false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete =
    name.trim() && (kind === "url" ? url.trim() : command.trim());

  function edited(): McpServerConfig {
    // Fields the dialog doesn't show are kept.
    const base = {
      description,
      enabled,
      ...(config?.exposure && { exposure: config.exposure }),
    };
    if (kind === "url") return { ...base, url, headers: record(headers) };
    const list = args
      .split("\n")
      .map((arg) => arg.trim())
      .filter(Boolean);
    return { ...base, command, args: list, env: record(env) };
  }

  async function save(action: () => Promise<unknown>) {
    setSaving(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!complete || saving) return;
    void save(() =>
      server
        ? client.updateMcpServer(server.name, { config: edited() })
        : client.createMcpServer({ name, config: edited() }),
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={server ? `Edit ${server.name}` : "Add MCP server"}
    >
      <form className={styles.form} onSubmit={submit}>
        {!server && (
          <label className={styles.field}>
            <span className={styles.label}>Name</span>
            <span className={styles.hint}>
              Letters, digits, - and _. It can't be changed later.
            </span>
            <input
              type="text"
              value={name}
              maxLength={40}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        )}
        <label className={styles.field}>
          <span className={styles.label}>Description</span>
          <span className={styles.hint}>
            What it's for, in a sentence. Pi reads it to know when to use the
            server.
          </span>
          <input
            type="text"
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Connect with</span>
          <select
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as "url" | "command")
            }
          >
            <option value="url">URL of a remote server</option>
            <option value="command">Command run on the backend</option>
          </select>
        </label>
        {kind === "url" ? (
          <>
            <label className={styles.field}>
              <span className={styles.label}>URL</span>
              <input
                type="url"
                value={url}
                placeholder="https://example.com/mcp"
                spellCheck={false}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <PairsField
              label="Headers"
              hint="For an API key, e.g. Authorization: Bearer … Servers without one may ask you to sign in once you've added them."
              add="Add header"
              pairs={headers}
              onChange={setHeaders}
            />
          </>
        ) : (
          <>
            <label className={styles.field}>
              <span className={styles.label}>Command</span>
              <input
                type="text"
                value={command}
                placeholder="bunx"
                spellCheck={false}
                onChange={(event) => setCommand(event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Arguments</span>
              <span className={styles.hint}>One per line.</span>
              <textarea
                value={args}
                rows={3}
                spellCheck={false}
                onChange={(event) => setArgs(event.target.value)}
              />
            </label>
            <PairsField
              label="Environment"
              hint="Variables the command gets, e.g. for credentials."
              add="Add variable"
              pairs={env}
              onChange={setEnv}
            />
          </>
        )}
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Use in chats
        </label>
        {error && <div className={ui.errorText}>{error}</div>}
        <div className={styles.actions}>
          {server && (
            <button
              type="button"
              className={cx(ui.button, ui.secondary, styles.delete)}
              disabled={saving}
              onClick={() =>
                void save(() => client.deleteMcpServer(server.name))
              }
            >
              Delete
            </button>
          )}
          <button
            type="button"
            className={cx(ui.button, ui.secondary)}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={ui.button}
            disabled={!complete || saving}
          >
            {server ? "Save" : "Add"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Names and values, like headers or environment variables. */
function PairsField({
  label,
  hint,
  add,
  pairs,
  onChange,
}: {
  label: string;
  hint: string;
  add: string;
  pairs: Pair[];
  onChange: (pairs: Pair[]) => void;
}) {
  const update = (index: number, pair: Pair) =>
    onChange(pairs.map((old, i) => (i === index ? pair : old)));

  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <span className={styles.hint}>{hint}</span>
      {pairs.map((pair, index) => (
        <div key={index} className={styles.pair}>
          <input
            type="text"
            aria-label="Name"
            placeholder="Name"
            value={pair.name}
            spellCheck={false}
            onChange={(event) =>
              update(index, { ...pair, name: event.target.value })
            }
          />
          <input
            type="text"
            aria-label="Value"
            placeholder="Value"
            value={pair.value}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) =>
              update(index, { ...pair, value: event.target.value })
            }
          />
          <button
            type="button"
            className={ui.iconButton}
            aria-label="Remove"
            onClick={() => onChange(pairs.filter((_, i) => i !== index))}
          >
            <LuX size={16} aria-hidden />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={cx(ui.linkButton, styles.add)}
        onClick={() => onChange([...pairs, { name: "", value: "" }])}
      >
        {add}
      </button>
    </div>
  );
}

function pairs(values: Record<string, string> | undefined): Pair[] {
  return Object.entries(values ?? {}).map(([name, value]) => ({ name, value }));
}

/** Rows without a name are left out. */
function record(pairs: Pair[]): Record<string, string> {
  return Object.fromEntries(
    pairs
      .filter((pair) => pair.name.trim())
      .map((pair) => [pair.name.trim(), pair.value]),
  );
}
