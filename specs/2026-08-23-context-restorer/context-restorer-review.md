# Code Review Report

**Generated**: 2026-08-28T10:30:00Z
**Spec Folder**: specs/2026-08-23-context-restorer/
**Reviewed Work**: Full Context Restorer build (Phases 0-5) plus the post-hoc Slack channel selector addition (closes Task 1.7's gap: Slack polling previously had no way to choose which channels to poll).
**Artifacts Reviewed**: context-restorer-requirements.md, context-restorer-design.md, context-restorer-plan.md, context-restorer-acceptance.md, context-restorer-tasks.json, sdlc.json
**Git Diff Summary**: Not applicable — this is not a git repository (version control skipped by user decision, 2026-08-23). Reviewed against the current working tree directly.
**Verdict**: PASS (after fixes applied during this review cycle)

---

## Executive Summary

The core security and architectural invariants (SEC-1..8, T-1/T-2, D-6/D-7, X-3, the `IpcDeps` optional-field pattern, the `preload.cts`/`bridge.d.ts` pairing) all hold correctly across the whole build, including the newly-added Slack channel selector. An initial review pass found one blocker (a repo-wide `typecheck` failure from a stale UI test mock) and three high-risk issues (one bad channel could wedge all Slack ingestion; the feature shipped with zero test coverage; a new table was missing from the SEC-8 right-to-delete list) — all four have been fixed and re-verified in this same cycle, along with two medium-risk items (a health-status ordering bug, a stale scope line in the design doc).

---

## Quick Reference

| #   | Description                                                                 | Risk Level | Recommended Solution                                            | Status |
| --- | ---------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------- | ------ |
| 1   | `npm run typecheck` failed — new `slack` bridge field missing from UI test mock | BLOCKER    | Add `slack: {...}` to the mock bridge object                      | Fixed  |
| 2   | One bad/non-member Slack channel could wedge ingestion for all channels        | HIGH       | Isolate per-channel errors; only fail the cycle if all fail       | Fixed  |
| 3   | Zero test coverage for the entire channel-selector feature                    | HIGH       | Added tests for `listChannels`, `SlackChannelsRepo`, IPC handlers | Fixed  |
| 4   | SEC-8 `deleteEverything()` did not purge `slack_selected_channels`             | HIGH       | Add table to `DELETE_ORDER`; add a schema-driven safety-net test | Fixed  |
| 5   | Slack health read as "ok" before checking whether Slack was ever connected     | MEDIUM     | Check the vault before the empty-selection idle check              | Fixed  |
| 6   | Design doc's §6.1 scope line was stale (missing `channels:read`)              | MEDIUM     | Updated design.md to match `SLACK_SCOPES` with dated rationale     | Fixed  |
| 7   | Onboarding status doesn't disclose "Slack connected, 0 channels selected"      | MEDIUM     | Deferred — see Assessment                                          | Deferred |
| 8   | Initial per-channel backfill is unbounded, multiplied by N channels           | MEDIUM     | Deferred (pre-existing single-channel issue, out of scope here)    | Deferred |
| 9-13| Minor UX/edge-case polish (dedup on save, no success toast, etc.)             | LOW        | Deferred — see Assessment                                          | Deferred |

---

## Issues by Risk Tier

### BLOCKERS (Must Fix Before Merge)

#### Issue #1: `npm run typecheck` failed — hand-maintained UI test mock missing the new bridge field

**Description**: Adding `slack: {...}` to `ContextRestorerBridge` in `apps/ui/types/bridge.d.ts` made the hand-rolled mock bridge object in a UI test structurally incomplete, since TypeScript requires every property of the interface. `npm run test` still passed because vitest transpiles without typechecking, so this was invisible to the test suite and only the `typecheck` gate caught it.

**Location**:
- File: `apps/ui/test/briefingView.test.tsx`
- Lines: 100 (object literal), 153-157 (insertion point)

**Offending Code**:
```
error TS2741: Property 'slack' is missing in type '{ onboarding: ...; }'
but required in type 'ContextRestorerBridge'.
```

**Resolution**: Added the `slack` block to the mock, matching the shape of the sibling `schedule`/`debug` blocks already present for the same reason (present only to satisfy the bridge contract; nothing in the briefing view touches these channels). Verified: `npm run typecheck` now exits 0 at the repo root.

---

### HIGH RISK (Should Fix Before Merge)

#### Issue #2: One unpollable channel could wedge ingestion for every other selected channel

**Description**: `listChannels()` returns every visible public channel, including ones the connected user has not joined. The settings UI rendered all of them as equally selectable. Selecting a non-member channel made `conversations.history` throw (Slack's `not_in_channel` error, correctly non-retryable), and that throw escaped the per-channel poll loop unguarded — discarding events already fetched from OTHER, healthy channels in the same cycle and backing the whole Slack source off. Because cursors never advanced, the failure repeated every cycle until the user removed the bad channel.

**Location**: `apps/desktop/src/main.ts` (`VaultBackedSlackClient.fetchSince`), `apps/ui/app/settings/channels.tsx`

**Resolution**:
1. Wrapped each channel's fetch in its own try/catch inside the loop; a failing channel keeps its previous watermark and logs the error, but does not stop the other channels from being polled. The whole cycle only fails (and the source only backs off) when *every* selected channel failed.
2. `channels.tsx` now disables the checkbox for any channel where `isMember` is false, with an inline "join this channel in Slack first" label, so the broken selection is no longer reachable through the happy path.

Verified: `npm run typecheck` and the full test suite pass; the settings UI was re-inspected for the new disabled-state rendering.

#### Issue #3: Zero test coverage for the entire feature

**Description**: No test file referenced `listChannels`, `SlackChannelsRepo`, the new IPC handlers, or `parseChannelCursors` — a real gap against this codebase's own established convention of a test file per repo/IPC module/client method.

**Resolution**: Added:
- `packages/ingest/test/slack.test.ts` — a `listChannels` describe block covering pagination, the repeated-cursor-loop guard, and id/name/isMember mapping (including the "no name" and "no is_member" fallback cases).
- `packages/store/test/repos.slackChannels.test.ts` — full `SlackChannelsRepo` coverage: empty start state, ordering, whole-selection replacement, `addedAt` preservation across an unrelated re-save, rename-on-resave, and clearing the selection.
- `apps/desktop/test/ipc.slackChannels.test.ts` — `parseSelection`'s accept/reject matrix, `getSelectedChannels`/`setSelectedChannels`'s happy path and failure-degradation, and `listAvailableChannels`'s `not_connected` / live-fetch / thrown-Slack-error paths (via a stubbed global `fetch`, matching `SlackClient`'s own transport-injection pattern).

`VaultBackedSlackClient` and `parseChannelCursors` remain in `main.ts` and are not directly unit-tested — consistent with this codebase's pre-existing convention that the composition root itself (which imports `electron` at module scope) has no dedicated test file anywhere in the build; every other adapter defined in `main.ts` (`citationFor`, `startBriefingGeneration`, the original single-channel `VaultBackedSlackClient`) was in the same position before this feature existed. This is a pre-existing convention boundary, not a gap newly introduced here.

Verified: 1180 tests pass repo-wide (up from 1152), 0 failing, 1 pre-existing skip.

#### Issue #4: SEC-8 `deleteEverything()` did not purge the new channel-selection table

**Description**: Migration 004 added `slack_selected_channels`, holding user data (workspace channel ids and names), but `retention.ts`'s `DELETE_ORDER` was not updated to include it — so a right-to-delete request would leave the user's channel selection intact and polling would silently resume against it.

**Location**: `packages/store/src/retention.ts` (`DELETE_ORDER`), `packages/store/test/rightToDelete.e2e.test.ts`

**Resolution**: Added `'slack_selected_channels'` to `DELETE_ORDER`. Also hardened the e2e test itself: rather than relying solely on a second hand-maintained table list (which is exactly how this gap occurred), added `allUserDataTables()`, which enumerates every real table from `sqlite_master` (excluding `schema_version`) and asserts each is empty after the wipe — so a future migration that adds a table but forgets to register it for deletion fails this test automatically instead of shipping silently. The existing static `USER_DATA_TABLES` list was also updated and the repo is now seeded with one channel selection in `seedEverything()`.

Verified: `packages/store/test/rightToDelete.e2e.test.ts` passes, including the new dynamic safety-net assertion.

---

### MEDIUM RISK (Fix Soon)

#### Issue #5: A never-connected Slack account read as healthy

**Description**: `VaultBackedSlackClient.fetchSince` checked "no channels selected" (a healthy idle state) before checking whether Slack was connected at all — so a fresh install with zero channels selected AND no OAuth token reported `status: 'ok'` in the health strip, contradicting the surrounding code's own stated rationale for why `{events: []}` must not stand in for "not connected".

**Resolution**: Reordered the checks — the vault load now runs first, so a revoked or never-connected token still throws `notConnectedError('slack')` regardless of channel selection state; the empty-selection idle return only applies once a token is confirmed present.

#### Issue #6: Design doc's scope line was stale

**Description**: `context-restorer-design.md` §6.1 still listed the pre-`channels:read` scope set, while `context-restorer-requirements.md`'s FR-1 had already been correctly updated — leaving the design doc's own "nothing broader (T-2)" claim technically false against the shipped code.

**Resolution**: Updated §6.1 to the current four-scope set, with the same dated (2026-08-28) rationale FR-1 carries, plus a note on the fixed Slack loopback port (a related, previously undocumented design detail from the same OAuth work).

#### Issue #7 (Deferred): Onboarding doesn't disclose "Slack connected, 0 channels selected"

**Description**: `onboarding:status` reports Slack as connected purely from vault presence, with no notion of channel selection — so a user could complete onboarding and request a briefing that will be permanently empty on the Slack side, with no signal pointing them at the settings page.

**Reasoning for deferral**: This is a real UX gap, not a correctness or security issue — the settings page's own copy already discloses the requirement, and no data is at risk. Fixing it properly means deciding a product question (does onboarding block on channel selection, or just nudge?) that is the user's call, not a code-review call. Recommended as a follow-up task if/when Slack OAuth is actually connected in this environment.

#### Issue #8 (Deferred): Unbounded initial per-channel backfill, multiplied by N channels

**Description**: `Poller` cursors are in-memory only; every app restart starts every selected channel's fetch with no `oldest` bound, walking full history and every threaded reply sequentially. This is a pre-existing single-channel issue that the channel selector makes proportionally worse (N channels instead of one).

**Reasoning for deferral**: Fixing this requires a persisted-cursor design (a new `poll_cursor` table) that is a meaningful piece of work in its own right and pre-dates this feature; it is not something the channel selector regressed in kind, only in degree. Recommended as a separate follow-up task, not a blocking fix for this feature.

---

### LOW RISK (Nice to Have) — Deferred

- `SlackChannelsRepo.setSelected` doesn't dedupe the incoming array before insert; a duplicate id aborts the transaction and is reported as a generic `internal_error`. Fails safely, just an unhelpful message.
- `channels.tsx`'s Save silently drops a previously-selected channel that's no longer visible (archived/left), with no notice to the user.
- No success confirmation after Save; the Save button is hidden entirely when the available list is empty, so a user whose channels all disappeared can't clear a stale selection through the UI.
- `listChannels()` doesn't dedupe by id across pages (only cursor-loop-dedupes), unlike `fetchChannel`'s dedup map — harmless today since the repo's primary key collapses duplicates on write, but inconsistent with its sibling method.
- Revoking Slack OAuth leaves `slack_selected_channels` populated; reconnecting silently resumes the old selection. Arguably correct (SEC-3 only requires credential purge), noted for awareness.

None of these affect correctness, security, or data integrity; recommended as opportunistic cleanup, not scheduled work.

---

## Spec Compliance Check

### Requirements Compliance

- [x] **FR-1 / SEC-1 / T-2** (exact minimum OAuth scopes) — `channels:read` added with a dated rationale; requirements and design docs both now match the shipped `SLACK_SCOPES` constant.
- [x] **T-2 scope centralization** — no scope string is inlined anywhere outside `packages/ingest/src/oauth/scopes.ts`.
- [x] **SEC-2/SEC-3** (tokens only via `TokenVault`) — both new call sites read from the vault and never persist a token elsewhere.
- [x] **SEC-4/SEC-5** (redact before persist / before display) — unchanged by this feature; verified still intact.
- [x] **SEC-6 / X-3** (localhost-only Ollama; exactly `['ollama','template']`) — unchanged; verified still intact.
- [x] **SEC-8** (right to delete) — was FAILING (Issue #4), now fixed and covered by a schema-driven safety-net test.
- [x] **T-1** (citation gate) — unchanged by this feature; verified still intact.
- [—] **AC-1, AC-3…AC-8, AC-11** — pre-existing, honestly-disclosed limitations from the original 6-phase build (see `context-restorer-acceptance.md`), unaffected by this feature.

### Design Compliance

- [x] **D-6 / D-7** (append-only deltas; durable debounce watermark) — untouched by this feature, re-verified.
- [x] **`IpcDeps` additive-optional-field pattern** — `slackChannels?: SlackChannelStore` correctly gated; `vault` (always present) is reused rather than duplicated.
- [x] **`preload.cts` / `bridge.d.ts` pairing** — the new `slack.*` surface is structurally identical across both files, field for field.
- [x] **Wiring into `main.ts`** — `SlackChannelsRepo` is constructed once and passed to both the poller and `registerIpcHandlers`; this build did not repeat the project's historical "built but not wired" bug.
- [x] **Migration ordering/idempotency** — migration 004 follows the established `NNN_*.sql` convention and is picked up automatically.

### Plan Compliance

- [x] Task 1.7's gap ("Slack polling had no channel selection") is closed end to end, including the health-state correctness fix (Issue #5).
- [x] The plan's own standard — "nothing counts as complete until it has been measured" — is now met: `npm run typecheck` exits 0, and the feature has real test coverage rather than "correct on inspection."

---

## Verification Checklist

- [x] All blockers addressed
- [x] High-risk issues reviewed and resolved
- [x] Breaking changes documented — none; this is a purely additive feature
- [x] Security vulnerabilities patched — SEC-8 gap closed
- [x] Performance regressions investigated — Issue #8 (unbounded backfill) identified and consciously deferred with reasoning, not ignored
- [x] Tests cover new functionality — `listChannels`, `SlackChannelsRepo`, and the three new IPC handlers all covered
- [x] Documentation updated for the scope change — requirements FR-1 and design §6.1 both current

---

## Final Verdict

**Status**: PASS

**Reasoning**: The single blocker (a broken repo-wide typecheck) and all three high-risk issues found in the initial review pass were fixed and re-verified within this same review cycle — `npm run typecheck` exits 0, the full test suite passes (1180 passed, 1 pre-existing skip, 0 failing), and both `apps/ui` and `apps/desktop` rebuild cleanly. The two medium-risk deferrals (onboarding disclosure, unbounded backfill) are real but are product/scope decisions and a pre-existing issue respectively, not defects introduced by or blocking this feature.

**SDLC Tracker**: `review` step set to `complete`.

**Next Steps**:
- `/document specs/2026-08-23-context-restorer/` — document the completed feature
- `/learn specs/2026-08-23-context-restorer/` — extract learnings from this cycle
- `/submit-changes` — not applicable; this is not a git repository (version control skipped by user decision)

---

**Report File**: `specs/2026-08-23-context-restorer/context-restorer-review.md`
