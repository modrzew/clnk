import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import styles from "./Header.module.css";
import { Spinner } from "./Spinner";
import ui from "./ui.module.css";

interface HeaderProps {
  title: string;
  running?: boolean;
  onMenu: () => void;
  /** Buttons at the end of the header. */
  children?: ReactNode;
}

export function Header({ title, running, onMenu, children }: HeaderProps) {
  return (
    <header className={styles.header}>
      <button
        type="button"
        className={cx(ui.iconButton, styles.menuButton)}
        aria-label="Show chats"
        onClick={onMenu}
      >
        ☰
      </button>
      <h1 className={styles.title}>{title}</h1>
      {running && <Spinner label="Running" />}
      {children}
    </header>
  );
}
