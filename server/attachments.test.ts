import { describe, expect, test } from "bun:test";
import type { Attachment } from "../shared/protocol";
import { splitUserText, toUserMessage, withAttachments } from "./attachments";

const files: Attachment[] = [
  { name: 'a "b" <&>.png', mimeType: "image/png", size: 10, inline: true },
  { name: "c (1).pdf", mimeType: "application/pdf", size: 20, inline: false },
];

describe("attachment notes", () => {
  test("round-trip file names, whatever they contain", () => {
    const text = withAttachments("Look\n\nat these", files);
    expect(splitUserText(text)).toEqual({
      text: "Look\n\nat these",
      note: expect.stringMatching(/^<attachments>\n/),
      attachments: files,
    });
    expect(splitUserText(withAttachments("  ", files)).text).toBe("");
    expect(withAttachments("Hi", [])).toBe("Hi");
  });

  test("leave out Pi's notes about the images, but not text that only looks like them", () => {
    const text = `${withAttachments("Hi", files)}\n\n[Image: original 4000x3000, displayed at 2000x1500.]`;
    expect(splitUserText(text).text).toBe("Hi");
    const typed = `${withAttachments("Hi", files)}\n\nand more`;
    expect(splitUserText(typed)).toEqual({
      text: typed,
      note: null,
      attachments: [],
    });
  });

  test("lists inline images as files when Pi left them out", () => {
    const message = toUserMessage({
      role: "user",
      content: [{ type: "text", text: withAttachments("Hi", files) }],
      timestamp: 1,
    });
    expect(message.content).toEqual([{ type: "text", text: "Hi" }]);
    expect(message.attachments?.map((a) => a.inline)).toEqual([false, false]);
  });
});
