import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantContent, ServerMessage } from "../shared/protocol";

/**
 * Converts Pi's streaming events for an assistant message into protocol messages.
 *
 * Pi's `partial` message can be ahead of the event being handled: at text_start the block may already
 * hold text that later arrives as a text_delta. So start events publish empty blocks, deltas carry the
 * text, and only end events (whose block is complete) copy content from Pi.
 */
export function streamMessage(chatId: string, event: AgentSessionEvent): ServerMessage | null {
  if (event.type === "message_start") {
    if (event.message.role !== "assistant") return null;
    return { type: "stream_start", chatId, message: { ...event.message, content: [] } };
  }
  if (event.type !== "message_update") return null;

  const update = event.assistantMessageEvent;
  const block = (index: number, block: AssistantContent): ServerMessage => ({ type: "stream_block", chatId, index, block });
  switch (update.type) {
    case "text_start":
      return block(update.contentIndex, { type: "text", text: "" });
    case "thinking_start":
      return block(update.contentIndex, { type: "thinking", thinking: "" });
    case "toolcall_start": {
      const call = update.partial.content[update.contentIndex];
      if (call?.type !== "toolCall") return null;
      // Arguments stream as JSON and are only shown once complete.
      return block(update.contentIndex, { type: "toolCall", id: call.id, name: call.name, arguments: {} });
    }
    case "text_delta":
    case "thinking_delta":
      return { type: "stream_delta", chatId, index: update.contentIndex, delta: update.delta };
    case "text_end":
      return block(update.contentIndex, { type: "text", text: update.content });
    case "thinking_end": {
      const thinking = update.partial.content[update.contentIndex];
      const redacted = thinking?.type === "thinking" && thinking.redacted ? { redacted: true } : {};
      return block(update.contentIndex, { type: "thinking", thinking: update.content, ...redacted });
    }
    case "toolcall_end":
      return block(update.contentIndex, update.toolCall);
    default:
      return null;
  }
}
