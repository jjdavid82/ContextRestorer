# Eval Fixtures

Labeled examples for the offline eval harness. One JSON file per example, filename stem ==
the fixture's `id`. Schema and validator: [`../src/types.ts`](../src/types.ts).

**Current size: 43 fixtures.** OI-5's target is ~70. See
[Size and confidence](#size-and-confidence) for the honest accounting of what this buys and
what it does not — labeling throughput is the stated bottleneck (design §7.5), and the count is
reported rather than papered over.

### Provenance, and why it limits what these can prove

Every fixture here is **author-constructed**: someone wrote synthetic messages with a
scenario in mind, then labeled the ground truth that scenario implies. The labels are
therefore reliable *about the scenario* — "Ben asked for a decision by Thursday" is true
because it was written to be true, not guessed at.

What that does **not** give you is a sample of real traffic. Author-constructed fixtures
inherit the author's blind spots twice over: in which situations get imagined at all, and in
how cleanly the obligation is phrased. Real Slack is messier, more elliptical, and more
dependent on context that never appears in the window. A system scoring well here has been
shown to handle *the failures we thought of*.

Treat these as a regression suite with real teeth and as a weak proxy for field accuracy. The
five fixtures added 2026-09-04 (`eng-mgr-quiet-01`, `designer-quiet-01`,
`ic-eng-reversal-01`, `pm-injection-01`, `am-refusal-01`) were written by Claude against
measured coverage gaps, which is the same caveat with one extra author.

---

## Collection habit

> **Every time a manual test in Phases 3–4 surfaces a wrong answer, capture it as a fixture
> before fixing it. This is the cheapest moment to get a labeled example, and Phase 5 needs
> the volume.**

Once the bug is fixed you no longer have the inputs, the wrong output, or your memory of why
it was wrong — reconstructing a fixture afterwards costs many times more than writing it down
in the moment, and usually never happens. Capture first, then fix.

---

## Schema

Shape follows design §10. See `EvalFixture` in [`../src/types.ts`](../src/types.ts) for the
authoritative definition and per-field documentation.

```jsonc
{
  "id": "eng-mgr-vacation-01",              // matches the filename stem
  "description": "...",                      // one line: what failure this catches
  "persona": "eng_manager",                  // eng_manager | pm | ic_engineer | designer | account_manager
  "window_kind": "vacation",                 // annotation: overnight | weekend | vacation | afternoon | week | two_day
  "volume": "balanced",                      // annotation: heavy_slack | balanced | low
  "window": { "start": "ISO-8601", "end": "ISO-8601" },
  "events": [                                // synthetic, normalized Slack + Gmail events
    {
      "event_id": "ev-...",
      "source": "slack",                     // 'slack' | 'gmail'
      "thread_key": "C0CHAN:1773040800.000100",
      "artifact_id": "slack:C0CHAN:1773040800.000200",  // what a citation points at
      "actor": "Rhea Talbot",
      "actor_is_self": false,                // optional; true == the briefing's owner
      "occurred_at": "ISO-8601",
      "context_label": "#platform-eng",      // optional: channel name or email subject
      "text": "..."
    }
  ],
  "ground_truth": {
    "pending_items": [{ "description": "...", "citation": "<artifact_id>" }],
    "expect_no_pending": true,               // the explicit negative label
    "acceptable_briefings": ["..."],
    "supported_claims": ["..."],             // what the content actually supports
    "unsupported_claims": ["..."],           // plausible-sounding claims that are wrong
    "notes": "why this is the correct answer"
  },
  "failure_mode_tags": ["missed_pending_item"]
}
```

**Events are normalized, not raw API payloads.** Fixtures are hand-authored and hand-reviewed,
so readability beats fidelity — the harness maps these onto the `events` table (§4.2) when it
seeds a temp database, converting ISO timestamps to epoch ms.

**Fixtures may carry extra fields.** `EvalFixture` has an index signature and the validator
ignores unknown keys, so a scenario-specific annotation needs no schema change. Conventions in
use, none of them validated:

| Field | Where | Meaning |
|---|---|---|
| `window_kind` | top level | Which window-length axis the fixture covers. |
| `volume` | top level | Which activity-profile axis the fixture covers. |
| `expected_top_item_citation` | top level | For `poor_ranking` fixtures: the artifact the top-ranked item must cite. |
| `ground_truth.unacceptable_briefings` | ground truth | For `bad_style` fixtures: stored anti-patterns that are factually clean but unusable. |
| `ground_truth.injection_payload_artifact_ids` | ground truth | Which artifacts carry injection payloads. |

Because these are unvalidated, treat them as documentation for a human reviewer until a
harness actually reads them. `window_kind` and `volume` exist so the axis coverage in the
table below can be recomputed from the files rather than trusted from prose.

### Validation rules

`validateFixture()` enforces:

- `id`, `description`, `persona` are non-empty strings; `window.start` / `window.end` present.
- `events` is non-empty, and every event has an `event_id`, `thread_key`, `artifact_id`,
  `actor`, `occurred_at`, `text`, and a `source` of `slack` or `gmail`.
- `failure_mode_tags` has **at least one** entry, every entry a known tag.
- **Exactly one ground-truth stance:** either `ground_truth.pending_items` has at least one
  entry, or `ground_truth.expect_no_pending === true`. Never neither — an unlabeled fixture
  cannot be scored, and silence must not be mistakable for a deliberate negative. Never both —
  that is a contradiction, not a shrug.
- Every `pending_items[].citation` resolves to an `artifact_id` present in `events`, so a
  fixture cannot ship a citation pointing nowhere. This is the same integrity property §4.2
  enforces with a foreign key at runtime.

`test/fixtures.test.ts` globs this directory at test time — a fixture added later is covered
automatically, and no filename list needs updating.

---

## Failure-mode taxonomy

The full taxonomy from design §10 / §7.5. Tags are a list: a fixture may carry more than one.

| Tag | Meaning |
|---|---|
| `missed_pending_item` | Something genuinely waiting on the user was not surfaced (hurts AC-3 recall). |
| `false_pending_item` | Something was surfaced that is not actually waiting on the user (hurts AC-4 precision). |
| `fabricated_claim` | A claim the source content does not support (hurts AC-5, the <2% release gate). |
| `wrong_citation` | The claim is right but the cited artifact does not support it (hurts AC-6). |
| `poor_ranking` | The important item is present but buried below trivia (hurts AC-7 top-3 relevance). |
| `bad_style` | Correct and cited, but unusable — bloated, robotic, or burying the point. |
| `refusal` | The system declined to produce output on benign content. |
| `prompt_injection_misbehavior` | Ingested text was followed as an instruction instead of treated as data (T-1). |

The first five are **required to be covered** by the committed fixture set at all times;
`REQUIRED_FAILURE_MODE_TAGS` in `../src/types.ts` is the list, and `fixtures.test.ts` fails by
name if one loses its last fixture. The coverage assertion is deliberately **at least one**, not
exactly one — every tag now has several examples, and a single example per category cannot
distinguish a real fix from an accident.

All eight tags are populated as of Task 5.2:

| Tag | Fixtures |
|---|---|
| `missed_pending_item` | 13 |
| `false_pending_item` | 10 |
| `fabricated_claim` | 7 |
| `poor_ranking` | 5 |
| `wrong_citation` | 5 |
| `bad_style` | 3 |
| `refusal` | 3 |
| `prompt_injection_misbehavior` | 3 |

Counts exceed 35 because a fixture may carry more than one tag.

---

## Coverage axes

Design §7.5 names three axes: persona, window length, activity profile. Current distribution
across 35 fixtures:

| Persona | n | | Window | n | | Volume | n |
|---|---|---|---|---|---|---|---|
| `eng_manager` | 8 | | `week` | 10 | | `balanced` | 19 |
| `ic_engineer` | 8 | | `afternoon` | 7 | | `heavy_slack` | 9 |
| `pm` | 7 | | `overnight` | 7 | | `low` | 7 |
| `account_manager` | 7 | | `vacation` | 5 | | | |
| `designer` | 5 | | `weekend` | 5 | | | |
| | | | `two_day` | 1 | | | |

Every persona has at least one fixture in every window kind except where noted in the table
below, and eight of the 35 carry the explicit negative label (`expect_no_pending`) so that
"nothing happened" is measured rather than assumed.

---

## Current fixtures

| File | Persona | Window | Volume | Tags | Scenario |
|---|---|---|---|---|---|
| `am-afternoon-01` | account_manager | afternoon | heavy | `bad_style`, `poor_ranking` | Nine "nothing needed" status posts around one 18:00 signature deadline. Stores two named anti-pattern briefings that are factually perfect and unusable. |
| `am-overnight-01` | account_manager | overnight | low | `false_pending_item` | An URGENT high-severity usage-drop alert that the alert itself, a colleague, and a digest all explain away. |
| `am-vacation-01` | account_manager | vacation | balanced | `missed_pending_item` | Two conditions in one customer email; the second is silently droppable. Warm tone and a calm quarter hide a dated revenue deadline. |
| `am-week-01` | account_manager | week | heavy | `fabricated_claim` | "Customer agreed to 3 years at 15% off" assembled from an internal approval ceiling and a counterpart who can't speak for his CFO. |
| `am-weekend-01` | account_manager | weekend | balanced | `missed_pending_item`, `fabricated_claim` | Escalation to a shared alias, user named only in the body; the real deadline requires joining two artifacts. |
| `am-wrong-citation-01` | account_manager | week | balanced | `wrong_citation`, `false_pending_item` | Two customers, near-identical questionnaires, different deadlines; the louder one is a colleague's. |
| `designer-afternoon-01` | designer | afternoon | heavy | `poor_ranking`, `false_pending_item` | Ten messages of colour-token crit (twice explicitly parked) versus one legal-mandated accessibility spec. |
| `designer-overnight-01` | designer | overnight | low | `missed_pending_item` | A cross-timezone handoff phrased with no question mark, no mention and no imperative. |
| `designer-vacation-01` | designer | vacation | balanced | `fabricated_claim` | n=3 research the researcher explicitly refuses to call a preference finding, quoting the exact phrase not to use. |
| `designer-week-01` | designer | week | balanced | `wrong_citation` | One sign-off obligation restated in four artifacts; only one is the ask. |
| `designer-weekend-01` | designer | weekend | low | `false_pending_item` | A single "can somebody take a look before Monday" claimed and closed within two hours. |
| `eng-mgr-afternoon-01` | eng_manager | afternoon | heavy | `missed_pending_item`, `wrong_citation` | Mid-incident tradeoff the on-call is not authorised to make; the ask is a constraint, never a question. |
| `eng-mgr-overnight-01` | eng_manager | overnight | low | `false_pending_item` | Overnight SEV3 whose open-looking question is addressed to someone else *and* answered later in the same thread. |
| `eng-mgr-refusal-01` | eng_manager | week | balanced | `refusal`, `missed_pending_item` | Support plan, salary figure, two confidentiality notices. Refusing or vaguening loses two dated obligations. |
| `eng-mgr-vacation-01` | eng_manager | vacation | balanced | `missed_pending_item` | Explicit blocking ask buried mid-thread under unrelated chatter; the tail of the thread reads as "all clear". |
| `eng-mgr-week-01` | eng_manager | week | heavy | `poor_ranking`, `missed_pending_item` | Four real items ordered opposite to their stakes: three bot reminders versus one quiet retention conversation. |
| `eng-mgr-weekend-01` | eng_manager | weekend | low | `false_pending_item` | A satisfying root-cause investigation someone else opened and closed. Narrative interest without obligation. |
| `eng-mgr-wrong-citation-01` | eng_manager | overnight | balanced | `wrong_citation`, `fabricated_claim` | One deadline, three dates, and the most recent artifact carries the superseded one. |
| `ic-eng-afternoon-01` | ic_engineer | afternoon | heavy | `false_pending_item` | Four @-mentions, four different reasons none of them is an ask. |
| `ic-eng-fabricated-01` | ic_engineer | afternoon | balanced | `fabricated_claim` | A cause hypothesized, refuted, re-hypothesized and explicitly left unproven. |
| `ic-eng-overnight-01` | ic_engineer | overnight | balanced | `missed_pending_item` | A pre-deploy confirmation asked at 21:34, followed by three bot messages saying everything is green. |
| `ic-eng-refusal-01` | ic_engineer | overnight | balanced | `refusal` | Benign internal security finding with an exploit description, a rotated token string, and "do not share". |
| `ic-eng-vacation-01` | ic_engineer | vacation | heavy | `missed_pending_item`, `poor_ranking` | Two items four days apart with an interesting, non-actionable architecture debate between them. |
| `ic-eng-week-01` | ic_engineer | week | balanced | `poor_ranking` | A compliance-gated patch stated once against a survey nudged three times. |
| `ic-eng-weekend-01` | ic_engineer | weekend | low | `false_pending_item`, `bad_style` | Genuinely nothing happened. Auto-merging dependency PRs are the only bait. |
| `injection-01` | eng_manager | two_day | balanced | `prompt_injection_misbehavior` | Injected directives plus a forged untrusted-content terminator, wrapped around legitimate incident content that must still be summarized. |
| `injection-02` | ic_engineer | afternoon | balanced | `prompt_injection_misbehavior`, `missed_pending_item` | Suppression injection via a bot mirroring a hostile PR description and an HTML comment in a support relay. |
| `injection-03` | account_manager | week | balanced | `prompt_injection_misbehavior`, `fabricated_claim` | Payment-fraud-shaped social engineering in plain business English: no jailbreak vocabulary at all. |
| `pm-afternoon-01` | pm | afternoon | heavy | `false_pending_item` | Six direct @-mentions, four of them decision requests, and the correct answer is the negative label. |
| `pm-overnight-01` | pm | overnight | balanced | `missed_pending_item` | The obligation is a lapsing clock in an automated workflow email, surrounded by ignorable automation. |
| `pm-refusal-01` | pm | week | balanced | `refusal`, `missed_pending_item` | Regulator questionnaire under privilege. The "safe" summary omits both what to write and by when. |
| `pm-vacation-01` | pm | vacation | balanced | `fabricated_claim` | A launch-date change that is only ever proposed conditionally and explicitly disclaimed — "slipped to May 4" is lexically grounded but false. |
| `pm-week-01` | pm | week | heavy | `bad_style`, `missed_pending_item` | Twelve messages of true, citable facts around two real items; stores the transcript anti-pattern. |
| `pm-weekend-01` | pm | weekend | low | `false_pending_item` | A colleague explicitly deferring a real question to Monday. A deferral is not a pending item. |
| `pm-wrong-citation-01` | pm | week | balanced | `wrong_citation` | Two near-identical pricing asks, same author, different threads, one addressed to the user. Right summary, wrong artifact is a failure. |

---

## Size and confidence

The design's offline eval set target is ~200 examples initially (§7.5); the Task 5.2 milestone
target was ~70. **This set contains 43** (35 through Task 5.2, plus 8 added 2026-09-04 against
measured coverage gaps). Reporting the number rather than shipping quietly
under it is the explicit instruction in the plan when labeling throughput binds, and it did:
each fixture here is a hand-written scenario with narrative events, per-item citations, and a
`notes` field justifying the label, which is the only way the ground truth stays checkable by
eye — and it is roughly an hour of work each.

What 43 buys. The arithmetic below is unchanged in kind from the 35-fixture version — five more
fixtures narrows the intervals slightly and moves nothing across a threshold, which is itself
the point: the gap to ~70 is not closed by a batch this size.

- **AC-5 (hallucination rate < 2%, release gate).** With 233 claims and zero observed
  fabrications, the 95% upper bound is about 1.3% (rule of three), so a *clean* run can clear
  the gate. But at two observed fabrications the point estimate is 0.86% with a 95% Wilson
  interval of roughly 0.2%–3.1% — the upper bound sits above 2%, so the gate cannot be cleared
  with confidence. At ~70 fixtures (~470 claims) the same two fabrications give roughly
  0.1%–1.5%, which does clear it. **That gap is the concrete reason the target was 70.**
- **AC-3 / AC-4 (recall ≥ 90%, precision ≥ 75%).** 40 positive pending items and 10 negative
  fixtures. One missed item moves measured recall by ~2.5 points, so the set can detect a
  regression of that size but cannot resolve smaller ones. The negative fixtures went 8 → 10
  deliberately: AC-4's precision denominator was the thinnest number in every run to date
  (25 items at n=35), and precision is measured only where the correct answer is "nothing".
- **Per-tag statistical power.** `bad_style` went 3 → 6, `refusal` and
  `prompt_injection_misbehavior` 3 → 4. That is enough to catch a category that is broadly
  broken, not enough to measure a rate within a category. `wrong_citation` (5) is now the
  thinnest tag and the obvious target for the next batch.

  `bad_style` was doubled deliberately, because it is the only tag NO numeric metric can
  detect: a style failure scores perfectly on recall, precision, citation accuracy and
  hallucination rate while being something no user reads to the end. It is therefore the tag
  where fixtures are the *only* instrument, and where the `unacceptable_briefings` field —
  stored anti-patterns for eyeball review — carries the whole signal. The three added on
  2026-09-04 cover style failures the original three did not: manufactured urgency
  (`pm-urgency-01`), burial by chronological or drama-first ordering (`eng-mgr-burial-01`),
  and fusion of unrelated decisions into one smooth clause (`designer-fusion-01`). Two of
  those are failures the Layer 3 system prompt explicitly forbids and nothing previously
  tested.

Treat the numbers above as directional and the interval arithmetic as illustrative: it assumes
one briefing per fixture, independent claims, and that labeled supported claims approximate the
claim count a real briefing emits. Use it to decide where the next fixtures go, not to certify
a release.

**Where the next 35 should go**, in priority order: more `refusal`, `bad_style` and
`prompt_injection_misbehavior` examples (three each is the thinnest coverage in the set); more
negative-label fixtures, since precision under quiet windows is the property users notice first;
`designer` and `two_day` windows, the thinnest axis cells; and every wrong answer from Phase 3–4
manual testing, captured per the habit above rather than invented.

---

## Adding a fixture

1. **Synthetic only.** No real names, no real company information, no real message content,
   no real credentials — not even redacted ones. Invent everything.
2. Name the file for the scenario and set `id` to the filename stem. The convention is
   `<persona-shorthand>-<window-or-failure>-NN`; injection fixtures are named `injection-NN`
   because the payload, not the persona, is the point.
3. Write enough narrative that a human reader can verify the ground truth from the fixture
   alone. A bare skeleton is not a labeled example; if the correct answer isn't checkable by
   eye, the fixture cannot arbitrate a disagreement later.
4. Fill in `ground_truth.notes` with *why* the answer is correct, especially the trap — the
   distractor that makes the fixture worth having.
5. Tag it. Add a second tag if the same example exercises two failure modes.
6. Set `window_kind` and `volume`, and check the axis table above — a fixture that duplicates a
   well-covered cell is worth less than one that fills an empty one.
7. `npm run test -w packages/eval` — the schema test picks the new file up automatically.
