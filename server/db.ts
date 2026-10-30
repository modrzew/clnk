import { Database } from "bun:sqlite";
import type { ModelRef } from "../shared/protocol";

/** Until there is a login flow, every request acts as this user. */
export const DEFAULT_USER_ID = "default";

export interface ChatRow {
  id: string;
  userId: string;
  title: string;
  model: ModelRef;
  /** Pi JSONL transcript, relative to the data dir. Null until the chat's Pi session is first opened. */
  sessionFile: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RawChatRow {
  id: string;
  user_id: string;
  title: string;
  model_provider: string;
  model_id: string;
  session_file: string | null;
  created_at: number;
  updated_at: number;
}

const MIGRATIONS = [
  `CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    model_provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    session_file TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX chats_user_updated ON chats (user_id, updated_at DESC);`,
];

export class Db {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
    this.db
      .query(
        "INSERT OR IGNORE INTO users (id, name, created_at) VALUES (?, ?, ?)",
      )
      .run(DEFAULT_USER_ID, "Default user", Date.now());
  }

  private migrate() {
    const { user_version } = this.db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    for (let version = user_version; version < MIGRATIONS.length; version++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      })();
    }
  }

  listChats(userId: string): ChatRow[] {
    const rows = this.db
      .query("SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC")
      .all(userId) as RawChatRow[];
    return rows.map(toChatRow);
  }

  getChat(userId: string, chatId: string): ChatRow | null {
    const row = this.db
      .query("SELECT * FROM chats WHERE id = ? AND user_id = ?")
      .get(chatId, userId) as RawChatRow | null;
    return row ? toChatRow(row) : null;
  }

  getChatById(chatId: string): ChatRow | null {
    const row = this.db
      .query("SELECT * FROM chats WHERE id = ?")
      .get(chatId) as RawChatRow | null;
    return row ? toChatRow(row) : null;
  }

  insertChat(chat: ChatRow) {
    this.db
      .query(
        `INSERT INTO chats (id, user_id, title, model_provider, model_id, session_file, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chat.id,
        chat.userId,
        chat.title,
        chat.model.provider,
        chat.model.id,
        chat.sessionFile,
        chat.createdAt,
        chat.updatedAt,
      );
  }

  setTitle(chatId: string, title: string) {
    this.db.query("UPDATE chats SET title = ? WHERE id = ?").run(title, chatId);
  }

  setSessionFile(chatId: string, sessionFile: string) {
    this.db
      .query("UPDATE chats SET session_file = ? WHERE id = ?")
      .run(sessionFile, chatId);
  }

  touchChat(chatId: string, updatedAt = Date.now()) {
    this.db
      .query("UPDATE chats SET updated_at = ? WHERE id = ?")
      .run(updatedAt, chatId);
  }

  deleteChat(chatId: string) {
    this.db.query("DELETE FROM chats WHERE id = ?").run(chatId);
  }

  close() {
    this.db.close();
  }
}

function toChatRow(row: RawChatRow): ChatRow {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    model: { provider: row.model_provider, id: row.model_id },
    sessionFile: row.session_file,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
