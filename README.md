# Context Restorer

A local-first Electron desktop app that polls Slack and Gmail, continuously
derives meaningful state changes via a three-layer local-LLM pipeline
(Ollama), and on demand streams a short, fully-cited narrative briefing of
what changed and what is waiting on you.

Everything runs on your machine. There is no server and no outbound network
traffic except to a local Ollama instance (`localhost:11434`) and to
Slack/Gmail's own OAuth and API endpoints for the sources you connect.

This is a proof-of-concept build — see `specs/2026-08-23-context-restorer/`
for the full requirements, technical design, implementation plan, and
acceptance report, including honestly-disclosed limitations (measured
latency, eval-set size, etc.).

## Getting started

Two different starting points, depending on what you have:

- **You were handed `Context Restorer-<version>-x64.exe`** — skip straight to
  [Running the packaged build](#running-the-packaged-build) below. You do not
  need Node, npm, or this source tree at all.
- **You're working from this source tree** — read on: [Prerequisites](#prerequisites),
  then [Setup](#setup).

Either way, **[Ollama](https://ollama.com) must be installed and running
locally first**, with both models pulled — this is the one dependency neither
path can skip:
```
ollama pull qwen2.5:7b
ollama pull nomic-embed-text
```
The app refuses to start (with a dialog naming the exact remedy) if Ollama is
unreachable or either model is missing — this is deliberate fail-loud
behavior, not a bug.

## Running the packaged build

If you received `Context Restorer-<version>-x64.exe` (built via
[`npm run package:win`](#building-a-shareable-exe)):

1. Make sure Ollama is running locally with both models pulled (see above).
2. Double-click the `.exe`. It is **portable** — nothing to install, no admin
   rights needed. It unpacks itself to a temp location and runs.
3. On first launch it creates its own local database, vector store, and
   token vault under your Windows user profile (`%APPDATA%\context-restorer\`)
   — nothing here is shared with or read from this source tree.
4. To connect Slack/Gmail, an OAuth app must already be registered and its
   `clientId`/`clientSecret` filled into
   `resources\config\default.json`, which sits right next to the `.exe`
   (unpacked, plain JSON — safe to edit directly). See
   [Connecting Slack and Gmail](#connecting-slack-and-gmail-optional) below
   for what to put there; without it, connecting a source just reports
   "not configured" rather than failing.
5. The app lives in the system tray; closing the window hides it rather than
   quitting.

Nobody needs Node.js, npm, or a copy of this repository to run the packaged
build — that is the entire point of packaging it.

## Prerequisites

- **Node.js 24 LTS** (`engines.node` is pinned to `>=24.0 <25`). If you use
  `nvm`, run `nvm use` in the repo root — do not change your global/default
  Node version for this project.
- **[Ollama](https://ollama.com)** with both models pulled — see
  [Getting started](#getting-started) above.
- A C++ build toolchain is **not** required: `better-sqlite3` is on the N-API
  ABI, so no native rebuild step is needed across Node/Electron versions.

## Setup

```
npm install
npm run typecheck   # sanity check — should exit clean
```

### Connecting Slack and Gmail (optional)

Ingestion requires an OAuth app registered with each provider. Without one,
the app still runs — connecting a source from the UI will report
`not_configured` instead of failing silently. The steps below are one-time
setup per provider; do them once, then every install (source or packaged
`.exe`) just needs the resulting `clientId`/`clientSecret` in
`config/default.json`.

#### Slack

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
   Give it any name (e.g. "Context Restorer") and pick your workspace.
2. Left sidebar → **OAuth & Permissions**.
3. Under **Redirect URLs**, add exactly `http://127.0.0.1:53682/callback` and
   save. This must match byte-for-byte — Slack matches redirect URIs exactly,
   including the port (`SLACK_REDIRECT_PORT` in
   `apps/desktop/src/ipc/oauth.ts`), unlike Google's installed-app flow.
4. Under **Scopes → User Token Scopes** (not Bot Token Scopes — this app reads
   *your* channel/DM history, not a bot's), add exactly these four:
   `channels:history`, `channels:read`, `im:history`, `users:read`. These come
   from `packages/ingest/src/oauth/scopes.ts`'s `SLACK_SCOPES` — do not add
   anything broader.
5. Scroll up and click **Install to Workspace** (or **Reinstall** if you
   change scopes later — a scope change needs a reinstall to take effect),
   then approve.
6. Left sidebar → **Basic Information** → **App Credentials** → copy the
   **Client ID** and **Client Secret**.
7. Paste both into `config/default.json`:
   ```json
   "oauth": { "slack": { "clientId": "...", "clientSecret": "..." } }
   ```
8. In the app, connect Slack from the UI — a browser window opens Slack's own
   consent screen; approving it completes the loopback exchange automatically.
9. Open **Settings → Slack channels** and select which channels to poll. A
   connected Slack account with zero channels selected ingests nothing by
   design — that is the intended idle state, not an error.

#### Gmail

1. Go to <https://console.cloud.google.com/> and select or create a project.
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen** → choose **External** (unless
   using a Google Workspace org) → fill in the app name and your email as
   support/developer contact → under **Scopes**, add
   `https://www.googleapis.com/auth/gmail.readonly` → under **Test users**,
   add the Google account(s) you'll actually connect (required while the app
   is unverified) → save.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID** →
   Application type: **Desktop app** (this is what lets Google accept a
   loopback redirect on *any* port — no fixed port needed, unlike Slack) →
   name it → **Create**.
5. Copy the **Client ID** and **Client Secret** it generates.
6. Paste both into `config/default.json`:
   ```json
   "oauth": { "gmail": { "clientId": "...", "clientSecret": "..." } }
   ```
7. In the app, connect Gmail from the UI. Because the OAuth consent screen is
   unverified, Google shows an "unverified app" warning — click **Advanced**
   → **Go to (app name) (unsafe)** to proceed (safe here: it's your own app
   requesting only `gmail.readonly`, which never writes or sends mail).
8. Gmail polling starts automatically once connected — unlike Slack, there is
   no channel-selection step; Gmail has no equivalent narrowing UI yet.

## Running

```
npm run build:ui        # builds the Next.js static export, copies it into apps/desktop/ui
npm run build:desktop    # compiles the Electron main process
npm run start            # launches the app
```

The app is a tray-resident window: closing it hides it rather than quitting.

## Building a shareable .exe

```
npm run package:win
```

This typechecks the whole workspace, builds the UI static export, and runs
`electron-builder` (config: `apps/desktop/electron-builder.yml`). Output:
`release/Context Restorer-<version>-x64.exe` — a single portable executable,
~115 MB, no installer. Hand that one file to anyone on Windows x64; see
[Running the packaged build](#running-the-packaged-build) for what they need
on their end (just Ollama).

Notes:
- No code signing is configured — Windows SmartScreen will warn "unknown
  publisher" for recipients. That's expected for an unsigned POC build.
- `config/default.json` is bundled unpacked (not inside `app.asar`) specifically
  so it stays editable after packaging — check what you've put in
  `oauth.slack`/`oauth.gmail` before sharing if you don't want your own
  `clientSecret` going out with the build.
- Native modules (`better-sqlite3`, `@lancedb/lancedb`) are packaged as-is,
  not rebuilt (`npmRebuild: false` in the electron-builder config) — both
  already ship a matching prebuilt binary, and rebuilding would require a
  Python/MSVC toolchain this project otherwise avoids entirely.

## Testing

```
npm run typecheck        # TypeScript, project-referenced across every package
npm run test              # vitest, every package and app
```

Package-scoped runs are also available, e.g. `npm run test -w packages/ingest`
or `npm run test -w apps/desktop`.

Eval and latency benchmarking (requires a running Ollama with both models
pulled):

```
npm run eval
npm run bench:briefing
```

## Project layout

npm workspaces monorepo:

- `packages/core` — domain types, deterministic IDs, config loader, injectable clock
- `packages/store` — SQLite (relational store + migrations) and LanceDB (vector store)
- `packages/redact` — secret/PII detection and redaction
- `packages/ingest` — OAuth, Slack/Gmail clients, the ingestion pipeline, the poller
- `packages/ai` — the three-layer LLM pipeline (extraction, synthesis, briefing generation), Ollama client, citation gate
- `packages/observability` — trace logging, AI-call audit log, PII-safe logging
- `packages/eval` — the eval harness, labeled fixtures, latency benchmark
- `apps/desktop` — the Electron main process: window, tray, IPC handlers, the poller/scheduler wiring
- `apps/ui` — the Next.js static-export renderer, talking to the main process exclusively over `contextBridge` IPC

Full architecture, security invariants, and acceptance criteria live in
`specs/2026-08-23-context-restorer/context-restorer-design.md` and
`context-restorer-requirements.md`.

## Data and privacy

- All data stays local: SQLite + LanceDB under your OS's app-data directory,
  OAuth tokens encrypted at rest via Electron's `safeStorage`.
- Secrets and PII are redacted from message text before it is ever persisted.
- Raw event payloads age out after 90 days; derived summaries are kept.
- A right-to-delete operation is available that erases every table, the
  vector store, and the token vault together — see
  `packages/store/src/retention.ts`.
