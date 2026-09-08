# Performance review — findings and plan (2026-09-07)

## Scope

A read-through of the hot paths: the briefing request path (`briefing:request`
→ `TemplateBriefingRenderer`, the AC-1 path since OI-7), the background
pipeline (Layer 1 sweep, Layer 2 debounce tick, Layer 3 pre-compute), the
poller/ingestion funnel, and every SQLite query behind them.

**Overall:** the acute problems are already handled. OI-7 took the model off
the request path; the ingestion hand-off is fire-and-forget; timers are
`unref`'d; `009_extraction_gate.sql` indexed the `NOT EXISTS extractions`
shape. What remains is a set of smaller, mostly low-risk wins. Nothing here
is a correctness bug; it is all latency and throughput.

Findings are ordered by leverage-per-unit-risk.

---

## Tier 1 — config only, highest leverage

### 1. `retrieval.topK` is 40; it should be ~16–24

`config/default.json` → `"retrieval": { "topK": 40 }`.

`RetrievalService` returns up to `topK` chunks, and the vector search
over-fetches `topK * CANDIDATE_FANOUT` (= **160**) candidates first
(`retrieval.ts` `CANDIDATE_FANOUT = 4`). Those chunks are rendered into the
untrusted payload for **both** Layer 2 synthesis (`forThread`) and Layer 3
briefing/pre-compute (`forBriefing`). Each chunk is up to `EMBED_MAX_CHARS`
(2600) of text; 40 of them is ~100 KB of prompt before the system prompt and
instructions. On CPU with `qwen2.5:14b`, prompt evaluation is the dominant
term in the 29–85 s-per-call numbers quoted throughout `layer1/extract.ts`
and `layer2/scheduler.ts`, and it scales with that payload.

AC-7 only asks that the top-3 items be relevant. 40 is well past the point
of diminishing returns for a single-thread synthesis (often the whole
thread and then some) and for a briefing sweep.

**Action:** drop `topK` to 16 (try 12–24). This is the single biggest lever
on Layer 2 and Layer 3 pre-compute latency, and it shrinks the
`budgets.generationMs` pressure (see Tier 4 note) rather than masking it.

**Risk:** a very long thread could lose tail context in Layer 2. Gate the
change on an eval run — `npm run eval` (state the n=~70 per OI-5/RO-2) plus
`npm run bench:briefing` before/after. If long threads regress, split the
knob: a larger `forThread` cap than `forBriefing`.

---

## Tier 2 — small code changes, clear wins

### 2. Missing indexes — add `010_perf_indexes.sql`

`REFERENCES` creates no index in SQLite, and these correlated / filtered
queries currently scan:

| Index | Query | Frequency |
|---|---|---|
| `briefing_claims(delta_id, produced_by)` | `deltasNeedingProse` (`NOT EXISTS … produced_by='llm'`), `proseByDelta`, `deltasWithProse` | every 30 s pre-compute tick **and every briefing request (AC-1 path)** |
| `state_deltas(supersedes)` | the `current_state_deltas` view (`LEFT JOIN … newer.supersedes = d.delta_id`) | every briefing request, every synthesis |
| `pending_items(status, created_at)` | `listOpen()` (`WHERE status='open' ORDER BY created_at`) | every first-paint, every briefing, every rank pass |
| `ai_calls(trace_id)` | `listByTrace` | Diagnostics / metrics panel |
| `ai_calls(created_at)` | `listRecentNotable` (`WHERE created_at >= ?`) | Diagnostics panel; table grows unbounded |

Note `BriefingsRepo.deltasWithProse`'s own doc comment already claims it is
"Indexed by `(delta_id, produced_by)`" — the index was never written.

```sql
-- 010_perf_indexes.sql
CREATE INDEX IF NOT EXISTS idx_claims_delta_produced ON briefing_claims(delta_id, produced_by);
CREATE INDEX IF NOT EXISTS idx_deltas_supersedes     ON state_deltas(supersedes);
CREATE INDEX IF NOT EXISTS idx_pending_status        ON pending_items(status, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_calls_trace        ON ai_calls(trace_id);
CREATE INDEX IF NOT EXISTS idx_ai_calls_created_at   ON ai_calls(created_at);
```

After adding: `npm run test -w packages/store`, then **rebuild the store
package** so `packages/store/dist/migrations/` picks up the new file
(`migrate.ts` prefers `src/` in dev, but `package:win` copies `dist`
migrations — see CLAUDE.md).

### 3. `countThreadEvents` materialises every event to count them

`main.ts`:
```js
countThreadEvents: (threadKey) => events.listByThread(threadKey).length,
```
`listByThread` selects `*` and JSON-parses every payload into an `Event`.
This runs once per **fired** thread per 30 s tick, purely to put a number in
a diagnostic trace (`DebounceScheduler` calls it "diagnostic").

**Action:** add `EventsRepo.countByThread(threadKey): number`
(`SELECT COUNT(*) FROM events WHERE thread_key = ?` — hits
`idx_events_thread`) and wire it here.

### 4. Re-embedding a constant string on every briefing sweep

`retrieval.ts` `forBriefing` calls `this.embed(BRIEFING_QUERY_TEXT)` every
call. `BRIEFING_QUERY_TEXT` is a compile-time constant, so this is a
redundant Ollama embedding round-trip (~50–150 ms on CPU) on every Layer 3
pre-compute cycle and every scheduled/manual generation.

**Action:** memoise it on the `RetrievalService` instance (one field,
lazy-filled). Keep `forThread`'s per-thread embed as is.

---

## Tier 3 — background-path throughput

### 5. `OllamaClient.embed()` is strictly sequential

```js
for (const text of texts) out.push(await embedOne(...));   // one HTTP round-trip each
```
Layer 1 batched extraction still embeds each non-noise chunk one at a time
inside `persistExtraction`. On a backfill this serialises hundreds of
embedding round-trips and is a direct contributor to NFR-2 ingestion lag.

**Action:** bounded concurrency (3–4 in flight) in `embed()`, preserving
input order in the result array. Optionally probe the batch `/api/embed`
endpoint once at construction and use it when present, falling back to the
current per-text loop (the version-compatibility concern is already noted in
the code).

**Risk:** low — same endpoint, same payloads, just overlapped. `nomic-embed-text`
handles concurrent requests fine on a local Ollama.

### 6. Per-call guard queries in the vector store

`vectors.ts`:
- `search()` runs `await table.countRows()` before **every** search.
- `upsert()` runs `ensureDimension()` → `readDimension()` (a `table.schema()`
  fetch) on **every** call.

Once the table is known non-empty and its dimension is known, neither can
change (dimension is fixed the moment data exists; a store that had rows
does not go back to empty in this app).

**Action:** cache both on first observation inside `openVectors`'s closure.
`countRows` stays as the empty-store fast-path only until the first
non-empty result.

### 7. Briefing request path runs two near-identical prose lookups

The `generate()` path calls `deltasWithProse` and the render path calls
`proseByDelta` — the template path only needs `proseByDelta` (it already
uses the returned text). Confirm `deltasWithProse` isn't also being hit on
the request path; if it is, drop it in favour of `proseByDelta(...).has()`.
Minor once index #2 lands.

---

## Tier 4 — structural, note only (not this pass)

### 8. Everything runs on the Electron main process

All Ollama calls and all `better-sqlite3` calls (synchronous) execute on the
main process. OI-7 + fire-and-forget ingestion already removed the
user-visible symptoms, and the code comments reference "worker-pool wiring
(a later task)". A worker-thread pool for Layer 1/2/3 inference is the real
fix for main-process contention during heavy background pre-compute, but it
is a large change with its own repo-ownership design (who owns the writes)
and is out of scope here. Record it; don't start it as part of this work.

### 9. `budgets.generationMs` is 360000 (6 min)

A smell, but a symptom of prompt size (#1) and the fixed 14B stack (OI-2),
not a lever in itself — lowering it only truncates. Revisit the number
*after* #1 lands and the bench shows where generation actually settles.

### 10. `ai_calls` and trace JSONL grow unbounded

Governance says "audit logs 1 year" but nothing prunes `ai_calls` or
`logs/trace-*.jsonl`. Not urgent on a POC, but the Diagnostics panel's
full-table `GROUP BY` (`layerStats`, `outcomeStats`) degrades linearly with
app age. A retention sweep (mirroring `retention.ts`) or a rolled-up stats
table is the eventual fix; the Tier 2 indexes buy time.

---

## Suggested sequencing

1. **#2 (indexes)** + **#3 (countByThread)** + **#4 (memoise query embed)** —
   one small PR, `npm run test -w packages/store -w packages/ai`, rebuild
   store package.
2. **#1 (topK)** — separate PR so the eval delta is attributable. Run
   `npm run eval` and `npm run bench:briefing` before/after; report numbers
   with n.
3. **#5 (embed concurrency)** + **#6 (vector-store guards)** — one PR,
   `npm run test -w packages/ai -w packages/store`, then a live backfill
   check against a real Ollama for NFR-2.
4. Tier 4 items: file as separate specs if/when they graduate.

## Verification commands

```
npm run typecheck
npm run test -w packages/store
npm run test -w packages/ai
npm run bench:briefing         # needs Ollama
npm run eval                   # needs Ollama; report n (~70, OI-5/RO-2)
```
