import { type ReactNode, useEffect, useId, useRef } from "react";
import { LuX } from "react-icons/lu";
import { cx } from "../lib/cx";
import styles from "./Dialog.module.css";
import ui from "./ui.module.css";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /**
   * "large" is for dialogs whose content is laid out in parts of its own, e.g. sections: wider, and
   * fixed in size so it doesn't jump as the content changes. Nearly full screen on narrow screens.
   */
  size?: "normal" | "large";
  /** Shows a close button by the title, for dialogs without a button of their own to close them. */
  closeButton?: boolean;
  children: ReactNode;
}

/** A modal dialog. Closes on Escape and on a click on the backdrop. */
export function Dialog({
  open,
  onClose,
  title,
  size = "normal",
  closeButton,
  children,
}: DialogProps) {
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
      className={cx(styles.dialog, size === "large" && styles.large)}
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
        <div className={styles.header}>
          <h2 id={titleId}>{title}</h2>
          {closeButton && (
            <button
              type="button"
              className={cx(ui.iconButton, styles.close)}
              aria-label="Close"
              title="Close"
              onClick={onClose}
            >
              <LuX size={18} aria-hidden />
            </button>
          )}
        </div>
        {children}
      </div>
    </dialog>
  );
}
