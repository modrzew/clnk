import type { ReactNode } from "react";

interface HeaderProps {
  title: string;
  running?: boolean;
  onMenu: () => void;
  /** Buttons at the end of the header. */
  children?: ReactNode;
}

export function Header({ title, running, onMenu, children }: HeaderProps) {
  return (
    <header className="header">
      <button
        type="button"
        className="icon-button menu-button"
        aria-label="Show chats"
        onClick={onMenu}
      >
        ☰
      </button>
      <h1 className="header-title">{title}</h1>
      {running && <span className="spinner" aria-label="Running" />}
      {children}
    </header>
  );
}
