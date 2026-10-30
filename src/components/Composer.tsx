import {
  type FormEvent,
  type KeyboardEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

interface ComposerProps {
  onSend: (text: string) => Promise<void>;
  /** When set, typing still works but sending doesn't, and this is shown as the placeholder. */
  blockedReason?: string;
  placeholder?: string;
  autoFocus?: boolean;
}

const MAX_HEIGHT_PX = 240;
// On touch devices Enter inserts a newline, the button sends, and the keyboard isn't opened unasked.
const isTouch = () => window.matchMedia("(pointer: coarse)").matches;

export function Composer({
  onSend,
  blockedReason,
  placeholder = "Message Pi",
  autoFocus,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const canSend = text.trim().length > 0 && !blockedReason && !sending;

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

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !isTouch()
    ) {
      event.preventDefault();
      void submit();
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
          placeholder={blockedReason ?? placeholder}
          autoFocus={autoFocus && !isTouch()}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          className="send"
          disabled={!canSend}
          aria-label="Send"
        >
          ↑
        </button>
      </div>
    </form>
  );
}
