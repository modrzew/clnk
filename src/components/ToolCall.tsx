import { useLayoutEffect, useRef } from "react";
import type {
  ImageContent,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from "../../shared/protocol";
import { cx } from "../lib/cx";
import { type OutputKind, useExpandable } from "../lib/prefs";
import styles from "./ToolCall.module.css";

interface ToolCallViewProps {
  call: ToolCall;
  result?: ToolResultMessage;
  /** Output so far, while the tool runs. */
  output?: string;
  running: boolean;
}

type Status = "ok" | "error" | "running" | "unknown";

const STATUS_LABEL: Record<Status, string> = {
  ok: "Done",
  error: "Failed",
  running: "Running",
  unknown: "No result",
};

const STATUS_CLASS: Record<Status, string | undefined> = {
  ok: styles.ok,
  error: styles.error,
  running: styles.running,
  unknown: undefined,
};

export function ToolCallView({
  call,
  result,
  output,
  running,
}: ToolCallViewProps) {
  const status: Status = result
    ? result.isError
      ? "error"
      : "ok"
    : running
      ? "running"
      : "unknown";
  const [open, toggle] = useExpandable(
    outputKind(call.name),
    status === "running",
  );
  const summary = summarizeArguments(call.arguments);
  return (
    <div className={cx(styles.tool, STATUS_CLASS[status])}>
      <button
        type="button"
        className={styles.call}
        aria-expanded={open}
        title={summary ? `${call.name}: ${summary}` : call.name}
        onClick={toggle}
      >
        <span className={styles.status} aria-label={STATUS_LABEL[status]} />
        <span className={styles.name}>{call.name}</span>
        {summary && <span className={styles.args}>{summary}</span>}
      </button>
      {open && (
        <ToolDetails
          call={call}
          result={result}
          output={output}
          live={status === "running"}
        />
      )}
    </div>
  );
}

function outputKind(toolName: string): OutputKind {
  switch (toolName) {
    case "bash":
    case "powershell":
      return "commands";
    case "edit":
    case "write":
      return "changes";
    case "read":
      return "reads";
    default:
      return "tools";
  }
}

function ToolDetails({
  call,
  result,
  output,
  live,
}: {
  call: ToolCall;
  result?: ToolResultMessage;
  output?: string;
  live: boolean;
}) {
  const args = call.arguments ?? {};
  const text = result ? resultText(result.content) : output;
  const images = result?.content.filter(
    (part): part is ImageContent => part.type === "image",
  );
  const errorText = result?.isError ? text : undefined;

  let body;
  switch (call.name) {
    case "bash":
    case "powershell":
      body = (
        <>
          <pre className={styles.input}>{`$ ${stringArg(args.command)}`}</pre>
          {text !== undefined && (
            <Output text={text || "(no output)"} follow={live} />
          )}
        </>
      );
      break;
    case "edit": {
      const diff = (result?.details as { diff?: unknown } | undefined)?.diff;
      body =
        typeof diff === "string" ? (
          <Diff text={diff} />
        ) : (
          text !== undefined && <Output text={text} />
        );
      break;
    }
    case "write":
      body = errorText ? (
        <Output text={errorText} />
      ) : (
        <Output text={stringArg(args.content)} />
      );
      break;
    case "read":
      body = text !== undefined && <Output text={text} />;
      break;
    default: {
      const input = JSON.stringify(args, null, 2);
      body = (
        <>
          {input !== "{}" && <pre className={styles.input}>{input}</pre>}
          {text && <Output text={text} follow={live} />}
        </>
      );
    }
  }
  return (
    <div className={styles.body}>
      {body}
      {images?.map((image, index) => (
        <img
          key={index}
          className={styles.image}
          alt=""
          src={`data:${image.mimeType};base64,${image.data}`}
        />
      ))}
    </div>
  );
}

/** Scrollable tool output. With `follow`, stays scrolled to the end as output arrives. */
function Output({ text, follow = false }: { text: string; follow?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [text, follow]);
  return (
    <pre ref={ref} className={styles.output}>
      {text}
    </pre>
  );
}

/** Pi's display diff: one line per row, prefixed with +, - or a space, then the line number. */
function Diff({ text }: { text: string }) {
  return (
    <div className={cx(styles.output, styles.diff)}>
      {text.split("\n").map((line, index) => (
        <div
          key={index}
          className={
            line.startsWith("+")
              ? styles.diffAdd
              : line.startsWith("-")
                ? styles.diffDel
                : undefined
          }
        >
          {line || " "}
        </div>
      ))}
    </div>
  );
}

const SUMMARY_KEYS = [
  "command",
  "path",
  "file_path",
  "pattern",
  "url",
  "query",
];

function summarizeArguments(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  for (const key of SUMMARY_KEYS) {
    const value = args[key];
    if (typeof value === "string") return value.split("\n")[0];
  }
  const json = JSON.stringify(args);
  return json === "{}" ? "" : json;
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function resultText(content: (TextContent | ImageContent)[]): string {
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}
