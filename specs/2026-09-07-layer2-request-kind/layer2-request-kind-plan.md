# Add a `request` delta kind to Layer 2

## Implementation status (2026-09-07)

Code + tests done and green:

- `packages/core/src/types.ts` — `DeltaKind` widened with `'request'`.
- `packages/ai/src/layer2/synthesize.ts` — `DELTA_KINDS` set + comment,
  `SYSTEM_PROMPT` (`request` line + tightened "Not meaningful"),
  `INSTRUCTIONS` schema string, and the `SYSTEM_PROMPT` doc comment
  (`v1` → `v2`). `SCHEMA_NAME` left as `layer2_synthesis_v1` per plan.
- `packages/ai/src/layer3/generate.ts` — "Section meanings" gains the
  one-clause "Worth knowing" carve-out for a not-yet-obligation request.
- `config/default.json` — `promptVersions.layer2` `"v1"` → `"v2"`.
  (No `config/default.local.json` exists, so no override to clear.)
- `config/prompts/layer2-synthesize.v2.md` — new, copied from v1 with all
  "four" → "five" and the `request` wording; `v1.md` untouched.
- `packages/ai/test/synthesize.test.ts` — new "request kind" describe
  block (self-owed → delta + item; third-party → delta only; unknown kind
  still `schema_error`). `PROMPT_VERSION` test constant left at `.v1`
  (self-consistent, plan says optional).
- `packages/ai/test/template.test.ts` — new case: a `request` delta with
  no pending item renders under "Worth knowing".

Verification run: `npm run typecheck`, `npm run test -w packages/ai`
(413), `-w packages/store` (207), `-w packages/core` (21), `-w
packages/eval` (239) all pass.

Still outstanding (need real Ollama / the running app, not run here):

- `npm run eval` full harness (~42 fixtures, ~min each) — `pm-afternoon-01`
  started as a spot regression check; full run + pass-rate-with-n is the
  user's to complete.
- Live re-check against `context-restorer.db` (verification step 5).

## Context

Diagnosed live against the running app's DB and trace logs: a test email
("Legal is holding the countersign until you approve the SOW... before
Friday") was ingested, extracted, and actually reached a real Layer 2 model
call — but the call returned `{"meaningful": false}`, so no delta and no
pending item were ever written. It silently never appears in a briefing no
matter how long you wait.

Root cause: `packages/ai/src/layer2/synthesize.ts`'s prompt only recognizes
four "meaningful" kinds — `decision`, `progress`, `reversal`, `resolution`.
A brand-new, unresolved request doesn't fit any of them (it isn't a
decision, doesn't advance prior work, doesn't reverse anything, and
`resolution` means an obligation was *closed*, not raised). Following the
prompt literally, the model correctly says nothing changed. Worse,
`pending_item` — the only thing that drives "Waiting on you" — is only ever
read when `meaningful: true` (`synthesize.ts:384` short-circuits before
looking at it), so there is currently no path at all for "nothing about the
thread's state changed, but a new obligation was just placed on you."

Chosen fix (over the alternative of letting `pending_item` ride along with
`meaningful: false`): add a fifth `DeltaKind`, `request`, meaning "a new,
specific obligation was placed on someone, with nothing else about the
thread's state changing." The alternative was rejected because
`pending_items.delta_id` is not optional — a pending item without
`meaningful: true` would still need a delta row, either via a schema change
(nullable FK) or by forcing a placeholder delta through the D-6
chain-versioning logic anyway, which breaks the module's own documented
invariant ("`{meaningful: false}` writes nothing at all — no delta, no
pending item").

Already confirmed by reading the surrounding code that most of the pipeline
requires **no changes** — see "Verified: no changes needed" below.

## Files to change

1. **`packages/core/src/types.ts:9`**
   Widen the type: `DeltaKind = 'decision' | 'progress' | 'reversal' | 'resolution' | 'request'`.

2. **`packages/ai/src/layer2/synthesize.ts`**
   - `DELTA_KINDS` set (~line 104-109): add `'request'`. Also fix the
     comment on line 103 ("The four categories a delta may take") → five.
   - `SYSTEM_PROMPT` (~line 121-151): add a fifth line to "Meaningful means
     one of", e.g. `request — a new, specific obligation was placed on
     someone, with nothing else about the thread's state changing`. Also
     tighten the "Not meaningful" list so a question that gets answered,
     withdrawn, or resolved inline the same window is NOT misclassified as
     a `request` — this is the precise failure mode the eval fixture
     `pm-afternoon-01` (`false_pending_item`) stress-tests (six direct
     @-mentions asking for a decision, all correctly resolved without the
     user).
   - `INSTRUCTIONS` (~line 162-176): add `|request` to the `kind` enum
     string in the schema description.
   - `SCHEMA_NAME` (line 179, `'layer2_synthesis_v1'`): leave as-is. Its
     doc comment (line 178) says "error attribution only" — it is a
     `generateJson` label, not a prompt version, and nothing joins on it.
     Bumping it would be churn with no audit value; the `promptVersion`
     recorded on rows is the real version marker.

3. **`packages/ai/src/layer3/generate.ts`** — `SYSTEM_PROMPT`, "Section
   meanings" (~line 162-166). The LLM narrative path renders `[kind:
   request]` into the prompt (line 247) with no guidance on where a
   `request` *without* an attached obligation belongs, and a model that
   sees the word "request" is likely to file it under "Waiting on you" —
   the exact false-"Waiting on you" failure F-5/AC-4 exist to prevent.
   Add one clause making the routing explicit, e.g. on the "Worth knowing"
   line: `— context they would want but that requires nothing from them,
   including a request that has not yet become an obligation on this
   person`. Prose-only; `BRIEFING_SECTIONS` and the citation gate are
   untouched. The deterministic `template.ts` path already routes this
   correctly (`sectionForKind` `default` branch — see "Verified" below),
   so this item covers the LLM path *only*.

4. **`config/default.json:7`** — bump `promptVersions.layer2` from `"v1"`
   to `"v2"`. This is a label-only change: confirmed `synthesize.ts:111-119`
   documents that the `SYSTEM_PROMPT`/`INSTRUCTIONS` constants in code are
   the sole executable prompt, and `config/prompts/layer2-synthesize.v1.md`
   is a human-readable mirror only. No code branches on this string:
   `packages/core/src/config.ts:24` types it as a bare `string` with no
   validation; `apps/desktop/src/main.ts:941` already builds the recorded
   value dynamically as
   `` `layer2-synthesize.${appConfig.promptVersions.layer2}` ``; the eval
   harness (`packages/eval/src/harness.ts:684`) passes it through as a
   telemetry label and never loads the `.md`. It is recorded on
   `ai_calls`/`state_deltas` rows for audit only.
   - Before verification step 5, check `config/default.local.json`
     (gitignored, untracked) is not pinning `promptVersions.layer2` to
     `"v1"` — a local override there would silently keep v1 wording at
     runtime and make the live re-check exercise the wrong prompt.

5. **`config/prompts/layer2-synthesize.v1.md` → copy to
   `layer2-synthesize.v2.md`** (leave `v1.md` untouched — rows already in
   the DB tagged `layer2-synthesize.v1` still mean the v1 wording). The
   `.md` says "four" in more places than the code diff touches; sync all
   of them:
   - heading line 1: `(v1)` → `(v2)`.
   - the "Meaningful means one of" block (~lines 25-29): add the `request`
     line, mirroring `SYSTEM_PROMPT`.
   - the "Not meaningful" line (~31-32): mirror the tightening.
   - output schema fence, line 65:
     `"kind": "decision|progress|reversal|resolution"` → add `|request`.
   - field note, line 82: "exactly one of the four literal values" → five.
   - after editing, `grep -n 'four\|resolution"' layer2-synthesize.v2.md`
     to confirm nothing stale remains.

## Verified: no changes needed (do not re-derive these)

- **`packages/store` schema/migrations** — `state_deltas.kind` is a plain
  `TEXT` column with no CHECK constraint (`001_initial.sql:72`, just a
  comment). No migration required.
- **`packages/ai/src/layer3/template.ts` (`sectionForKind`, ~188-198)** —
  `buildClaims` (~661-683) already routes *any* delta carrying an open
  pending item to `'Waiting on you'` regardless of `kind` (`template.ts:675`).
  A `request` delta with no pending item falls to the existing
  `default: 'Worth knowing'` branch (`template.ts:196`), which is a safe,
  adequate fallback. No code change — but note this is the *deterministic*
  path; the LLM path needs the prose tweak in "Files to change" item 3.
- **`packages/ai/src/layer3/generate.ts`** — no *code* change: the path
  passes `[kind: ${delta.kind}]` into the prompt as a plain label
  (line 247) with no hardcoded enum, so `request` flows through like any
  other string, and `persist()` (line 1128) already stopped minting
  pending items from section membership (F-5). The *prompt* does need the
  one-clause "Section meanings" tweak — see "Files to change" item 3 for
  why a bare `request` would otherwise likely be misfiled under "Waiting
  on you".
- **D-6 chain versioning** — no change, but a known interaction to watch
  in eval: a `request` delta becomes the thread's new chain tip and
  supersedes the prior version, and both Layer 3 paths read tips only
  (`currentForWindow`, `template.ts:392`/`535`, `generate.ts:647`). By its
  own definition ("nothing else about the thread's state changing") a
  `request` is the kind most likely to land on a thread whose prior
  `decision`/`progress` tip is *still true*, and that prior tip then drops
  out of subsequent briefings. This is existing behaviour for every kind
  (a `progress` delta supersedes a `decision` the same way) and the prior
  state was already delivered in an earlier briefing, so it is acceptable
  for the POC — but the tightened `SYSTEM_PROMPT` should still steer the
  model to fold genuinely-unresolved prior state into the `request`
  summary rather than dropping it. Flag any eval fixture where a late
  request buries an earlier still-open item.
- **`packages/ai/src/layer2/pending.ts`** — entirely kind-agnostic (rule 1
  gates on `waitingOnSelf`, then citation, description, dedupe — never
  `kind`; verified end-to-end `pending.ts:176-220`). The motivating case
  (`kind: "request"` + `pending_item{waiting_on: "self", …}`) flows
  straight through `derivePendingItem`. No changes.
- **`packages/eval/fixtures/*.json`** — ground truth is free-text
  (`acceptable_briefings`, `supported_claims`, `expect_no_pending`), not
  tied to Layer 2's internal `kind` field. No fixture edits required, but
  see verification step 4 below — `pm-afternoon-01` is the one most likely
  to regress.

## Test changes

- **`packages/ai/test/synthesize.test.ts`** — add a case mirroring the
  existing kind-validation tests (the `meaningful({ kind: 'not_a_kind' })`
  → `schema_error` pattern at ~line 635): model output classifying a new,
  self-owed, specific ask as `{"meaningful": true, "kind": "request", ...,
  "pending_item": {...}}` must write both a delta and a pending item.
  Keep/extend an existing "not_meaningful" case for a vague or already-
  resolved ask, so the new kind doesn't swallow that bucket. The local
  `PROMPT_VERSION` constant (line 39, `'layer2-synthesize.v1'`) is passed
  straight into the constructor and is self-consistent — the config bump
  does not break these tests. Bump it to `.v2` in the same change only for
  label accuracy; not required.
- **`packages/ai/test/generate.test.ts`** — add/extend a case that feeds a
  `request` delta with **no** pending item through the LLM path and
  asserts it does not land in "Waiting on you" (the regression the item-3
  prompt clause guards against). If the existing generate tests stub the
  model rather than asserting section routing from real output, at minimum
  add a template-path assertion in `template.test.ts` that a `request`
  delta with no open item renders under "Worth knowing".

## Verification

1. `npm run typecheck` — confirms the widened `DeltaKind` union type-checks
   everywhere it's consumed.
2. `npm run test -w packages/ai` — `synthesize.test.ts`, `template.test.ts`,
   `generate.test.ts`, `pending.test.ts`.
3. `npm run test -w packages/store` — sanity that delta persistence accepts
   the new kind string.
4. `npm run eval` (Ollama running, `qwen2.5:14b`) — re-run the harness and
   report the new pass rate **with the actual example count the run
   reports** (OI-5 / RO-2 — an unqualified percentage is not acceptable;
   `packages/eval/fixtures/` currently holds 41 fixture files, so do not
   restate "~70" without confirming what the harness counts). Specifically
   confirm `pm-afternoon-01` and any other `false_pending_item`-tagged
   fixtures still pass — that's the regression risk from adding a new
   "something was asked" category — and eyeball any fixture where a thread
   with a late request also had an earlier still-open item, per the D-6
   note above.
5. Live re-check against the running app: first confirm
   `config/default.local.json` does not pin `promptVersions.layer2` back to
   `"v1"` (see "Files to change" item 4). Then restart Context Restorer
   (already has the earlier scheduler `DEFAULT_MAX_ATTEMPTS` fix and the
   manually un-parked Vendor SOW thread,
   `thread_key = 1a07d81d89d8827e`), let it resynthesize, and query
   `context-restorer.db`'s `state_deltas` / `pending_items` tables for that
   thread to confirm a `request` delta and a self-owed pending item now
   exist, then confirm it renders under **"Waiting on you"** (the actual
   section name — `generate.ts:96`, `BriefingView.tsx:54`) in a freshly
   generated briefing.
