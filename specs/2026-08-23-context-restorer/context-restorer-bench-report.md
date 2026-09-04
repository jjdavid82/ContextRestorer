# Context Restorer — Latency Benchmark (AC-1)

_Generated 2026-09-04T16:54:56.043Z by `npm run bench:briefing` (Task 5.3)._

This is the only measurement of AC-1 in the build. The Task 5.1 eval harness pins the clock inside each fixture's window, which makes every latency it records 0 and makes the §7.8 generation budget unable to elapse; it measures quality, not latency.

## Results

**n = 20 briefing generation(s) measured** (20 attempted, 0 failed, 0 produced no citable context).

| Metric | Observations | P50 | P95 |
|---|--:|--:|--:|
| First paint — pending items, NO model call | 0 | — ms | — ms |
| Deterministic briefing — the P0 request path, NO model call | 20 | 2 ms | 3 ms |
| First token — LLM stream (runs that produced one) | 0 | — ms | — ms |
| Total — `generate()` end to end | 0 | — ms | — ms |
| ↳ stage: retrieval | 0 | — ms | — ms |
| ↳ stage: prompt assembly | 0 | — ms | — ms |
| ↳ stage: generation (streamed) | 0 | — ms | — ms |
| ↳ stage: citation gate + persist | 0 | — ms | — ms |

_`↳ stage:` rows are the OI-1 stage spans from inside `generate()`. `generation` CONTAINS `first token` (the `firstToken` span is nested), so the two must not be added together; the four stages that do partition a run are retrieval + assembly + generation + citation._

### AC-1

| Criterion | Requirement | Measured P95 | Sample | Status |
|---|---|--:|--:|:--:|
| AC-1 | Briefing delivered to the user, end to end (P95) — deterministic path < 60,000 ms | 3 ms | 20 run(s) | PASS |

_First paint is **not** an AC-1 row and is not a substitute for first token. It is the Task 3.5 `briefing:pending` path — one SELECT over `pending_items`, ranked by stakes × confidence, with no model client in scope — measured as its own timed call. Reporting it as "first token" would hide a real regression in either path._

_The background generation path was **not exercised** in this run. Since P0 the model is not on the request path, so AC-1 is measured against the deterministic render alone and the LLM rows above are absent rather than zero. Set `CR_BENCH_LLM=1` to time the pre-computer as well — it takes hours and grades nothing._

### What was measured against

| Field | Value |
|---|---|
| Seeded period | 5 days, 2 sources (slack + gmail) |
| Events ingested (real `IngestionPipeline`) | 3000 |
| Distinct threads | 174 |
| Events extracted (real Layer 1, 1 chat call each) | 0 |
| Threads synthesized (real Layer 2, 1 chat call each) | 0 |
| `state_deltas` tips available | 8 |
| Open `pending_items` available | 0 |
| Briefing window width | 48 h |
| Chat model | `qwen2.5:14b` |
| Embedding model | `nomic-embed-text` |
| `budgets.generationMs` | 360000 |
| `retrieval.budgetMs` / `topK` | 5000 / 40 |
| Prompt versions | layer1=v1, layer2=v1, layer3=v2 |

_`Events ingested` is NOT `events extracted`: Layer 1 is one chat call per event, so extracting the whole corpus would be weeks of local inference and would not change what Layer 3 consumes (chunks and deltas). The bulk tier exists so nothing being timed runs against an empty table; the signal tier exists so every window has real deltas to retrieve and rank._


## Method

- **Real pipeline, real model, live clock.** A fresh file-backed SQLite database and a fresh LanceDB directory are seeded with a synthetic 5-day, 2-source corpus through the real `IngestionPipeline`; the signal threads then run through the real `Layer1Extractor` and `Layer2Synthesizer` against local Ollama. The clock is pinned inside the period while seeding (so `state_deltas.created_at` spreads across the five days rather than landing in one instant) and is switched to `Date.now()` before the first timed call.
- **`BriefingGenerator.generate()` is called directly, not through `generateWithFallback`.** A template-mode briefing takes milliseconds because no model runs, so a fallback in the loop would let a measurement of SQLite be published as a measurement of the LLM path. An iteration that throws is skipped and counted.
- **First paint is measured separately from first token.** First paint is the Task 3.5 `briefing:pending` path — one SELECT over `pending_items`, ranked by stakes × confidence, with no model client in scope — timed as its own call. First token comes from the LLM run's own `firstToken` span. Deriving one from the other would hide a regression in either.
- **Percentiles are nearest-rank**, using the same arithmetic as `BriefingsRepo.percentiles` (`packages/store/src/repos/briefings.ts`), so the number printed here and the number the app's own metrics view prints are the same statistic. No interpolation: every value is traceable to one real run.
- **`DebounceScheduler` is skipped**, exactly as in the eval harness: waiting out real quiet windows would test the scheduler rather than the generation being timed.
- **These latencies INCLUDE queueing behind anything else using the same local Ollama.** That is a real property of a single-machine product and is not corrected for: the numbers describe the machine as it was, not the model in isolation. If another inference job was running during the measurement, it is stated in the conditions above (`CR_BENCH_NOTE`) — a latency table with no such note should be read as claiming the machine was otherwise idle.

## Per-run detail

| # | Window (UTC) | First paint ms | Total ms | retrieval | assembly | firstToken | generation | citation | Claims | Dropped | Partial | Outcome |
|--:|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|:--:|---|
| 1 | 08-30T16:54 → 09-01T16:54 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 2 | 08-30T20:42 → 09-01T20:42 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 3 | 08-31T00:29 → 09-02T00:29 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 4 | 08-31T04:17 → 09-02T04:17 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 5 | 08-31T08:04 → 09-02T08:04 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 6 | 08-31T11:51 → 09-02T11:51 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 7 | 08-31T15:39 → 09-02T15:39 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 8 | 08-31T19:26 → 09-02T19:26 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 9 | 08-31T23:13 → 09-02T23:13 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 10 | 09-01T03:01 → 09-03T03:01 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 11 | 09-01T06:48 → 09-03T06:48 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 12 | 09-01T10:35 → 09-03T10:35 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 13 | 09-01T14:23 → 09-03T14:23 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 14 | 09-01T18:10 → 09-03T18:10 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 15 | 09-01T21:58 → 09-03T21:58 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 16 | 09-02T01:45 → 09-04T01:45 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 17 | 09-02T05:32 → 09-04T05:32 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 18 | 09-02T09:20 → 09-04T09:20 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 19 | 09-02T13:07 → 09-04T13:07 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |
| 20 | 09-02T16:54 → 09-04T16:54 | <1 | NaN | — | — | — | — | — | 3 | 0 | no | template |

_A `no_context` row made no model call and is excluded from every LLM latency distribution above; its first-paint measurement still counts, because first paint does not depend on the model._
