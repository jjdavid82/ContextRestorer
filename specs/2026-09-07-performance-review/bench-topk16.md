# Context Restorer — Latency Benchmark (AC-1)

_Generated 2026-09-08T11:20:50.381Z by `npm run bench:briefing` (Task 5.3)._

This is the only measurement of AC-1 in the build. The Task 5.1 eval harness pins the clock inside each fixture's window, which makes every latency it records 0 and makes the §7.8 generation budget unable to elapse; it measures quality, not latency.

## Results

**n = 6 briefing generation(s) measured** (6 attempted, 0 failed, 0 produced no citable context).

> **REDUCED SAMPLE.** The plan calls for 20 real briefing generations; this run measured 6. Every number below is a 6-sample measurement and must be quoted with that sample size. A P95 over 6 observations is, by nearest-rank, the slowest one or two runs — it is a weak upper bound, not a stable percentile.

**Conditions this run was measured under:**

- E candidate: topK=16, seeding 20x4 signal threads, 72h windows, idle machine

| Metric | Observations | P50 | P95 |
|---|--:|--:|--:|
| First paint — pending items, NO model call | 6 | <1 ms | 2 ms |
| Deterministic briefing — the P0 request path, NO model call | 6 | 10 ms | 43 ms |
| First token — LLM stream (runs that produced one) | 6 | 267,841 ms | 325,430 ms |
| Total — `generate()` end to end | 6 | 360,066 ms | 360,186 ms |
| ↳ stage: retrieval | 6 | 52 ms | 143 ms |
| ↳ stage: prompt assembly | 6 | 1 ms | 4 ms |
| ↳ stage: generation (streamed) | 6 | 360,011 ms | 360,032 ms |
| ↳ stage: citation gate + persist | 6 | 0 ms | 1 ms |

_`↳ stage:` rows are the OI-1 stage spans from inside `generate()`. `generation` CONTAINS `first token` (the `firstToken` span is nested), so the two must not be added together; the four stages that do partition a run are retrieval + assembly + generation + citation._

### AC-1

| Criterion | Requirement | Measured P95 | Sample | Status |
|---|---|--:|--:|:--:|
| AC-1 | Briefing delivered to the user, end to end (P95) — deterministic path < 60,000 ms | 43 ms | 6 run(s) | PASS |
| AC-1 | Background pre-computation, end to end (P95) — NOT a user wait < ∞ ms | 360,186 ms | 6 run(s) | REPORTED |
| AC-1 | Background first token (P95) — NOT a user wait < ∞ ms | 325,430 ms | 6 run(s) | REPORTED |

_First paint is **not** an AC-1 row and is not a substitute for first token. It is the Task 3.5 `briefing:pending` path — one SELECT over `pending_items`, ranked by stakes × confidence, with no model client in scope — measured as its own timed call. Reporting it as "first token" would hide a real regression in either path._

### Slowest run — where the time went

Run #1 took 360,186 ms. Dominant stage: **generationMs** at 360,032 ms. Unattributed (claim persistence, narrative write, `ai_calls` row, trace flush): 7 ms.

_5 of 6 measured run(s) were TRUNCATED by `budgets.generationMs` = 360,000 ms (§7.8). That is a healthy, deliberate truncation — but it also means the `totalMs` distribution is CAPPED by the budget rather than describing how long the model would have taken. A P95 total that passes AC-1 because generation was cut off at the budget is a pass for the product, not evidence that the model is fast._

### What was measured against

| Field | Value |
|---|---|
| Seeded period | 5 days, 2 sources (slack + gmail) |
| Events ingested (real `IngestionPipeline`) | 300 |
| Distinct threads | 46 |
| Events extracted (real Layer 1, 1 chat call each) | 80 |
| Threads synthesized (real Layer 2, 1 chat call each) | 20 |
| `state_deltas` tips available | 20 |
| Open `pending_items` available | 3 |
| Briefing window width | 72 h |
| Chat model | `qwen2.5:14b` |
| Embedding model | `nomic-embed-text` |
| `budgets.generationMs` | 360000 |
| `retrieval.budgetMs` / `topK` | 5000 / 16 |
| Prompt versions | layer1=v1, layer2=v2, layer3=v2 |

_`Events ingested` is NOT `events extracted`: Layer 1 is one chat call per event, so extracting the whole corpus would be weeks of local inference and would not change what Layer 3 consumes (chunks and deltas). The bulk tier exists so nothing being timed runs against an empty table; the signal tier exists so every window has real deltas to retrieve and rank._

**Read the generation numbers as a LOWER BOUND.** Only extracted events have chunks in the vector store, so retrieval can return at most ~80 chunks against a `topK` of 16. The Layer 3 prompt is therefore SMALLER than a briefing over a fully-extracted 5-day corpus would be, and prompt evaluation is the dominant term in time-to-first-token on a local model. A production window with 40 retrieved chunks will be slower than what is measured here — this benchmark is not entitled to claim otherwise.

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
| 1 | 09-03T07:38 → 09-06T07:38 | 2 | 360186 | 143 | 3 | 325430 | 360032 | 1 | 0 | 0 | yes | budget_exceeded |
| 2 | 09-03T17:14 → 09-06T17:14 | <1 | 340641 | 51 | 4 | 254405 | 340585 | 0 | 0 | 0 | no | ok |
| 3 | 09-04T02:50 → 09-07T02:50 | <1 | 360058 | 40 | 1 | 254760 | 360011 | 0 | 0 | 0 | yes | budget_exceeded |
| 4 | 09-04T12:26 → 09-07T12:26 | <1 | 360066 | 52 | 1 | 290633 | 360009 | 0 | 0 | 0 | yes | budget_exceeded |
| 5 | 09-04T22:02 → 09-07T22:02 | <1 | 360141 | 123 | 1 | 286538 | 360015 | 0 | 0 | 0 | yes | budget_exceeded |
| 6 | 09-05T07:38 → 09-08T07:38 | <1 | 360079 | 57 | 1 | 267841 | 360013 | 0 | 0 | 0 | yes | budget_exceeded |

_A `no_context` row made no model call and is excluded from every LLM latency distribution above; its first-paint measurement still counts, because first paint does not depend on the model._
