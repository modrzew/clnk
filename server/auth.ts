import { createHash, randomBytes, randomUUID } from "node:crypto";
import { HttpError } from "./chats";
import type { Db, UserRow } from "./db";

const NAME_LENGTH = 40;

/** A logged-in client. */
export interface Session {
  user: UserRow;
  /** SHA-256 of the token. Only hashes are stored, so a copy of the database can't be used to log in. */
  tokenHash: string;
}

/**
 * Accounts and their sessions. Logging in with name and password gets a random token, which clients
 * send with every request. Sessions last until the client logs out or the password changes.
 */
export class AuthService {
  constructor(private db: Db) {}

  async createUser(name: string, password: string): Promise<UserRow> {
    const trimmed = userName(name);
    const existing = this.db.getUserByName(trimmed);
    if (existing)
      throw new HttpError(
        409,
        `There already is a user named ${existing.name}`,
      );
    const user: UserRow = {
      id: randomUUID(),
      name: trimmed,
      passwordHash: await hashPassword(password),
      createdAt: Date.now(),
    };
    this.db.insertUser(user);
    return user;
  }

  /** Sets a new password and logs the user out everywhere, except in the session given. */
  async setPassword(
    userId: string,
    password: string,
    except: Session | null = null,
  ) {
    this.db.setPasswordHash(userId, await hashPassword(password));
    this.db.deleteSessions(userId, except?.tokenHash ?? null);
  }

  async login(
    name: string,
    password: string,
  ): Promise<{ token: string; user: UserRow }> {
    const user = this.db.getUserByName(name.trim());
    if (
      !user?.passwordHash ||
      !(await Bun.password.verify(password, user.passwordHash))
    ) {
      const noAccounts = !this.db.listUsers().some((u) => u.passwordHash);
      throw new HttpError(
        401,
        noAccounts
          ? "There are no accounts yet. Create one on the server with `bun users add <name>`."
          : "Wrong name or password",
      );
    }
    const token = randomBytes(32).toString("base64url");
    this.db.insertSession(hashToken(token), user.id);
    return { token, user };
  }

  /** The session a token belongs to, or null if it isn't valid (anymore). */
  authenticate(token: string): Session | null {
    const tokenHash = hashToken(token);
    const user = this.db.getSessionUser(tokenHash);
    return user ? { user, tokenHash } : null;
  }

  logout(session: Session) {
    this.db.deleteSession(session.tokenHash);
  }

  /** Changes the password of the session's user, who stays logged in only in this session. */
  async changePassword(session: Session, current: string, password: string) {
    const { passwordHash } = session.user;
    if (!passwordHash || !(await Bun.password.verify(current, passwordHash)))
      throw new HttpError(403, "The current password is wrong");
    await this.setPassword(session.user.id, password, session);
  }
}

function userName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new HttpError(400, "The name is empty");
  if (trimmed.length > NAME_LENGTH)
    throw new HttpError(
      400,
      `Names can be at most ${NAME_LENGTH} characters long`,
    );
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed))
    throw new HttpError(400, "Names can't contain control characters");
  return trimmed;
}

function hashPassword(password: string): Promise<string> {
  if (!password) throw new HttpError(400, "The password is empty");
  return Bun.password.hash(password);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
