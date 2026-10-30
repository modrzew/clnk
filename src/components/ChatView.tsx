import type { ChatSummary } from "../../shared/protocol";
import type { BackendClient } from "../lib/client";
import { useTranscript } from "../lib/hooks";
import { Composer } from "./Composer";
import { Header } from "./Header";
import { Transcript } from "./Transcript";

interface ChatViewProps {
  client: BackendClient;
  chatId: string;
  /** Undefined while the chat list is loading or if the chat doesn't exist. */
  chat: ChatSummary | undefined;
  chatsLoaded: boolean;
  onMenu: () => void;
}

export function ChatView({ client, chatId, chat, chatsLoaded, onMenu }: ChatViewProps) {
  const transcript = useTranscript(client, chatId);
  const running = chat?.status === "running";

  if (chatsLoaded && !chat) {
    return (
      <>
        <Header title="Chat not found" onMenu={onMenu} />
        <div className="empty">This chat doesn't exist on this backend.</div>
      </>
    );
  }

  return (
    <>
      <Header title={chat?.title ?? ""} model={chat?.model} running={running} onMenu={onMenu} />
      {transcript.loaded ? (
        <Transcript messages={transcript.messages} streaming={transcript.streaming} running={running} />
      ) : (
        <div className="empty">
          <span className="spinner" />
        </div>
      )}
      {transcript.error && <div className="run-error">{transcript.error}</div>}
      <Composer
        key={chatId}
        blockedReason={running ? "Pi is working… you can send when it's done" : undefined}
        autoFocus
        onSend={(text) => client.sendMessage(chatId, text).then(() => {})}
      />
    </>
  );
}
