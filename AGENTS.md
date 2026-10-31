# clnk

Client-server chat frontend for the Pi agent harness: Bun backend (`server/`) + React web UI (`src/`), thin Tauri macOS wrapper (`src-tauri/`). Design notes and roadmap: `docs/overview.md`.

## Commands

- `bun dev` — Vite UI on :1420, proxies `/api` to the backend (override target with `CLNK_BACKEND`).
- `bun server` — backend on 127.0.0.1:8787 (`server:dev` for watch; env vars in `server/config.ts`).
- `bun fmt`, `bun lint`, `bun test`
- `bun tauri build --bundles dmg` — macOS app, Apple Silicon only. `bun tauri android build --apk --target aarch64` — Android APK, arm64 only; needs `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME`, and is signed when the `ANDROID_KEYSTORE_*`/`ANDROID_KEY_*` env vars from `.github/workflows/apps.yml` are set. That workflow attaches both to releases, plus the updater artifacts (signed `clnk_*.app.tar.gz` and `latest.json`) it packages itself; signing uses the `TAURI_SIGNING_PRIVATE_KEY` secret, its public key is in `src-tauri/tauri.conf.json`.

## Architecture

- `shared/protocol.ts` is the wire contract between server and UI (REST + WebSocket message shapes). Add new messages there; the UI deliberately does not import the Pi SDK.
- `applyServerMessage` in `shared/transcript.ts` is the transcript reducer the client applies — and the server applies it to its own copy before publishing (`ChatService.emit`, `server/chats.ts`). Keep both uses in sync when changing protocol or reducer.
- One chat = one Pi AgentSession (`server/pi.ts`), cwd = per-chat folder under the data dir. Transcripts are the Pi JSONL session files next to the SQLite DB; chat metadata is in SQLite (`server/db.ts`).
- All Pi sessions share the global `~/.pi/agent` config (models, MCP, extensions). Per-chat isolation is the cwd only — not a security boundary; the agent is told to stay inside via `chatInstructions` in `server/pi.ts`.
- The frontend is stateless: on connect the server pushes the chat list, per-chat `subscribe` gets a snapshot then live events. Backend URL lives in localStorage; the Setup screen asks for it on load. So do per-device display preferences (`src/lib/prefs.ts`).
- Notifications: the server publishes `chat_finished` when a chat goes idle after a run, and each client decides whether to show it (`src/lib/notifications.ts`). The desktop app gets `window.Notification` from Tauri's notification plugin; the Android app has none.
- The desktop app auto-updates from the GitHub releases: `src/lib/updates.ts` polls the `latest.json` manifest of the latest release (`tauri-plugin-updater`, desktop builds only), the sidebar offers the update, and `UpdateDialog.tsx` lists the releases since the current one (fetched from the GitHub API) and drives download, install and restart. The updater swaps the app bundle in place while the app runs, so `restart_after_update` in `src-tauri/src/lib.rs` reopens it after the app exits.
- Edit and retry (`ChatService.rewind`) move the Pi session's leaf back with `navigateTree` and publish a fresh `snapshot`. The cut-off messages stay in the JSONL on an abandoned branch. User messages are addressed by their timestamp.

## Gotchas

- Components style with CSS modules. Their class types are generated into the gitignored `generated/` by css-modules-kit (`cmk`, run by `typecheck` and `build`; `bun dev` keeps them current). Bare `tsc` without them silently types every class as `string`.

- Per-chat workspace folders are transient and may be pruned; any code reading them must tolerate missing files (e.g. `readTranscript` → `[]`).
- `src-tauri/gen/android` came from `tauri android init` but has hand edits (`app/build.gradle.kts`, `AndroidManifest.xml`, `MainActivity.kt`). Don't regenerate it without carrying them over.
- `pi-agent/` is gitignored but required for the docker-compose Pi config volume — don't delete or commit it.
