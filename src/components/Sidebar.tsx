import { useState } from "react";
import {
  LuArchive,
  LuArchiveRestore,
  LuSlidersHorizontal,
} from "react-icons/lu";
import type { ChatSummary } from "../../shared/protocol";
import type { ConnectionStatus } from "../lib/client";
import { cx } from "../lib/cx";
import { navigate, type Route } from "../lib/hooks";
import styles from "./Sidebar.module.css";
import { Spinner } from "./Spinner";
import ui from "./ui.module.css";

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

const CONNECTION_CLASS: Record<ConnectionStatus, string | undefined> = {
  connecting: undefined,
  open: styles.connectionOpen,
  offline: styles.connectionOffline,
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
        className={chat.id === activeId ? styles.active : undefined}
        onClick={(event) => {
          event.preventDefault();
          navigate({ name: "chat", chatId: chat.id });
          onClose();
        }}
      >
        <span className={styles.chatTitle}>{chat.title}</span>
        {chat.status === "running" && <Spinner label="Running" />}
      </a>
      <button
        type="button"
        className={cx(ui.iconButton, styles.chatAction)}
        aria-label={chat.archived ? "Unarchive chat" : "Archive chat"}
        title={chat.archived ? "Unarchive" : "Archive"}
        onClick={() => onArchive(chat.id, !chat.archived)}
      >
        {chat.archived ? (
          <LuArchiveRestore size={16} aria-hidden />
        ) : (
          <LuArchive size={16} aria-hidden />
        )}
      </button>
    </li>
  );

  return (
    <>
      <div
        className={cx(styles.backdrop, open && styles.visible)}
        onClick={onClose}
      />
      <nav
        className={cx(styles.sidebar, open && styles.open)}
        aria-label="Chats"
      >
        <div className={styles.top}>
          <span className={styles.brand}>clnk</span>
          <button
            type="button"
            className={cx(ui.iconButton, styles.settingsButton)}
            aria-label="Display settings"
            title="Display settings"
            onClick={onOpenSettings}
          >
            <LuSlidersHorizontal size={16} aria-hidden />
          </button>
          <a className={styles.newChatButton} href="#/" onClick={onClose}>
            + New chat
          </a>
        </div>
        <ul className={styles.chatList}>
          {current?.map(item)}
          {current?.length === 0 && (
            <li className={styles.empty}>No chats yet</li>
          )}
          {archived.length > 0 && (
            <li>
              <button
                type="button"
                className={cx(ui.disclosure, styles.archivedToggle)}
                aria-expanded={showArchived}
                onClick={() => setShowArchived(!showArchived)}
              >
                Archived ({archived.length})
              </button>
            </li>
          )}
          {showArchived && archived.map(item)}
        </ul>
        <div className={styles.footer}>
          <span
            className={cx(styles.connection, CONNECTION_CLASS[connection])}
            title={CONNECTION_LABEL[connection]}
          />
          <span className={styles.backendUrl} title={backendUrl}>
            {backendUrl.replace(/^https?:\/\//, "")}
          </span>
          <button
            type="button"
            className={ui.linkButton}
            onClick={onChangeBackend}
          >
            Change
          </button>
        </div>
      </nav>
    </>
  );
}
