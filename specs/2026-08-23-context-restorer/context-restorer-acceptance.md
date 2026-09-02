# Context Restorer (POC) — Acceptance Validation

_Task 5.5. Every row below states either a measured value with its method and sample size, or an explicit "not measured" with the reason. No cell is guessed. Where a criterion could not be validated in this environment, that is recorded as a limitation of this validation run, not papered over as a pass._

**Machine this validation was run on:** ~40 GB RAM (Windows 11, `wmic ComputerSystem get TotalPhysicalMemory` → 42,675,769,344 bytes). **This does NOT satisfy AC-11's specific 16 GB RAM requirement** — see AC-11 below.

**Model:** `qwen2.5:14b` (chat) + `nomic-embed-text` (embed), both local via Ollama, deterministic decoding (`temperature: 0`, fixed seed — added during this phase after an initial eval run showed non-reproducible results with no decoding parameters set).

---

## Acceptance Criteria

| Criterion | Target | Measured | Method |
|---|---|---|---|
| AC-1 briefing P95 | < 60s | **254.5s — FAIL** | `npm run bench:briefing`, n=20 real briefings, contended machine (see note) |
| AC-1 first token P95 | < 5s | **254.4s — FAIL** (n=19; 1 of 20 runs never produced a token and is excluded from this specific metric, per bench methodology) | same bench run, `firstTokenMs` |
| AC-2 claims cited | 100% | **100% (structural, not merely observed)** | `briefing_claims.citation_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id)` (`packages/store/src/migrations/001_initial.sql:128`) — a claim without a citation cannot be inserted, full stop. Exercised repeatedly in `packages/ai/test/generate.test.ts:335`, `packages/ai/test/citationGate.test.ts`, and the live 35-fixture eval run (in progress at time of writing; every fixture that reached persistence did so with 100% cited claims, consistent with the schema guarantee) |
| AC-3 pending recall | ≥ 90% | **0.0% (0/4 items) — FAIL, n=5 of 35 available (see note)** | `npm run eval`, subset run |
| AC-4 pending precision | ≥ 75% | **0.0% (0/6 items) — FAIL, n=5** | `npm run eval`, subset run |
| AC-5 hallucination rate | < 2% | **10.5% (2/19 claims) — FAIL, n=5. This is the release gate; see the confidence-interval discussion below before treating this as settled** | `npm run eval`, subset run |
| AC-6 citation accuracy | ≥ 95% | **89.5% (17/19 citations) — FAIL, n=5. Also structurally capped: citations are compared at THREAD granularity, not message granularity, so this number is an upper bound on true message-level accuracy even before the sample-size caveat** | `npm run eval`, subset run |
| AC-7 top-3 relevance | ≥ 80% | **100.0% (4/4 scoreable cases) — PASS, n=5** | `npm run eval`, subset run |
| AC-8 ingestion lag P95 | < 5 min | **NOT MEASURED — requires a live-connected Slack/Gmail workspace running for ~24h.** Real OAuth setup was deliberately deferred starting in Phase 1 (user chose to proceed on code/test/review evidence rather than register live Slack/Google Cloud OAuth apps); this criterion cannot be validated without that live connection | health panel over a 24h run (not run) |
| AC-9 feedback capture | < 1s | **PASS — measured sub-millisecond** (`performance.now()`-bracketed real call, well under the 1000ms bound) | `apps/desktop/test/ipc.feedback.test.ts:114-149`, `npm run test -w apps/desktop` |
| AC-10 zero loss / idempotent | exact | **PASS — measured** | `packages/ingest/test/pipeline.test.ts:97` ("is idempotent — replaying the same batch adds no rows"); enforced at the DB level by `UNIQUE(source, source_event_id)` on `events` |
| AC-11 validated at 16 GB | yes | **NOT MET — this machine has ~40 GB RAM, not 16 GB.** No 16 GB machine was available in this environment for validation | machine spec recorded above |

---

## Notes on the FAIL and PENDING rows

**AC-1 (FAIL, both halves).** Measured via a real 20-briefing benchmark (`packages/eval/src/bench.ts`, Task 5.3), run concurrently with the separate full eval-set pass — both against the same local Ollama instance, so these are **contended-machine numbers**, not idle-machine numbers; a re-run in isolation would likely be faster, though how much faster is not measured here and should not be assumed. Per-stage attribution is unambiguous: retrieval, prompt assembly, and the citation gate are collectively under 1% of total runtime in every one of the 20 runs; **100% of the failure is generation time** (time-to-first-token / decode) on the local 14B model. 20/20 runs hit the 30-second `budgets.generationMs` timeout and were truncated before enough tokens arrived to produce accepted claims in 19 of 20 cases. First paint (pending items, zero LLM calls — the OI-1 property AC-1's "sub-5s experience" actually depends on) stayed under 1ms across all 20 runs and is unaffected by this failure.

This is a genuine, measured product/hardware finding, not a test artifact: **on this machine's hardware, `qwen2.5:14b` is too slow to meet AC-1's latency targets**, even before accounting for the additional contention from the concurrent eval run. Remedies worth investigating (not implemented, out of scope for this validation pass): a smaller/faster local model, GPU acceleration if not already in use, or revisiting the 30s generation budget's relationship to the 60s total target given the model's actual decode speed on target hardware.

**AC-3 through AC-7 — measured on n=5, not the full set, and here is why.** A full 35-fixture eval run was attempted in the background during this phase. It was killed by the environment after completing 14 of 35 fixtures — several hours of real wall-clock time, at an observed ~12–37 minutes per fixture on this hardware (visible in the run's own log: individual fixtures ranged from ~709,000ms to ~2,238,000ms). That data point is itself informative: **an unattended full pass over even the current 35-fixture set is impractical within an interactive session on this hardware**, and would need to run as a dedicated overnight/scheduled batch job outside a live session. Since the partial run's 14 completed fixtures were never aggregated into a report before the process was killed (the harness writes its report only on completion), the numbers in this table are the original n=5 run from Task 5.1, which DID complete and DID produce a real report (`context-restorer-eval-report.md`).

**This means AC-3 through AC-7 above should be read as a small, real, honestly-reported sample — not as the final release-gate determination.** The eval set itself is 35 of the ~70-example target (Task 5.2), itself reported honestly rather than padded — see `packages/eval/fixtures/README.md`'s "Size and confidence" section for the statistical consequence: at 35 fixtures (~233 labeled claims), a clean run clears AC-5's <2% gate, but even 2 observed fabrications produces a confidence interval whose upper bound exceeds 2%; at n=5 (~19 claims, as measured here) the interval is wider still. **Recommendation before shipping on these numbers:** run `npm run eval` (no arguments, full set) as an unattended overnight job once the eval set reaches closer to 70 examples, and treat the n=5 numbers here as directional (all four of AC-3/4/5/6 failing on this sample, with real product causes identified in Task 5.1's own report — thread-granularity citations, and pending items not clearing the description-similarity threshold or citing the wrong thread) rather than conclusive.

**AC-8 and AC-11 (not measured).** Both require conditions outside this session: AC-8 needs a real, live-connected Slack/Gmail workspace running continuously for about a day (blocked by the deliberate, user-approved decision in Phase 1 to defer real OAuth app registration); AC-11 needs a physical or VM-constrained 16 GB machine, which was not available here. Neither is reported as met or as failed — both are recorded as genuinely unmeasured, per the plan's own instruction that an empty cell is more honest than a guess.

---

## Cross-reference: other Acceptance Criteria items from the plan (informational, not the Task 5.5 table above)

These are drawn from the plan's broader "Acceptance Criteria" checklist and are backed by evidence already produced in earlier phases — listed here for completeness, not re-measured in this document:

- `npm run typecheck` exits 0 — true at every phase gate throughout this build, most recently reconfirmed alongside Task 5.4.
- `npm run test` exits 0, every suite passing — true as of the last full run (see Phase 5 batch notes for the exact count at time of writing).
- App launches to tray, opens the Next.js UI, registers as a login item — live-verified multiple times during Phases 0, 3, and 4 (`npm run start`, confirmed via live `electron.exe` processes).
- Ollama missing/model not pulled → loud, specific failure naming the remedy — built and tested in Phase 0 (`preflight.ts`), wired into `main.ts`'s blocking startup gate.
- A 14-message burst produces exactly one StateDelta; a continuous thread checkpoints at 30 minutes; a pending synthesis survives restart (D-7 properties 1–3) — all three independently unit-tested in `packages/ai/test/scheduler.test.ts` (Phase 2), not re-run live here (live verification requires real Slack traffic, blocked by the same deferred-OAuth decision as AC-8).
- A reversed decision produces version 2 with `supersedes` set; `current_state_deltas` shows only the tip (D-6) — tested in `packages/ai/test/synthesize.test.ts`.
- Every injection-corpus entry produces no misbehavior, no leaked system prompt — 30/30 attacks pass in `packages/ai/test/injection.e2e.test.ts` (Phase 4), run through the real L1→L2→L3 pipeline.
- Killing Ollama mid-briefing yields "Simplified briefing" with citations intact, no crash; fallback chain is exactly `['ollama','template']` — built and tested in `packages/ai/test/template.test.ts` (Phase 4), and `generateWithFallback` is confirmed wired into the live app (`apps/desktop/src/main.ts`), independently re-verified by two separate integration reviews.
- Trace files contain no raw email addresses / message bodies (SEC-7) — verified against real written file bytes in `packages/observability/test/e2eTrace.test.ts` (Phase 4).
- A recurring schedule fires once, covers the correct window, collapses missed runs after sleep, and a quiet-hours schedule generates without notifying — all tested with real IANA-tzdata DST handling in `apps/desktop/test/briefingSchedule.test.ts` (Phase 3); live firing not observed in this session (would require leaving the app running unattended across a real scheduled time).
- No calendar-return detection exists anywhere — true; never built, consistent with the design's acknowledged deviation §12.3.
- "I'm caught up" persists `caught_up_at`, idempotent; time-to-re-entry computable — tested in `apps/desktop/test/ipc.feedback.test.ts` (Phase 3/4).
- `deleteEverything()` leaves zero rows/vectors/files; the 90-day purge preserves append-only triggers — both re-verified end-to-end in `packages/store/test/rightToDelete.e2e.test.ts` (Task 5.4, this phase).
- No source-write code path exists anywhere; no GitHub/Jira/Calendar/Teams source; no Layer 4 ranking; no vendor model path; no Slack-DM/email delivery; no app-level encryption layer — all true by construction; none of these were built at any phase, and this was checked during every phase's spec-compliance review rather than assumed.

---

_AC-3 through AC-7 are measured on n=5 (see the note above for why a larger unattended run was attempted but did not complete in this session). Re-running `npm run eval` over the full fixture set as a dedicated background job, and growing the set further toward the ~70 target, would materially strengthen these four rows before they are used as a final release decision._
