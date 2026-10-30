import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { LuSquare } from "react-icons/lu";

interface ComposerProps {
  onSend: (text: string) => Promise<void>;
  /** While Pi is running, sending steers the run and a stop button is shown. */
  running?: boolean;
  /** Stops the run. Resolves to unsent messages, which are put back into the input. */
  onStop?: () => Promise<string[]>;
  /** When set, typing still works but sending doesn't, and this is shown as the placeholder. */
  blockedReason?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** Shown below the input, e.g. the model picker. */
  children?: ReactNode;
}

const MAX_HEIGHT_PX = 240;
// On touch devices Enter inserts a newline, the button sends, and the keyboard isn't opened unasked.
const isTouch = () => window.matchMedia("(pointer: coarse)").matches;

export function Composer({
  onSend,
  running = false,
  onStop,
  blockedReason,
  placeholder = "Message Pi",
  autoFocus,
  children,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const canSend = text.trim().length > 0 && !blockedReason && !sending;
  const canStop = running && onStop !== undefined;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await onSend(text);
      setText("");
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
    <form className="composer" onSubmit={(event) => void submit(event)}>
      {error && <div className="composer-error">{error}</div>}
      <div className="composer-box">
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
        />
        {canStop && (
          <button
            type="button"
            className="stop"
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
          className="send"
          disabled={!canSend}
          aria-label={running ? "Steer" : "Send"}
        >
          ↑
        </button>
      </div>
      {children && <div className="composer-bar">{children}</div>}
    </form>
  );
}
