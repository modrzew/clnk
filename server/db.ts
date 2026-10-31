import { Database } from "bun:sqlite";
import type { ContextUsage, ModelRef } from "../shared/protocol";

export interface UserRow {
  id: string;
  /** What the user logs in with. Unique, ignoring case. */
  name: string;
  /** Null for users from before there were passwords, who can't log in. */
  passwordHash: string | null;
  createdAt: number;
}

interface RawUserRow {
  id: string;
  name: string;
  password_hash: string | null;
  created_at: number;
}

export interface ChatRow {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  model: ModelRef;
  /** Pi JSONL transcript, relative to the data dir. Null until the chat's Pi session is first opened. */
  sessionFile: string | null;
  archivedAt: number | null;
  context: ContextUsage | null;
  createdAt: number;
  updatedAt: number;
}

interface RawChatRow {
  id: string;
  user_id: string;
  project_id: string | null;
  title: string;
  model_provider: string;
  model_id: string;
  session_file: string | null;
  archived_at: number | null;
  context_tokens: number | null;
  /** Null when the context usage is unknown altogether. */
  context_window: number | null;
  created_at: number;
  updated_at: number;
}

export interface ProjectRow {
  id: string;
  userId: string;
  name: string;
  instructions: string;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface RawProjectRow {
  id: string;
  user_id: string;
  name: string;
  instructions: string;
  archived_at: number | null;
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
  `ALTER TABLE chats ADD COLUMN archived_at INTEGER;
  ALTER TABLE chats ADD COLUMN context_tokens INTEGER;
  ALTER TABLE chats ADD COLUMN context_window INTEGER;`,
  `CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    instructions TEXT NOT NULL,
    archived_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX projects_user ON projects (user_id);
  ALTER TABLE chats ADD COLUMN project_id TEXT REFERENCES projects(id);`,
  `ALTER TABLE users ADD COLUMN password_hash TEXT;
  CREATE UNIQUE INDEX users_name ON users (name COLLATE NOCASE);
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions (user_id);`,
];

export class Db {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
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

  listUsers(): UserRow[] {
    const rows = this.db
      .query("SELECT * FROM users ORDER BY created_at")
      .all() as RawUserRow[];
    return rows.map(toUserRow);
  }

  getUserByName(name: string): UserRow | null {
    const row = this.db
      .query("SELECT * FROM users WHERE name = ? COLLATE NOCASE")
      .get(name) as RawUserRow | null;
    return row ? toUserRow(row) : null;
  }

  insertUser(user: UserRow) {
    this.db
      .query(
        "INSERT INTO users (id, name, password_hash, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(user.id, user.name, user.passwordHash, user.createdAt);
  }

  setPasswordHash(userId: string, passwordHash: string) {
    this.db
      .query("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(passwordHash, userId);
  }

  insertSession(tokenHash: string, userId: string, createdAt = Date.now()) {
    this.db
      .query(
        "INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)",
      )
      .run(tokenHash, userId, createdAt);
  }

  /** The user a session belongs to, or null if there is no such session. */
  getSessionUser(tokenHash: string): UserRow | null {
    const row = this.db
      .query(
        "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ?",
      )
      .get(tokenHash) as RawUserRow | null;
    return row ? toUserRow(row) : null;
  }

  deleteSession(tokenHash: string) {
    this.db.query("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  /** Deletes the user's sessions, except the one given. */
  deleteSessions(userId: string, except: string | null = null) {
    this.db
      .query("DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?")
      .run(userId, except);
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
        `INSERT INTO chats (id, user_id, project_id, title, model_provider, model_id, session_file,
           archived_at, context_tokens, context_window, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chat.id,
        chat.userId,
        chat.projectId,
        chat.title,
        chat.model.provider,
        chat.model.id,
        chat.sessionFile,
        chat.archivedAt,
        chat.context?.tokens ?? null,
        chat.context?.contextWindow ?? null,
        chat.createdAt,
        chat.updatedAt,
      );
  }

  setTitle(chatId: string, title: string) {
    this.db.query("UPDATE chats SET title = ? WHERE id = ?").run(title, chatId);
  }

  setModel(chatId: string, model: ModelRef) {
    this.db
      .query("UPDATE chats SET model_provider = ?, model_id = ? WHERE id = ?")
      .run(model.provider, model.id, chatId);
  }

  setArchived(chatId: string, archivedAt: number | null) {
    this.db
      .query("UPDATE chats SET archived_at = ? WHERE id = ?")
      .run(archivedAt, chatId);
  }

  setContext(chatId: string, context: ContextUsage | null) {
    this.db
      .query(
        "UPDATE chats SET context_tokens = ?, context_window = ? WHERE id = ?",
      )
      .run(context?.tokens ?? null, context?.contextWindow ?? null, chatId);
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

  listProjects(userId: string): ProjectRow[] {
    const rows = this.db
      .query("SELECT * FROM projects WHERE user_id = ?")
      .all(userId) as RawProjectRow[];
    return rows.map(toProjectRow);
  }

  getProject(userId: string, projectId: string): ProjectRow | null {
    const row = this.db
      .query("SELECT * FROM projects WHERE id = ? AND user_id = ?")
      .get(projectId, userId) as RawProjectRow | null;
    return row ? toProjectRow(row) : null;
  }

  getProjectById(projectId: string): ProjectRow | null {
    const row = this.db
      .query("SELECT * FROM projects WHERE id = ?")
      .get(projectId) as RawProjectRow | null;
    return row ? toProjectRow(row) : null;
  }

  insertProject(project: ProjectRow) {
    this.db
      .query(
        `INSERT INTO projects (id, user_id, name, instructions, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.userId,
        project.name,
        project.instructions,
        project.archivedAt,
        project.createdAt,
        project.updatedAt,
      );
  }

  /** Writes the project's mutable fields. */
  updateProject(project: ProjectRow) {
    this.db
      .query(
        "UPDATE projects SET name = ?, instructions = ?, archived_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        project.name,
        project.instructions,
        project.archivedAt,
        project.updatedAt,
        project.id,
      );
  }

  close() {
    this.db.close();
  }
}

function toUserRow(row: RawUserRow): UserRow {
  return {
    id: row.id,
    name: row.name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

function toChatRow(row: RawChatRow): ChatRow {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    title: row.title,
    model: { provider: row.model_provider, id: row.model_id },
    sessionFile: row.session_file,
    archivedAt: row.archived_at,
    context:
      row.context_window === null
        ? null
        : { tokens: row.context_tokens, contextWindow: row.context_window },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProjectRow(row: RawProjectRow): ProjectRow {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    instructions: row.instructions,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
