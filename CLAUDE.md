# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Context Restorer: a local-first Electron desktop app that polls Slack and
Gmail, derives state changes via a three-layer local-LLM pipeline (Ollama),
and streams a fully-cited briefing of what changed and what's waiting on the
user. Everything runs on-machine — no server, no outbound calls except to
localhost Ollama and Slack/Gmail's own OAuth/API endpoints. This is a POC;
full requirements/design/plan/acceptance docs live in
`specs/2026-08-23-context-restorer/`.

## Commands

```
npm install
npm run typecheck              # tsc -b across the whole project-referenced workspace
npm run test                   # vitest, every package/app
npm run test -w packages/ingest    # scope to one workspace
npm run build:ui                # next build (apps/ui) + copies static export into apps/desktop/ui
npm run build:desktop           # builds packages/store then apps/desktop
npm run start                   # launch the Electron app (npm run start -w apps/desktop)
npm run package:win             # full shareable .exe: typecheck -> build:ui -> copy store migrations -> electron-builder
npm run rebuild:native          # electron-rebuild for better-sqlite3 (rarely needed, see below)
npm run eval                    # eval harness (packages/eval), needs Ollama running
npm run bench:briefing          # latency benchmark
```

Single test file: `npm run test -w <package> -- <path-or-name>` (vitest picks
up args after `--`), e.g. `npm run test -w packages/ai -- retrieval`.

Requires Node 24 (`engines.node` pinned `>=24.0 <25`) and Ollama running
locally with `qwen2.5:14b` and `nomic-embed-text` pulled — several tests and
all `eval`/`bench` runs talk to real Ollama, not a mock.

## Environment gotchas

- No Python/MSVC toolchain on this machine — `npmRebuild: false` in
  `apps/desktop/electron-builder.yml` deliberately skips native rebuilds.
  `better-sqlite3` (v13, N-API) and `@lancedb/lancedb` rely entirely on their
  prebuilt binaries; don't "fix" a native-module issue by forcing a rebuild.
- `npm run typecheck` does not check every package's test files: only
  `packages/ai`, `packages/observability`, and `apps/ui` have a
  `tsconfig.test.json` wired into the root `tsconfig.json` references. A
  type error inside `*.test.ts` in `core`, `store`, `redact`, `ingest`,
  `eval`, or `apps/desktop` will not surface via `npm run typecheck` —
  `npm run test -w <that-package>` (vitest/tsc under the hood) is what
  actually compiles those.
- Use `nvm use` for this repo's Node version in-session; do not change the
  global/default `nvm` alias.

## Architecture

npm workspaces monorepo, TypeScript project references
(`tsconfig.json` → per-package `tsconfig.json`), `strict` +
`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` everywhere.

**Data flow**: Slack/Gmail (OAuth) → `packages/ingest` poller/pipeline →
redact secrets/PII (`packages/redact`, SEC-4) → persist to
`packages/store` (SQLite relational + LanceDB vector) → three-layer LLM
pipeline in `packages/ai` (layer1 extraction → layer2 synthesis → layer3
briefing generation, all via a local Ollama client) → citation gate →
streamed briefing to the UI. `packages/observability` provides trace
logging and a PII-safe AI-call audit log across the pipeline.

**Process split**: `apps/desktop` is the Electron main process — window,
tray, autostart, the poller/scheduler wiring, and one IPC handler module per
feature under `apps/desktop/src/ipc/` (`briefing`, `oauth`, `projects`,
`slackChannels`, `schedule`, `feedback`, `metrics`, `health`, `pipelineStatus`,
`modelSettings`, `external`, `claim`). `apps/ui` is a Next.js **static
export** rendered inside that window, talking to the main process
exclusively through `contextBridge`/`preload.cts` IPC — never a live Next.js
server, never direct Node access from renderer code.

**Config**: `packages/core/src/config.ts` loads `config/default.json`, then
deep-merges `config/default.local.json` if present (gitignored, untracked —
the only place a real Slack/Gmail OAuth `clientId`/`clientSecret` belongs).
`assertValid` deliberately treats a missing `oauth` block as legitimate
("not configured", never a startup abort) and hard-fails if
`model.ollamaBaseUrl` is anything but localhost (SEC-6). When packaging
(`apps/desktop/electron-builder.yml`), `config/` is copied unpacked into
`resources/` as `extraResources` so a recipient can edit it post-build — the
filter there excludes `*.local.json` specifically so a dev's real secret
never ships in a built `.exe`; keep that exclusion if you touch the filter.

**Security invariants** (full list in
`specs/2026-08-23-context-restorer/context-restorer-requirements.md`,
referenced by code comments as `SEC-n`/`OI-n`): OAuth tokens live only in the
OS keychain via Electron `safeStorage`, never in the app DB or a plain config
file (SEC-2); secrets/PII are redacted before content reaches any LLM
(SEC-4) and again on outputs before storage/delivery (SEC-5); no LLM API
calls ever leave the machine (SEC-6); right-to-delete purges the relational
store, vector index, and token vault together (SEC-8,
`packages/store/src/retention.ts`).

**Design decisions worth knowing before changing behavior** (`OI-n` in the
requirements doc): the latency budget is a 45s synchronous-path cap (OI-1);
model choice is fixed-stack, config-file only, not runtime-selectable
(OI-2); declaring projects at onboarding is mandatory but not yet wired into
ranking — `onboarding.minDeclaredProjects` accepts any non-negative integer
because no code path creates the `belongs_to` graph edge `wStakes` reads yet
(OI-3); eval-set size is fixed at ~70 labeled examples — any reported metric
must state that size alongside the number, an unqualified percentage is not
acceptable (OI-5/RO-2).

## Project layout

- `packages/core` — domain types, deterministic IDs, config loader, injectable clock
- `packages/store` — SQLite (relational store + migrations) and LanceDB (vector store)
- `packages/redact` — secret/PII detection and redaction
- `packages/ingest` — OAuth, Slack/Gmail clients, ingestion pipeline, poller
- `packages/ai` — three-layer LLM pipeline, Ollama client, citation gate
- `packages/observability` — trace logging, AI-call audit log, PII-safe logging
- `packages/eval` — eval harness, labeled fixtures, latency benchmark
- `apps/desktop` — Electron main process
- `apps/ui` — Next.js static-export renderer
