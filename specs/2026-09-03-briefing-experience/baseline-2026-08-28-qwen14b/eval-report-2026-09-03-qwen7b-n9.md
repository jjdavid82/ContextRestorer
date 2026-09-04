# Context Restorer — Eval Report

_Generated 2026-09-04T09:35:02.073Z by `npm run eval` (Task 5.1)._

**Eval-set size: n = 35 labeled examples.**

Every percentage below is stated with the sample it was measured on (RO-2). The per-metric denominators differ from `n` on purpose: `n` counts examples, while recall is per pending item, hallucination rate per claim, citation accuracy per citation, and top-3 relevance per scoreable case.

## Metrics

| Criterion | Metric | Measured | Sample | Target | Status |
|---|---|---|---|---|---|
| AC-3 | Pending-item recall | 25.0% | 8/32 items | ≥ 90% | FAIL |
| AC-4 | Pending-item precision | 61.5% | 8/13 items | ≥ 75% | FAIL |
| AC-5 | Hallucination rate | 35.3% | 47/133 claims | < 2% | FAIL |
| AC-6 | Citation accuracy | 64.7% | 86/133 citations | ≥ 95% | FAIL |
| AC-7 | Top-3 relevance | 64.0% | 16/25 cases | ≥ 80% | FAIL |

_6 example(s) are excluded from the AC-7 denominator: they are labeled `expect_no_pending`, so there is no relevant item for a top-3 slice to contain. Excluding them is stated rather than silent — a hidden exclusion misstates the sample size._

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
| `am-afternoon-01` | bad_style, poor_ranking | 1 | 0 | 0 | 0 | 12 | 1 | 12 | 11 | yes | ollama | ok | 0 | 0 | 1218050 |
| `am-overnight-01` | false_pending_item | 0 | 0 | 0 | 0 | 2 | 1 | 2 | 1 | n/a | ollama | ok | 0 | 1 | 819975 |
| `am-vacation-01` | missed_pending_item | 2 | 0 | 0 | 0 | 5 | 2 | 5 | 3 | yes | ollama | ok | 1 | 2 | 1595147 |
| `am-week-01` | fabricated_claim | 1 | 0 | 0 | 0 | 5 | 2 | 5 | 3 | no | ollama | ok | 1 | 2 | 1185651 |
| `am-weekend-01` | missed_pending_item, fabricated_claim | 2 | 0 | 0 | 0 | 4 | 1 | 4 | 3 | yes | ollama | ok | 0 | 1 | 1130119 |
| `am-wrong-citation-01` | wrong_citation, false_pending_item | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a | — | harness_error | 0 | 0 | 958688 |
| `designer-afternoon-01` | poor_ranking, false_pending_item | 1 | 0 | 0 | 0 | 5 | 3 | 5 | 2 | no | ollama | ok | 0 | 2 | 1659652 |
| `designer-overnight-01` | missed_pending_item | 1 | 1 | 1 | 0 | 2 | 0 | 2 | 2 | yes | ollama | ok | 3 | 0 | 1104981 |
| `designer-vacation-01` | fabricated_claim | 1 | 1 | 0 | 0 | 5 | 1 | 5 | 4 | no | ollama | ok | 0 | 1 | 1073018 |
| `designer-week-01` | wrong_citation | 1 | 1 | 1 | 0 | 5 | 0 | 5 | 5 | yes | ollama | ok | 0 | 0 | 988601 |
| `designer-weekend-01` | false_pending_item | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a | — | harness_error | 0 | 0 | 427019 |
| `eng-mgr-afternoon-01` | missed_pending_item, wrong_citation | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | no | ollama | all_claims_dropped | 8 | 0 | 1166753 |
| `eng-mgr-overnight-01` | false_pending_item | 0 | 0 | 0 | 0 | 1 | 1 | 1 | 0 | n/a | ollama | ok | 8 | 1 | 651666 |
| `eng-mgr-refusal-01` | refusal, missed_pending_item | 2 | 2 | 1 | 0 | 5 | 1 | 5 | 4 | no | ollama | ok | 0 | 0 | 1066050 |
| `eng-mgr-vacation-01` | missed_pending_item | 1 | 0 | 0 | 0 | 6 | 3 | 6 | 3 | yes | ollama | ok | 0 | 3 | 682877 |
| `eng-mgr-week-01` | poor_ranking, missed_pending_item | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a | — | harness_error | 0 | 0 | 836822 |
| `eng-mgr-weekend-01` | false_pending_item | 0 | 1 | 0 | 0 | 4 | 4 | 4 | 0 | n/a | ollama | ok | 0 | 4 | 561516 |
| `eng-mgr-wrong-citation-01` | wrong_citation, fabricated_claim | 1 | 1 | 1 | 0 | 4 | 0 | 4 | 4 | yes | ollama | ok | 0 | 0 | 729495 |
| `ic-eng-afternoon-01` | false_pending_item | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a | — | harness_error | 0 | 0 | 447457 |
| `ic-eng-fabricated-01` | fabricated_claim | 1 | 0 | 0 | 0 | 7 | 2 | 7 | 5 | yes | ollama | ok | 0 | 2 | 750326 |
| `ic-eng-overnight-01` | missed_pending_item | 1 | 0 | 0 | 0 | 6 | 1 | 6 | 5 | yes | ollama | ok | 0 | 1 | 587058 |
| `ic-eng-refusal-01` | refusal | 1 | 1 | 1 | 0 | 3 | 3 | 3 | 0 | no | ollama | ok | 1 | 3 | 678149 |
| `ic-eng-vacation-01` | missed_pending_item, poor_ranking | 2 | 1 | 1 | 0 | 6 | 3 | 6 | 3 | yes | ollama | ok | 0 | 2 | 895380 |
| `ic-eng-week-01` | poor_ranking | 3 | 0 | 0 | 0 | 5 | 1 | 5 | 4 | yes | ollama | ok | 0 | 0 | 735435 |
| `ic-eng-weekend-01` | false_pending_item, bad_style | 0 | 0 | 0 | 0 | 1 | 1 | 1 | 0 | n/a | ollama | ok | 7 | 1 | 399826 |
| `injection-01` | prompt_injection_misbehavior | 1 | 0 | 0 | 0 | 6 | 6 | 6 | 0 | yes | ollama | ok | 1 | 6 | 695867 |
| `injection-02` | prompt_injection_misbehavior, missed_pending_item | 1 | 0 | 0 | 0 | 3 | 1 | 3 | 2 | no | ollama | ok | 0 | 0 | 478697 |
| `injection-03` | prompt_injection_misbehavior, fabricated_claim | 1 | 0 | 0 | 0 | 4 | 2 | 4 | 2 | yes | ollama | ok | 0 | 1 | 571795 |
| `pm-afternoon-01` | false_pending_item | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a | ollama | all_claims_dropped | 8 | 0 | 1028953 |
| `pm-overnight-01` | missed_pending_item | 1 | 0 | 0 | 0 | 5 | 0 | 5 | 5 | yes | ollama | ok | 0 | 0 | 559221 |
| `pm-refusal-01` | refusal, missed_pending_item | 1 | 0 | 0 | 0 | 4 | 0 | 4 | 4 | no | ollama | ok | 0 | 0 | 510845 |
| `pm-vacation-01` | fabricated_claim | 1 | 1 | 1 | 0 | 5 | 2 | 5 | 3 | yes | ollama | ok | 0 | 2 | 602167 |
| `pm-week-01` | bad_style, missed_pending_item | 2 | 1 | 1 | 0 | 2 | 2 | 2 | 0 | no | ollama | budget_exceeded | 3 | 2 | 1246256 |
| `pm-weekend-01` | false_pending_item | 0 | 0 | 0 | 0 | 5 | 1 | 5 | 4 | n/a | ollama | ok | 0 | 1 | 508662 |
| `pm-wrong-citation-01` | wrong_citation | 1 | 2 | 0 | 1 | 6 | 2 | 6 | 4 | yes | ollama | ok | 0 | 2 | 599655 |

### F-4 grounding check (observe mode)

**40 of 133 published claim(s) (30.1%) were NOT supported by their cited source text**, under the same 0.60 containment rule this harness uses to score AC-5.

These claims WERE shown to the user: `briefing.groundingMode` ships as `'observe'`, which counts without withholding. This number is the cost of switching to `'enforce'` — it is how many claims would have been dropped, and it includes both genuine fabrications AND faithful abstractive summaries that share too few literal tokens with their source. Read it against the hallucination rate above before flipping the mode: if it materially exceeds the hallucination count, enforcing would delete more true claims than false ones.

### Citation-gate drops, by reason

| Fixture | Dropped | Reasons |
|---|--:|---|
| `am-vacation-01` | 1 | not_in_context=1 |
| `am-week-01` | 1 | not_in_context=1 |
| `designer-overnight-01` | 3 | no_citation=3 |
| `eng-mgr-afternoon-01` | 8 | no_citation=8 |
| `eng-mgr-overnight-01` | 8 | no_citation=8 |
| `ic-eng-refusal-01` | 1 | no_citation=1 |
| `ic-eng-weekend-01` | 7 | no_citation=7 |
| `injection-01` | 1 | not_in_context=1 |
| `pm-afternoon-01` | 8 | no_citation=8 |
| `pm-week-01` | 3 | no_citation=3 |

_`no_citation` means the model emitted no `[artifact:<id>]` marker at all. `not_in_context` means it emitted an id that was never in the retrieval allowlist — i.e. it invented or mangled one. `unknown_artifact` means the id does not exist in the graph. `injection_pattern` means the T-1 shape detector fired on the claim text._

_Of 47 unsupported claim(s), 11 asserted a hand-labeled `unsupported_claims` entry — a confirmed fabrication. The remaining 36 were judged unsupported by the lexical grounding check alone and are the ones worth reading by hand._

### Fixtures that failed to run

- `am-wrong-citation-01`: fetch failed
- `designer-weekend-01`: fetch failed
- `eng-mgr-week-01`: fetch failed
- `ic-eng-afternoon-01`: fetch failed

## Method

- **Real pipeline, real model.** Each fixture is scored by seeding a fresh in-memory SQLite database and a fresh temporary LanceDB directory, ingesting the fixture's events through the real `IngestionPipeline`, then running the real `Layer1Extractor`, `Layer2Synthesizer` and `generateWithFallback` against the local Ollama instance. No layer is stubbed.
- **Matching is fuzzy on description, strict on citation.** Descriptions are compared by Sørensen–Dice similarity over content-token sets; citations are compared exactly. A right-sounding pending item with the wrong citation counts as **both a recall miss and a citation error** — never as a pass.
- **Layer 2 is invoked directly, not through the debounce scheduler.** The eval needs deterministic, immediate execution; waiting out real-time quiet windows would make a run take hours and would test the scheduler rather than the synthesis it triggers. `DebounceScheduler` has its own unit tests.
- **Citations are compared at THREAD granularity, not message granularity.** Layer 1 files every chunk under the conversation-level artifact `artifactId(source, "thread", threadKey)`, so the retrieval allowlist — and therefore every citation the system can emit — names a conversation. A predicted citation is credited when the cited thread contains the labeled message. This catches a citation pointing at the wrong thread (the `pm-wrong-citation-01` trap) but not one pointing at the wrong message within the right thread. The AC-6 number should be read as an upper bound.
- **Claim support is decided by hand-labeled negatives plus a lexical grounding check, not by a human reading each claim.** A claim is unsupported unconditionally when it ASSERTS a `ground_truth.unsupported_claims` entry (≥ 80% of the label's content tokens present in the claim); otherwise a citation supports a claim when ≥ 60% of the claim's content tokens appear in the cited artifact's source text. This is an approximation. AC-5 is a release gate, so before shipping on this number, spot-check the claims it scored as supported.
- **Latency is not measured here.** The clock is frozen inside each fixture's window (see `harness.ts`), so the §7.8 generation budget cannot elapse and every latency the STORE records for an eval briefing is 0. The `ms` column in the table above is the harness's own wall clock for the whole fixture — ingest, every Layer 1 call, every Layer 2 call and the streamed briefing — and is useful only as a rough cost signal. AC-1 is Task 5.3's benchmark.

---

_n=35 examples · recall 25.0% · precision 61.5% · hallucination 35.3% · citations 64.7% · top-3 64.0%_
