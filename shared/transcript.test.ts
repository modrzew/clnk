import { describe, expect, test } from "bun:test";
import type { AssistantMessage, ChatSummary, ServerMessage } from "./protocol";
import {
  applyServerMessage,
  emptyTranscript,
  type TranscriptState,
} from "./transcript";

const chat: ChatSummary = {
  id: "c1",
  title: "Hi",
  model: { provider: "p", id: "m" },
  status: "running",
  createdAt: 0,
  updatedAt: 0,
};

const partial: AssistantMessage = {
  role: "assistant",
  content: [],
  provider: "p",
  model: "m",
  stopReason: "pending",
  timestamp: 1,
};

function apply(...messages: ServerMessage[]): TranscriptState {
  return messages.reduce(applyServerMessage, emptyTranscript);
}

describe("applyServerMessage", () => {
  test("a snapshot replaces the transcript", () => {
    const before = apply({ type: "run_error", chatId: "c1", error: "boom" });
    const state = applyServerMessage(before, {
      type: "snapshot",
      chat,
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
      streaming: null,
    });
    expect(state).toEqual({
      loaded: true,
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
      streaming: null,
      error: null,
    });
  });

  test("builds the streaming message from blocks and deltas", () => {
    const state = apply(
      { type: "snapshot", chat, messages: [], streaming: null },
      { type: "stream_start", chatId: "c1", message: partial },
      {
        type: "stream_block",
        chatId: "c1",
        index: 0,
        block: { type: "thinking", thinking: "" },
      },
      { type: "stream_delta", chatId: "c1", index: 0, delta: "Hmm, " },
      { type: "stream_delta", chatId: "c1", index: 0, delta: "ok." },
      {
        type: "stream_block",
        chatId: "c1",
        index: 1,
        block: { type: "text", text: "" },
      },
      { type: "stream_delta", chatId: "c1", index: 1, delta: "Hello" },
      {
        type: "stream_block",
        chatId: "c1",
        index: 2,
        block: { type: "toolCall", id: "t1", name: "bash", arguments: {} },
      },
      {
        type: "stream_block",
        chatId: "c1",
        index: 2,
        block: {
          type: "toolCall",
          id: "t1",
          name: "bash",
          arguments: { command: "ls" },
        },
      },
    );
    expect(state.streaming?.content).toEqual([
      { type: "thinking", thinking: "Hmm, ok." },
      { type: "text", text: "Hello" },
      {
        type: "toolCall",
        id: "t1",
        name: "bash",
        arguments: { command: "ls" },
      },
    ]);
  });

  test("ignores deltas for blocks it doesn't have", () => {
    const state = apply(
      { type: "stream_delta", chatId: "c1", index: 0, delta: "lost" },
      { type: "stream_start", chatId: "c1", message: partial },
      { type: "stream_delta", chatId: "c1", index: 3, delta: "lost" },
    );
    expect(state.streaming?.content).toEqual([]);
  });

  test("a finished assistant message replaces the streaming one", () => {
    const final: AssistantMessage = {
      ...partial,
      content: [{ type: "text", text: "Done" }],
      stopReason: "stop",
    };
    const state = apply(
      { type: "stream_start", chatId: "c1", message: partial },
      { type: "message", chatId: "c1", message: final },
    );
    expect(state.streaming).toBeNull();
    expect(state.messages).toEqual([final]);
  });

  test("tool results keep the streaming message and a new user message clears errors", () => {
    let state = apply(
      { type: "run_error", chatId: "c1", error: "boom" },
      { type: "stream_start", chatId: "c1", message: partial },
      {
        type: "message",
        chatId: "c1",
        message: {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "bash",
          content: [],
          isError: false,
          timestamp: 2,
        },
      },
    );
    expect(state.streaming).not.toBeNull();
    expect(state.error).toBe("boom");
    state = applyServerMessage(state, {
      type: "message",
      chatId: "c1",
      message: { role: "user", content: "again", timestamp: 3 },
    });
    expect(state.error).toBeNull();
  });
});
