# Add a `request` delta kind to Layer 2

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
   - `DELTA_KINDS` set (~line 104-109): add `'request'`.
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

3. **`config/default.json:7`** — bump `promptVersions.layer2` from `"v1"`
   to `"v2"`. This is a label-only change: confirmed `synthesize.ts:112-119`
   documents that the `SYSTEM_PROMPT`/`INSTRUCTIONS` constants in code are
   the sole executable prompt, and `config/prompts/layer2-synthesize.v1.md`
   is a human-readable mirror only — no code branches on this string, it's
   just recorded on `ai_calls`/`state_deltas` rows for audit
   (`apps/desktop/src/main.ts:824` already builds the string dynamically as
   `` `layer2-synthesize.${appConfig.promptVersions.layer2}` ``, so no
   change needed there).

4. **`config/prompts/layer2-synthesize.v1.md`** — copy to
   `layer2-synthesize.v2.md` with the same wording changes as the
   `SYSTEM_PROMPT`/`INSTRUCTIONS` update, to keep the documented source of
   truth in sync with the executable version, per that file's own stated
   purpose.

## Verified: no changes needed (do not re-derive these)

- **`packages/store` schema/migrations** — `state_deltas.kind` is a plain
  `TEXT` column with no CHECK constraint (`001_initial.sql:72`, just a
  comment). No migration required.
- **`packages/ai/src/layer3/template.ts` (`sectionForKind`, ~188-198)** —
  `buildClaims` (~661-682) already routes *any* delta carrying an open
  pending item to `'Waiting on you'` regardless of `kind`. A `request`
  delta with no pending item falls to the existing `default: 'Worth
  knowing'` branch, which is a safe, adequate fallback.
- **`packages/ai/src/layer3/generate.ts`** — the real LLM narrative path
  passes `[kind: ${delta.kind}]` straight into the prompt as a plain label
  (line 247); the model has no hardcoded enum to validate against here, so
  `request` flows through like any other string. Section placement in this
  path is guided by prose ("Section meanings", lines 162-166) plus whether
  a pending item is attached — not a kind switch. No prompt change needed.
- **`packages/ai/src/layer2/pending.ts`** — entirely kind-agnostic (only
  reads `deltaId`, `waitingOnSelf`, citation, description). No changes.
- **`packages/eval/fixtures/*.json`** — ground truth is free-text
  (`acceptable_briefings`, `supported_claims`, `expect_no_pending`), not
  tied to Layer 2's internal `kind` field. No fixture edits required, but
  see verification step 4 below — `pm-afternoon-01` is the one most likely
  to regress.

## Test changes

- **`packages/ai/test/synthesize.test.ts`** — add a case mirroring the
  existing kind-validation tests: model output classifying a new,
  self-owed, specific ask as `{"meaningful": true, "kind": "request", ...,
  "pending_item": {...}}` must write both a delta and a pending item.
  Keep/extend an existing "not_meaningful" case for a vague or already-
  resolved ask, so the new kind doesn't swallow that bucket.

## Verification

1. `npm run typecheck` — confirms the widened `DeltaKind` union type-checks
   everywhere it's consumed.
2. `npm run test -w packages/ai` — `synthesize.test.ts`, `template.test.ts`,
   `generate.test.ts`, `pending.test.ts`.
3. `npm run test -w packages/store` — sanity that delta persistence accepts
   the new kind string.
4. `npm run eval` (Ollama running, `qwen2.5:14b`) — re-run the ~70-fixture
   harness and report the new pass rate alongside the fixture count (OI-5).
   Specifically confirm `pm-afternoon-01` and any other
   `false_pending_item`-tagged fixtures still pass — that's the regression
   risk from adding a new "something was asked" category.
5. Live re-check against the running app: restart Context Restorer (already
   has the earlier scheduler `DEFAULT_MAX_ATTEMPTS` fix and the manually
   un-parked Vendor SOW thread, `thread_key = 1a07d81d89d8827e`), let it
   resynthesize, and query `context-restorer.db`'s `state_deltas` /
   `pending_items` tables for that thread to confirm a `request` delta and
   a self-owed pending item now exist, then confirm it renders under
   "Needs you" in a freshly generated briefing.
