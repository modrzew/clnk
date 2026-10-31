import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { LuFile, LuPaperclip, LuSquare, LuX } from "react-icons/lu";
import { MAX_REQUEST_BYTES } from "../../shared/protocol";
import { cx } from "../lib/cx";
import { formatSize } from "../lib/format";
import styles from "./Composer.module.css";
import { Spinner } from "./Spinner";
import ui from "./ui.module.css";

interface ComposerProps {
  /** Sends the text, which may be empty if files are attached. */
  onSend: (text: string, files: File[]) => Promise<void>;
  /** While Pi is running, sending steers the run and a stop button is shown. */
  running?: boolean;
  /** Stops the run. Resolves to unsent messages, which are put back into the input. */
  onStop?: () => Promise<string[]>;
  /** When set, typing still works but sending doesn't, and this is shown as the placeholder. */
  blockedReason?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** False if the model can't see images, to say so when one is attached. */
  seesImages?: boolean;
  /** Shown below the input, e.g. the model picker. */
  children?: ReactNode;
}

interface PendingFile {
  id: number;
  file: File;
}

const MAX_HEIGHT_PX = 240;
/** What attachments can add up to, leaving room in the request for the rest. */
const MAX_FILES_BYTES = MAX_REQUEST_BYTES - 1024 ** 2;
let nextFileId = 0;
// On touch devices Enter inserts a newline, the button sends, and the keyboard isn't opened unasked.
const isTouch = () => window.matchMedia("(pointer: coarse)").matches;

export function Composer({
  onSend,
  running = false,
  onStop,
  blockedReason,
  placeholder = "Message Pi",
  autoFocus,
  seesImages,
  children,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const canSend =
    (text.trim().length > 0 || files.length > 0) && !blockedReason && !sending;
  const canStop = running && onStop !== undefined;

  function attach(added: File[]) {
    if (!added.length) return;
    const total = [...files.map((pending) => pending.file), ...added].reduce(
      (sum, file) => sum + file.size,
      0,
    );
    if (total > MAX_FILES_BYTES)
      return setError(
        `Attachments can add up to ${formatSize(MAX_FILES_BYTES)} per message.`,
      );
    setError(null);
    setFiles((current) => [
      ...current,
      ...added.map((file) => ({ id: nextFileId++, file })),
    ]);
  }

  const detach = useCallback(
    (id: number) =>
      setFiles((current) => current.filter((pending) => pending.id !== id)),
    [],
  );

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = Array.from(event.clipboardData.files);
    // Office apps put a picture of what was copied next to its text. The text is what's meant.
    if (!pasted.length || event.clipboardData.types.includes("text/plain"))
      return;
    event.preventDefault();
    attach(pasted);
  }

  const dropProps = {
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
        setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      setDragging(false);
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      attach(Array.from(event.dataTransfer.files));
    },
  };

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await onSend(
        text,
        files.map((pending) => pending.file),
      );
      setText("");
      setFiles([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (!onStop || stopping) return;
    setStopping(true);
    setError(null);
    try {
      const unsent = await onStop();
      if (unsent.length)
        setText((current) =>
          [...unsent, current].filter((part) => part.trim()).join("\n\n"),
        );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !isTouch()
    ) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape" && canStop) {
      event.preventDefault();
      void stop();
    }
  }

  return (
    <form
      className={styles.composer}
      onSubmit={(event) => void submit(event)}
      {...dropProps}
    >
      {error && <div className={ui.errorText}>{error}</div>}
      {seesImages === false &&
        files.some((pending) => isImage(pending.file)) && (
          <div className={styles.hint}>
            This model can't see images. Pi only gets them as files.
          </div>
        )}
      <div className={cx(styles.box, dragging && styles.dragging)}>
        {files.length > 0 && (
          <ul className={styles.files} aria-label="Attachments">
            {files.map((pending) => (
              <Pending
                key={pending.id}
                id={pending.id}
                file={pending.file}
                onRemove={detach}
              />
            ))}
          </ul>
        )}
        <div className={styles.row}>
          <button
            type="button"
            className={styles.attach}
            aria-label="Attach files"
            title="Attach files"
            onClick={() => fileInputRef.current?.click()}
          >
            <LuPaperclip size={18} aria-hidden />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              attach(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <textarea
            ref={inputRef}
            value={text}
            rows={1}
            placeholder={
              blockedReason ??
              (running
                ? "Steer Pi: it reads this after its current step"
                : placeholder)
            }
            autoFocus={autoFocus && !isTouch()}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {canStop && (
            <button
              type="button"
              className={styles.stop}
              disabled={stopping}
              aria-label="Stop"
              title="Stop (Esc)"
              onClick={() => void stop()}
            >
              <LuSquare size={12} fill="currentColor" aria-hidden />
            </button>
          )}
          <button
            type="submit"
            className={styles.send}
            disabled={!canSend}
            aria-label={running ? "Steer" : "Send"}
          >
            {sending && files.length > 0 ? <Spinner label="Uploading" /> : "↑"}
          </button>
        </div>
      </div>
      {children && <div className={styles.bar}>{children}</div>}
    </form>
  );
}

/** A file waiting to be sent: a preview of images, the name and size of others. */
const Pending = memo(function Pending({
  id,
  file,
  onRemove,
}: {
  id: number;
  file: File;
  onRemove: (id: number) => void;
}) {
  // Not every image type shows in every browser, e.g. HEIC photos.
  const [broken, setBroken] = useState(false);
  const preview = isImage(file) && !broken;
  const previewRef = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img) return;
      const url = URL.createObjectURL(file);
      img.src = url;
      return () => URL.revokeObjectURL(url);
    },
    [file],
  );
  return (
    <li
      className={cx(styles.file, preview && styles.image)}
      title={`${file.name} (${formatSize(file.size)})`}
    >
      {preview ? (
        <img ref={previewRef} alt={file.name} onError={() => setBroken(true)} />
      ) : (
        <>
          <LuFile size={16} className={styles.fileIcon} aria-hidden />
          <span className={styles.fileName}>{file.name}</span>
          <span className={styles.fileSize}>{formatSize(file.size)}</span>
        </>
      )}
      <button
        type="button"
        className={styles.remove}
        aria-label={`Remove ${file.name}`}
        title="Remove"
        onClick={() => onRemove(id)}
      >
        <LuX size={12} aria-hidden />
      </button>
    </li>
  );
});

const isImage = (file: File) => file.type.startsWith("image/");
