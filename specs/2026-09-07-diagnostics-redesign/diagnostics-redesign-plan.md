# Diagnostics redesign — plan

**Status:** COMPLETE (uncommitted) — all 6 phases implemented + verified. Full `npm run typecheck` clean; `npm run test` 1516 pass / 1 skip across 77 files; `build:ui` clean (0 `<style>` in `settings/index.html`); Electron app boots without error (renderer up, IPC registered) — visual confirmation of the panel is the one remaining human look.
**Date:** 2026-09-07
**Touches:** `apps/ui/app/settings/metrics.tsx`, `apps/desktop/src/ipc/metrics.ts`,
`packages/observability/src/traceLog.ts`, `packages/ai/src/layer1/extract.ts`,
`packages/store/src/repos/{aiCalls,extractionFailures}.ts`, `apps/desktop/src/preload.cts`,
`apps/ui/types/bridge.d.ts`, plus tests.

---

## 1. Problem

The Diagnostics panel (`apps/ui/app/settings/metrics.tsx`, fed by `debug:metrics`)
was built as an operator/bug-report surface and reads like one:

- Percentile language (`P50`/`P95`, "observation(s)"), raw millisecond values.
- Internal vocabulary shown verbatim: layer numbers (`Extraction (Layer 1)`),
  `ai_calls` outcome codes (`all_claims_dropped`, `stream_error`,
  `budget_exceeded`), citation-gate reason codes (`injection_pattern`,
  `not_in_context`), scheduler trigger codes (`quiet`, `hard_cap`), redaction
  "kinds" (`aws_access_key`).
- Seven stacked `<details>` blocks of dense tables using legacy `.diag-*` /
  `.data-table` CSS.
- Spec references leaking into copy ("Time to re-entry (NFR-10)", "OI-1").

It also **does not answer the one question a normal user actually has when the
app feels stuck**: *did something in the pipeline just fail or get thrown away,
and why?* Today that information is either aggregated into a 7-day count buried
in a collapsed table, or not surfaced at all (Layer 1 prefilter/schema-fail).

The live `pipeline:status` strip in the nav rail (`RailStatus.tsx`) only ever
shows `Reading N messages…` / `Summarizing N…` / `Idle` — it has no failure or
discard state.

## 2. Goals

1. Rewrite the Diagnostics panel around **what a non-technical user needs**: is
   the app healthy, is my data staying local, and did anything get dropped.
2. Add a **Recent activity** view that names each pipeline failure or discard in
   plain language, with a timestamp and (where possible) a "what to do" line.
3. Keep a full technical dump available for bug reports — one collapsed section,
   not the default view.
4. No new SQLite migration. Derive everything from data already persisted
   (`ai_calls`, `extraction_failures`, `briefings`, trace JSONL).

## 3. Non-goals

- No change to what the pipeline *does* on failure (retry/park/write-off
  behaviour stays exactly as in `scheduler.ts` / `extract.ts`).
- No real-time streaming of individual events into the panel — it stays
  refresh-on-demand like today (a small live "attention" dot on the rail is the
  only push change; see §7).
- No move of Sources health out of the rail. Diagnostics links to it, doesn't
  duplicate it.
- Not touching the eval/bench harness or `briefing:metrics` (FR-11 completion
  surface) — separate channel, separate purpose.

## 4. Audience: what a regular user should see

| Question they have | New answer | Source |
|---|---|---|
| Is the app keeping up? | "Briefings usually take ~8s. That's well within target." / "Briefings have been slow lately — try a smaller chat model." | `briefings.latencyStats()` |
| Is my data leaving the machine? | "All model work runs on this computer. Nothing has been sent anywhere." (static reassurance + call count) | `ai_calls` layer stats |
| Did the app leave anything out of my briefings? | "3 lines were left out of the 9:00 AM briefing because they weren't backed by a source." | trace `briefing` / `gateDrops` |
| Did anything get stuck? | "A conversation in #api-redesign couldn't be summarized after several tries. It'll be retried automatically." | `ai_calls` outcome + scheduler `degraded` |
| Did it skip any messages? | "12 automated messages (bots, notifications) were skipped today — this is normal." | Layer 1 prefilter (new annotation) |
| When did it last run? | "Last briefing: today 9:02 AM." | `briefings` |

Everything else (token counts, per-layer mean latency, percentile spreads,
redaction kinds, trigger reasons, unparseable-line counts) moves into the
collapsed **Technical details** block, unchanged.

## 5. Data inventory (what already exists)

| Fact | Where it lives now | Timestamped? | Per-item? |
|---|---|---|---|
| Model call failed (`schema_fail`, `error`, `stream_error`, `budget_exceeded`, `all_claims_dropped`) | `ai_calls.outcome` | yes (`created_at`) | yes (per call, has `layer`, `trace_id`) |
| Extraction write-off (event the model never classified) | `extraction_failures` (`event_id`, `attempts`, `last_at`) | yes | yes |
| Citation-gate drops by reason | trace JSONL `annotations.gateDrops` on `event:'briefing'` | per briefing (trace `startedAtMs`) | aggregated per briefing |
| Briefing fell back to template mode | `briefings.mode = 'template'` | yes (`generated_at`) | yes |
| Layer 2 thread parked after repeated failure | `scheduler.ts` `onTrace {event:'degraded'}` — **not persisted** | — | — |
| Layer 1 prefilter (noise skip) | `Layer1PipelineResult.prefiltered` counter — **not persisted / not traced** | — | — |
| Layer 2 trigger outcomes (`no_context`, `not_meaningful`, `error`) | trace JSONL `event:'layer2_trigger'` | yes | yes (per thread) |

Gaps to close: **Layer 1 prefilter counts** and **Layer 2 park events** are the
only two user-relevant facts with no reader. Both can be added as trace
annotations (no migration) — see §6.2.

## 6. Proposed design

### 6.1 Panel structure (`metrics.tsx`)

Three zones, top to bottom:

```
┌ Diagnostics ─────────────────────────────── [Refresh] Updated 9:03 AM ┐
│                                                                       │
│  ● Everything looks healthy                     (single status line)  │
│    Last briefing: today 9:02 AM · usual time ~8s                      │
│    All processing runs on this machine.                              │
│                                                                       │
│  Recent activity (last 7 days)                                        │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │ ⚠  Today 9:02 AM                                                 │ │
│  │    3 lines were left out of a briefing — not backed by a source. │ │
│  │ ⓘ  Today 8:40 AM                                                 │ │
│  │    A conversation in #api-redesign couldn't be summarized after  │ │
│  │    several tries. It will be retried automatically.              │ │
│  │ ⓘ  Yesterday · 12 automated messages skipped (bots/notifications)│ │
│  └─────────────────────────────────────────────────────────────────┘ │
│  Nothing needs your attention. / 1 item may need a look.             │
│                                                                       │
│  ▸ Technical details                            (collapsed; for bugs) │
└───────────────────────────────────────────────────────────────────────┘
```

**Zone A — Status headline.** One computed verdict: `healthy` / `slow` /
`attention`. Derived from:
- `attention` if there is ≥1 unresolved parked thread, or a briefing P95 over
  the 45s budget, or an `injection_pattern` gate drop in the window.
- `slow` if P95 is between target and target but trending (optional; can fold
  into healthy for v1).
- else `healthy`.

Plus 2–3 plain sub-lines: last briefing time, typical duration ("~8s", never
"P50 7,900 ms"), the local-only reassurance.

**Zone B — Recent activity feed.** A reverse-chronological list (cap ~25) of
*notable* pipeline events, each rendered as: icon (`⚠` attention / `ⓘ` info) +
relative time + one plain sentence + optional dim "what happens next" line.
Event kinds, in priority order:

| Kind | Trigger | Copy (example) | Tone |
|---|---|---|---|
| `thread_parked` | Layer 2 `degraded` trace | "A conversation in {channel} couldn't be summarized after several tries. It'll be retried automatically." | attention |
| `gate_injection` | `gateDrops.injection_pattern > 0` on a briefing | "A line was blocked from a briefing because it looked like a planted instruction." | attention |
| `gate_drops` | other `gateDrops` on a briefing | "{n} line(s) left out of the {time} briefing — not backed by a source." | info |
| `template_fallback` | `briefings.mode='template'` | "The {time} briefing used a simpler format because the model didn't respond in time." | info |
| `extraction_writeoff` | `extraction_failures` rows in window | "{n} message(s) couldn't be read by the model and were set aside." | info |
| `model_error` | `ai_calls.outcome` in (`error`,`stream_error`,`budget_exceeded`) | "A processing step failed at {time} and was retried." | info |
| `noise_skipped` | Layer 1 prefilter count (new annotation), aggregated per day | "{n} automated messages skipped (bots, notifications) — this is normal." | info |

`ok` / `not_meaningful` / `quiet` outcomes never appear — they are the happy
path. Empty feed → "No problems in the last 7 days."

**Zone C — Technical details.** The current summary rows + all seven `<details>`
tables, moved wholesale under one top-level `<details>`. No copy changes here;
this is the bug-report payload. Migrating `.diag-*` tables to MUI stays a
separate later cleanup (already noted in the MUI redesign plan).

### 6.2 Data layer

**Option A (recommended): one enriched read channel, no migration.**

Extend `debug:metrics` (or add a sibling `debug:activity` on the same handler
module) to also return a `recentActivity: ActivityEvent[]` array, assembled in
`collectLocalMetrics` from:

1. `AiCallsRepo.listRecentNotable(sinceMs, limit)` — new method:
   `SELECT trace_id, layer, outcome, created_at FROM ai_calls
    WHERE outcome NOT IN ('ok') AND created_at >= ? ORDER BY created_at DESC LIMIT ?`.
2. `ExtractionFailuresRepo.listRecent(sinceMs)` — new method over
   `extraction_failures.last_at`.
3. `BriefingsRepo.listRecentModes(sinceMs)` — new method returning
   `{generatedAt, mode}` so template fallbacks are datable.
4. `readTraceMetrics` extended to optionally return **recent events** (not just
   counts): each `briefing` trace's `startedAtMs` + `gateDrops` map, and each
   `layer2_trigger` trace's `startedAtMs` + `outcome` + (redacted) `threadKey`.

**New trace annotations (no schema change, `packages/ai`):**

- `packages/ai/src/layer1/extract.ts` — in the sweep, annotate a per-sweep
  trace with `{event: 'layer1_sweep', prefiltered: n, schemaFail: n,
  wroteOff: n}`. Cheap: the counts already exist in `Layer1PipelineResult`.
- `packages/ai/src/layer2/scheduler.ts` — when a thread is parked
  (`wm.attempts >= maxAttempts`), write a one-line trace
  `{event: 'layer2_parked', threadKey, attempts}` before the existing
  `onTrace({event:'degraded'})`. (Channel name for the redacted thread key
  → resolve to a Slack channel/Gmail label name in the IPC layer if a mapping
  is available; otherwise "a conversation".)
- `packages/observability/src/traceLog.ts` — teach `readTraceMetrics` (or a new
  `readTraceEvents`) to recognise `layer1_sweep` and `layer2_parked`.

**Park-resolution:** a parked thread that later synthesizes successfully should
drop off the "attention" list. `scheduler.ts` already resets `attempts` on
success; add a `layer2_unparked` trace on the transition so the reader can
net them out within the window. (Simplest v1: show park events but compute the
Zone-A `attention` verdict only from parks with no later unpark for the same
`threadKey`.)

### 6.3 Plain-language mapping

Central `Record<code, {label, tone, next?}>` tables in `metrics.tsx` (extend the
existing `OUTCOME_LABELS` / `GATE_REASON_LABELS`). One place, tested, so a new
code shows a humanized fallback rather than a raw token.

## 7. Live "attention" signal (rail)

Small, optional, keeps the panel refresh-on-demand:

- Extend `PipelineStatus` with `attention?: { count: number }` computed in
  `computePipelineStatus` from `scheduler` parked-thread count (the scheduler
  already knows its parked set for the `synthesisDue` filter).
- `RailStatus.tsx` `pipelineLine()` gains one branch: when `attention.count > 0`
  and otherwise idle → "1 item needs a look" in warning colour, linking to
  `/settings` Diagnostics.

This is the only push-path change. If it adds risk, defer it — the panel is
still fully functional without it.

## 8. Implementation phases

| Phase | Work | Verify | Status |
|---|---|---|---|
| 0 | Repo readers: `AiCallsRepo.listRecentNotable`, `ExtractionFailuresRepo.listRecent`, `BriefingsRepo.recentTemplateFallbacks` | `npm run test -w packages/store` | ✅ done (214 pass) |
| 1 | Trace annotations: `layer1_sweep` (written in `main.ts` `sweepOnce`, which owns the per-thread loop and already has the counts + `logsDir`); `layer2_parked` in `scheduler.ts`, guarded by a per-instance `parked` Set so it writes once per thread, not every 30s tick. `layer2_unparked` dropped — the current design has no path that un-parks a thread (only `resetAttempts` on a `run()` success clears the count, and a parked thread never enters `run()`), so it would be dead code; a still-parked thread emits one fresh line per app launch instead. | `npm run test -w packages/ai -- scheduler` (26 pass ✅); `readTraceEvents` test covers the `layer1_sweep` shape | ✅ done |
| 2 | `readTraceEvents` in `packages/observability` (`traceEvents.ts`) — recognises `briefing` gate drops now, `layer2_parked` / `layer1_sweep` when Phase 1 lands | `npm run test -w packages/observability` | ✅ done (57 pass) |
| 3 | `collectLocalMetrics` assembles `recentActivity`; `LocalMetrics` + `ActivityEvent` added to `preload.cts` and `bridge.d.ts` (hand-synced); `metricsExtractionFailures` dep wired in `ipc/index.ts` + `main.ts` | `npm run test -w apps/desktop` | ✅ done (279 pass) |
| 4 | `metrics.tsx` rewrite: Zone 1 `StatusHeadline` (verdict), Zone 2 `RecentActivity` (feed + copy map), Zone 3 = the old summary+tables verbatim under a collapsed `<details>` | `npm run test -w apps/ui` (56 pass ✅); `npm run build:ui` → `settings.html` has 0 `<style>` ✅ | ✅ done |
| 5 | Rail `parkedThreads` signal + Zone 1 "Last briefing" line. **`PipelineStatus.parkedThreads`** computed in `computePipelineStatus` from `watermarks.due()` filtered to `attempts >= maxAttempts` — NOT the scheduler's in-memory `parked` Set, so a thread parked in a previous run counts before this process's scheduler ticks (and no scheduler accessor is needed). `RailStatus` shows `"N conversations stuck — see Diagnostics"` (warning colour, `<a href="/settings">`) only while `parkedThreads > 0`. **`LocalMetrics.lastBriefingAt`** from new `BriefingsRepo.lastDeliveredAt()` (`MAX(generated_at) WHERE purpose='delivered'`); Zone 1 renders "Last briefing: {relativeTime}". | `pipelineStatus.test.ts` (+2), `ipc.metrics.test.ts` (+2), `railStatus.test.tsx` (+1), `repos.briefings.test.ts` (+1) | ✅ done |
| 6 | `npm run typecheck` full ✅; `npm run test` — 77 files, 1516 pass / 1 skip ✅; `npm run build:ui` — `settings/index.html` 0 `<style>` ✅; `electron .` boots clean (DB opens, IPC handlers register with the new deps, renderer process loads the static export — no startup crash). Visual check of the panel in the running window is the one step left for a human (no display access from the shell; same as how the MUI redesign was signed off). | manual | ✅ done (bar the human look) |

**Build note (Phases 0–4):** because `apps/desktop` / `apps/ui` vitest resolves
`@cr/*` to each package's `dist/`, `packages/store` and `packages/observability`
were built individually (`npm run build -w …`) so the new readers resolve at
test time. Both changes are purely additive; `tsc -b --dry` confirmed only those
two packages rebuild (core/ai/ingest untouched). Full `npm run typecheck` passes
for every file this change touches.

**Final verification (all green):** full `npm run typecheck`; `npm run test` —
77 files / 1516 pass / 1 skip; `npm run build:ui` clean; `electron .` boots
without error.

**Concurrency note:** a second session built `poll:refresh` (source
manual-refresh) on the same working tree in parallel, touching `preload.cts`,
`bridge.d.ts`, `main.ts`, `ipc/index.ts`, `RailStatus.tsx`, `globals.css`,
`lib/bridge.ts`. All edits merged cleanly (different regions). Phase 5 landed
after that work settled — `RailStatus.tsx` now carries both the poll-refresh
button (theirs) and the stuck-conversation link (this change); `PipelineStatus`
carries both nothing-new-from-them and `parkedThreads`.

**Still uncommitted:** this change, the `poll:refresh` change, and the earlier
layer2-request-kind work all sit together in the working tree. Nothing has been
committed.

## 9. Testing

- **Store readers:** fixture rows with each `outcome`, assert window filtering
  and ordering.
- **Trace reader:** golden JSONL with `layer1_sweep` / `layer2_parked` lines +
  malformed lines (the forgiving-parse contract must hold).
- **`collectLocalMetrics`:** unchanged "never throws" guarantee — a reader
  throwing must still yield `available:false`, now also `recentActivity:[]`.
- **`metrics.tsx`:** verdict computation table-driven (healthy / slow /
  attention); feed renders each kind; empty state; unavailable state; existing
  snapshot tests updated.
- **Copy:** every event kind maps to a non-tokenized sentence; unknown code
  falls back to `humanize()`.

## 10. Open decisions

1. **`debug:metrics` extended vs new `debug:activity` channel.** Recommend
   extending — same handler module, same "never throws" wrapper, one round trip.
   New channel only if `recentActivity` needs a different refresh cadence.
2. **Channel-name resolution for parked threads.** Show real channel names
   (needs a `threadKey → channel` lookup in the IPC layer) or generic "a
   conversation in Slack"? Recommend generic for v1, real names as a follow-up.
3. **Rail attention signal in this change or deferred.** Recommend include if
   Phase 5 stays small; it's the piece that makes failures *discoverable*
   without opening Settings.
4. **7-day window vs shorter for the feed.** Matches the existing metrics
   window; a 48h default with a "show older" toggle may read better. Recommend
   keep 7 days for v1.
5. **"Last briefing at {time}" line in Zone 1.** Deferred in the current build —
   `LocalMetrics` carries only the latency *distribution*, not a last-run
   timestamp. Adding `lastBriefingAt` is a one-line `BriefingsRepo` read + wire
   field; do it in Phase 5/6 alongside the rail signal. Zone 1 currently shows
   "usually finishes in about {p50}, over {count} in the last 7 days".

## 11. Risks

- `metrics.tsx` has existing tests/snapshots (`apps/ui/test`) — Zone C keeping
  the current markup verbatim limits churn; Zone A/B are additive.
- Trace annotations in `packages/ai` run inside the hot pipeline path — they are
  synchronous object writes on an already-open trace, negligible cost, but the
  `packages/ai` suite talks to real Ollama so Phase 1 needs Ollama up.
- `preload.cts` ↔ `bridge.d.ts` hand-sync is a known footgun (file headers call
  it out); the `LocalMetrics` shape change touches both.
