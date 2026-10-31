import {
  type KeyboardEvent,
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LuPaperclip } from "react-icons/lu";
import type {
  AssistantMessage,
  ChatMessage,
  CompactionMarker,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolResultMessage,
  UserMessage,
} from "../../shared/protocol";
import type { TranscriptState } from "../../shared/transcript";
import { cx } from "../lib/cx";
import { useExpandable } from "../lib/prefs";
import { FileList, ImageList } from "./Attachments";
import { Markdown } from "./Markdown";
import { Spinner } from "./Spinner";
import { ToolCallView } from "./ToolCall";
import styles from "./Transcript.module.css";
import ui from "./ui.module.css";

/** Edits (with `message`) or retries the user message with the given timestamp. */
export type Rewind = (timestamp: number, message?: string) => Promise<void>;

/** Where to download a file attached to a message of the chat. */
export type AttachmentUrl = (name: string) => string;

interface TranscriptProps {
  transcript: TranscriptState;
  running: boolean;
  attachmentUrl: AttachmentUrl;
  /** Set when messages can be edited and retried. */
  onRewind?: Rewind;
}

/** Distance from the bottom within which new content keeps the view scrolled to the end. */
const STICK_THRESHOLD_PX = 80;
const NO_OUTPUT: Record<string, string> = {};

export function Transcript({
  transcript,
  running,
  attachmentUrl,
  onRewind,
}: TranscriptProps) {
  const { messages, streaming, toolOutput, queued, activity } = transcript;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const results = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const message of messages)
      if (message.role === "toolResult") map.set(message.toolCallId, message);
    return map;
  }, [messages]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [transcript, running]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el)
      stickToBottom.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  };

  const lastUser = lastUserMessage(messages);
  const waiting = running && !streaming;
  return (
    <div className={styles.transcript} ref={scrollRef} onScroll={onScroll}>
      <div className={styles.inner}>
        {messages.map((message, index) => (
          <MessageView
            key={`${index}:${message.timestamp}`}
            message={message}
            results={results}
            // Only messages with tool calls still waiting for results re-render as output streams.
            toolOutput={
              hasPendingCalls(message, results) ? toolOutput : NO_OUTPUT
            }
            running={running}
            attachmentUrl={attachmentUrl}
            onRewind={onRewind}
          />
        ))}
        {streaming && (
          <AssistantView
            message={streaming}
            results={results}
            toolOutput={toolOutput}
            running
            streaming
          />
        )}
        {queued.map((text, index) => (
          <div key={index} className={cx(styles.msgUser, styles.queued)}>
            <div className={styles.bubble}>{text}</div>
            <div className={styles.msgNote}>
              Pi reads this after its current step
            </div>
          </div>
        ))}
        {(waiting || activity) && (
          <div className={styles.working} aria-live="polite">
            <Spinner /> {activity ?? "Pi is working…"}
          </div>
        )}
        {onRewind && lastUser && (
          <RetryButton onRetry={() => onRewind(lastUser.timestamp)} />
        )}
      </div>
    </div>
  );
}

interface MessageViewProps {
  message: ChatMessage;
  results: Map<string, ToolResultMessage>;
  toolOutput: Record<string, string>;
  running: boolean;
  attachmentUrl: AttachmentUrl;
  onRewind?: Rewind;
}

const MessageView = memo(function MessageView({
  message,
  results,
  toolOutput,
  running,
  attachmentUrl,
  onRewind,
}: MessageViewProps) {
  switch (message.role) {
    case "user":
      return (
        <UserMessageView
          message={message}
          attachmentUrl={attachmentUrl}
          onRewind={onRewind}
        />
      );
    case "assistant":
      return (
        <AssistantView
          message={message}
          results={results}
          toolOutput={toolOutput}
          running={running}
        />
      );
    case "custom":
      return (
        <div className={styles.msgCustom}>
          <Markdown text={contentText(message.content)} />
        </div>
      );
    case "compaction":
      return <CompactionView marker={message} />;
    default:
      // Tool results are shown on their tool call line.
      return null;
  }
});

function UserMessageView({
  message,
  attachmentUrl,
  onRewind,
}: {
  message: UserMessage;
  attachmentUrl: AttachmentUrl;
  onRewind?: Rewind;
}) {
  const [editing, setEditing] = useState(false);
  const { content, attachments = [] } = message;
  const text = typeof content === "string" ? content : textParts(content);
  const images =
    typeof content === "string"
      ? []
      : content.filter((part): part is ImageContent => part.type === "image");
  const files = attachments.filter((attachment) => !attachment.inline);
  if (editing)
    return (
      <EditMessage
        initial={text}
        attachments={attachments.map((attachment) => attachment.name)}
        onCancel={() => setEditing(false)}
        onSave={
          onRewind &&
          (async (edited) => {
            await onRewind(message.timestamp, edited);
            setEditing(false);
          })
        }
      />
    );
  return (
    <div className={styles.msgUser}>
      <div className={styles.userContent}>
        {images.length > 0 && <ImageList images={images} />}
        {files.length > 0 && <FileList files={files} href={attachmentUrl} />}
        {text.trim() && <div className={styles.bubble}>{text}</div>}
      </div>
      {onRewind && (
        <div className={styles.msgActions}>
          <button
            type="button"
            className={ui.linkButton}
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        </div>
      )}
    </div>
  );
}

function EditMessage({
  initial,
  attachments,
  onCancel,
  onSave,
}: {
  initial: string;
  /** Names of the message's files, which are sent again with it. */
  attachments: string[];
  onCancel: () => void;
  /** Unset while the message can't be edited, e.g. because Pi started running. */
  onSave?: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const canSave =
    onSave !== undefined &&
    (text.trim().length > 0 || attachments.length > 0) &&
    !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    }
  }

  return (
    <div className={styles.msgUser}>
      <div className={styles.editBox}>
        <textarea
          ref={inputRef}
          value={text}
          autoFocus
          aria-label="Edit message"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {attachments.length > 0 && (
          <div className={styles.editAttachments}>
            <LuPaperclip size={13} aria-hidden />
            <span>{attachments.join(", ")}</span>
          </div>
        )}
        {error && <div className={ui.errorText}>{error}</div>}
        <div className={styles.editActions}>
          <span className={styles.editHint}>
            {onSave
              ? "Pi answers again from here; later messages are replaced."
              : "Wait for Pi to finish to send this."}
          </span>
          <button
            type="button"
            className={cx(ui.button, ui.secondary)}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={ui.button}
            disabled={!canSave}
            onClick={() => void save()}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function RetryButton({ onRetry }: { onRetry: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={styles.retry}>
      <button
        type="button"
        className={ui.linkButton}
        disabled={pending}
        title="Send the last message again"
        onClick={() => {
          setPending(true);
          setError(null);
          onRetry()
            .catch((err: Error) => setError(err.message))
            .finally(() => setPending(false));
        }}
      >
        ↻ Retry
      </button>
      {error && <span className={ui.errorText}>{error}</span>}
    </div>
  );
}

interface AssistantViewProps {
  message: AssistantMessage;
  results: Map<string, ToolResultMessage>;
  toolOutput: Record<string, string>;
  running: boolean;
  streaming?: boolean;
}

function AssistantView({
  message,
  results,
  toolOutput,
  running,
  streaming = false,
}: AssistantViewProps) {
  const lastIndex = message.content.length - 1;
  return (
    <div className={styles.msgAssistant}>
      {message.content.map((block, index) => {
        switch (block.type) {
          case "text":
            return block.text.trim() ? (
              <Markdown key={index} text={block.text} />
            ) : null;
          case "thinking":
            return (
              <Thinking
                key={index}
                block={block}
                active={streaming && index === lastIndex}
              />
            );
          case "toolCall":
            return (
              <ToolCallView
                key={index}
                call={block}
                result={results.get(block.id)}
                output={toolOutput[block.id]}
                running={running}
              />
            );
          default:
            return null;
        }
      })}
      {message.stopReason === "error" && (
        <div className={ui.error}>
          {message.errorMessage || "The model returned an error."}
        </div>
      )}
      {message.stopReason === "aborted" && (
        <div className={styles.msgNote}>Stopped.</div>
      )}
      {message.stopReason === "length" && (
        <div className={styles.msgNote}>Stopped at the output token limit.</div>
      )}
    </div>
  );
}

function Thinking({
  block,
  active,
}: {
  block: ThinkingContent;
  active: boolean;
}) {
  const [open, toggle] = useExpandable("thinking", active);
  const text = block.thinking.trim();
  if (!text && !active) return null;
  return (
    <div>
      <button
        type="button"
        className={ui.disclosure}
        aria-expanded={open}
        onClick={toggle}
      >
        {active
          ? "Thinking…"
          : block.redacted
            ? "Thinking (redacted)"
            : "Thinking"}
      </button>
      {open && text && <div className={styles.thinkingBody}>{text}</div>}
    </div>
  );
}

function CompactionView({ marker }: { marker: CompactionMarker }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className={styles.msgDivider}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Context compacted
      </button>
      {open && (
        <div className={styles.compactionSummary}>
          <Markdown text={marker.summary} />
        </div>
      )}
    </div>
  );
}

function lastUserMessage(messages: ChatMessage[]): UserMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") return message;
  }
  return undefined;
}

function hasPendingCalls(
  message: ChatMessage,
  results: Map<string, ToolResultMessage>,
): boolean {
  return (
    message.role === "assistant" &&
    message.content.some(
      (block) => block.type === "toolCall" && !results.has(block.id),
    )
  );
}

function contentText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("\n")
    .trim();
}

function textParts(content: (TextContent | ImageContent)[]): string {
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}
