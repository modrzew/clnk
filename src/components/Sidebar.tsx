import type { ChatSummary } from "../../shared/protocol";
import type { ConnectionStatus } from "../lib/client";
import { navigate, type Route } from "../lib/hooks";

interface SidebarProps {
  chats: ChatSummary[] | null;
  route: Route;
  connection: ConnectionStatus;
  backendUrl: string;
  open: boolean;
  onClose: () => void;
  onChangeBackend: () => void;
}

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  open: "Connected",
  offline: "Reconnecting…",
};

export function Sidebar({ chats, route, connection, backendUrl, open, onClose, onChangeBackend }: SidebarProps) {
  const activeId = route.name === "chat" ? route.chatId : null;
  return (
    <>
      <div className={`backdrop${open ? " visible" : ""}`} onClick={onClose} />
      <nav className={`sidebar${open ? " open" : ""}`} aria-label="Chats">
        <div className="sidebar-top">
          <span className="brand">clnk</span>
          <a className="new-chat-button" href="#/" onClick={onClose}>
            + New chat
          </a>
        </div>
        <ul className="chat-list">
          {chats?.map((chat) => (
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
                {chat.status === "running" && <span className="spinner" aria-label="Running" />}
              </a>
            </li>
          ))}
          {chats?.length === 0 && <li className="chat-list-empty">No chats yet</li>}
        </ul>
        <div className="sidebar-footer">
          <span className={`connection connection-${connection}`} title={CONNECTION_LABEL[connection]} />
          <span className="backend-url" title={backendUrl}>
            {backendUrl.replace(/^https?:\/\//, "")}
          </span>
          <button type="button" className="link-button" onClick={onChangeBackend}>
            Change
          </button>
        </div>
      </nav>
    </>
  );
}
