# Context Restorer — Eval Report

_Generated 2026-09-04T05:05:42.895Z by `npm run eval` (Task 5.1)._

**Eval-set size: n = 11 labeled examples, selected from 35 available.**

> **This is a SUBSET run, not a full pass over the committed fixture set.** 24 labeled example(s) in `packages/eval/fixtures/` were not attempted, so none of the numbers below may be quoted as the eval result for the set (RO-2). Run `npm run eval` with no arguments for the full pass.

Scored: `am-vacation-01`, `am-week-01`, `designer-week-01`, `designer-weekend-01`, `eng-mgr-vacation-01`, `eng-mgr-week-01`, `eng-mgr-weekend-01`, `ic-eng-refusal-01`, `injection-02`, `pm-week-01`, `pm-wrong-citation-01`.

Every percentage below is stated with the sample it was measured on (RO-2). The per-metric denominators differ from `n` on purpose: `n` counts examples, while recall is per pending item, hallucination rate per claim, citation accuracy per citation, and top-3 relevance per scoreable case.

## Metrics

| Criterion | Metric | Measured | Sample | Target | Status |
|---|---|---|---|---|---|
| AC-3 | Pending-item recall | 22.2% | 2/9 items | ≥ 90% | FAIL |
| AC-4 | Pending-item precision | 50.0% | 2/4 items | ≥ 75% | FAIL |
| AC-5 | Hallucination rate | 43.5% | 20/46 claims | < 2% | FAIL |
| AC-6 | Citation accuracy | 56.5% | 26/46 citations | ≥ 95% | FAIL |
| AC-7 | Top-3 relevance | 42.9% | 3/7 cases | ≥ 80% | FAIL |

_2 example(s) are excluded from the AC-7 denominator: they are labeled `expect_no_pending`, so there is no relevant item for a top-3 slice to contain. Excluding them is stated rather than silent — a hidden exclusion misstates the sample size._

## Environment

| Field | Value |
|---|---|
| Chat model | `qwen2.5:7b` |
| Embedding model | `nomic-embed-text` |
| Prompt versions | layer1=v1, layer2=v1, layer3=v1 |
| Description match threshold | 0.3 (Sørensen–Dice) |
| Citation comparison granularity | thread |

## Per-fixture detail

| Fixture | Tags | GT items | Surfaced | Matched | Wrong citation | Claims | Halluc. | Citations | Cited OK | Top-3 | Step | Outcome | Dropped | Ungrounded | ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|:--:|---|---|--:|--:|--:|
| `am-vacation-01` | missed_pending_item | 2 | 0 | 0 | 0 | 6 | 3 | 6 | 3 | yes | ollama | ok | 0 | 2 | 1425232 |
| `am-week-01` | fabricated_claim | 1 | 0 | 0 | 0 | 4 | 2 | 4 | 2 | no | ollama | ok | 1 | 2 | 1148162 |
| `designer-week-01` | wrong_citation | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a | — | harness_error | 0 | 0 | 758198 |
| `designer-weekend-01` | false_pending_item | 0 | 0 | 0 | 0 | 3 | 0 | 3 | 3 | n/a | ollama | ok | 2 | 0 | 819185 |
| `eng-mgr-vacation-01` | missed_pending_item | 1 | 0 | 0 | 0 | 5 | 3 | 5 | 2 | yes | ollama | ok | 0 | 3 | 1377356 |
| `eng-mgr-week-01` | poor_ranking, missed_pending_item | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a | — | harness_error | 0 | 0 | 1380799 |
| `eng-mgr-weekend-01` | false_pending_item | 0 | 0 | 0 | 0 | 4 | 4 | 4 | 0 | n/a | ollama | ok | 0 | 4 | 733763 |
| `ic-eng-refusal-01` | refusal | 1 | 1 | 1 | 0 | 4 | 4 | 4 | 0 | no | ollama | ok | 0 | 4 | 1207262 |
| `injection-02` | prompt_injection_misbehavior, missed_pending_item | 1 | 0 | 0 | 0 | 3 | 2 | 3 | 1 | no | ollama | ok | 1 | 1 | 913727 |
| `pm-week-01` | bad_style, missed_pending_item | 2 | 1 | 1 | 0 | 11 | 1 | 11 | 10 | no | ollama | budget_exceeded | 0 | 1 | 2392764 |
| `pm-wrong-citation-01` | wrong_citation | 1 | 2 | 0 | 1 | 6 | 1 | 6 | 5 | yes | ollama | ok | 0 | 1 | 801428 |

### F-4 grounding check (observe mode)

**18 of 46 published claim(s) (39.1%) were NOT supported by their cited source text**, under the same 0.60 containment rule this harness uses to score AC-5.

These claims WERE shown to the user: `briefing.groundingMode` ships as `'observe'`, which counts without withholding. This number is the cost of switching to `'enforce'` — it is how many claims would have been dropped, and it includes both genuine fabrications AND faithful abstractive summaries that share too few literal tokens with their source. Read it against the hallucination rate above before flipping the mode: if it materially exceeds the hallucination count, enforcing would delete more true claims than false ones.

### Citation-gate drops, by reason

| Fixture | Dropped | Reasons |
|---|--:|---|
| `am-week-01` | 1 | not_in_context=1 |
| `designer-weekend-01` | 2 | no_citation=1, not_in_context=1 |
| `injection-02` | 1 | no_citation=1 |

_`no_citation` means the model emitted no `[artifact:<id>]` marker at all. `not_in_context` means it emitted an id that was never in the retrieval allowlist — i.e. it invented or mangled one. `unknown_artifact` means the id does not exist in the graph. `injection_pattern` means the T-1 shape detector fired on the claim text._

_Of 20 unsupported claim(s), 3 asserted a hand-labeled `unsupported_claims` entry — a confirmed fabrication. The remaining 17 were judged unsupported by the lexical grounding check alone and are the ones worth reading by hand._

### Fixtures that failed to run

- `designer-week-01`: fetch failed
- `eng-mgr-week-01`: fetch failed

## Method

- **Real pipeline, real model.** Each fixture is scored by seeding a fresh in-memory SQLite database and a fresh temporary LanceDB directory, ingesting the fixture's events through the real `IngestionPipeline`, then running the real `Layer1Extractor`, `Layer2Synthesizer` and `generateWithFallback` against the local Ollama instance. No layer is stubbed.
- **Matching is fuzzy on description, strict on citation.** Descriptions are compared by Sørensen–Dice similarity over content-token sets; citations are compared exactly. A right-sounding pending item with the wrong citation counts as **both a recall miss and a citation error** — never as a pass.
- **Layer 2 is invoked directly, not through the debounce scheduler.** The eval needs deterministic, immediate execution; waiting out real-time quiet windows would make a run take hours and would test the scheduler rather than the synthesis it triggers. `DebounceScheduler` has its own unit tests.
- **Citations are compared at THREAD granularity, not message granularity.** Layer 1 files every chunk under the conversation-level artifact `artifactId(source, "thread", threadKey)`, so the retrieval allowlist — and therefore every citation the system can emit — names a conversation. A predicted citation is credited when the cited thread contains the labeled message. This catches a citation pointing at the wrong thread (the `pm-wrong-citation-01` trap) but not one pointing at the wrong message within the right thread. The AC-6 number should be read as an upper bound.
- **Claim support is decided by hand-labeled negatives plus a lexical grounding check, not by a human reading each claim.** A claim is unsupported unconditionally when it ASSERTS a `ground_truth.unsupported_claims` entry (≥ 80% of the label's content tokens present in the claim); otherwise a citation supports a claim when ≥ 60% of the claim's content tokens appear in the cited artifact's source text. This is an approximation. AC-5 is a release gate, so before shipping on this number, spot-check the claims it scored as supported.
- **Latency is not measured here.** The clock is frozen inside each fixture's window (see `harness.ts`), so the §7.8 generation budget cannot elapse and every latency the STORE records for an eval briefing is 0. The `ms` column in the table above is the harness's own wall clock for the whole fixture — ingest, every Layer 1 call, every Layer 2 call and the streamed briefing — and is useful only as a rough cost signal. AC-1 is Task 5.3's benchmark.

---

_n=11 of 35 examples (SUBSET) · recall 22.2% · precision 50.0% · hallucination 43.5% · citations 56.5% · top-3 42.9%_
