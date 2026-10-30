import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import styles from "./Header.module.css";
import { Spinner } from "./Spinner";
import ui from "./ui.module.css";

interface HeaderProps {
  title: string;
  /** Where the page belongs, e.g. a chat's project. Shown before the title. */
  parent?: { label: string; href: string };
  running?: boolean;
  onMenu: () => void;
  /** Buttons at the end of the header. */
  children?: ReactNode;
}

export function Header({
  title,
  parent,
  running,
  onMenu,
  children,
}: HeaderProps) {
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
      <h1 className={styles.title}>
        {parent && (
          <>
            <a className={styles.parent} href={parent.href}>
              {parent.label}
            </a>
            <span className={styles.separator} aria-hidden>
              /
            </span>
          </>
        )}
        <span className={styles.titleText}>{title}</span>
      </h1>
      {running && <Spinner label="Running" />}
      {children}
    </header>
  );
}
