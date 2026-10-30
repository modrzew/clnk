import type { ContextUsage } from "../../shared/protocol";

/** Above this share of the context window, the meter is highlighted. */
const HIGH_PERCENT = 80;

export function ContextMeter({ context }: { context: ContextUsage | null }) {
  if (!context) return null;
  const { tokens, contextWindow } = context;
  const percent =
    tokens === null ? null : Math.round((tokens / contextWindow) * 100);
  const title =
    tokens === null
      ? "Context size is unknown until the next response"
      : `${tokens.toLocaleString()} of ${contextWindow.toLocaleString()} tokens in context (${percent}%)`;
  return (
    <span
      className={`context-meter${percent !== null && percent >= HIGH_PERCENT ? " high" : ""}`}
      title={title}
    >
      {tokens === null ? "?" : formatTokens(tokens)} /{" "}
      {formatTokens(contextWindow)}
    </span>
  );
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  const [value, unit] =
    count < 1_000_000 ? [count / 1000, "k"] : [count / 1_000_000, "M"];
  const digits = value < 10 ? 1 : 0;
  return `${value.toFixed(digits).replace(/\.0$/, "")}${unit}`;
}
