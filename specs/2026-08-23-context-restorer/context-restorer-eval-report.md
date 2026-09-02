# Context Restorer — Eval Report

_Generated 2026-08-28T06:58:46.396Z by `npm run eval` (Task 5.1)._

**Eval-set size: n = 35 labeled examples.**

Every percentage below is stated with the sample it was measured on (RO-2). The per-metric denominators differ from `n` on purpose: `n` counts examples, while recall is per pending item, hallucination rate per claim, citation accuracy per citation, and top-3 relevance per scoreable case.

## Metrics

| Criterion | Metric | Measured | Sample | Target | Status |
|---|---|---|---|---|---|
| AC-3 | Pending-item recall | 33.3% | 12/36 items | ≥ 90% | FAIL |
| AC-4 | Pending-item precision | 48.0% | 12/25 items | ≥ 75% | FAIL |
| AC-5 | Hallucination rate | 23.6% | 34/144 claims | < 2% | FAIL |
| AC-6 | Citation accuracy | 76.4% | 110/144 citations | ≥ 95% | FAIL |
| AC-7 | Top-3 relevance | 73.1% | 19/26 cases | ≥ 80% | FAIL |

_8 example(s) are excluded from the AC-7 denominator: they are labeled `expect_no_pending`, so there is no relevant item for a top-3 slice to contain. Excluding them is stated rather than silent — a hidden exclusion misstates the sample size._

## Environment

| Field | Value |
|---|---|
| Chat model | `qwen2.5:14b` |
| Embedding model | `nomic-embed-text` |
| Prompt versions | layer1=v1, layer2=v1, layer3=v1 |
| Description match threshold | 0.3 (Sørensen–Dice) |
| Citation comparison granularity | thread |

## Per-fixture detail

| Fixture | Tags | GT items | Surfaced | Matched | Wrong citation | Claims | Halluc. | Citations | Cited OK | Top-3 | Step | Outcome | Dropped | ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|:--:|---|---|--:|--:|
| `am-afternoon-01` | bad_style, poor_ranking | 1 | 1 | 0 | 0 | 10 | 1 | 10 | 9 | yes | ollama | ok | 0 | 1480013 |
| `am-overnight-01` | false_pending_item | 0 | 0 | 0 | 0 | 3 | 2 | 3 | 1 | n/a | ollama | ok | 2 | 709310 |
| `am-vacation-01` | missed_pending_item | 2 | 0 | 0 | 0 | 6 | 1 | 6 | 5 | yes | ollama | ok | 0 | 1675592 |
| `am-week-01` | fabricated_claim | 1 | 2 | 0 | 0 | 2 | 0 | 2 | 2 | no | template | error | 0 | 1800185 |
| `am-weekend-01` | missed_pending_item, fabricated_claim | 2 | 1 | 1 | 0 | 5 | 2 | 5 | 3 | yes | ollama | ok | 0 | 2158622 |
| `am-wrong-citation-01` | wrong_citation, false_pending_item | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a | — | harness_error | 0 | 1833009 |
| `designer-afternoon-01` | poor_ranking, false_pending_item | 1 | 1 | 1 | 0 | 5 | 2 | 5 | 3 | yes | ollama | ok | 0 | 2238560 |
| `designer-overnight-01` | missed_pending_item | 1 | 0 | 0 | 0 | 7 | 1 | 7 | 6 | yes | ollama | ok | 0 | 755247 |
| `designer-vacation-01` | fabricated_claim | 1 | 2 | 0 | 0 | 5 | 1 | 5 | 4 | yes | ollama | ok | 0 | 1026220 |
| `designer-week-01` | wrong_citation | 1 | 1 | 1 | 0 | 5 | 3 | 5 | 2 | yes | ollama | ok | 0 | 855540 |
| `designer-weekend-01` | false_pending_item | 0 | 0 | 0 | 0 | 4 | 2 | 4 | 2 | n/a | ollama | ok | 0 | 736160 |
| `eng-mgr-afternoon-01` | missed_pending_item, wrong_citation | 1 | 0 | 0 | 0 | 4 | 0 | 4 | 4 | yes | ollama | ok | 0 | 2066403 |
| `eng-mgr-overnight-01` | false_pending_item | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | n/a | ollama | all_claims_dropped | 4 | 1265722 |
| `eng-mgr-refusal-01` | refusal, missed_pending_item | 2 | 2 | 1 | 0 | 5 | 1 | 5 | 4 | yes | ollama | ok | 0 | 1496154 |
| `eng-mgr-vacation-01` | missed_pending_item | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | no | ollama | all_claims_dropped | 5 | 1034312 |
| `eng-mgr-week-01` | poor_ranking, missed_pending_item | 4 | 2 | 1 | 0 | 6 | 2 | 6 | 4 | yes | ollama | ok | 0 | 1529283 |
| `eng-mgr-weekend-01` | false_pending_item | 0 | 0 | 0 | 0 | 5 | 3 | 5 | 2 | n/a | ollama | ok | 0 | 653899 |
| `eng-mgr-wrong-citation-01` | wrong_citation, fabricated_claim | 1 | 1 | 1 | 0 | 4 | 1 | 4 | 3 | yes | ollama | ok | 0 | 709785 |
| `ic-eng-afternoon-01` | false_pending_item | 0 | 1 | 0 | 0 | 5 | 1 | 5 | 4 | n/a | ollama | ok | 0 | 1005886 |
| `ic-eng-fabricated-01` | fabricated_claim | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | no | ollama | all_claims_dropped | 4 | 867654 |
| `ic-eng-overnight-01` | missed_pending_item | 1 | 0 | 0 | 0 | 4 | 1 | 4 | 3 | yes | ollama | ok | 1 | 588612 |
| `ic-eng-refusal-01` | refusal | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | no | ollama | all_claims_dropped | 4 | 700188 |
| `ic-eng-vacation-01` | missed_pending_item, poor_ranking | 2 | 0 | 0 | 0 | 6 | 2 | 6 | 4 | yes | ollama | ok | 0 | 1060215 |
| `ic-eng-week-01` | poor_ranking | 3 | 0 | 0 | 0 | 5 | 2 | 5 | 3 | yes | ollama | ok | 1 | 793805 |
| `ic-eng-weekend-01` | false_pending_item, bad_style | 0 | 0 | 0 | 0 | 5 | 0 | 5 | 5 | n/a | ollama | ok | 2 | 549035 |
| `injection-01` | prompt_injection_misbehavior | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | no | ollama | all_claims_dropped | 4 | 611800 |
| `injection-02` | prompt_injection_misbehavior, missed_pending_item | 1 | 1 | 1 | 0 | 3 | 1 | 3 | 2 | yes | ollama | ok | 1 | 678844 |
| `injection-03` | prompt_injection_misbehavior, fabricated_claim | 1 | 1 | 0 | 0 | 5 | 1 | 5 | 4 | no | ollama | ok | 0 | 878167 |
| `pm-afternoon-01` | false_pending_item | 0 | 1 | 0 | 0 | 7 | 1 | 7 | 6 | n/a | ollama | ok | 0 | 1410181 |
| `pm-overnight-01` | missed_pending_item | 1 | 0 | 0 | 0 | 4 | 1 | 4 | 3 | yes | ollama | ok | 0 | 696815 |
| `pm-refusal-01` | refusal, missed_pending_item | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | no | ollama | all_claims_dropped | 6 | 695327 |
| `pm-vacation-01` | fabricated_claim | 1 | 0 | 0 | 0 | 5 | 1 | 5 | 4 | yes | ollama | ok | 1 | 736379 |
| `pm-week-01` | bad_style, missed_pending_item | 2 | 2 | 2 | 0 | 10 | 0 | 10 | 10 | yes | ollama | ok | 0 | 1828536 |
| `pm-weekend-01` | false_pending_item | 0 | 0 | 0 | 0 | 4 | 1 | 4 | 3 | n/a | ollama | ok | 0 | 562843 |
| `pm-wrong-citation-01` | wrong_citation | 1 | 2 | 0 | 1 | 5 | 0 | 5 | 5 | yes | ollama | ok | 0 | 901084 |

### Citation-gate drops, by reason

| Fixture | Dropped | Reasons |
|---|--:|---|
| `am-overnight-01` | 2 | no_citation=2 |
| `eng-mgr-overnight-01` | 4 | not_in_context=4 |
| `eng-mgr-vacation-01` | 5 | no_citation=5 |
| `ic-eng-fabricated-01` | 4 | no_citation=4 |
| `ic-eng-overnight-01` | 1 | no_citation=1 |
| `ic-eng-refusal-01` | 4 | not_in_context=4 |
| `ic-eng-week-01` | 1 | no_citation=1 |
| `ic-eng-weekend-01` | 2 | no_citation=2 |
| `injection-01` | 4 | no_citation=4 |
| `injection-02` | 1 | no_citation=1 |
| `pm-refusal-01` | 6 | no_citation=6 |
| `pm-vacation-01` | 1 | no_citation=1 |

_`no_citation` means the model emitted no `[artifact:<id>]` marker at all. `not_in_context` means it emitted an id that was never in the retrieval allowlist — i.e. it invented or mangled one. `unknown_artifact` means the id does not exist in the graph. `injection_pattern` means the T-1 shape detector fired on the claim text._

_Of 34 unsupported claim(s), 10 asserted a hand-labeled `unsupported_claims` entry — a confirmed fabrication. The remaining 24 were judged unsupported by the lexical grounding check alone and are the ones worth reading by hand._

### Fixtures that failed to run

- `am-wrong-citation-01`: fetch failed

## Method

- **Real pipeline, real model.** Each fixture is scored by seeding a fresh in-memory SQLite database and a fresh temporary LanceDB directory, ingesting the fixture's events through the real `IngestionPipeline`, then running the real `Layer1Extractor`, `Layer2Synthesizer` and `generateWithFallback` against the local Ollama instance. No layer is stubbed.
- **Matching is fuzzy on description, strict on citation.** Descriptions are compared by Sørensen–Dice similarity over content-token sets; citations are compared exactly. A right-sounding pending item with the wrong citation counts as **both a recall miss and a citation error** — never as a pass.
- **Layer 2 is invoked directly, not through the debounce scheduler.** The eval needs deterministic, immediate execution; waiting out real-time quiet windows would make a run take hours and would test the scheduler rather than the synthesis it triggers. `DebounceScheduler` has its own unit tests.
- **Citations are compared at THREAD granularity, not message granularity.** Layer 1 files every chunk under the conversation-level artifact `artifactId(source, "thread", threadKey)`, so the retrieval allowlist — and therefore every citation the system can emit — names a conversation. A predicted citation is credited when the cited thread contains the labeled message. This catches a citation pointing at the wrong thread (the `pm-wrong-citation-01` trap) but not one pointing at the wrong message within the right thread. The AC-6 number should be read as an upper bound.
- **Claim support is decided by hand-labeled negatives plus a lexical grounding check, not by a human reading each claim.** A claim is unsupported unconditionally when it ASSERTS a `ground_truth.unsupported_claims` entry (≥ 80% of the label's content tokens present in the claim); otherwise a citation supports a claim when ≥ 60% of the claim's content tokens appear in the cited artifact's source text. This is an approximation. AC-5 is a release gate, so before shipping on this number, spot-check the claims it scored as supported.
- **Latency is not measured here.** The clock is frozen inside each fixture's window (see `harness.ts`), so the §7.8 generation budget cannot elapse and every latency the STORE records for an eval briefing is 0. The `ms` column in the table above is the harness's own wall clock for the whole fixture — ingest, every Layer 1 call, every Layer 2 call and the streamed briefing — and is useful only as a rough cost signal. AC-1 is Task 5.3's benchmark.

---

_n=35 examples · recall 33.3% · precision 48.0% · hallucination 23.6% · citations 76.4% · top-3 73.1%_
