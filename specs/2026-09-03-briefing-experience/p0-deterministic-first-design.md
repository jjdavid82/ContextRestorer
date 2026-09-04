# P0 — Deterministic-First Briefing: Technical Design

**Status:** Design, not approved. No code written against it.
**Date:** 2026-09-03
**Implements:** P0 in `briefing-experience-proposal.md`
**Amends:** §7.8's fallback semantics; OI-1's latency allocation
**Author's note:** §3 reaches a different conclusion from the proposal's own P0
sketch. That divergence is the main thing to review.

---

## 1. Why

AC-1 requires a briefing P95 under 60s and first token under 5s. Measured on the
shipped config, uncontended: **first token 97,925 ms, total 360,920 ms** (n=20,
2026-09-03). Generation is ~99.9% of every run; retrieval, prompt assembly and
the citation gate together never exceed ~910 ms.

No prompt or model change closes a 6× gap. The only remaining lever is to stop
putting a language model on the synchronous path.

Two facts make that viable rather than aspirational:

- `apps/desktop/src/ipc/briefing.ts` already serves first paint with **no model
  reference in scope** — its dependency type has no Ollama-shaped member, so a
  model call there would not compile.
- `packages/ai/src/layer3/template.ts` already renders a **fully cited** briefing
  from stored `state_deltas` with no inference, and `appendTemplateRemainder`
  already merges template claims into a briefing that has model claims in it,
  deduplicating by delta.

The pieces exist. What is wrong is which one is load-bearing.

---

## 2. What is wrong with the current chain

`generateWithFallback` runs: preflight → `BriefingGenerator.generate()` → on
failure, template. The template is the **exception path**. Consequences:

1. **The user always waits for the model**, even though the deterministic
   briefing was available in milliseconds.
2. **The failure path is the fast path**, so the system is fastest when it is
   least healthy — and `mode: 'template'` is announced to the user as a
   degradation ("Simplified briefing — local model unavailable").
3. **`budgets.generationMs` was raised 30s → 360s** to stop truncating. That
   abandoned OI-1's 45s cap rather than meeting it.

---

## 3. The decision, and where it departs from the proposal

The proposal's P0 said: *ship the deterministic briefing, run the LLM in the
background, and swap it in when it arrives.*

**The swap is the wrong half of that idea, and the numbers say so.** NFR-10's
outcome metric is time-to-re-entry — the elapsed time from delivery to the user
tapping "I'm caught up". The product is *trying* to get the user done quickly. A
prose version that arrives 250–360s later arrives after a successful session has
already ended. Building a mechanism to mutate a briefing the user has finished
reading optimises for the case the product is designed to avoid.

So:

> **The synchronous path is deterministic, always. The model never runs on it.
> Model-written prose is produced by BACKGROUND pre-computation and is read from
> storage by the next briefing that covers its window.**

This is not a new principle — it is OI-1's own ("background pre-computation owns
all extraction and synthesis", consistent with D-3) extended one layer, to
generation. Layers 1 and 2 already work this way; Layer 3 is the anomaly.

### What the user sees

| When | What renders | Source |
|---|---|---|
| Press the button | Obligations + changed items, cited | SQLite only |
| Same press, if prose already exists for this window | The same items, with model-written headlines | `briefing_claims` written by an earlier background pass |
| Never | A spinner waiting on inference | — |

Nothing mutates under the reader. A briefing is whatever was ready when it was
asked for.

### Rejected alternatives

| Alternative | Why not |
|---|---|
| Template first, hot-swap prose when ready | Optimises for a session that has already ended (above). Also needs conflict rules for a claim the user has acted on. |
| Keep the LLM synchronous, shrink the prompt | The bench shows generation dominates regardless; a smaller prompt moves 360s, not to under 60s. |
| Keep the LLM synchronous, cut the budget back to 30s | That is today's behaviour with truncation — 20/20 runs `budget_exceeded`, and the briefing is arbitrarily cut mid-thought. |
| Drop the LLM from Layer 3 entirely | Loses the one thing prose does that a list cannot: cross-item linkage (OI-6 preserves it as a requirement). |

---

## 4. Design

### 4.1 Two producers, one store

Both paths already write `briefing_claims`. Keep that. Add provenance per claim
rather than per briefing.

```
briefing_claims
  + produced_by TEXT NOT NULL DEFAULT 'template'   -- 'template' | 'llm'
```

`briefings.mode` becomes derived and is retained only for backward
compatibility: `'llm'` when any claim on the briefing is `produced_by = 'llm'`,
else `'template'`. It stops being a statement about *how the run went* and
becomes a statement about *what is on the page*, which is what the renderer
actually needs.

**Why per-claim.** A briefing can legitimately be half prose (the background
pass covered four of seven deltas before the user asked). Per-briefing mode
cannot express that, and today's `appendTemplateRemainder` already produces
exactly that mixed state while reporting a single mode.

### 4.2 The synchronous path

`briefing:request` becomes fully synchronous in substance as well as in shape:

1. Mint `briefingId`, insert the `briefings` row.
2. `SELECT` open `pending_items` (already done, already model-free).
3. `SELECT` current `state_deltas` for the window; render one claim each via the
   existing `TemplateBriefingRenderer` logic.
4. **If a prior background pass produced prose for deltas in this window**,
   prefer that claim over the template's for the same `delta_id`.
5. Return. No `startGeneration`, no streaming, no abort controller.

Expected cost: the four stages the bench measured at retrieval 604 ms + assembly
0 ms + citation 3 ms, minus retrieval — so **single-digit milliseconds**, bounded
by SQLite.

`briefing:chunk` / `briefing:done` remain, because the renderer's subscription
model and rehydration path are already built on them, and a background pass that
finishes while the window is open should still be able to push. They simply stop
being how a briefing arrives.

### 4.3 The background producer

A new `BriefingPrecomputer`, triggered by the same D-7 debounce cycle that fires
Layer 2 (`DebounceScheduler`), running after synthesis settles a thread:

- Input: state deltas with no `produced_by = 'llm'` claim yet.
- Batches them into one generation over a rolling window.
- Writes claims through the **unchanged** `CitationGate` — every existing
  guarantee (AC-2, T-1, SEC-5, F-4's grounding counter) applies identically.
- Bounded by `budgets.generationMs`, which can return to 30s or lower: nobody is
  waiting, so truncation costs a headline rather than a briefing.

### 4.4 What is deleted

- The `preflight` → generate → fallback ordering in `generateWithFallback`.
  Preflight moves to the background producer, where "the model is down" means
  "no prose this cycle" instead of a user-visible banner.
- `SIMPLIFIED_BRIEFING_LABEL` and its banner. Under this design a briefing with
  no prose is not degraded, it is *normal*, and telling the user their briefing
  is second-rate when it is the designed output is a lie the current UI tells.

---

## 5. Consequences for stated requirements

| Requirement | Effect |
|---|---|
| **AC-1** (P95 < 60s, first token < 5s) | Met by construction — the synchronous path is a SELECT. This is the point. |
| **OI-1** (45s synchronous budget, staged) | The stage table becomes retrieval-free. The budget stops being a race and becomes slack. **Requires an amendment**, like OI-6. |
| **§7.8** (template is the fallback) | Inverted. The template is the product; the model is an enhancement. **Requires an amendment.** |
| **AC-2** (100% claims cited) | Unchanged. Both producers write through the same gate. |
| **NFR-5** (reproducible briefings) | **Improved.** The deterministic path is reproducible by definition; today's is not. |
| **FR-2** (streamed) | Weakened in letter, met in spirit: there is nothing to stream because the whole briefing is present at once. Worth confirming with the design owner — this is the second FR-2 amendment in two days. |
| **NFR-10** (time-to-re-entry) | Should improve sharply. It is the metric this design optimises. |

---

## 6. Migration

1. Migration `007_claim_provenance.sql`: add `produced_by` with a
   `'template'` default, so existing rows describe themselves correctly —
   pre-P0 claims were model-written, so the backfill sets `'llm'` where
   `briefings.mode = 'llm'` and `'template'` otherwise.
2. SEC-8: no new table, so `DELETE_ORDER` is unaffected.
3. No vector-store change.

---

## 7. What this design does NOT do

- **It does not make briefings better.** It makes them fast and honest. Every
  quality criterion (AC-3/4/5/6/7) is untouched by it, and all five currently
  fail.
- **It does not remove the LLM.** Cross-item linkage (OI-6) still needs prose.
- **It does not address the F-1 cost ceiling.** Layer 1 is still one call per
  event outside the pre-filter; that is P3 part 2.
- **It does not fix the first-briefing case.** A user who has just onboarded has
  no background pass behind them, so their first briefing is deterministic-only.
  That is the R-6 cold-start problem, and it is *better* than today (instant and
  cited, rather than 6 minutes and possibly empty) but it is not solved.

---

## 8. Verification

Not "it compiles" — these are the claims that would need measuring:

1. **Re-run the bench.** Expect synchronous P95 in single-digit ms. If it is not,
   the design failed and the number says so immediately.
2. **Re-run the eval** with prose pre-computed, so the quality criteria are
   measured against the same claims a user would see. Note that the eval harness
   currently drives `generateWithFallback` directly and would need to drive the
   new synchronous path plus a forced background pass.
3. **An explicit "no prose available" case** must produce a complete, cited,
   non-empty briefing from deltas alone.
4. **`produced_by` accounting** — a mixed briefing reports both, and
   `briefings.mode` derives correctly.

---

## 9. Open questions for the design owner

All four were answered on 2026-09-04.

| # | Question | Answer |
|---|---|---|
| 1 | Is §3's reframing accepted? | **Yes.** Background pre-computation, not hot-swap. Implemented in four slices. |
| 2 | FR-2 "streamed" again? | **Not amended.** Claims still arrive over `briefing:chunk` and the run still ends with `briefing:done`; they simply all arrive within milliseconds. OI-6 reworded FR-2 for *perceived latency*, and a briefing that is complete immediately serves that intent more fully than one that trickles. Recorded in OI-7 rather than silently reinterpreted. |
| 3 | How stale may prose be? | **No guard needed — D-6 already prevents it.** `deltaId` is derived as `(threadKey, version)`, so prose written for v1 is keyed to an id `currentForWindow()` stops returning the moment v2 supersedes it. Stale prose is unreachable by construction. A guard would have added a query and implied a risk that does not exist; a test pins the property instead, so if delta ids ever stop being per-version it fails loudly. The residual case — a thread with events Layer 2 has not synthesized yet — makes the tip delta stale, but the deterministic line renders from that same delta, so there is no prose-specific asymmetry and OI-1's still-processing disclosure already covers it. |
| 4 | Battery / metered power? | **Paused on battery**, via an injected `mayRun` predicate (`powerMonitor.onBatteryPower` in `main.ts`), overridable with `precompute.pauseOnBattery: false`. Pausing costs blunter headlines on the next briefing and never a broken one, because the request path is deterministic — the cheapest restraint available for the most expensive thing the app does. |
