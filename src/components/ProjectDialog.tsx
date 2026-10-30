import { type FormEvent, useState } from "react";
import type { ProjectSummary } from "../../shared/protocol";
import { cx } from "../lib/cx";
import { Dialog } from "./Dialog";
import styles from "./ProjectDialog.module.css";
import ui from "./ui.module.css";

export interface ProjectFields {
  name: string;
  instructions: string;
}

interface ProjectDialogProps {
  /** The project to edit. Without one, the dialog creates a project. */
  project?: ProjectSummary;
  onSave: (fields: ProjectFields) => Promise<void>;
  onClose: () => void;
}

/** Name and instructions of a project. Open while mounted. */
export function ProjectDialog({
  project,
  onSave,
  onClose,
}: ProjectDialogProps) {
  const [name, setName] = useState(project?.name ?? "");
  const [instructions, setInstructions] = useState(project?.instructions ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ name, instructions });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={project ? "Edit project" : "New project"}
    >
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <label className={styles.field}>
          <span className={styles.label}>Name</span>
          <input
            type="text"
            value={name}
            maxLength={120}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Instructions</span>
          <span className={styles.hint}>
            Added to every chat in the project: what it's about, how Pi should
            work or write.
          </span>
          <textarea
            value={instructions}
            rows={8}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        {error && <div className={ui.errorText}>{error}</div>}
        <div className={styles.actions}>
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
            disabled={!name.trim() || saving}
          >
            {project ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
