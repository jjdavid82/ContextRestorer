# Context Restorer — Latency Benchmark (AC-1)

_Generated 2026-08-28T01:44:17.193Z by `npm run bench:briefing` (Task 5.3)._

This is the only measurement of AC-1 in the build. The Task 5.1 eval harness pins the clock inside each fixture's window, which makes every latency it records 0 and makes the §7.8 generation budget unable to elapse; it measures quality, not latency.

## Results

**n = 20 briefing generation(s) measured** (20 attempted, 0 failed, 0 produced no citable context).

**Conditions this run was measured under:**

- Measured while a separate multi-hour eval job (Task 5.1's full fixture pass) was streaming against the SAME local Ollama instance. Every latency below therefore includes queueing behind that job: these are contended-machine numbers, not idle-machine numbers.

| Metric | Observations | P50 | P95 |
|---|--:|--:|--:|
| First paint — pending items, NO model call | 20 | <1 ms | <1 ms |
| First token — LLM stream (runs that produced one) | 19 | 107,864 ms | 254,393 ms |
| Total — `generate()` end to end | 20 | 107,968 ms | 254,501 ms |
| ↳ stage: retrieval | 20 | 82 ms | 139 ms |
| ↳ stage: prompt assembly | 20 | 0 ms | 1 ms |
| ↳ stage: generation (streamed) | 20 | 107,865 ms | 254,394 ms |
| ↳ stage: citation gate + persist | 20 | 0 ms | 0 ms |

_`↳ stage:` rows are the OI-1 stage spans from inside `generate()`. `generation` CONTAINS `first token` (the `firstToken` span is nested), so the two must not be added together; the four stages that do partition a run are retrieval + assembly + generation + citation._

### AC-1

| Criterion | Requirement | Measured P95 | Sample | Status |
|---|---|--:|--:|:--:|
| AC-1 | Briefing generation, end to end (P95) < 60,000 ms | 254,501 ms | 20 run(s) | FAIL |
| AC-1 | Time to first LLM token (P95) < 5,000 ms | 254,393 ms | 19 run(s) | FAIL |

_First paint is **not** an AC-1 row and is not a substitute for first token. It is the Task 3.5 `briefing:pending` path — one SELECT over `pending_items`, ranked by stakes × confidence, with no model client in scope — measured as its own timed call. Reporting it as "first token" would hide a real regression in either path._

### Slowest run — where the time went

Run #2 took 304,464 ms. Dominant stage: **generationMs** at 304,363 ms. Unattributed (claim persistence, narrative write, `ai_calls` row, trace flush): 3 ms.

_1 of 20 measured run(s) produced **no token at all** (`outcome: 'error'` — the stream failed before the model emitted anything). Those runs are counted in `Total` (the user really did wait) and EXCLUDED from `First token`, because the `firstToken` span on such a run measures a wait for something that never arrived. Publishing it as a time-to-first-token would report a latency for an event that did not happen._

_20 of 20 measured run(s) were TRUNCATED by `budgets.generationMs` = 30,000 ms (§7.8). That is a healthy, deliberate truncation — but it also means the `totalMs` distribution is CAPPED by the budget rather than describing how long the model would have taken. A P95 total that passes AC-1 because generation was cut off at the budget is a pass for the product, not evidence that the model is fast._

### What was measured against

| Field | Value |
|---|---|
| Seeded period | 5 days, 2 sources (slack + gmail) |
| Events ingested (real `IngestionPipeline`) | 3000 |
| Distinct threads | 338 |
| Events extracted (real Layer 1, 1 chat call each) | 8 |
| Threads synthesized (real Layer 2, 1 chat call each) | 4 |
| `state_deltas` tips available | 4 |
| Open `pending_items` available | 4 |
| Briefing window width | 48 h |
| Chat model | `qwen2.5:14b` |
| Embedding model | `nomic-embed-text` |
| `budgets.generationMs` | 30000 |
| `retrieval.budgetMs` / `topK` | 5000 / 40 |
| Prompt versions | layer1=v1, layer2=v1, layer3=v1 |

_`Events ingested` is NOT `events extracted`: Layer 1 is one chat call per event, so extracting the whole corpus would be weeks of local inference and would not change what Layer 3 consumes (chunks and deltas). The bulk tier exists so nothing being timed runs against an empty table; the signal tier exists so every window has real deltas to retrieve and rank._

**Read the generation numbers as a LOWER BOUND.** Only extracted events have chunks in the vector store, so retrieval can return at most ~8 chunks against a `topK` of 40. The Layer 3 prompt is therefore SMALLER than a briefing over a fully-extracted 5-day corpus would be, and prompt evaluation is the dominant term in time-to-first-token on a local 14B model. A production window with 40 retrieved chunks will be slower than what is measured here — this benchmark is not entitled to claim otherwise.

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
| 1 | 08-23T00:22 → 08-25T00:22 | <1 | 187692 | 56 | 2 | 187620 | 187626 | 0 | 0 | 0 | yes | budget_exceeded |
| 2 | 08-23T04:09 → 08-25T04:09 | <1 | 304464 | 98 | 0 | 304362 | 304363 | 0 | 0 | 0 | yes | error |
| 3 | 08-23T07:57 → 08-25T07:57 | <1 | 86109 | 934 | 1 | 85167 | 85168 | 0 | 0 | 0 | yes | budget_exceeded |
| 4 | 08-23T11:44 → 08-25T11:44 | <1 | 128234 | 82 | 1 | 128148 | 128148 | 0 | 0 | 0 | yes | budget_exceeded |
| 5 | 08-23T15:31 → 08-25T15:31 | <1 | 117231 | 139 | 0 | 117087 | 117087 | 0 | 0 | 0 | yes | budget_exceeded |
| 6 | 08-23T19:19 → 08-25T19:19 | <1 | 89743 | 83 | 1 | 89655 | 89655 | 1 | 0 | 0 | yes | budget_exceeded |
| 7 | 08-23T23:06 → 08-25T23:06 | <1 | 86943 | 76 | 0 | 86861 | 86862 | 0 | 0 | 0 | yes | budget_exceeded |
| 8 | 08-24T02:53 → 08-26T02:53 | <1 | 93684 | 82 | 1 | 93597 | 93598 | 0 | 0 | 0 | yes | budget_exceeded |
| 9 | 08-24T06:41 → 08-26T06:41 | <1 | 133348 | 85 | 0 | 133258 | 133258 | 0 | 0 | 0 | yes | budget_exceeded |
| 10 | 08-24T10:28 → 08-26T10:28 | <1 | 251107 | 80 | 0 | 251023 | 251024 | 0 | 0 | 0 | yes | budget_exceeded |
| 11 | 08-24T14:15 → 08-26T14:15 | <1 | 105074 | 107 | 0 | 104961 | 104961 | 0 | 0 | 0 | yes | budget_exceeded |
| 12 | 08-24T18:03 → 08-26T18:03 | <1 | 254501 | 77 | 0 | 254393 | 254394 | 0 | 0 | 0 | yes | budget_exceeded |
| 13 | 08-24T21:50 → 08-26T21:50 | <1 | 101145 | 75 | 1 | 101062 | 101062 | 0 | 0 | 0 | yes | budget_exceeded |
| 14 | 08-25T01:38 → 08-27T01:38 | <1 | 98299 | 94 | 0 | 98201 | 98201 | 0 | 0 | 0 | yes | budget_exceeded |
| 15 | 08-25T05:25 → 08-27T05:25 | <1 | 95759 | 79 | 1 | 95673 | 95674 | 0 | 0 | 0 | yes | budget_exceeded |
| 16 | 08-25T09:12 → 08-27T09:12 | <1 | 92559 | 75 | 1 | 92479 | 92479 | 0 | 0 | 0 | yes | budget_exceeded |
| 17 | 08-25T13:00 → 08-27T13:00 | <1 | 127947 | 86 | 1 | 127855 | 127856 | 0 | 0 | 0 | yes | budget_exceeded |
| 18 | 08-25T16:47 → 08-27T16:47 | <1 | 218703 | 94 | 0 | 218602 | 218603 | 0 | 0 | 0 | yes | budget_exceeded |
| 19 | 08-25T20:34 → 08-27T20:34 | <1 | 203185 | 72 | 0 | 203107 | 203107 | 0 | 0 | 0 | yes | budget_exceeded |
| 20 | 08-26T00:22 → 08-28T00:22 | <1 | 107968 | 99 | 0 | 107864 | 107865 | 0 | 0 | 0 | yes | budget_exceeded |

_A `no_context` row made no model call and is excluded from every LLM latency distribution above; its first-paint measurement still counts, because first paint does not depend on the model._
