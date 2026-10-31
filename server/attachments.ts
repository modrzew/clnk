import { lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
  Attachment,
  ImageContent,
  TextContent,
  UserMessage,
} from "../shared/protocol";
import { imageType, isFile } from "./files";

/*
 * Files attached to a message are saved in the chat folder, and listed at the end of the message's
 * text, in a block Pi reads and the server takes out again for clients. The transcript is the only
 * record of them. Images Pi can read are also sent as images, so the model sees them.
 */

/** Where a chat's folder keeps the files attached to its messages. */
export const ATTACHMENTS_DIR = "attachments";

const NAME_BYTES = 255;
/** Leaves room in a file name for a " (n)" to tell it apart from one with the same name. */
const SUFFIX_BYTES = 12;
const NOTE_START = "<attachments>";
const NOTE_END = "</attachments>";
/**
 * A message's attachment block, with Pi's notes about its images after it, e.g. that it shrank one.
 * Both are left out of what clients see.
 */
const NOTE = new RegExp(
  `(?:^|\\n\\n)(${NOTE_START}\\n(?:<file [^\\n]*/>\\n)*${NOTE_END})(?:\\n\\n\\[Image[^\\n]*\\](?:\\n\\[Image[^\\n]*\\])*)?$`,
);

export interface SavedAttachments {
  attachments: Attachment[];
  /** The attachments Pi can read as images, to send along with the message. */
  images: ImageContent[];
}

/** Saves uploaded files in a chat folder. Files are renamed where the name is taken. */
export async function saveAttachments(
  cwd: string,
  files: File[],
): Promise<SavedAttachments> {
  const saved: SavedAttachments = { attachments: [], images: [] };
  if (!files.length) return saved;
  const dir = attachmentsDir(cwd);
  try {
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const name = await writeNew(dir, safeName(file.name), bytes);
      const image = imageType(bytes);
      saved.attachments.push({
        name,
        mimeType: image ?? (file.type || "application/octet-stream"),
        size: bytes.length,
        inline: image !== null,
      });
      if (image)
        saved.images.push({
          type: "image",
          mimeType: image,
          data: Buffer.from(bytes).toString("base64"),
        });
    }
  } catch (error) {
    removeAttachments(cwd, saved.attachments);
    throw error;
  }
  return saved;
}

/** Deletes saved attachments, e.g. when the message they came with was refused. */
export function removeAttachments(cwd: string, attachments: Attachment[]) {
  for (const { name } of attachments)
    rmSync(join(cwd, ATTACHMENTS_DIR, name), { force: true });
}

/** Path of an attached file to download, or null if it's gone, e.g. with a pruned chat folder. */
export function attachmentPath(cwd: string, name: string): string | null {
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name))
    return null;
  const dir = join(cwd, ATTACHMENTS_DIR);
  try {
    // Not if Pi put a symlink in its place.
    if (!lstatSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const path = join(dir, name);
  return isFile(path) ? path : null;
}

/** The text Pi gets for a message: the user's, then the list of attached files, if there are any. */
export function withAttachments(
  text: string,
  attachments: Attachment[],
): string {
  if (!attachments.length) return text;
  const files = attachments.map(
    ({ name, mimeType, size, inline }) =>
      `<file path="${escape(`${ATTACHMENTS_DIR}/${name}`)}" type="${escape(mimeType)}" size="${size}"${inline ? ' inline="true"' : ""} />`,
  );
  return withNote(text, [NOTE_START, ...files, NOTE_END].join("\n"));
}

/** Adds an attachment block, as `splitUserText` returns it, back to a message's text. */
export function withNote(text: string, note: string | null): string {
  if (!note) return text;
  return text.trim() ? `${text}\n\n${note}` : note;
}

/** Splits the text Pi got for a message into what the user wrote and the attachment block. */
export function splitUserText(text: string): {
  text: string;
  note: string | null;
  attachments: Attachment[];
} {
  const match = NOTE.exec(text);
  if (!match) return { text, note: null, attachments: [] };
  const note = match[1];
  const attachments = note
    .split("\n")
    .slice(1, -1)
    .flatMap((line) => {
      const attrs = Object.fromEntries(
        [...line.matchAll(/ (\w+)="([^"]*)"/g)].map(([, key, value]) => [
          key,
          unescape(value),
        ]),
      );
      const prefix = `${ATTACHMENTS_DIR}/`;
      if (!attrs.path?.startsWith(prefix)) return [];
      return [
        {
          name: attrs.path.slice(prefix.length),
          mimeType: attrs.type ?? "application/octet-stream",
          size: Number(attrs.size) || 0,
          inline: attrs.inline === "true",
        },
      ];
    });
  return { text: text.slice(0, match.index), note, attachments };
}

/** A user message as clients see it: with its attachments listed apart from its text. */
export function toUserMessage(message: UserMessage): UserMessage {
  const content: (TextContent | ImageContent)[] =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  const index = content.findIndex((part) => part.type === "text");
  if (index < 0) return message;
  const { text, note, attachments } = splitUserText(
    (content[index] as TextContent).text,
  );
  if (!note) return message;
  const images = content.filter((part) => part.type === "image").length;
  const inline = attachments.filter((attachment) => attachment.inline).length;
  return {
    ...message,
    content: content.with(index, { type: "text", text }),
    // Pi leaves out images it can't read. Then it's not clear which are in the message, so all are files.
    attachments:
      images < inline
        ? attachments.map((attachment) => ({ ...attachment, inline: false }))
        : attachments,
  };
}

/** How a message waiting for Pi to read it is shown: its text, or the names of its files. */
export function queuedText(text: string): string {
  const split = splitUserText(text);
  return split.text.trim() || split.attachments.map((a) => a.name).join(", ");
}

/** The chat folder's attachment folder. Whatever Pi put in its place is moved aside. */
function attachmentsDir(cwd: string): string {
  const dir = join(cwd, ATTACHMENTS_DIR);
  mkdirSync(cwd, { recursive: true });
  try {
    if (lstatSync(dir).isDirectory()) return dir;
    renameSync(dir, `${dir}-${Date.now()}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dir);
  return dir;
}

/** Writes a file that doesn't exist yet, numbering the name until it's free. Returns the name used. */
async function writeNew(
  dir: string,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`;
    try {
      // Exclusive: never replaces a file, and never writes through a symlink Pi left there.
      await writeFile(join(dir, candidate), bytes, { flag: "wx" });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** A name for an uploaded file that stays inside the attachment folder. */
function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = name.replace(/[/\\\x00-\x1f\x7f]/g, "_").trim();
  if (!safe || safe === "." || safe === "..") return "file";
  const max = NAME_BYTES - SUFFIX_BYTES;
  if (Buffer.byteLength(safe) <= max) return safe;
  const ext = extname(safe);
  return Buffer.byteLength(ext) <= SUFFIX_BYTES
    ? truncate(safe.slice(0, safe.length - ext.length), max - ext.length) + ext
    : truncate(safe, max);
}

function truncate(text: string, maxBytes: number): string {
  let result = "";
  for (const char of text) {
    if (Buffer.byteLength(result + char) > maxBytes) break;
    result += char;
  }
  return result;
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function unescape(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
