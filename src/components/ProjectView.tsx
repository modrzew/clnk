import { useState } from "react";
import { LuArchive, LuArchiveRestore, LuPencil } from "react-icons/lu";
import type { ChatSummary, ProjectSummary } from "../../shared/protocol";
import type { BackendClient } from "../lib/client";
import { cx } from "../lib/cx";
import { formatDate } from "../lib/format";
import { type Models, routeHref } from "../lib/hooks";
import { Artefacts } from "./Artefacts";
import { Disclosure, IconButton, LinkButton } from "./Button";
import { ErrorMessage } from "./ErrorMessage";
import { Header } from "./Header";
import { NewChatComposer } from "./NewChat";
import { ProjectDialog } from "./ProjectDialog";
import styles from "./ProjectView.module.css";
import { Spinner } from "./Spinner";

interface ProjectViewProps {
  client: BackendClient;
  /** Undefined while the project list is loading or if the project doesn't exist. */
  project: ProjectSummary | undefined;
  projectsLoaded: boolean;
  /** The project's chats, most recently updated first. */
  chats: ChatSummary[];
  models: Models;
  onMenu: () => void;
}

/** Long instructions are cut short until expanded. */
const CLAMP_LINES = 6;
const CLAMP_LENGTH = 400;

export function ProjectView({
  client,
  project,
  projectsLoaded,
  chats,
  models,
  onMenu,
}: ProjectViewProps) {
  const [editing, setEditing] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!project) {
    return (
      <>
        <Header
          title={projectsLoaded ? "Project not found" : ""}
          onMenu={onMenu}
        />
        <div className={styles.empty}>
          {projectsLoaded ? (
            "This project doesn't exist on this backend."
          ) : (
            <Spinner />
          )}
        </div>
      </>
    );
  }

  const setArchived = (archived: boolean) => {
    setError(null);
    client
      .updateProject(project.id, { archived })
      .catch((err: Error) => setError(err.message));
  };
  const current = chats.filter((chat) => !chat.archived);
  const archived = chats.filter((chat) => chat.archived);
  const longInstructions =
    project.instructions.split("\n").length > CLAMP_LINES ||
    project.instructions.length > CLAMP_LENGTH;

  const chatItem = (chat: ChatSummary) => (
    <li key={chat.id}>
      <a
        className={styles.chat}
        href={routeHref({ name: "chat", chatId: chat.id })}
      >
        <span className={styles.chatTitle}>{chat.title}</span>
        {chat.status === "running" ? (
          <Spinner label="Running" />
        ) : (
          <span className={styles.chatDate}>{formatDate(chat.updatedAt)}</span>
        )}
      </a>
    </li>
  );

  return (
    <>
      <Header title={project.name} onMenu={onMenu}>
        <IconButton
          aria-label="Edit project"
          title="Edit project"
          onClick={() => setEditing(true)}
        >
          <LuPencil size={16} aria-hidden />
        </IconButton>
        <IconButton
          aria-label={
            project.archived ? "Unarchive project" : "Archive project"
          }
          title={project.archived ? "Unarchive project" : "Archive project"}
          onClick={() => setArchived(!project.archived)}
        >
          {project.archived ? (
            <LuArchiveRestore size={16} aria-hidden />
          ) : (
            <LuArchive size={16} aria-hidden />
          )}
        </IconButton>
      </Header>
      {editing && (
        <ProjectDialog
          project={project}
          onClose={() => setEditing(false)}
          onSave={(fields) =>
            client.updateProject(project.id, fields).then(() => {})
          }
        />
      )}
      <div className={styles.page}>
        <div className={styles.inner}>
          {project.archived && (
            <div className={styles.notice}>
              This project is archived: its chats and artefacts can't be
              changed.{" "}
              <LinkButton inline onClick={() => setArchived(false)}>
                Unarchive it
              </LinkButton>
            </div>
          )}
          {error && <ErrorMessage variant="box">{error}</ErrorMessage>}

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2>Instructions</h2>
              <LinkButton onClick={() => setEditing(true)}>Edit</LinkButton>
            </div>
            {project.instructions ? (
              <>
                <p
                  className={cx(
                    styles.instructions,
                    longInstructions && !showInstructions && styles.clamped,
                  )}
                >
                  {project.instructions}
                </p>
                {longInstructions && (
                  <div className={styles.more}>
                    <Disclosure
                      expanded={showInstructions}
                      onToggle={() => setShowInstructions(!showInstructions)}
                    >
                      {showInstructions ? "Show less" : "Show all"}
                    </Disclosure>
                  </div>
                )}
              </>
            ) : (
              <p className={styles.hint}>
                None. Instructions tell Pi what the project is about and how to
                work in it, in every chat of the project.
              </p>
            )}
          </section>

          <Artefacts client={client} project={project} />

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2>Chats</h2>
            </div>
            {current.length > 0 ? (
              <ul className={styles.chats}>{current.map(chatItem)}</ul>
            ) : (
              <p className={styles.hint}>
                {project.archived
                  ? "No chats."
                  : "No chats yet. Start one below."}
              </p>
            )}
            {archived.length > 0 && (
              <>
                <div className={styles.more}>
                  <Disclosure
                    expanded={showArchived}
                    onToggle={() => setShowArchived(!showArchived)}
                  >
                    Archived ({archived.length})
                  </Disclosure>
                </div>
                {showArchived && (
                  <ul className={styles.chats}>{archived.map(chatItem)}</ul>
                )}
              </>
            )}
          </section>
        </div>
      </div>
      {!project.archived && (
        <NewChatComposer
          key={project.id}
          client={client}
          models={models}
          projectId={project.id}
          placeholder={`Start a chat in ${project.name}`}
        />
      )}
    </>
  );
}
