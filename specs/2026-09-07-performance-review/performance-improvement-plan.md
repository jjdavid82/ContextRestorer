# Performance improvement plan (2026-09-07, rev 2)

Supersedes `performance-review-plan.md`. That file is the raw read-through;
this one is the corrected, scoped, do-this list after checking every claim
against the code.

## Build status (2026-09-08)

| Item | State |
|---|---|
| A — `014_perf_indexes.sql` | **done** — `npm run test -w packages/store` green, store package rebuilt |
| B — delete `BriefingsRepo.deltasWithProse` | **done** — method + its test removed |
| C — memoise briefing-query embedding | **done** — `retrieval.ts`, test added |
| D — `EventsRepo.countByThread` + wire at `main.ts` | **done** — tests added; `main.ts` + `e2eTrace.test.ts` updated |
| F — batch the Layer 1 embed fan-out | **done** — in `extractBatch` / new `persistExtractionBatch`, not `OllamaClient.embed` (see below); 2 tests added |
| E — `retrieval.topK` 40 → 16 | **measured, dropped.** The `CR_BENCH_LLM=1` bench (topK 40 vs 16, n=6 each — `bench-topk{40,16}.md`) shows first-token flat (~259 s vs ~277 s) and total generation budget-capped at both. `topK` is not the Layer 3 latency lever. `topK` stays 40. Real finding: generation runs to the 6-min `generationMs` ceiling — its own follow-up. |

A + B + C + D + F ship together as `perf/hot-path-cleanup`.
`npm run typecheck` and the full `npm run test` across `store`, `ai`,
`observability`, `desktop`, `ingest`, `core`, `redact`, `eval` are all green.

### F — corrected scope

Rev 2 aimed F at `OllamaClient.embed()`. That was wrong: **every production
caller passes a single-element array** (`ollama.embed([text])`), so the
serialisation is not there. The real hot loop is `Layer1Extractor.extractBatch`,
which called `persistExtraction` (→ one `embed` + one `vectors.upsert`) once per
event in a `for … await` loop.

Implemented instead: `extractBatch` collects the model-classified events and
calls a new `persistExtractionBatch`, which fans the chunk embeds out with
`Promise.all` (bounded by `MAX_BATCH_EVENTS = 4`, so no pool needed) and does
**one** `vectors.upsert` for the batch. Chunk-before-row ordering is preserved
across the whole batch — an embed/upsert failure writes no rows and every event
is re-queued. `persistExtraction` (the single-event path) is now a thin wrapper
over the batch of one, so the two paths can't drift. `OllamaClient.embed` is
left untouched.

## What changed from rev 1

- **The `briefing_claims(delta_id, produced_by)` index already exists** —
  `007_claim_provenance.sql:32` creates `idx_briefing_claims_delta_produced`.
  Rev 1's "the index was never written" is wrong; the `deltasWithProse` doc
  comment that claims an index is telling the truth. That row is **out** of
  the new migration.
- **`BriefingsRepo.deltasWithProse` is dead code.** No production caller —
  the request path (`layer3/template.ts:402`) uses `proseByDelta`, the
  pre-computer uses `deltasNeedingProse`. Both of those are already covered
  by the 007 index. Rev 1 #7 ("two near-identical lookups on the request
  path") is a non-issue; the real action is delete the method.
- **The Diagnostics commit (`2148e79`) added two more unindexed queries** —
  `AiCallsRepo.listRecentNotable` (`WHERE outcome <> 'ok' AND created_at >= ?`)
  and `ExtractionFailuresRepo.listRecent` (`WHERE last_at >= ? ORDER BY
  last_at DESC`). Neither table nor column is indexed for that shape. Folded
  into the migration below.
- Honest priority: **#1 (topK) is the finding.** Everything else is cheap
  housekeeping with small *measurable* impact at POC data volumes — worth
  doing because it's a few lines each and `ai_calls` grows unbounded, not
  because a benchmark will move.

---

## Do now

### A. `014_perf_indexes.sql` — the genuinely missing indexes

`REFERENCES` creates no index in SQLite (see the `009` header comment for the
same reasoning). These queries scan today:

| Index | Query | Called from |
|---|---|---|
| `state_deltas(supersedes)` | `current_state_deltas` view — `LEFT JOIN state_deltas newer ON newer.supersedes = d.delta_id` | every briefing request, every Layer 2 synthesis |
| `pending_items(status, created_at)` | `PendingRepo.listOpen()` — `WHERE status='open' ORDER BY created_at ASC` | every first-paint, every briefing, every rank pass |
| `ai_calls(trace_id)` | `AiCallsRepo.listByTrace` | Diagnostics panel |
| `ai_calls(created_at)` | `AiCallsRepo.listRecentNotable` — `WHERE outcome <> 'ok' AND created_at >= ?`; table grows unbounded | Diagnostics "recent activity" (new in `2148e79`) |
| `extraction_failures(last_at)` | `ExtractionFailuresRepo.listRecent` — `WHERE last_at >= ? ORDER BY last_at DESC` | Diagnostics "recent activity" (new in `2148e79`) |

```sql
-- 014_perf_indexes.sql
-- REFERENCES does not create an index in SQLite (see 009). These correlated /
-- filtered reads run on the briefing path, the 30s scheduler tick, and the
-- Diagnostics panel; without an index each is a full table scan. IF NOT EXISTS
-- so a hand-built DB is tolerated, matching 009.

CREATE INDEX IF NOT EXISTS idx_deltas_supersedes      ON state_deltas(supersedes);
CREATE INDEX IF NOT EXISTS idx_pending_status         ON pending_items(status, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_calls_trace         ON ai_calls(trace_id);
CREATE INDEX IF NOT EXISTS idx_ai_calls_created_at    ON ai_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_extraction_failures_last_at ON extraction_failures(last_at);
```

**Expectation:** at current POC volumes (hundreds of rows) only the two
`ai_calls` indexes will matter, and only as the table ages — `ai_calls` has
no retention sweep (see "Defer" #3). The rest is cheap insurance that costs
one INSERT-time B-tree update on small, low-churn tables. Don't expect
`bench:briefing` to move.

**After adding:** `npm run test -w packages/store`, then rebuild the store
package so `packages/store/dist/migrations/` picks up the file (`migrate.ts`
prefers `src/` in dev; `package:win` ships `dist` — per CLAUDE.md).

### B. Delete `BriefingsRepo.deltasWithProse`

Unused in production. Remove the method, its doc comment, and its test in
`packages/store/test/repos.briefings.test.ts`. `proseByDelta` and
`deltasNeedingProse` stay — both are real request/tick-path callers and both
are already served by `idx_briefing_claims_delta_produced` (007).

### C. Memoise the briefing query embedding

`retrieval.ts:281` — `forBriefing` calls `this.embed(BRIEFING_QUERY_TEXT)`
every invocation. `BRIEFING_QUERY_TEXT` is a compile-time constant and the
embed model is fixed for the service's lifetime, so this is a redundant
Ollama round-trip (~50–150 ms on CPU) on **every 30 s Layer 3 pre-compute
tick** and every scheduled/manual generation.

**Action:** one lazily-filled `private briefingQueryVector?: number[]` field
on `RetrievalService`, populated on first `forBriefing`. Leave `forThread`'s
per-thread embed untouched (its query text varies).

**Risk:** none — same vector every time by construction.

### D. `countThreadEvents` → `EventsRepo.countByThread`

`main.ts:976` — `countThreadEvents: (threadKey) => events.listByThread(threadKey).length`.
`listByThread` selects `*` and JSON-parses every payload into an `Event`,
purely to produce a number for a diagnostic trace field
(`layer2/scheduler.ts:430`, explicitly "never aborts the decision it
describes"). Runs once per *fired* thread per 30 s tick.

**Action:** add `EventsRepo.countByThread(threadKey): number` —
`SELECT COUNT(*) FROM events WHERE thread_key = ?` (hits the existing
`idx_events_thread`) — and wire it at `main.ts:976`.

**Payoff:** small (diagnostic-only path, thread event counts are modest).
Do it because it's five lines and removes a full-payload parse from the tick.

> **Ship A–D as one PR.** `npm run typecheck`, `npm run test -w packages/store
> -w packages/ai`, rebuild store package. No eval/bench needed — none of these
> changes affect retrieval output or prompt content.

---

## Do next (separate PR — this is the real work)

### E. `retrieval.topK` 40 → 16–24, gated on eval

`config/default.json:16` — `"retrieval": { "topK": 40, "budgetMs": 5000 }`.

`RetrievalService` caps results at `topK` and over-fetches
`topK * CANDIDATE_FANOUT` (`CANDIDATE_FANOUT = 4`, `retrieval.ts:64`) →
**160 candidates** from the vector store first. The final chunks render into
the untrusted payload for **both** Layer 2 synthesis (`forThread`) and Layer
3 briefing/pre-compute (`forBriefing`). Each chunk is up to `EMBED_MAX_CHARS`
= 2600 chars (`ollama.ts:343`); 40 of them is ~100 KB of prompt body before
system prompt and instructions. On CPU `qwen2.5:14b`, prompt evaluation is
the dominant term in the 29–85 s/call figures quoted in `layer1/extract.ts`
and `layer2/scheduler.ts`, and it scales with that payload.

AC-7 only requires the top-3 items be relevant. 40 is well past diminishing
returns for a single-thread synthesis (often the whole thread and then some)
and for a briefing sweep. Dropping to 16 also cuts the candidate fan-out
64 vs 160 — less LanceDB work per call.

**Status: measured, then NOT shipped — the premise above is wrong.** `topK`
was set to 16, benchmarked against 40, and reverted. The measurement
(`bench-topk40.md` / `bench-topk16.md` in this folder) refutes the hypothesis
that prompt evaluation dominates and scales with the retrieved payload.

> **Measurement (2026-09-08, real `CR_BENCH_LLM=1` bench, `CR_BENCH_THREADS=20×4`,
> 72 h windows, n=6 briefings each — the "OOM killed" notice was spurious, both
> runs completed):**
>
> | | topK=40 | topK=16 |
> |---|--:|--:|
> | First token — median of runs | ~259 s | ~277 s |
> | First token — P95 | 360 s | 325 s |
> | Total `generate()` — P50 | 360.1 s | 360.1 s |
> | Runs truncated by `budgets.generationMs` (360 s) | 6 / 6 | 5 / 6 |
>
> Cutting the retrieved context 40 → 16 chunks moved **time-to-first-token by
> nothing** (within n=6 noise, if anything slightly worse), and total
> generation stayed pinned at the 6-minute truncation budget either way.
>
> **What this means:** at this corpus (~48 in-window chunks), the Layer 3
> latency is *not* prompt-eval-bound on the retrieved payload. First token is
> ~255–260 s regardless of chunk count — dominated by the fixed prompt (system
> + instructions + state deltas + pending items), CPU compute, and per-request
> overhead. Then the model decodes until `generationMs` cuts it off. `topK` is
> not the lever; the model over-generating into a 6-minute ceiling is.
>
> **Caveat:** n=6, and a real inbox window holds hundreds of chunks, not ~48 —
> at that scale prompt-eval *might* start to bite. But the 40-vs-16 delta at
> equal corpus is flat, so if prompt-eval scaled strongly with chunk count it
> would already show here. The eval (quality) gate is separately a no-op —
> fixtures are ≤12 events, so retrieval never returns >12 chunks and `topK` 16
> vs 40 produces identical eval output.
>
> **Decision: `topK` stays 40.** The real Layer 3 latency problem is
> decode-bound generation hitting the truncation budget — a prompt-shape /
> `maxChangedItems` / output-length question, not a retrieval-`topK` one. That
> is its own investigation (see #9, now upgraded from "smell" to "the actual
> finding").

**`budgets.generationMs` (360 000 = 6 min) is the actual finding.** The E
bench shows every briefing generation runs to this ceiling and gets
truncated — at both `topK` values, 5–6 of 6 runs. Time-to-first-token is
~255–260 s and then the model decodes for another ~100 s until the budget
cuts it off. This is where the Layer 3 latency budget is actually being
spent, and `topK` doesn't touch it. Worth its own investigation: is the model
being asked to produce too much (prompt shape, `briefing.maxChangedItems`,
output-length instructions)? Is 6 min even the right ceiling, or should it
fail faster? Not a config one-liner — a Layer 3 prompt/output study.

---

## F — batch the Layer 1 embed fan-out (done)

**Where the serialisation actually was.** `Layer1Extractor.extractBatch`
already batches the *model* call (`MAX_BATCH_EVENTS = 4` events, one
`generateJson`), but then persisted the results in a `for … await` loop —
`persistExtraction` per event, each doing one `this.embed(text)` round-trip
followed by one `this.vectors.upsert([chunk])`. Four events = four serial
embed round-trips + four LanceDB writes behind one model call.

`OllamaClient.embed()` — rev 2's target — is a red herring: every production
caller (`apps/desktop/src/main.ts:680`, the eval harness) passes a
single-element array and destructures `const [v] = …`. Nothing batches through
it.

**Implemented:**
- New `persistExtractionBatch(items)`: builds the chunk bodies (`chunkBodyFor`,
  shared with the single path so "what gets indexed" can't drift), embeds them
  with `Promise.all` (batch is ≤ `MAX_BATCH_EVENTS`, so the cap bounds
  concurrency — no pool), one `vectors.upsert(chunks)` for the batch, then the
  `extractions` rows.
- `persistExtraction` (single-event path, used by `extractEvent`) is now a
  wrapper over `persistExtractionBatch([{ event, parsed }])`.
- `extractBatch` collects the classified events and makes one
  `persistExtractionBatch` call.

**Ordering / failure:** chunk-before-row holds across the whole batch — if an
embed or the upsert throws, no `extractions` row is written and every event is
re-queued by the next sweep (chunk ids are deterministic, so the retry
overwrites). This is stricter than the old per-event partial commit, and
simpler.

**Risk:** low — `nomic-embed-text` serves ≤4 concurrent local requests fine;
`OllamaClient.embed` is untouched.

**Verify:** `npm run test -w packages/ai` green (added: batched-upsert-in-one-call
and concurrent-embed tests in `extractThread.test.ts`). A timed real-Ollama
backfill for NFR-2 is still worth doing but is an operator run.

---

## Defer / drop

1. **Vector-store per-call guards** (`vectors.ts:294` `countRows()` per
   `search`; `vectors.ts:247` `readDimension()` per `upsert`). Real, but
   sub-millisecond against a local LanceDB table. Cache-on-first-observation
   is correct but not worth the review surface now. **Defer.**

2. **Worker-thread pool for Layer 1/2/3 inference.** The right fix for
   main-process contention during heavy pre-compute, but a large change with
   its own repo-ownership design (who owns the writes). OI-7 + fire-and-forget
   ingestion already removed the user-visible symptoms. **Separate spec, not
   now.**

3. **`ai_calls` / trace JSONL unbounded growth.** Governance says "audit logs
   1 year" but nothing prunes `ai_calls` or `logs/trace-*.jsonl`. The
   Diagnostics `layerStats` / `outcomeStats` are full-table `GROUP BY` with no
   `WHERE` — no index helps them, only a retention sweep (mirroring
   `store/src/retention.ts`) or a rolled-up stats table. The A migration's
   `ai_calls` indexes buy time. **File as its own task when the panel gets
   slow.**

---

## What's left — E, dropped; the real Layer 3 finding

**E (topK 40 → 16) is not shipped.** Implemented, benchmarked against 40,
reverted. The `CR_BENCH_LLM=1` bench (both runs completed — see the table
under "E" and `bench-topk{40,16}.md`) shows **first-token flat and total
generation budget-capped at both values**. `topK` is not the Layer 3 latency
lever the review assumed it was.

**The real finding:** Layer 3 generation runs to the 6-minute
`budgets.generationMs` ceiling and is truncated, ~every briefing. First token
is ~255–260 s (fixed-prompt + CPU bound, not retrieved-payload bound), then
~100 s of decode until the cut-off. Fixing that is a Layer 3 prompt/output
study — how much the model is asked to produce, whether 6 min is the right
ceiling — not a retrieval knob. That's the follow-up worth opening.

The eval (quality) gate for E is separately a structural no-op: fixtures are
≤12 events, so retrieval never returns >12 chunks and `topK` 16 vs 40 produce
identical eval output. A ≥60-event labelled fixture would be needed to make it
bind — only relevant if E is ever reconsidered at a corpus size where
prompt-eval might actually matter.

## Verification commands

```
npm run typecheck
npm run test -w packages/store -w packages/ai -w packages/observability -w apps/desktop
```

## Honest bottom line

A–D + F ship as `perf/hot-path-cleanup` and are green, but be clear-eyed about
scale: **none of it produces a speedup you can feel.**

- **B** is pure cleanup (dead method, no callers).
- **A** (5 indexes) is ~zero on POC-sized tables — latent value only as
  `ai_calls` grows, which has no retention sweep.
- **C** and **D** each remove a small redundant cost from the 30 s tick
  (one embedding round-trip; one full-payload parse). Real, tiny.
- **F** overlaps 4 serial embed round-trips (~300 ms) that sit next to a
  ~78 s Layer 1 model call — the code is cleaner and strictly better, but it's
  ~0.4 % of Layer 1 time.

The performance review's own conclusion holds: OI-7 already fixed the acute
problem by taking the model off the request path. What remained was small.
**E was the candidate lever, and the bench showed it isn't one** — Layer 3
latency is decode-bound generation hitting the 6-minute budget, unaffected by
`topK`. A–D + F are worth merging because they're free and strictly-better,
not because the app gets faster. The genuine next step is the
`budgets.generationMs` / Layer 3 output-length investigation, filed as its own
follow-up.
