import { expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantContent, ServerMessage } from "../shared/protocol";
import { applyServerMessage, emptyTranscript } from "../shared/transcript";
import { streamMessage, toolOutputMessage } from "./stream";

/** Pi's partial message after the provider has parsed further than the event being delivered. */
function partial(...content: AssistantContent[]) {
  return {
    role: "assistant",
    content,
    api: "x",
    provider: "p",
    model: "m",
    usage: {},
    stopReason: "pending",
    timestamp: 1,
  };
}

const ahead = partial(
  { type: "thinking", thinking: "\nThe user wants" },
  { type: "text", text: "Hi there" },
  { type: "toolCall", id: "t1", name: "bash", arguments: { command: "l" } },
);

function update(
  assistantMessageEvent: Record<string, unknown>,
): AgentSessionEvent {
  return {
    type: "message_update",
    message: ahead,
    assistantMessageEvent: { partial: ahead, ...assistantMessageEvent },
  } as never;
}

test("streams from events only, even when Pi's partial message is ahead of them", () => {
  const events: AgentSessionEvent[] = [
    { type: "message_start", message: ahead } as never,
    update({ type: "thinking_start", contentIndex: 0 }),
    update({ type: "thinking_delta", contentIndex: 0, delta: "\nThe" }),
    update({ type: "thinking_delta", contentIndex: 0, delta: " user wants" }),
    update({
      type: "thinking_end",
      contentIndex: 0,
      content: "\nThe user wants",
    }),
    update({ type: "text_start", contentIndex: 1 }),
    update({ type: "text_delta", contentIndex: 1, delta: "Hi" }),
  ];
  const later: AgentSessionEvent[] = [
    update({ type: "text_delta", contentIndex: 1, delta: " there" }),
    update({ type: "text_end", contentIndex: 1, content: "Hi there" }),
    update({ type: "toolcall_start", contentIndex: 2 }),
    update({ type: "toolcall_delta", contentIndex: 2, delta: '{"command":"l' }),
    update({
      type: "toolcall_end",
      contentIndex: 2,
      toolCall: {
        type: "toolCall",
        id: "t1",
        name: "bash",
        arguments: { command: "ls" },
      },
    }),
  ];
  const messages = (list: AgentSessionEvent[]) =>
    list
      .map((event) => streamMessage("c1", event))
      .filter((msg): msg is ServerMessage => msg !== null);

  const midway = messages(events).reduce(applyServerMessage, emptyTranscript);
  expect(midway.streaming?.content).toEqual([
    { type: "thinking", thinking: "\nThe user wants" },
    { type: "text", text: "Hi" },
  ]);

  const done = messages(later).reduce(applyServerMessage, midway);
  expect(done.streaming?.content).toEqual([
    { type: "thinking", thinking: "\nThe user wants" },
    { type: "text", text: "Hi there" },
    { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
  ]);
});

test("ignores events that aren't part of a streaming assistant message", () => {
  expect(
    streamMessage("c1", {
      type: "message_start",
      message: { role: "user", content: "hi", timestamp: 1 },
    } as never),
  ).toBeNull();
  expect(streamMessage("c1", { type: "agent_start" } as never)).toBeNull();
});

test("sends only the new part of a running tool's output", () => {
  const update = (text: string, parentToolCallId?: string) =>
    ({
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
      partialResult: { content: [{ type: "text", text }] },
      parentToolCallId,
    }) as never;

  expect(toolOutputMessage("c1", update("one\n"))).toEqual({
    type: "tool_output",
    chatId: "c1",
    toolCallId: "t1",
    text: "one\n",
    append: true,
  });
  expect(toolOutputMessage("c1", update("one\ntwo\n"), "one\n")).toMatchObject({
    text: "two\n",
    append: true,
  });
  // Truncated output no longer extends what was sent, so it replaces it.
  expect(toolOutputMessage("c1", update("two\n"), "one\ntwo\n")).toMatchObject({
    text: "two\n",
    append: false,
  });
  expect(toolOutputMessage("c1", update("two\n"), "two\n")).toBeNull();
  expect(toolOutputMessage("c1", update("nested", "t0"))).toBeNull();
});
