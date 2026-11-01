import type { ReactNode } from "react";
import styles from "./ErrorMessage.module.css";

interface ErrorMessageProps {
  /**
   * "text" goes with a field or button. "box" stands on its own among other content, e.g. a reply
   * that failed. "banner" spans the main column, outside the transcript.
   */
  variant?: "text" | "box" | "banner";
  children: ReactNode;
}

export function ErrorMessage({
  variant = "text",
  children,
}: ErrorMessageProps) {
  return <div className={styles[variant]}>{children}</div>;
}
