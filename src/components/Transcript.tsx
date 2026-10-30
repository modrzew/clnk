import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AssistantMessage,
  ChatMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from "../../shared/protocol";
import { Markdown } from "./Markdown";

interface TranscriptProps {
  messages: ChatMessage[];
  streaming: AssistantMessage | null;
  running: boolean;
}

/** Distance from the bottom within which new content keeps the view scrolled to the end. */
const STICK_THRESHOLD_PX = 80;

export function Transcript({ messages, streaming, running }: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const results = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const message of messages) if (message.role === "toolResult") map.set(message.toolCallId, message);
    return map;
  }, [messages]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, running]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  };

  const waiting = running && !streaming;
  return (
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      <div className="transcript-inner">
        {messages.map((message, index) => (
          <MessageView key={index} message={message} results={results} running={running} />
        ))}
        {streaming && <AssistantView message={streaming} results={results} running streaming />}
        {waiting && (
          <div className="working" aria-live="polite">
            <span className="spinner" /> Pi is working…
          </div>
        )}
      </div>
    </div>
  );
}

interface MessageViewProps {
  message: ChatMessage;
  results: Map<string, ToolResultMessage>;
  running: boolean;
}

const MessageView = memo(function MessageView({ message, results, running }: MessageViewProps) {
  switch (message.role) {
    case "user":
      return (
        <div className="msg msg-user">
          <div className="bubble">{contentText(message.content)}</div>
        </div>
      );
    case "assistant":
      return <AssistantView message={message} results={results} running={running} />;
    case "custom":
      return (
        <div className="msg msg-custom">
          <Markdown text={contentText(message.content)} />
        </div>
      );
    case "compaction":
      return <div className="msg-divider">Context compacted</div>;
    default:
      // Tool results are shown on their tool call line.
      return null;
  }
});

interface AssistantViewProps {
  message: AssistantMessage;
  results: Map<string, ToolResultMessage>;
  running: boolean;
  streaming?: boolean;
}

function AssistantView({ message, results, running, streaming = false }: AssistantViewProps) {
  const lastIndex = message.content.length - 1;
  return (
    <div className="msg msg-assistant">
      {message.content.map((block, index) => {
        switch (block.type) {
          case "text":
            return block.text.trim() ? <Markdown key={index} text={block.text} /> : null;
          case "thinking":
            return <Thinking key={index} block={block} active={streaming && index === lastIndex} />;
          case "toolCall":
            return <ToolCallLine key={index} call={block} result={results.get(block.id)} running={running} />;
          default:
            return null;
        }
      })}
      {message.stopReason === "error" && (
        <div className="msg-error">{message.errorMessage || "The model returned an error."}</div>
      )}
      {message.stopReason === "aborted" && <div className="msg-note">Aborted.</div>}
      {message.stopReason === "length" && <div className="msg-note">Stopped at the output token limit.</div>}
    </div>
  );
}

function Thinking({ block, active }: { block: ThinkingContent; active: boolean }) {
  // Open while it streams, then collapse, unless the user has toggled it.
  const [open, setOpen] = useState(active);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setOpen(active);
  }, [active, touched]);

  const text = block.thinking.trim();
  if (!text && !active) return null;
  return (
    <div className={`thinking${open ? " open" : ""}`}>
      <button
        type="button"
        className="thinking-toggle"
        aria-expanded={open}
        onClick={() => {
          setTouched(true);
          setOpen(!open);
        }}
      >
        {active ? "Thinking…" : block.redacted ? "Thinking (redacted)" : "Thinking"}
      </button>
      {open && text && <div className="thinking-body">{text}</div>}
    </div>
  );
}

function ToolCallLine({ call, result, running }: { call: ToolCall; result?: ToolResultMessage; running: boolean }) {
  const status = result ? (result.isError ? "error" : "ok") : running ? "running" : "unknown";
  const summary = summarizeArguments(call.arguments);
  const label = { ok: "Done", error: "Failed", running: "Running", unknown: "No result" }[status];
  return (
    <div className={`tool-call tool-${status}`} title={summary ? `${call.name}: ${summary}` : call.name}>
      <span className="tool-status" aria-label={label} />
      <span className="tool-name">{call.name}</span>
      {summary && <span className="tool-args">{summary}</span>}
    </div>
  );
}

const SUMMARY_KEYS = ["command", "path", "file_path", "pattern", "url", "query"];

function summarizeArguments(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  for (const key of SUMMARY_KEYS) {
    const value = args[key];
    if (typeof value === "string") return value.split("\n")[0];
  }
  const json = JSON.stringify(args);
  return json === "{}" ? "" : json;
}

function contentText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("\n")
    .trim();
}
