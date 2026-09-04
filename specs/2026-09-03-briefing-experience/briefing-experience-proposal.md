# Briefing Experience — Critical Evaluation and Proposal

**Status:** Proposal, not approved
**Date:** 2026-09-03
**Scope:** The end-to-end briefing experience — Layer 1/2/3 pipeline, ranking, citation
enforcement, and the renderer workflow.
**Evaluates:** the build described in `specs/2026-08-23-context-restorer/`
**Evidence:** `context-restorer-eval-report.md` (n=35), `context-restorer-bench-report.md`
(n=20), the working tree as of 2026-09-03.

> This document challenges design decisions that were deliberately made and recorded
> (`OI-n` / `X-n` / `D-n`). Where it proposes reversing one, the original decision is named
> so the trade is explicit rather than accidental. Nothing here is a defect report against
> an unfinished feature: every finding is measured, or is a contradiction visible in the
> shipped code.

---

## 1. Bottom line

The briefing workflow is well-engineered around the wrong centre of gravity. The guardrails
(citation omission, untrusted-content wrapping, append-only deltas, per-stage tracing) are
the strongest part of the build. What they guard produces measurably unusable output.

**Every acceptance criterion currently fails, most by an order of magnitude.** That is the
finding. It is not a tuning gap, and no amount of prompt iteration closes it.

| Criterion | Measured | Target | Sample | Config |
|---|--:|--:|---|---|
| AC-1 first token P95 | **97,925 ms** | < 5,000 ms | 20 runs | shipped (7b) |
| AC-1 total P95 | **360,920 ms** | < 60,000 ms | 20 runs | shipped (7b) |
| AC-5 hallucination (release gate) | 23.6% | < 2% | 34/144 claims | 14b — **stale** |
| AC-3 pending recall | 33.3% | ≥ 90% | 12/36 items | 14b — **stale** |
| AC-4 pending precision | 48.0% | ≥ 75% | 12/25 items | 14b — **stale** |
| AC-6 citation accuracy | 76.4% | ≥ 95% | 110/144 citations | 14b — **stale** |
| AC-7 top-3 relevance | 73.1% | ≥ 80% | 19/26 cases | 14b — **stale** |

AC-1 was re-measured on 2026-09-03 against the shipped config (`qwen2.5:7b`,
`budgets.generationMs: 360000`) on an otherwise-idle machine. The five quality rows are still
the 2026-08-28 `qwen2.5:14b` run and have **not** been re-baselined; the archived originals
are in `baseline-2026-08-28-qwen14b/`. Do not quote a quality row and a latency row together
without saying they came from different models (RO-2).

What the re-run changed, and what it did not:

- **The model swap helped materially and was nowhere near sufficient.** First token improved
  2.6× (254,393 → 97,925 ms) and remains **20× over** the 5s bar. Generation is ~99.9% of
  every run; retrieval, assembly and the citation gate together never exceed ~910 ms.
- **The end-to-end distribution is now real.** 13 of 20 runs completed rather than 0 of 20,
  so 250–360s is what writing a briefing actually costs — the archived 254s P95 was the cap,
  this one is the model.
- **§7.8 budget enforcement now works.** The archived run overshot its own 30,000 ms abort by
  8× (generation P95 254,394 ms); this run overshoots 360,000 ms by **12 ms**. The
  independent `budgetTimer` in `generate.ts` closed a real bug between the two runs.
- **There is no fast success case.** The quickest generation (126,894 ms) is the one run that
  produced nothing — `all_claims_dropped`, 9 dropped. Every run that produced claims took
  ≥ 249s.

Qualifications, all of which make the picture worse rather than better:

- **The eval set is n=35, not the ~70 OI-5 fixed.** One fixture (`am-wrong-citation-01`)
  failed to run at all. AC-6 is measured at thread granularity and the report states it
  should be read as an upper bound.
- **Still a lower bound.** Only 24 of 3,000 seeded events were extracted, so retrieval
  returns ~24 chunks against a `topK` of 40. A fully-extracted window means a larger prompt
  and a slower first token.
- **Zero obligations were produced.** 24 extracted events and 8 deltas yielded 0 open
  `pending_items`, so the bench's "first paint" figure (<1 ms) timed an empty SELECT rather
  than a painted screen. See the caveat on P0.

---

## 2. Findings

### F-1 — The cost model is the root cause, not the prompts

Layer 1 is **one LLM call per event** (`packages/ai/src/layer1/extract.ts`). The benchmark
seeded 3,000 events and extracted 8, stating plainly that extracting the corpus "would be
weeks of local inference."

Consequences:

- The pipeline has never been exercised at realistic volume. Every quality number above was
  measured against a pipeline whose first stage was mostly skipped.
- Briefing quality is bounded by *what got extracted*, not by the writer. Improving Layer 3
  cannot move AC-3/AC-5 while Layer 1 is the bottleneck.
- The ceiling is invisible to the user. A briefing built over 8 of 3,000 events looks
  exactly like a briefing over a quiet week.

Per-event is also the wrong altitude: Layer 2 already operates per *thread*, and the D-7
debounce exists precisely because a conversation should produce one delta per burst.

### F-2 — The core workflow does not exist

`apps/ui/components/CaughtUpButton.tsx:10` states the button "marks the briefing's deltas as
seen so the next briefing starts from here instead of repeating what the user has already
read."

It does not. `apps/desktop/src/ipc/feedback.ts` stamps `caught_up_at` and nothing else — it
is the NFR-10 metric and only that. The window actually comes from a `datetime-local` value
in `localStorage` (`apps/ui/lib/briefingWindow.ts`), defaulting to **30 days ago through
now**, edited on the Settings page (`apps/ui/app/settings/briefingWindow.tsx`).

So the product's flagship action re-briefs the same thirty days on every press, and the
control that decides what you are briefed on lives on a different page from the button that
briefs you. "What changed since I last caught up" — the entire premise in §1 of the
requirements — is not implemented.

### F-3 — FR-5, the differentiator, is unwired

`config/default.json` sets `wStakes: 3.0`, the second-largest ranking weight. Nothing in the
build creates the `belongs_to` graph edge `toRankableDelta` reads (`packages/ai/src/ranker.ts`),
a gap already recorded in OI-3 and CLAUDE.md. `onboarding.minDeclaredProjects` was therefore
relaxed to `0` and the onboarding gate removed (`apps/ui/app/page.tsx:125`).

Net effect: ranking is recency plus self-participation. "Items ordered by relevance to the
user's interests, not recency" is not shipping, and the cold-start mitigation R-6 depended on
(OI-3's mandatory declaration) was removed rather than completed.

### F-4 — Citing is not grounding

The citation gate checks marker presence and allowlist membership. It cannot check whether
the cited artifact *supports* the sentence. 76.4% citation accuracy alongside 23.6%
hallucination is the signature of well-formed citations attached to unsupported claims —
exactly the failure T-4 exists to prevent, arriving through the mechanism built to prevent it.

The eval harness already computes a lexical grounding check (≥60% of a claim's content tokens
present in the cited source text). That check exists only in the report. It belongs in the
runtime gate.

### F-5 — Precision is attacked from inside the generator

`packages/ai/src/layer3/generate.ts:1079` promotes any accepted "Waiting on you" claim into a
durable `pending_items` row with `waitingOnSelf: true` **asserted**, because Layer 3 has no
per-claim obligee signal. The code comment says so, and says it is weaker than Layer 2's
explicit `waiting_on` field.

`packages/ai/src/layer2/pending.ts` is built around the opposite discipline: rule 1 rejects
anything not explicitly first-person, because third-party obligations are "the single most
common false-positive source." Layer 3 routes around that rule. AC-4 is at 48%.

### F-6 — Two sources of truth for one section

"Waiting on you" is painted from `pending_items` *and* from streamed claims, de-duplicated in
the renderer by artifact id (`BriefingView.tsx:409`). Any id mismatch surfaces the same
obligation twice; any overlap hides a real one. The section that matters most is the one with
the most fragile assembly.

### F-7 — Cognitive load, and controls that do nothing

Each bullet can carry: a `sources` chip, Relevant / Not relevant / Wrong, Mark resolved, and a
low-confidence advisory. Three of those are inert from the user's point of view — feedback
feeds offline eval only, by design (X-2, FR-7).

The subtitle "Still learning your preferences — early briefings will be rough, and the
feedback buttons sharpen them" (`BriefingView.tsx:421`) promises a learning loop that X-2
forbids. It was written to set expectations (R-6); it currently misrepresents the system.

Worst case, observed in 5 of 35 eval fixtures (`all_claims_dropped`): the user sees four
empty headings under a banner apologising for a system that is learning.

### F-8 — Structure is recovered from prose that was asked to have structure

The model is instructed to emit markdown headings and `[artifact:<id>]` markers; `ClaimBuffer`,
`SectionRouter`, `HEADING_RE` and `canonicalSection` then reconstruct the structure. The
`renderContext` doc comment records a real bug this caused — a label shape one token
different from the marker shape lost every claim to `no_citation`.

This is a large amount of machinery, and a documented class of failure, in service of a format
the model could emit as constrained JSON.

---

## 3. Proposal

Five changes. P0 and P1 are independently valuable and do not depend on the rest.

### P0 — Make the deterministic briefing the product; make the LLM optional

The first-paint path holds no model reference at all (`apps/desktop/src/ipc/briefing.ts` — its
dependency type has no Ollama-shaped member, so a model call would not compile), and
`packages/ai/src/layer3/template.ts` already produces a fully cited briefing in milliseconds.

**Caveat on the measurement, stated because an earlier draft of this section leaned on it.**
The bench reports first paint at <1 ms, but the 2026-09-03 run had **0 open `pending_items`** —
that number timed an empty SELECT, not a rendered obligation list. The *structural* claim (no
model on the path) is sound and is what P0 rests on; the *latency* claim is not yet evidenced
and should not be quoted until a run with a non-empty pending table exists.

**Ship the deterministic briefing as the briefing.** Run generation in the background and swap
prose in only when it arrives and passes the gate. The user is never waiting four minutes;
`mode: 'template'` stops being an apology banner and becomes the fast path.

- Fixes AC-1 by construction rather than by raising the budget.
- Removes the "empty four headings" failure entirely — a deterministic briefing over real
  deltas is never empty when there are deltas.
- Reverses nothing in S-8; it promotes it.

### P1 — One action, no window picker

Replace the Settings date control with a single derived window: **since `caught_up_at` of the
last acknowledged briefing**, falling back to 24h on first run, with one "go further back"
affordance in the briefing itself.

- Fixes F-2 and makes the button's existing doc comment true.
- Deletes `apps/ui/app/settings/briefingWindow.tsx` and `apps/ui/lib/briefingWindow.ts`.
- Makes FR-11 load-bearing rather than telemetry-only, which is what NFR-10 was measuring
  the value of anyway.

### P2 — Two sections, hard-capped

Two groups: obligations, then everything else. Cap the second at ~7 items, ranked.

Per P4, the headings are stated as counts ("3 things need you" / "4 things changed") rather
than as titles, so the reader learns the size of the job before reading any of it. "Needs
you" / "Changed while you were out" remain the internal names for the two groups.

- "Quietly resolved" and "Worth knowing" are the lowest-value sections and the ones
  fabrication fills; `DEFAULT_SECTION` already routes every unattributable claim into
  "Worth knowing."
- The cap is what makes the output a briefing rather than a feed. Without it, "short,
  synthesized narrative" is a prompt instruction rather than a property.

### P3 — Spend inference on judgement, not prose

- Cheap deterministic/embedding pre-filter over events; LLM only on candidate **threads**.
- One question per candidate thread: *is something owed by this person here, and which
  message proves it?* — with a required artifact id in the answer.
- Layer 3's job shrinks to ordering and compressing already-grounded facts.

This directly targets F-1 and F-5, and is the only change here that can plausibly move AC-3
and AC-4.

### P4 — A plain list of sentences, not a narrative and not a card grid

Narrative form is what forces the model to invent connective tissue between two facts, and
that connective tissue is where the fabrications live. But the first draft of this section
proposed bordered cards with a channel name, sender, message count, source badge, timestamp,
confidence chip and three actions apiece — which reproduced F-7's cognitive-load problem in a
new shape. Reviewer feedback (2026-09-03) rejected it as hard to read, correctly.

The structure was not the problem; the chrome was. Same data, written as sentences:

```
Monday 9:14am — you were away 3 days


3 things need you
─────────────────────────────────────────────────────────

Dana needs you to approve the vendor SOW.
Legal is holding the countersign until you do.
                                    Friday · Slack   [Done]

Security needs your sign-off on the SSO exception.
They've been blocked since Wednesday.
                                 Wednesday · Gmail   [Done]

Marco may want your read on the nav spec — not sure.
He said "might be worth getting a manager's read."
                                  Saturday · Slack   [Done]


4 things changed
─────────────────────────────────────────────────────────

The team postponed the migration to Q4.
Load testing showed a 40% regression. This reverses
Thursday's decision to ship in Q3.

Priya shipped the retry logic — paging dropped from
14 a night to 2.

Q4 headcount is frozen. Finance confirmed no new reqs
until January.

The 2027 budget draft needs your comments by Oct 1.

                                     Show 7 more ▾


                    [ I'm caught up ]
```

**Where each line comes from.** Only the first sentence of each item is model-authored. The
rest is data already in the store:

| Element | Source | Model involved? |
|---|---|---|
| Item sentence | `state_deltas.summary` / `pending_items.description` | Yes — one short line |
| Supporting sentence | the cited artifact's own text | No — quoted or lightly paraphrased |
| `This reverses Thursday's decision` | the `supersedes` chain (D-6) | No — the link is stored |
| `Friday · Slack` | `artifacts` + `events` | No |
| Hedging ("may… not sure") | `confidence < 0.5` | No — threshold picks the phrasing |
| Counts, overflow count | row counts | No |

That is the whole point: the fabrication surface shrinks from every sentence to one line per
item, and that line sits directly above the evidence for it.

**Deliberately removed, against the first draft:**

| Removed | Why |
|---|---|
| Card borders | Boxes imply separate things to process; this is a list |
| Channel name, sender, message count | Nobody re-enters their week by channel name |
| Source badges as a column | Collapsed into one quiet `Friday · Slack` line |
| `⚠ low confidence` chip | The hedge moves into the sentence — words read faster than symbols |
| Per-item "Open" and "Wrong?" buttons | Clicking the item opens the source; "Wrong?" moves to one footer control |
| Section titles | Replaced by counts — "3 things need you" states the size of the job first |

**Retained, because it is load-bearing:** obligations first and separated, with a count; the
reversal linkage; exactly one action (`Done`) and only on items that need one; the overflow
count so nothing is silently hidden; the OI-1 still-processing disclosure in the footer.

**DECIDED 2026-09-03 — verbatim on obligations, paraphrase on the rest.** Paraphrasing the
supporting line moves verbatim evidence one click away, in exchange for a screen readable in
~15 seconds. That trade is worth making where being wrong is cheap and not where it is not:

- ***Needs you*** items keep the **literal quoted text**. An item asserting that someone is
  waiting on the user is exactly the claim they must be able to check without a click, and
  AC-4 precision is 48% — the evidence has to be on the page.
- ***Changed*** items carry a **paraphrased** supporting sentence, with the verbatim text one
  click away.

The rejected alternative was verbatim everywhere: more trustworthy, but it re-introduces the
density that made the card draft unreadable — the failure this section already corrected once.

**Implementation consequences either way:** this deletes `SectionRouter`, the heading regex
and the marker regex, and with them the label-shape hazard documented in `renderContext`
(F-8). If prose is retained instead, emit constrained JSON (`{section, claim, artifact_ids}`)
via Ollama's schema support rather than parsing markdown. In both cases, add the harness's
grounding check to the runtime gate (F-4).

---

## 4. Keep unchanged

These are the most valuable things in the build and none of the above touches them:

- Citation enforcement by **omission**, never flag-and-show (T-4, AC-2).
- `wrapUntrusted` / `assemblePrompt` as the only route for artifact text (T-1), and the
  branded `WrappedContent` type that makes it structural.
- Append-only `state_deltas` with `supersedes`, and the narrow reversal-narration exception (D-6).
- Per-stage OI-1 tracing, one `ai_calls` row per call, and the drop-reason/redaction telemetry.
- Local-only inference (SEC-6) and keychain-only tokens (SEC-2).
- The eval and bench reports' refusal to publish an unqualified percentage (RO-2), and their
  habit of stating their own limits. That discipline is why this failure is legible at all.

---

## 5. Sequencing

| Step | Work | Unblocks |
|---|---|---|
| 0a | ~~Re-baseline **bench** on the shipped config~~ — **done 2026-09-03**, AC-1 fails both bars (§1) | AC-1 is now measured on what ships |
| 0b | Re-baseline **eval** on the shipped config — **deliberately deferred 2026-09-03**, see below | The five quality rows in §1, which are still 14b numbers |
| 0c | Label fixtures up to n≈70 per OI-5 | Any quality claim strong enough to gate a release |
| 1 | P1 (window from `caught_up_at`) | Fixes F-2; smallest change with a visible user effect |
| 2 | P0 (deterministic-first) | AC-1; removes the empty-briefing failure |
| 3 | F-5 fix: stop promoting Layer 3 claims to `pending_items` | AC-4 |
| 4 | F-4 fix: grounding check in the runtime gate | AC-5, AC-6 |
| 5 | P3 (thread-level extraction) | AC-3, AC-4, and the F-1 ceiling |
| 6 | P2 / P4 | Cognitive load, and the F-8 machinery |

**Revised order after the 2026-09-03 sign-offs.** A-2 moves up: it is a self-contained write
path, it unblocks A-4's cap, and AC-7 cannot move without it. P2/P4 are also unblocked by Q-1
and need nothing else. So the near-term order is:

| # | Work | Depends on |
|---|---|---|
| 1 | ~~A-2 — channel → project tagging, restore the OI-3 onboarding gate~~ — **DONE 2026-09-03** | nothing |
| 2 | ~~P2 / P4 — list layout, counts as headings, verbatim-on-obligations~~ — **DONE 2026-09-03** (renderer half; structured LLM output still open) | Q-1 (done) |
| 3 | ~~A-4 — the configurable cap on the changed list~~ — **DONE 2026-09-03** | A-2 |
| 4 | 0b — eval re-baseline on the shipped config | nothing, but must precede 5 |
| 5 | F-4 / P3 — grounding gate, thread-level extraction | 0b, for a comparable baseline |
| 6 | P0 — deterministic-first | its own design doc |

**On step 0b.** An earlier draft of this document asserted that the whole of step 0 was "not
optional." That was too strong for the eval half, and the bench result is what showed it: the
quality gaps are 12× (hallucination, 23.6% vs a 2% gate) and 2.7× (recall, 33% vs 90%), which
is far outside the range a 14b → 7b swap plausibly moves. Re-running the existing 35 fixtures
would refine numbers that fail either way and would reverse no recommendation here, at a cost
of most of a day of local inference. It was started on 2026-09-03 and stopped after one
fixture.

The bench half *was* load-bearing and was worth the two hours: its archived numbers were
capped artifacts (20/20 truncated), so the real cost of generation was genuinely unknown
until it ran.

What remains true: **do not quote a 7b latency row and a 14b quality row as one result set**
(RO-2). Either re-run the eval before publishing a combined table, or label the provenance in
place as §1 now does. And note that the binding constraint on quality evidence is 0c, not 0b
— OI-5 fixed the target at ~70 labeled examples, and re-running the existing 35 does not
advance that by a single example.

---

## 6. Decisions this proposal asks to reverse

| Existing | Proposed | Why |
|---|---|---|
| OI-1 — 45s synchronous cap met by streaming LLM prose | Cap met by rendering deterministic content; prose is asynchronous | Measured P95 is 254s. The cap was already abandoned in config (360s), silently. |
| §7.8 — template is the *fallback* | Template is the default; LLM is the upgrade | The fallback is the only path that meets AC-1 today. |
| Four sections (`BRIEFING_SECTIONS`) | Two | Two of the four carry the least value and the most fabrication. |
| Layer 1 per-event extraction | Per-thread, pre-filtered | Per-event is unaffordable at real volume, by the bench's own statement. |
| Narrative briefing (§1, "synthesize a narrative") | Ranked cards | The narrative requirement is what makes per-sentence citation necessary and fabrication likely. This is the largest reversal here and the one most worth arguing about. |

Not proposed for reversal: X-2 (no learned ranking), X-3 (local-only), or any SEC-n.

---

## 7. Open questions for the design owner

| ID | Question | Status |
|---|---|---|
| Q-1 | Is "narrative briefing" a product requirement or a presentation choice? P4 depends on the answer. | **DECIDED 2026-09-03** — presentation choice; ship a ranked list of short sentences. See A-1. |
| Q-2 | Is the `belongs_to` edge (and with it FR-5) in scope now, or is stated-stakes ranking deferred? Today `wStakes` is dead config. | **DECIDED 2026-09-03** — in scope; wire the write path. See A-2. |
| Q-3 | Does "Still learning your preferences" stay, given X-2? If nothing learns, the sentence should go. | **DONE 2026-09-03** — removed from `BriefingView.tsx` and `onboarding/page.tsx`. See A-3. |
| Q-4 | Is a ~7-item cap acceptable, or is completeness over the window a requirement? | **DECIDED 2026-09-03** — per-section: obligations uncapped, changed list capped. See A-4. |

All four are now settled. The remaining gate on implementation is sequencing (§5), not sign-off.

---

## 8. Recommended answers

Q-1 and Q-2 change how a ported requirement (FR-2, FR-5) reads, so they needed sign-off before
implementation — the same bar `specs/2026-08-23-context-restorer/context-restorer-requirements.md`
§8 applied to OI-1…OI-5. **All four were signed off on 2026-09-03** and are recorded as
decisions below, with the reasoning that supported each preserved rather than replaced.

Only Q-1 required amending a requirement (OI-6 in the requirements doc). Q-2 is the opposite
case: it brings the *code* back into conformance with a requirement the doc already states —
see A-2.

### A-1 — DECIDED: narrative is a presentation choice

**Decision (2026-09-03):** the briefing ships as a **ranked list of short sentences**, per the
layout in P4. Not flowing paragraphs, and not the card grid the first draft proposed.

The rationale that supported it is preserved below.

The source calls for a "narrative summary" (§1, FR-2), so it is stated as a requirement — but
**nothing measures it**. Every acceptance criterion is about latency (AC-1), grounding
(AC-2, AC-5, AC-6), obligation detection (AC-3, AC-4) or ordering (AC-7), and the outcome
metric is time-to-re-entry (NFR-10). Prose is the delivery vehicle the design happened to
pick for those; it is not itself the goal, and it is currently the most expensive and least
verifiable part of the system.

**What the decision carries with it** — two constraints, so nothing real is lost:

- **Keep streaming.** FR-2's "streamed" is about perceived latency, not prose; cards stream
  as well as sentences do.
- **Keep exactly one narrative capability: cross-item linkage.** The reversal narration in
  `generate.ts` ("we chose X, then reversed to Y") is the one place prose says something a
  list cannot, and it is the entire justification for D-6 keeping history. Preserve it as a
  card-level annotation on the superseding card — not as free prose over the whole window.

**Requirement change this authorises, and which is NOT yet applied:** FR-2 in
`specs/2026-08-23-context-restorer/context-restorer-requirements.md` still reads "returns a
narrative summary, streamed." The decision above supersedes that wording — it should become
"returns a synthesized, cited summary, streamed" — but the requirements doc is a port of an
approved design and has not been amended here. Until it is, the two documents disagree, and
the requirements doc's own preamble says the design doc wins. **Amending FR-2 is the open
follow-up on this decision**, and it is a deliberate deviation to be recorded as such rather
than edited in silently.

### A-2 — DECIDED: wire `belongs_to`; it is a write path, not a feature

**Decision (2026-09-03):** in scope. Build the artifact → project write path, and restore
`onboarding.minDeclaredProjects` and the onboarding gate to what OI-3 already specifies.

**No requirement changes.** FR-5, FR-8 and OI-3 already say declarations are mandatory and
used as ranking priors; it is the *implementation* that diverged, relaxing the gate to
optional because the edge it depended on never existed. This decision closes that divergence
rather than authorising a new one — the opposite of Q-1/OI-6. Nothing in the requirements doc
needs amending, and `wStakes` stays.

The reasoning is preserved below.

FR-5's machinery is already built and tested — `ranker.ts`, `scoreDelta`, the weights in
`config/default.json`, the stakes term in `retrieval.ts` and in `rankPendingItems`. The only
missing piece is **one write path**: something that creates an artifact → project edge.

It does not need inference, and therefore does not touch X-2:

- **Slack:** the channel selector already exists and the user is already picking channels
  (`apps/ui/app/settings/channels.tsx`, `SlackChannelsRepo`). Let them tag each selected
  channel with one of their declared projects. Channel → project is a *stated* mapping.
- **Gmail:** the same tag applied to a label, or to the threads a declared project's
  participants appear on.

That is a declaration the user makes, not a cluster the system guesses, so it stays inside
X-2 and makes OI-3's "mandatory, assisted" declaration meaningful again instead of relaxed to
optional.

**Sequencing:** earlier than §5 step 5 — AC-7 (73.1%) cannot improve while the largest
non-obligation ranking term is inert, and Q-4's cap must not ship ahead of it.

*(The alternative, had this been deferred, was to delete `wStakes` from `config/default.json`
and the stakes term from `scoreDelta` rather than leave a config key naming a weight the
system cannot apply. Recorded because it is the fallback if the write path proves harder than
it looks.)*

### A-3 — Remove the sentence; keep the expectation-setting

Remove "Still learning your preferences — early briefings will be rough, and the feedback
buttons sharpen them" (`BriefingView.tsx:421`). It is false under X-2: FR-7 states feedback
feeds offline eval only, and `ranker.ts`'s X-2 guardrail comment forbids any feedback-derived
value from ever entering the scoring input.

It is also the only line on the page that misrepresents the system, in a build whose whole
character is disclosure — partial-generation notices, threads-still-processing counts, the
simplified-briefing banner, an eval report that states its own sample size and calls its own
AC-6 an upper bound. One false promise costs more here than it would anywhere else.

**Recommendation:** replace it with something that still does R-6's job and is true, e.g.
*"Ranked by the projects you declared. Nothing is learned from what you click."* Then, as part
of P2, cut the per-bullet control count (F-7): keep one per-claim control ("Wrong" / "Report a
problem") and move Relevant / Not relevant to the briefing footer, where FR-7 is already
satisfied by the briefing-level `FeedbackControls`.

### A-4 — DECIDED: cap the changed section; never cap the obligations

**Decision (2026-09-03):** per-section, as below. The cap is a `config` value (NFR-7), and it
does **not** ship before A-2 — a cap over a recency-ordered list is truncation, not editing.

The two sections have opposite failure modes, so one cap is the wrong answer for both.

| Section | Cap? | Why |
|---|---|---|
| **Needs you** | **No cap.** | AC-3 requires ≥90% recall. An obligation dropped by a display cap is a recall miss the user cannot see, which is the one unacceptable failure. `rankPendingItems` already refuses to hide even zero-stakes items for exactly this reason. Collapse the tail behind "+N more" past ~7 — collapse is not a drop, and the count stays visible. |
| **Changed while you were out** | **Yes, ~5–7.** | This is where "briefing, not feed" is won or lost, and where an omission costs the user nothing they cannot recover by opening the tool. Disclose it: *"N further changes not shown"* — same discipline as the threads-still-processing note. |

Two constraints on the cap itself:

- It must be a `config` value (NFR-7, config-controlled and rollback-able), not a constant.
- **It depends on A-2 landing first.** A cap over a genuinely ranked list is editorial
  judgement; a cap over a recency-ordered list is just truncation. Do not ship the cap while
  ranking is still recency plus participation.
