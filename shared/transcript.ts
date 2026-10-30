import type { AssistantContent, AssistantMessage, ChatMessage, ServerMessage } from "./protocol";

/** What a client knows about one chat's transcript. */
export interface TranscriptState {
  /** False until the first snapshot arrives. */
  loaded: boolean;
  messages: ChatMessage[];
  /** The assistant message currently being streamed, if any. */
  streaming: AssistantMessage | null;
  /** Last run failure that has no assistant message to show it in. */
  error: string | null;
}

export const emptyTranscript: TranscriptState = { loaded: false, messages: [], streaming: null, error: null };

/** Applies a server message that belongs to this chat. Callers filter by chat id. */
export function applyServerMessage(state: TranscriptState, msg: ServerMessage): TranscriptState {
  switch (msg.type) {
    case "snapshot":
      return { loaded: true, messages: msg.messages, streaming: msg.streaming, error: null };
    case "message": {
      const isAssistant = msg.message.role === "assistant";
      return {
        ...state,
        messages: [...state.messages, msg.message],
        streaming: isAssistant ? null : state.streaming,
        error: msg.message.role === "user" ? null : state.error,
      };
    }
    case "stream_start":
      return { ...state, streaming: msg.message };
    case "stream_block":
      return updateBlock(state, msg.index, () => msg.block);
    case "stream_delta":
      return updateBlock(state, msg.index, (block) => {
        if (block?.type === "text") return { ...block, text: block.text + msg.delta };
        if (block?.type === "thinking") return { ...block, thinking: block.thinking + msg.delta };
        return block;
      });
    case "run_error":
      return { ...state, streaming: null, error: msg.error };
    default:
      return state;
  }
}

function updateBlock(
  state: TranscriptState,
  index: number,
  update: (block: AssistantContent | undefined) => AssistantContent | undefined,
): TranscriptState {
  if (!state.streaming) return state;
  const block = update(state.streaming.content[index]);
  if (!block) return state;
  const content = [...state.streaming.content];
  content[index] = block;
  return { ...state, streaming: { ...state.streaming, content } };
}
