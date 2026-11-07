import type { ReactNode } from "react";
import styles from "./ChatBackground.module.css";

/** The repeating pattern behind a chat, which stays put while the transcript scrolls over it. */
export function ChatBackground({ children }: { children: ReactNode }) {
  return <div className={styles.background}>{children}</div>;
}
