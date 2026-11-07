import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { ServerMessage, UserSettings } from "../../shared/protocol";

type Changes = Partial<UserSettings>;

const SAVE_DELAY_MS = 300;
const RETRY_DELAY_MS = 5000;

/** What the store needs of a client, with the requests kept to answer by hand. */
class FakeBackend {
  sent: Changes[] = [];
  private answers: { resolve: () => void; reject: () => void }[] = [];
  private listeners = new Set<(msg: ServerMessage) => void>();

  onMessage(listener: (msg: ServerMessage) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  updateSettings(changes: Changes) {
    this.sent.push(changes);
    return new Promise<void>((resolve, reject) =>
      this.answers.push({ resolve, reject }),
    );
  }

  push(settings: Changes) {
    for (const listener of this.listeners)
      listener({ type: "settings", settings });
  }

  async answer(ok = true) {
    const answer = this.answers.shift();
    if (ok) answer?.resolve();
    else answer?.reject();
    // Lets the store carry on after the request.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
}

const storage = new Map<string, string>();
let loads = 0;

/** A fresh copy of the store, the way a page load gets one. */
async function loadStore() {
  return (await import(
    `./settings?load=${++loads}`
  )) as typeof import("./settings");
}

/** A store that's connected and has heard from the backend. */
async function connected(settings: Changes = {}) {
  const store = await loadStore();
  const backend = new FakeBackend();
  const stop = store.syncSettings(backend);
  backend.push(settings);
  return { store, backend, stop };
}

beforeEach(() => {
  storage.clear();
  jest.useFakeTimers();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("settings", () => {
  test("are the defaults, overlaid with what the backend has", async () => {
    const { store, backend } = await connected({ theme: "dark" });
    expect(store.getSettings()).toMatchObject({
      theme: "dark",
      thinking: "running",
    });

    backend.push({ accent: "#112233" });
    expect(store.getSettings()).toMatchObject({
      theme: "system",
      accent: "#112233",
    });
  });

  test("start from the copy of the last run, until the backend answers", async () => {
    const first = await connected({ theme: "dark", reads: "expanded" });
    first.stop();

    const store = await loadStore();
    expect(store.getSettings()).toMatchObject({
      theme: "dark",
      reads: "expanded",
    });
    expect(JSON.parse(storage.get("clnk.settings") ?? "")).toMatchObject({
      theme: "dark",
    });
  });

  test("ignore a damaged copy", async () => {
    storage.set("clnk.settings", "{not json");
    expect((await loadStore()).getSettings().theme).toBe("system");
    storage.set("clnk.settings", '{"theme":"blue","accent":"red"}');
    expect((await loadStore()).getSettings().theme).toBe("system");
  });

  test("a change shows right away, and a burst of them is saved once", async () => {
    const { store, backend } = await connected();
    const seen: string[] = [];
    store.onSettingsChange(() => seen.push(store.getSettings().accent));

    store.updateSettings({ accent: "#000001" });
    jest.advanceTimersByTime(SAVE_DELAY_MS - 1);
    store.updateSettings({ accent: "#000002" });
    jest.advanceTimersByTime(SAVE_DELAY_MS - 1);
    store.updateSettings({ accent: "#000003" });
    expect(seen).toEqual(["#000001", "#000002", "#000003"]);
    expect(backend.sent).toEqual([]);

    jest.advanceTimersByTime(SAVE_DELAY_MS);
    expect(backend.sent).toEqual([{ accent: "#000003" }]);
  });

  test("what the backend says doesn't undo changes it hasn't got yet", async () => {
    const { store, backend } = await connected();
    store.updateSettings({ accent: "#000001" });
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    store.updateSettings({ accent: "#000002" });

    // The first change coming back, and one from another device.
    backend.push({ accent: "#000001", theme: "dark" });
    expect(store.getSettings()).toMatchObject({
      accent: "#000002",
      theme: "dark",
    });

    await backend.answer();
    expect(store.getSettings().accent).toBe("#000002");
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    expect(backend.sent.at(-1)).toEqual({ accent: "#000002" });
  });

  test("what the backend says doesn't put off a save", async () => {
    const { store, backend } = await connected();
    store.updateSettings({ theme: "dark" });
    jest.advanceTimersByTime(SAVE_DELAY_MS - 1);
    backend.push({ accent: "#000001" });
    jest.advanceTimersByTime(1);
    expect(backend.sent).toEqual([{ theme: "dark" }]);
  });

  test("only one save runs at a time", async () => {
    const { store, backend } = await connected();
    store.updateSettings({ theme: "dark" });
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    store.updateSettings({ theme: "light" });
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    expect(backend.sent).toEqual([{ theme: "dark" }]);

    await backend.answer();
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    expect(backend.sent).toEqual([{ theme: "dark" }, { theme: "light" }]);
  });

  test("a saved change stays when its echo comes after the answer", async () => {
    const { store, backend } = await connected();
    store.updateSettings({ theme: "dark" });
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    await backend.answer();
    expect(store.getSettings().theme).toBe("dark");

    backend.push({ theme: "dark" });
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    expect(backend.sent).toHaveLength(1);
  });

  test("a change that couldn't be saved is tried again until it is", async () => {
    const { store, backend } = await connected();
    store.updateSettings({ theme: "dark" });
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    await backend.answer(false);
    expect(store.getSettings().theme).toBe("dark");

    backend.push({});
    expect(store.getSettings().theme).toBe("dark");
    jest.advanceTimersByTime(RETRY_DELAY_MS);
    expect(backend.sent).toHaveLength(2);
    await backend.answer(false);
    jest.advanceTimersByTime(RETRY_DELAY_MS);
    expect(backend.sent).toHaveLength(3);

    await backend.answer();
    jest.advanceTimersByTime(RETRY_DELAY_MS);
    expect(backend.sent).toEqual(Array(3).fill({ theme: "dark" }));
  });
});

describe("settings from before the backend had them", () => {
  beforeEach(() => {
    storage.set("clnk.theme", "dark");
    storage.set("clnk.accent", "#abcdef");
    storage.set("clnk.display", '{"reads":"expanded","thinking":"nonsense"}');
  });

  test("are used until the backend is heard from", async () => {
    expect((await loadStore()).getSettings()).toMatchObject({
      theme: "dark",
      accent: "#abcdef",
      reads: "expanded",
      thinking: "running",
    });
  });

  test("go to the backend, for what it doesn't have", async () => {
    const { store, backend } = await connected({ theme: "light" });
    expect(store.getSettings()).toMatchObject({
      theme: "light",
      accent: "#abcdef",
    });
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    expect(backend.sent).toEqual([{ accent: "#abcdef", reads: "expanded" }]);
    expect(
      ["clnk.theme", "clnk.accent", "clnk.display"].filter((key) =>
        storage.has(key),
      ),
    ).toEqual([]);
  });

  test("don't go to the backend again on the next run", async () => {
    const first = await connected({});
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    await first.backend.answer();
    first.stop();

    const { backend } = await connected({ accent: "#abcdef" });
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    expect(backend.sent).toEqual([]);
  });
});

describe("logging in as someone else", () => {
  test("doesn't give them the settings of the one before", async () => {
    const { store, backend, stop } = await connected({ theme: "dark" });
    store.updateSettings({ accent: "#000001" });
    stop();
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    expect(backend.sent).toEqual([]);

    const next = new FakeBackend();
    store.syncSettings(next);
    next.push({});
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    expect(next.sent).toEqual([]);
    expect(store.getSettings().theme).toBe("system");
    expect(store.getSettings().accent).not.toBe("#000001");
  });

  test("ignores a save of the one before that ends late", async () => {
    const { store, backend, stop } = await connected();
    store.updateSettings({ theme: "dark" });
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    stop();

    const next = new FakeBackend();
    store.syncSettings(next);
    next.push({});
    await backend.answer();
    store.updateSettings({ reads: "expanded" });
    expect(store.getSettings().theme).toBe("system");
  });
});
