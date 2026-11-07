import {
  afterEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "./auth";
import type { HttpError } from "./chats";
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

describe("failed logins", () => {
  const START = new Date("2026-01-01T00:00:00Z").getTime();

  /** Fails `count` times, five being what a name gets before it has to wait. */
  function fail(auth: AuthService, name: string, count = 5) {
    for (let i = 0; i < count; i++)
      expect(auth.login(name, "wrong")).rejects.toThrow(
        "Wrong name or password",
      );
  }

  function setupAtStart() {
    setSystemTime(START);
    cleanup.push(() => setSystemTime());
    return setup();
  }

  test("make a name wait longer and longer, even with the right password", async () => {
    const { auth } = setupAtStart();
    await auth.createUser("alice", "secret");
    fail(auth, "alice");
    expect(auth.login("alice", "secret")).rejects.toMatchObject({
      status: 429,
      message: "Too many failed logins. Try again in 1 s.",
    });

    setSystemTime(START + 1000);
    fail(auth, "alice", 1);
    expect(auth.login("alice", "secret")).rejects.toMatchObject({
      status: 429,
      message: "Too many failed logins. Try again in 2 s.",
    });
    // Waiting logins don't make it longer.
    setSystemTime(START + 2999);
    expect(auth.login("alice", "wrong")).rejects.toMatchObject({
      status: 429,
    });
    setSystemTime(START + 3000);
    expect((await auth.login("alice", "secret")).user.name).toBe("alice");
  });

  test("are forgotten after logging in, and after an hour", async () => {
    const { auth } = setupAtStart();
    await auth.createUser("alice", "secret");
    fail(auth, "alice", 4);
    await auth.login("alice", "secret");
    fail(auth, "alice");

    setSystemTime(START + 60 * 60_000);
    fail(auth, "alice");
  });

  test("count the same for every spelling of a name, and only for that name", async () => {
    const { auth } = setupAtStart();
    await auth.createUser("alice", "secret");
    await auth.createUser("bob", "secret");
    fail(auth, "alice", 2);
    fail(auth, " ALICE ", 3);
    expect(auth.login("Alice", "secret")).rejects.toMatchObject({
      status: 429,
    });
    await auth.login("bob", "secret");
  });

  test("treat names without an account like names with one", async () => {
    const { auth } = setupAtStart();
    await auth.createUser("alice", "secret");
    const verify = spyOn(Bun.password, "verify");
    cleanup.push(() => verify.mockRestore());
    fail(auth, "nobody");
    expect(verify).toHaveBeenCalledTimes(5);
    expect(auth.login("nobody", "wrong")).rejects.toMatchObject({
      status: 429,
    });
  });

  test("can't be raced past with parallel guesses", async () => {
    const { auth } = setupAtStart();
    await auth.createUser("alice", "secret");
    fail(auth, "alice", 4);
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => auth.login("alice", "wrong")),
    );
    expect(
      results.map((result) =>
        result.status === "rejected"
          ? (result.reason as HttpError).status
          : 200,
      ),
    ).toEqual([401, 429, 429]);
  });

  test("only run a few at a time", async () => {
    const { auth } = setupAtStart();
    await auth.createUser("alice", "secret");
    const results = await Promise.allSettled(
      ["a", "b", "c", "d", "e"].map((name) => auth.login(name, "wrong")),
    );
    expect(
      results.map((result) =>
        result.status === "rejected"
          ? (result.reason as HttpError).status
          : 200,
      ),
    ).toEqual([401, 401, 401, 401, 429]);
    // A login turned away for that isn't held against the name.
    fail(auth, "e");
  });
});
