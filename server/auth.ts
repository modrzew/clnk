import { createHash, randomBytes, randomUUID } from "node:crypto";
import { HttpError } from "./chats";
import type { Db, UserRow } from "./db";

const NAME_LENGTH = 40;
/** Failed logins a name gets before it has to wait between attempts. */
const FREE_LOGIN_FAILURES = 5;
/** The first wait. Each failure after that doubles it, up to the maximum. */
const LOGIN_WAIT_MS = 1000;
const MAX_LOGIN_WAIT_MS = 5 * 60_000;
/** How long a name's failures are remembered after the last one. */
const LOGIN_FAILURES_TTL_MS = 60 * 60_000;
/** Checking a password takes a lot of CPU and memory on purpose, and anyone can ask for it. */
const MAX_CONCURRENT_LOGINS = 4;

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
  /** By `loginKey`, oldest first. Names without an account count too, or waiting would give them away. */
  private loginFailures = new Map<string, { count: number; at: number }>();
  private runningLogins = 0;
  /** Checked for names without a password, made when first needed. */
  private decoyHash: Promise<string> | undefined;

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
    const key = loginKey(name);
    this.admitLogin(key);
    this.runningLogins++;
    try {
      const user = this.db.getUserByName(name.trim());
      // Names without an account take as long as wrong passwords, so timing doesn't give them away.
      const hash =
        user?.passwordHash ??
        (await (this.decoyHash ??= Bun.password.hash(randomUUID())));
      const correct = await Bun.password.verify(password, hash);
      if (!user?.passwordHash || !correct) {
        const noAccounts = !this.db.listUsers().some((u) => u.passwordHash);
        throw new HttpError(
          401,
          noAccounts
            ? "There are no accounts yet. Create one on the server with `bun users add <name>`."
            : "Wrong name or password",
        );
      }
      this.loginFailures.delete(key);
      const token = randomBytes(32).toString("base64url");
      this.db.insertSession(hashToken(token), user.id);
      return { token, user };
    } finally {
      this.runningLogins--;
    }
  }

  /**
   * Refuses a login that has to wait, and counts the others as failed until they succeed, so parallel
   * guesses can't all get in before the wait starts. Refused logins don't count, so they can't make it
   * longer.
   */
  private admitLogin(key: string) {
    const now = Date.now();
    for (const [name, { at }] of this.loginFailures) {
      if (now - at < LOGIN_FAILURES_TTL_MS) break;
      this.loginFailures.delete(name);
    }
    const failures = this.loginFailures.get(key);
    const wait = failures ? failures.at + loginWait(failures.count) - now : 0;
    if (wait > 0)
      throw new HttpError(
        429,
        `Too many failed logins. Try again in ${Math.ceil(wait / 1000)} s.`,
      );
    if (this.runningLogins >= MAX_CONCURRENT_LOGINS)
      throw new HttpError(
        429,
        "Too many logins at once. Try again in a moment.",
      );
    // Added anew, to keep the oldest first.
    this.loginFailures.delete(key);
    this.loginFailures.set(key, { count: (failures?.count ?? 0) + 1, at: now });
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

/** What failed logins are counted by: names match like `Db.getUserByName`, and no account has a longer one. */
function loginKey(name: string): string {
  return name.trim().toLowerCase().slice(0, NAME_LENGTH);
}

function loginWait(failures: number): number {
  if (failures < FREE_LOGIN_FAILURES) return 0;
  return Math.min(
    LOGIN_WAIT_MS * 2 ** (failures - FREE_LOGIN_FAILURES),
    MAX_LOGIN_WAIT_MS,
  );
}

function hashPassword(password: string): Promise<string> {
  if (!password) throw new HttpError(400, "The password is empty");
  return Bun.password.hash(password);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
