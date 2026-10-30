import { useCallback, useState } from "react";
import { LuArchive, LuArchiveRestore } from "react-icons/lu";
import type { ChatSummary, ModelInfo } from "../../shared/protocol";
import type { BackendClient } from "../lib/client";
import { cx } from "../lib/cx";
import { useTranscript } from "../lib/hooks";
import styles from "./ChatView.module.css";
import { Composer } from "./Composer";
import { ContextMeter } from "./ContextMeter";
import { Header } from "./Header";
import { ModelLabel, ModelSelect } from "./ModelSelect";
import { Spinner } from "./Spinner";
import { Transcript } from "./Transcript";
import ui from "./ui.module.css";

interface ChatViewProps {
  client: BackendClient;
  chatId: string;
  /** Undefined while the chat list is loading or if the chat doesn't exist. */
  chat: ChatSummary | undefined;
  chatsLoaded: boolean;
  models: ModelInfo[];
  onMenu: () => void;
}

export function ChatView({
  client,
  chatId,
  chat,
  chatsLoaded,
  models,
  onMenu,
}: ChatViewProps) {
  const transcript = useTranscript(client, chatId);
  const [actionError, setActionError] = useState<string | null>(null);
  const running = chat?.status === "running";
  const archived = chat?.archived ?? false;

  const rewind = useCallback(
    (timestamp: number, message?: string) =>
      client.rewind(chatId, { timestamp, message }).then(() => {}),
    [client, chatId],
  );

  function act(action: () => Promise<unknown>) {
    setActionError(null);
    action().catch((err: Error) => setActionError(err.message));
  }
  const setArchived = (value: boolean) =>
    act(() => client.updateChat(chatId, { archived: value }));

  if (chatsLoaded && !chat) {
    return (
      <>
        <Header title="Chat not found" onMenu={onMenu} />
        <div className={styles.empty}>
          This chat doesn't exist on this backend.
        </div>
      </>
    );
  }

  return (
    <>
      <Header title={chat?.title ?? ""} running={running} onMenu={onMenu}>
        {chat && (
          <button
            type="button"
            className={ui.iconButton}
            aria-label={archived ? "Unarchive chat" : "Archive chat"}
            title={archived ? "Unarchive chat" : "Archive chat"}
            onClick={() => setArchived(!archived)}
          >
            {archived ? (
              <LuArchiveRestore size={16} aria-hidden />
            ) : (
              <LuArchive size={16} aria-hidden />
            )}
          </button>
        )}
      </Header>
      {transcript.loaded ? (
        <Transcript
          transcript={transcript}
          running={running}
          onRewind={running || archived ? undefined : rewind}
        />
      ) : (
        <div className={styles.empty}>
          <Spinner />
        </div>
      )}
      {transcript.error && (
        <div className={ui.errorBanner}>{transcript.error}</div>
      )}
      {actionError && <div className={ui.errorBanner}>{actionError}</div>}
      {archived ? (
        <div className={styles.archivedNotice}>
          This chat is archived.{" "}
          <button
            type="button"
            className={cx(ui.linkButton, styles.unarchiveButton)}
            onClick={() => setArchived(false)}
          >
            Unarchive it
          </button>{" "}
          to continue.
        </div>
      ) : (
        <Composer
          key={chatId}
          running={running}
          autoFocus
          onSend={(text) => client.sendMessage(chatId, text).then(() => {})}
          onStop={() => client.abort(chatId).then(({ queued }) => queued)}
        >
          {chat &&
            (models.length > 0 ? (
              <ModelSelect
                models={models}
                value={chat.model}
                onChange={(model) =>
                  act(() => client.updateChat(chatId, { model }))
                }
              />
            ) : (
              <ModelLabel model={chat.model} />
            ))}
          <ContextMeter context={chat?.context ?? null} />
        </Composer>
      )}
    </>
  );
}
