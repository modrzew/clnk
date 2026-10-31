import { type ReactNode, useEffect, useId, useRef } from "react";
import styles from "./Dialog.module.css";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/** A modal dialog. Closes on Escape and on a click on the backdrop. */
export function Dialog({ open, onClose, title, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressedOnBackdrop = useRef(false);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      // React passes on close events of dialogs opened from this one's content.
      onClose={(event) => {
        if (event.target === ref.current) onClose();
      }}
      // A click on the dialog itself, not its content, is on the backdrop. A drag that started in the
      // content, e.g. selecting text in a field, isn't.
      onPointerDown={(event) => {
        pressedOnBackdrop.current = event.target === ref.current;
      }}
      onClick={(event) => {
        if (pressedOnBackdrop.current && event.target === ref.current)
          onClose();
      }}
    >
      <div className={styles.content}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </dialog>
  );
}
