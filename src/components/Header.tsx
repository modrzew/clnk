import type { ModelRef } from "../../shared/protocol";

interface HeaderProps {
  title: string;
  model?: ModelRef;
  running?: boolean;
  onMenu: () => void;
}

export function Header({ title, model, running, onMenu }: HeaderProps) {
  return (
    <header className="header">
      <button type="button" className="icon-button menu-button" aria-label="Show chats" onClick={onMenu}>
        ☰
      </button>
      <h1 className="header-title">{title}</h1>
      {running && <span className="spinner" aria-label="Running" />}
      {model && (
        <span className="model-chip" title={`${model.provider}/${model.id}`}>
          {model.id}
        </span>
      )}
    </header>
  );
}
