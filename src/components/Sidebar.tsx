import { useState } from "react";
import type { ChatSummary } from "../../shared/protocol";
import type { ConnectionStatus } from "../lib/client";
import { navigate, type Route } from "../lib/hooks";
import { ArchiveIcon, SettingsIcon, UnarchiveIcon } from "./icons";

interface SidebarProps {
  chats: ChatSummary[] | null;
  route: Route;
  connection: ConnectionStatus;
  backendUrl: string;
  open: boolean;
  onClose: () => void;
  onChangeBackend: () => void;
  onOpenSettings: () => void;
  onArchive: (chatId: string, archived: boolean) => void;
}

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  open: "Connected",
  offline: "Reconnecting…",
};

export function Sidebar({
  chats,
  route,
  connection,
  backendUrl,
  open,
  onClose,
  onChangeBackend,
  onOpenSettings,
  onArchive,
}: SidebarProps) {
  const [showArchived, setShowArchived] = useState(false);
  const activeId = route.name === "chat" ? route.chatId : null;
  const current = chats?.filter((chat) => !chat.archived);
  const archived = chats?.filter((chat) => chat.archived) ?? [];

  const item = (chat: ChatSummary) => (
    <li key={chat.id}>
      <a
        href={`#/chat/${encodeURIComponent(chat.id)}`}
        className={chat.id === activeId ? "active" : undefined}
        onClick={(event) => {
          event.preventDefault();
          navigate({ name: "chat", chatId: chat.id });
          onClose();
        }}
      >
        <span className="chat-title">{chat.title}</span>
        {chat.status === "running" && (
          <span className="spinner" aria-label="Running" />
        )}
      </a>
      <button
        type="button"
        className="icon-button chat-action"
        aria-label={chat.archived ? "Unarchive chat" : "Archive chat"}
        title={chat.archived ? "Unarchive" : "Archive"}
        onClick={() => onArchive(chat.id, !chat.archived)}
      >
        {chat.archived ? <UnarchiveIcon /> : <ArchiveIcon />}
      </button>
    </li>
  );

  return (
    <>
      <div className={`backdrop${open ? " visible" : ""}`} onClick={onClose} />
      <nav className={`sidebar${open ? " open" : ""}`} aria-label="Chats">
        <div className="sidebar-top">
          <span className="brand">clnk</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Display settings"
            title="Display settings"
            onClick={onOpenSettings}
          >
            <SettingsIcon />
          </button>
          <a className="new-chat-button" href="#/" onClick={onClose}>
            + New chat
          </a>
        </div>
        <ul className="chat-list">
          {current?.map(item)}
          {current?.length === 0 && (
            <li className="chat-list-empty">No chats yet</li>
          )}
          {archived.length > 0 && (
            <li>
              <button
                type="button"
                className="disclosure archived-toggle"
                aria-expanded={showArchived}
                onClick={() => setShowArchived(!showArchived)}
              >
                Archived ({archived.length})
              </button>
            </li>
          )}
          {showArchived && archived.map(item)}
        </ul>
        <div className="sidebar-footer">
          <span
            className={`connection connection-${connection}`}
            title={CONNECTION_LABEL[connection]}
          />
          <span className="backend-url" title={backendUrl}>
            {backendUrl.replace(/^https?:\/\//, "")}
          </span>
          <button
            type="button"
            className="link-button"
            onClick={onChangeBackend}
          >
            Change
          </button>
        </div>
      </nav>
    </>
  );
}
