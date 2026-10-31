import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "./auth";
import { Db } from "./db";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "clnk-auth-"));
  const db = new Db(join(dir, "clnk.db"));
  cleanup.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => db.close(),
  );
  return { db, auth: new AuthService(db) };
}

describe("accounts", () => {
  test("tells how to create the first account", async () => {
    const { auth } = setup();
    expect(auth.login("alice", "secret")).rejects.toThrow(
      "There are no accounts yet",
    );
    await auth.createUser("alice", "secret");
    expect(auth.login("alice", "wrong")).rejects.toThrow(
      "Wrong name or password",
    );
  });

  test("names are trimmed and unique, ignoring case", async () => {
    const { auth } = setup();
    expect((await auth.createUser("  Alice ", "secret")).name).toBe("Alice");
    expect(auth.createUser("alice", "secret")).rejects.toThrow(
      "There already is a user named Alice",
    );
    expect(auth.createUser(" ", "secret")).rejects.toThrow();
    expect(auth.createUser("a\nb", "secret")).rejects.toThrow();
    expect(auth.createUser("x".repeat(41), "secret")).rejects.toThrow();
    expect(auth.createUser("bob", "")).rejects.toThrow();
  });

  test("tokens are stored hashed and setting a password ends every session", async () => {
    const { db, auth } = setup();
    const user = await auth.createUser("alice", "secret");
    const { token } = await auth.login("alice", "secret");
    const session = auth.authenticate(token);
    expect(session?.user.id).toBe(user.id);
    expect(session?.tokenHash).not.toBe(token);
    expect(db.getSessionUser(token)).toBeNull();

    await auth.setPassword(user.id, "better");
    expect(auth.authenticate(token)).toBeNull();
    const { token: next } = await auth.login("alice", "better");
    expect(auth.authenticate(next)?.user.name).toBe("alice");
  });
});
