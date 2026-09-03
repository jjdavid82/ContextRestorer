# Context Restorer — Latency Benchmark (AC-1)

_Generated 2026-09-03T22:53:15.670Z by `npm run bench:briefing` (Task 5.3)._

This is the only measurement of AC-1 in the build. The Task 5.1 eval harness pins the clock inside each fixture's window, which makes every latency it records 0 and makes the §7.8 generation budget unable to elapse; it measures quality, not latency.

## Results

**n = 20 briefing generation(s) measured** (20 attempted, 0 failed, 0 produced no citable context).

| Metric | Observations | P50 | P95 |
|---|--:|--:|--:|
| First paint — pending items, NO model call | 20 | <1 ms | <1 ms |
| First token — LLM stream (runs that produced one) | 20 | 77,593 ms | 97,925 ms |
| Total — `generate()` end to end | 20 | 322,602 ms | 360,920 ms |
| ↳ stage: retrieval | 20 | 604 ms | 906 ms |
| ↳ stage: prompt assembly | 20 | 0 ms | 1 ms |
| ↳ stage: generation (streamed) | 20 | 322,495 ms | 360,012 ms |
| ↳ stage: citation gate + persist | 20 | 3 ms | 6 ms |

_`↳ stage:` rows are the OI-1 stage spans from inside `generate()`. `generation` CONTAINS `first token` (the `firstToken` span is nested), so the two must not be added together; the four stages that do partition a run are retrieval + assembly + generation + citation._

### AC-1

| Criterion | Requirement | Measured P95 | Sample | Status |
|---|---|--:|--:|:--:|
| AC-1 | Briefing generation, end to end (P95) < 60,000 ms | 360,920 ms | 20 run(s) | FAIL |
| AC-1 | Time to first LLM token (P95) < 5,000 ms | 97,925 ms | 20 run(s) | FAIL |

_First paint is **not** an AC-1 row and is not a substitute for first token. It is the Task 3.5 `briefing:pending` path — one SELECT over `pending_items`, ranked by stakes × confidence, with no model client in scope — measured as its own timed call. Reporting it as "first token" would hide a real regression in either path._

### Slowest run — where the time went

Run #4 took 360,922 ms. Dominant stage: **generationMs** at 360,004 ms. Unattributed (claim persistence, narrative write, `ai_calls` row, trace flush): 2 ms.

_7 of 20 measured run(s) were TRUNCATED by `budgets.generationMs` = 360,000 ms (§7.8). That is a healthy, deliberate truncation — but it also means the `totalMs` distribution is CAPPED by the budget rather than describing how long the model would have taken. A P95 total that passes AC-1 because generation was cut off at the budget is a pass for the product, not evidence that the model is fast._

### What was measured against

| Field | Value |
|---|---|
| Seeded period | 5 days, 2 sources (slack + gmail) |
| Events ingested (real `IngestionPipeline`) | 3000 |
| Distinct threads | 174 |
| Events extracted (real Layer 1, 1 chat call each) | 24 |
| Threads synthesized (real Layer 2, 1 chat call each) | 8 |
| `state_deltas` tips available | 8 |
| Open `pending_items` available | 0 |
| Briefing window width | 48 h |
| Chat model | `qwen2.5:7b` |
| Embedding model | `nomic-embed-text` |
| `budgets.generationMs` | 360000 |
| `retrieval.budgetMs` / `topK` | 5000 / 40 |
| Prompt versions | layer1=v1, layer2=v1, layer3=v1 |

_`Events ingested` is NOT `events extracted`: Layer 1 is one chat call per event, so extracting the whole corpus would be weeks of local inference and would not change what Layer 3 consumes (chunks and deltas). The bulk tier exists so nothing being timed runs against an empty table; the signal tier exists so every window has real deltas to retrieve and rank._

**Read the generation numbers as a LOWER BOUND.** Only extracted events have chunks in the vector store, so retrieval can return at most ~24 chunks against a `topK` of 40. The Layer 3 prompt is therefore SMALLER than a briefing over a fully-extracted 5-day corpus would be, and prompt evaluation is the dominant term in time-to-first-token on a local 14B model. A production window with 40 retrieved chunks will be slower than what is measured here — this benchmark is not entitled to claim otherwise.

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
| 1 | 08-29T20:45 → 08-31T20:45 | <1 | 360109 | 68 | 2 | 97925 | 360012 | 17 | 8 | 0 | yes | budget_exceeded |
| 2 | 08-30T00:33 → 09-01T00:33 | <1 | 360644 | 626 | 1 | 78742 | 360008 | 3 | 8 | 0 | yes | budget_exceeded |
| 3 | 08-30T04:20 → 09-01T04:20 | <1 | 360920 | 894 | 1 | 108230 | 360016 | 3 | 6 | 0 | yes | budget_exceeded |
| 4 | 08-30T08:08 → 09-01T08:08 | <1 | 360922 | 909 | 1 | 81794 | 360004 | 6 | 10 | 0 | yes | budget_exceeded |
| 5 | 08-30T11:55 → 09-01T11:55 | <1 | 317807 | 607 | 0 | 77593 | 317193 | 2 | 8 | 1 | no | ok |
| 6 | 08-30T15:42 → 09-01T15:42 | <1 | 126894 | 609 | 0 | 75867 | 126283 | 1 | 0 | 9 | no | all_claims_dropped |
| 7 | 08-30T19:30 → 09-01T19:30 | <1 | 360078 | 61 | 0 | 96247 | 360010 | 3 | 9 | 0 | yes | budget_exceeded |
| 8 | 08-30T23:17 → 09-01T23:17 | <1 | 354451 | 906 | 0 | 76219 | 353541 | 2 | 10 | 0 | no | ok |
| 9 | 08-31T03:04 → 09-02T03:04 | <1 | 360620 | 608 | 1 | 76159 | 360002 | 5 | 8 | 0 | yes | budget_exceeded |
| 10 | 08-31T06:52 → 09-02T06:52 | <1 | 360904 | 894 | 1 | 82582 | 360002 | 4 | 9 | 0 | yes | budget_exceeded |
| 11 | 08-31T10:39 → 09-02T10:39 | <1 | 289884 | 618 | 0 | 88048 | 289261 | 3 | 10 | 0 | no | ok |
| 12 | 08-31T14:27 → 09-02T14:27 | <1 | 322602 | 98 | 1 | 83022 | 322495 | 4 | 10 | 0 | no | ok |
| 13 | 08-31T18:14 → 09-02T18:14 | <1 | 332080 | 604 | 1 | 84993 | 331469 | 4 | 10 | 0 | no | ok |
| 14 | 08-31T22:01 → 09-02T22:01 | <1 | 301513 | 592 | 0 | 74843 | 300914 | 3 | 10 | 0 | no | ok |
| 15 | 09-01T01:49 → 09-03T01:49 | <1 | 359326 | 605 | 0 | 94658 | 358717 | 1 | 4 | 0 | no | ok |
| 16 | 09-01T05:36 → 09-03T05:36 | <1 | 268363 | 595 | 1 | 70965 | 267762 | 2 | 8 | 0 | no | ok |
| 17 | 09-01T09:23 → 09-03T09:23 | <1 | 249547 | 58 | 0 | 70831 | 249485 | 3 | 8 | 0 | no | ok |
| 18 | 09-01T13:11 → 09-03T13:11 | <1 | 279769 | 60 | 1 | 68737 | 279704 | 2 | 8 | 0 | no | ok |
| 19 | 09-01T16:58 → 09-03T16:58 | <1 | 254000 | 72 | 0 | 70074 | 253923 | 3 | 3 | 2 | no | ok |
| 20 | 09-01T20:45 → 09-03T20:45 | <1 | 268013 | 67 | 0 | 72048 | 267939 | 3 | 8 | 0 | no | ok |

_A `no_context` row made no model call and is excluded from every LLM latency distribution above; its first-paint measurement still counts, because first paint does not depend on the model._
