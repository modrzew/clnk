import { isTauri } from "@tauri-apps/api/core";
import { type DragEvent, useId, useRef, useState } from "react";
import { LuFile, LuTrash2, LuUpload } from "react-icons/lu";
import type { ProjectSummary } from "../../shared/protocol";
import type { BackendClient } from "../lib/client";
import { cx } from "../lib/cx";
import { formatDate, formatSize } from "../lib/format";
import styles from "./Artefacts.module.css";
import { Button, IconButton, LinkButton } from "./Button";
import { ErrorMessage } from "./ErrorMessage";
import { Spinner } from "./Spinner";

/** A project's artefacts: download them, and unless the project is archived, upload and delete them. */
export function Artefacts({
  client,
  project,
}: {
  client: BackendClient;
  project: ProjectSummary;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [uploading, setUploading] = useState<string[]>([]);
  /** Files waiting for the go-ahead to replace artefacts with the same names. */
  const [replacing, setReplacing] = useState<File[] | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = !project.archived;
  const existing = new Set(project.artefacts.map((artefact) => artefact.name));
  const conflicts =
    replacing?.filter((file) => existing.has(file.name.trim())) ?? [];

  function choose(files: File[]) {
    if (!files.length) return;
    setError(null);
    if (files.some((file) => existing.has(file.name.trim())))
      setReplacing(files);
    else void upload(files);
  }

  async function upload(files: File[]) {
    setReplacing(null);
    setUploading((names) => [...names, ...files.map((file) => file.name)]);
    for (const file of files) {
      try {
        await client.uploadArtefact(project.id, file);
      } catch (err) {
        setError(`Couldn't upload ${file.name}: ${(err as Error).message}`);
      } finally {
        setUploading((names) => without(names, file.name));
      }
    }
  }

  async function remove(name: string) {
    setDeleting(null);
    setError(null);
    try {
      await client.deleteArtefact(project.id, name);
    } catch (err) {
      setError(`Couldn't delete ${name}: ${(err as Error).message}`);
    }
  }

  const dropProps = editable
    ? {
        onDragOver: (event: DragEvent) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        },
        onDragLeave: (event: DragEvent) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDragging(false);
        },
        onDrop: (event: DragEvent) => {
          event.preventDefault();
          setDragging(false);
          choose(Array.from(event.dataTransfer.files));
        },
      }
    : {};

  return (
    <section
      className={cx(styles.artefacts, dragging && styles.dragging)}
      aria-labelledby={titleId}
      {...dropProps}
    >
      <div className={styles.header}>
        <h2 id={titleId}>Artefacts</h2>
        {editable && (
          <>
            <Button
              variant="secondary"
              size="small"
              onClick={() => inputRef.current?.click()}
            >
              <LuUpload size={14} aria-hidden /> Upload
            </Button>
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                choose(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
          </>
        )}
      </div>
      <p className={styles.hint}>
        Files every chat in the project can read. Pi saves files here when you
        ask it to keep them for the project.
      </p>
      {replacing && (
        <div className={styles.confirm}>
          <span>Replace {conflicts.map((file) => file.name).join(", ")}?</span>
          <Button onClick={() => void upload(replacing)}>Replace</Button>
          <Button variant="secondary" onClick={() => setReplacing(null)}>
            Cancel
          </Button>
        </div>
      )}
      {error && <ErrorMessage variant="box">{error}</ErrorMessage>}
      <ul className={styles.list}>
        {project.artefacts.map((artefact) => (
          <li key={artefact.name} className={styles.artefact}>
            <LuFile size={16} className={styles.icon} aria-hidden />
            <a
              className={styles.name}
              href={client.artefactUrl(project.id, artefact.name)}
              download={artefact.name}
              // The apps' webviews don't download files. Links with a target open in the browser instead.
              target={isTauri() ? "_blank" : undefined}
              title={`Download ${artefact.name}`}
            >
              {artefact.name}
            </a>
            <span className={styles.meta}>
              {formatSize(artefact.size)} · {formatDate(artefact.updatedAt)}
            </span>
            {editable &&
              (deleting === artefact.name ? (
                <span className={styles.deleteConfirm}>
                  <Button
                    size="small"
                    danger
                    onClick={() => void remove(artefact.name)}
                  >
                    Delete
                  </Button>
                  <LinkButton onClick={() => setDeleting(null)}>
                    Cancel
                  </LinkButton>
                </span>
              ) : (
                <IconButton
                  size="small"
                  danger
                  aria-label={`Delete ${artefact.name}`}
                  title="Delete"
                  onClick={() => setDeleting(artefact.name)}
                >
                  <LuTrash2 size={15} aria-hidden />
                </IconButton>
              ))}
          </li>
        ))}
        {uploading.map((name, index) => (
          <li key={`uploading-${index}`} className={styles.artefact}>
            <Spinner label="Uploading" />
            <span className={styles.name}>{name}</span>
            <span className={styles.meta}>Uploading…</span>
          </li>
        ))}
        {project.artefacts.length === 0 && uploading.length === 0 && (
          <li className={styles.empty}>
            {editable
              ? "No artefacts yet. Upload files or drop them here."
              : "No artefacts."}
          </li>
        )}
      </ul>
    </section>
  );
}

function without(names: string[], name: string) {
  const index = names.indexOf(name);
  return index < 0
    ? names
    : [...names.slice(0, index), ...names.slice(index + 1)];
}
