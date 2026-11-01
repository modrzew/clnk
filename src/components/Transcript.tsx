import {
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LuCheck, LuCopy, LuPaperclip, LuPencil, LuX } from "react-icons/lu";
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
import { copyText } from "../lib/clipboard";
import { cx } from "../lib/cx";
import { formatTime } from "../lib/format";
import { useExpandable } from "../lib/prefs";
import { fadePieces, type Revealed, useReveal } from "../lib/reveal";
import { FileList, ImageList } from "./Attachments";
import { Button, Disclosure, IconButton, LinkButton } from "./Button";
import { ErrorMessage } from "./ErrorMessage";
import { Markdown } from "./Markdown";
import { Spinner } from "./Spinner";
import { ToolCallView } from "./ToolCall";
import styles from "./Transcript.module.css";

/** Edits (with `message`) or retries the user message with the given timestamp. */
export type Rewind = (timestamp: number, message?: string) => Promise<void>;

/** Where to download a file attached to a message of the chat. */
export type AttachmentUrl = (name: string) => string;

/** Where to load an image in the chat's folder, by the path a reply gives it. */
export type ImageUrl = (path: string) => string;

interface TranscriptProps {
  transcript: TranscriptState;
  running: boolean;
  attachmentUrl: AttachmentUrl;
  imageUrl: ImageUrl;
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
  imageUrl,
  onRewind,
}: TranscriptProps) {
  const { messages, streaming, toolOutput, queued, activity } = transcript;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastScrollTop = useRef(0);
  const results = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const message of messages)
      if (message.role === "toolResult") map.set(message.toolCallId, message);
    return map;
  }, [messages]);

  const keepEndInView = useCallback(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(keepEndInView, [transcript, running, keepEndInView]);

  // Images load after they're rendered, and push the end down. `load` doesn't bubble, but can be captured.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("load", keepEndInView, true);
    return () => el.removeEventListener("load", keepEndInView, true);
  }, [keepEndInView]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    // Leaving the end means scrolling up. When content grows, the browser can scroll down a little to
    // keep what's in view in place, which doesn't count.
    if (atBottom || el.scrollTop < lastScrollTop.current)
      stickToBottom.current = atBottom;
    lastScrollTop.current = el.scrollTop;
  };

  const lastUser = lastUserMessage(messages);
  const waiting = running && !streaming;
  return (
    <div className={styles.transcript} ref={scrollRef} onScroll={onScroll}>
      <div className={styles.inner}>
        {/* The streaming message has the key it gets once it's done, so its view stays, e.g. to finish
            revealing its text. */}
        {(streaming ? [...messages, streaming] : messages).map(
          (message, index) => (
            <MessageView
              key={`${index}:${message.timestamp}`}
              message={message}
              results={results}
              // Only messages with tool calls still waiting for results re-render as output streams.
              toolOutput={
                hasPendingCalls(message, results) ? toolOutput : NO_OUTPUT
              }
              running={running}
              streaming={message === streaming}
              onReveal={keepEndInView}
              attachmentUrl={attachmentUrl}
              imageUrl={imageUrl}
              onRewind={onRewind}
            />
          ),
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
  streaming: boolean;
  /** Called when more of a streamed text is shown. */
  onReveal: () => void;
  attachmentUrl: AttachmentUrl;
  imageUrl: ImageUrl;
  onRewind?: Rewind;
}

const MessageView = memo(function MessageView({
  message,
  results,
  toolOutput,
  running,
  streaming,
  onReveal,
  attachmentUrl,
  imageUrl,
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
          imageUrl={imageUrl}
          running={running || streaming}
          streaming={streaming}
          onReveal={onReveal}
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
      {/* Focusable so that tapping it shows its footer on touch screens. */}
      <div className={styles.userContent} tabIndex={-1}>
        {images.length > 0 && <ImageList images={images} />}
        {files.length > 0 && <FileList files={files} href={attachmentUrl} />}
        {text.trim() && <div className={styles.bubble}>{text}</div>}
        <div className={styles.footer}>
          <MessageTime timestamp={message.timestamp} />
          {onRewind && (
            <IconButton
              size="small"
              aria-label="Edit"
              title="Edit"
              onClick={() => setEditing(true)}
            >
              <LuPencil size={14} aria-hidden />
            </IconButton>
          )}
          {text.trim() && <CopyButton text={text} />}
        </div>
      </div>
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
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <div className={styles.editActions}>
          <span className={styles.editHint}>
            {onSave
              ? "Pi answers again from here; later messages are replaced."
              : "Wait for Pi to finish to send this."}
          </span>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            Send
          </Button>
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
      <LinkButton
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
      </LinkButton>
      {error && <ErrorMessage>{error}</ErrorMessage>}
    </div>
  );
}

interface AssistantViewProps {
  message: AssistantMessage;
  results: Map<string, ToolResultMessage>;
  toolOutput: Record<string, string>;
  imageUrl: ImageUrl;
  running: boolean;
  streaming: boolean;
  onReveal: () => void;
}

function AssistantView({
  message,
  results,
  toolOutput,
  imageUrl,
  running,
  streaming,
  onReveal,
}: AssistantViewProps) {
  const lastIndex = message.content.length - 1;
  return (
    <div className={styles.msgAssistant}>
      {message.content.map((block, index) => {
        switch (block.type) {
          case "text":
            return (
              <ReplyText
                key={index}
                text={block.text}
                timestamp={message.timestamp}
                imageUrl={imageUrl}
                onReveal={onReveal}
              />
            );
          case "thinking":
            return (
              <Thinking
                key={index}
                block={block}
                active={streaming && index === lastIndex}
                onReveal={onReveal}
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
        <ErrorMessage variant="box">
          {message.errorMessage || "The model returned an error."}
        </ErrorMessage>
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

/** Text of a reply, revealed letter by letter as it streams in. */
function ReplyText({
  text,
  timestamp,
  imageUrl,
  onReveal,
}: {
  text: string;
  /** When the message with the text was sent. */
  timestamp: number;
  imageUrl: ImageUrl;
  onReveal: () => void;
}) {
  const revealed = useReveal(text);
  useLayoutEffect(onReveal, [revealed.text, onReveal]);
  if (!revealed.text.trim()) return null;
  return (
    <div className={styles.reply} tabIndex={-1}>
      <Markdown text={revealed.text} fade={revealed.fade} imageUrl={imageUrl} />
      <div className={styles.footer}>
        <CopyButton text={text} />
        <MessageTime timestamp={timestamp} />
      </div>
    </div>
  );
}

function MessageTime({ timestamp }: { timestamp: number }) {
  return (
    <time className={styles.time} dateTime={new Date(timestamp).toISOString()}>
      {formatTime(timestamp)}
    </time>
  );
}

/** How long a copy button shows whether it copied. */
const COPY_FEEDBACK_MS = 1500;

function CopyButton({ text }: { text: string }) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [result]);
  const label =
    result === "copied"
      ? "Copied"
      : result === "failed"
        ? "Couldn't copy"
        : "Copy";
  const Icon =
    result === "copied" ? LuCheck : result === "failed" ? LuX : LuCopy;
  return (
    <IconButton
      size="small"
      aria-label={label}
      title={label}
      onClick={() =>
        void copyText(text).then(
          () => setResult("copied"),
          () => setResult("failed"),
        )
      }
    >
      <Icon size={14} aria-hidden />
    </IconButton>
  );
}

function FadedText({ text, fade }: Revealed) {
  if (!fade) return text;
  return fadePieces(text, 0, fade).map(({ text, opacity }, index) =>
    opacity === undefined ? (
      text
    ) : (
      <span key={index} style={{ opacity }}>
        {text}
      </span>
    ),
  );
}

function Thinking({
  block,
  active,
  onReveal,
}: {
  block: ThinkingContent;
  active: boolean;
  onReveal: () => void;
}) {
  const [open, toggle] = useExpandable("thinking", active);
  const text = block.thinking.trim();
  const revealed = useReveal(text);
  useLayoutEffect(onReveal, [revealed.text, onReveal]);
  if (!text && !active) return null;
  return (
    <div>
      <Disclosure expanded={open} onToggle={toggle}>
        {active
          ? "Thinking…"
          : block.redacted
            ? "Thinking (redacted)"
            : "Thinking"}
      </Disclosure>
      {open && revealed.text && (
        <div className={styles.thinkingBody}>
          <FadedText {...revealed} />
        </div>
      )}
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
