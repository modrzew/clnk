import { type MouseEvent, useState } from "react";
import {
  LuArchive,
  LuArchiveRestore,
  LuChevronRight,
  LuPlus,
  LuSlidersHorizontal,
} from "react-icons/lu";
import type { ChatSummary, ProjectSummary } from "../../shared/protocol";
import type { ConnectionStatus } from "../lib/client";
import { cx } from "../lib/cx";
import { navigate, type Route, routeHref } from "../lib/hooks";
import styles from "./Sidebar.module.css";
import { Spinner } from "./Spinner";
import ui from "./ui.module.css";

interface SidebarProps {
  chats: ChatSummary[] | null;
  projects: ProjectSummary[] | null;
  route: Route;
  connection: ConnectionStatus;
  backendUrl: string;
  open: boolean;
  onClose: () => void;
  onChangeBackend: () => void;
  onOpenSettings: () => void;
  onNewProject: () => void;
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
  projects,
  route,
  connection,
  backendUrl,
  open,
  onClose,
  onChangeBackend,
  onOpenSettings,
  onNewProject,
  onArchive,
}: SidebarProps) {
  const [showArchived, setShowArchived] = useState(false);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const activeChatId = route.name === "chat" ? route.chatId : null;
  const activeProjectId =
    route.name === "project"
      ? route.projectId
      : (chats?.find((chat) => chat.id === activeChatId)?.projectId ?? null);

  // Projects are collapsed until opened. The one of the open page is shown whenever it changes,
  // or moves to the archived ones.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const activeArchived =
    projects?.find((project) => project.id === activeProjectId)?.archived ??
    false;
  const reveal = activeProjectId && `${activeProjectId}:${activeArchived}`;
  const [revealed, setRevealed] = useState<string | null>(null);
  if (reveal !== revealed) {
    setRevealed(reveal);
    if (activeProjectId && !expanded.has(activeProjectId))
      setExpanded(new Set([...expanded, activeProjectId]));
    if (activeArchived) setShowArchivedProjects(true);
  }
  const toggleProject = (projectId: string) => {
    const next = new Set(expanded);
    if (!next.delete(projectId)) next.add(projectId);
    setExpanded(next);
  };

  // Chats of projects the client doesn't know are listed with the others rather than lost.
  const known = new Set(projects?.map((project) => project.id));
  const inProject = (chat: ChatSummary) =>
    chat.projectId !== null && known.has(chat.projectId);
  const standalone = chats?.filter((chat) => !inProject(chat));
  const current = standalone?.filter((chat) => !chat.archived);
  const archived = standalone?.filter((chat) => chat.archived) ?? [];
  const currentProjects = projects?.filter((project) => !project.archived);
  const archivedProjects =
    projects?.filter((project) => project.archived) ?? [];

  const go = (target: Route) => (event: MouseEvent) => {
    event.preventDefault();
    navigate(target);
    onClose();
  };

  const chatItem = (chat: ChatSummary) => (
    <li key={chat.id}>
      <a
        href={routeHref({ name: "chat", chatId: chat.id })}
        className={chat.id === activeChatId ? styles.active : undefined}
        onClick={go({ name: "chat", chatId: chat.id })}
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

  const projectItem = (project: ProjectSummary) => {
    const projectChats =
      chats?.filter(
        (chat) => chat.projectId === project.id && !chat.archived,
      ) ?? [];
    const isExpanded = expanded.has(project.id);
    const running =
      !isExpanded && projectChats.some((chat) => chat.status === "running");
    return (
      <li key={project.id}>
        <div className={styles.project}>
          <button
            type="button"
            className={styles.expand}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${project.name}`}
            onClick={() => toggleProject(project.id)}
          >
            <LuChevronRight size={14} aria-hidden />
          </button>
          <a
            href={routeHref({ name: "project", projectId: project.id })}
            className={cx(
              styles.projectLink,
              route.name === "project" &&
                route.projectId === project.id &&
                styles.active,
            )}
            onClick={go({ name: "project", projectId: project.id })}
          >
            <span className={styles.chatTitle}>{project.name}</span>
            {running && <Spinner label="Running" />}
          </a>
        </div>
        {isExpanded && (
          <ul className={styles.nested}>
            {projectChats.map(chatItem)}
            {projectChats.length === 0 && (
              <li className={styles.empty}>No chats</li>
            )}
          </ul>
        )}
      </li>
    );
  };

  return (
    <>
      <div
        className={cx(styles.backdrop, open && styles.visible)}
        onClick={onClose}
      />
      <nav
        className={cx(styles.sidebar, open && styles.open)}
        aria-label="Chats and projects"
      >
        <div className={styles.top}>
          <span className={styles.brand}>clnk</span>
          <button
            type="button"
            className={cx(ui.iconButton, styles.settingsButton)}
            aria-label="Settings"
            title="Settings"
            onClick={onOpenSettings}
          >
            <LuSlidersHorizontal size={16} aria-hidden />
          </button>
          <a className={styles.newChatButton} href="#/" onClick={onClose}>
            + New chat
          </a>
        </div>
        <div className={styles.lists}>
          <div className={styles.sectionHeader}>
            <h2>Projects</h2>
            <button
              type="button"
              className={ui.iconButton}
              aria-label="New project"
              title="New project"
              onClick={onNewProject}
            >
              <LuPlus size={16} aria-hidden />
            </button>
          </div>
          <ul className={styles.chatList}>
            {currentProjects?.map(projectItem)}
            {projects?.length === 0 && (
              <li className={styles.empty}>No projects yet</li>
            )}
            {archivedProjects.length > 0 && (
              <li>
                <button
                  type="button"
                  className={cx(ui.disclosure, styles.archivedToggle)}
                  aria-expanded={showArchivedProjects}
                  onClick={() => setShowArchivedProjects(!showArchivedProjects)}
                >
                  Archived ({archivedProjects.length})
                </button>
              </li>
            )}
            {showArchivedProjects && archivedProjects.map(projectItem)}
          </ul>
          <div className={styles.sectionHeader}>
            <h2>Chats</h2>
          </div>
          <ul className={styles.chatList}>
            {current?.map(chatItem)}
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
            {showArchived && archived.map(chatItem)}
          </ul>
        </div>
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
