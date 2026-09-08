# Manual "refresh now" button per source, with a cooldown

## Implementation status (2026-09-07)

Done, all tests green. Files as landed:

- `apps/desktop/src/ipc/poll.ts` — NEW. `poll:refresh` channel,
  `MANUAL_REFRESH_COOLDOWN_MS = 60_000`, `PollRefreshResult`,
  `parsePollSource`, `requestManualRefresh` (pure, takes the cooldown
  `Map`), `registerPollHandlers`. A `pollNow` throw returns
  `internal_error` and does **not** start the cooldown.
- `apps/desktop/src/ipc/index.ts` — import + re-export block +
  `registerPollHandlers({ poller, clock })` called unconditionally.
- `apps/desktop/src/preload.cts` — `PollRefreshResult` type + `poll.refresh`
  method (reuses `assertSource`).
- `packages/ingest/src/poller.ts` — comment-only: class-doc bullet and
  `pollNow`'s doc comment now name the manual-refresh caller.
- `apps/ui/types/bridge.d.ts` + `apps/ui/lib/bridge.ts` — mirror
  `PollRefreshResult` + `poll.refresh`.
- `apps/ui/components/RailStatus.tsx` — `RefreshIcon` inline SVG, per-source
  `IconButton`, `busy` / `readyAt` / `nowTs` state, a 1s ticker that clears
  itself when nothing is cooling, `handleRefresh`. Right edge of each row is
  now `lag + button` in one flex box.
- `apps/ui/app/globals.css` — `@keyframes cr-spin` + `.cr-spin`.
- `apps/desktop/test/ipc.poll.test.ts` — NEW, 17 cases.
- `apps/ui/test/railStatus.test.tsx` — NEW, 5 cases (fake timers).

Verification run: `npm run typecheck`; `npm run test -w apps/desktop` (296);
`-w apps/ui` (61); `-w packages/ingest` (152 + 1 skip); `npm run build:ui`
then grepped `apps/ui/out/{index,onboarding/index,settings/index}.html` for
`<style` → zero (the Next.js built-in `404.html` carries one, pre-existing
and never served by the `app://` shell). Still outstanding: `npm run start`
and the manual click-through in step 6 below.

Deviation from the plan: the busy spinner is a `<Box>` wrapper with the
`.cr-spin` class inside the `IconButton` (not `CircularProgress`), exactly as
Design decision 7 preferred.

## Summary

Add a small refresh icon-button beside **Slack** and **Gmail** in the
`RailStatus` "Sources" block. Clicking it forces that source's next poll
cycle immediately (bypassing the poll interval / any backoff), rather than
waiting up to `polling.<source>.intervalMs` (5 min default). To stop it
being used as a hammer against Slack/Gmail rate limits, each source can only
be manually refreshed once per **cooldown window** (60 s), enforced in the
main process — the button in the renderer is only a UX echo of that gate.

The mechanism already exists: `Poller.pollNow(source)` forgets the source's
backoff and schedules a cycle at delay 0. Today its only caller is
`oauth:connect`'s `onConnected` hook. This adds a second sanctioned caller,
reached through a new `poll:refresh` IPC channel that owns the throttle.

## What exists today (verified — do not re-derive)

- **`packages/ingest/src/poller.ts`** — `Poller.pollNow(source: 'slack' |
  'gmail'): void` (line 193). Resets `failures`/`nextDelayMs` to the base
  interval, and if running and not mid-cycle, `#scheduleNext(source, 0)`. If
  a cycle is in flight it sets `rerunImmediately` so the cycle re-runs at
  once when it settles. Returns nothing; does not touch health. The class
  doc comment (lines 11-13) and `pollNow`'s own comment (lines 174-192)
  currently claim it exists for "exactly … the moment the user connects a
  source" — that wording needs to widen to "connect, or an explicit user
  refresh".
- **`apps/desktop/src/ipc/oauth.ts`** — `OauthHandlerDeps.onConnected`,
  wired in `ipc/index.ts:375` to `(source) => deps.poller.pollNow(source)`.
  The pattern to mirror: a thin `ipcMain.handle` that never throws, returns
  `{ ok, reason }`, re-validates its argument (`parseSource`).
- **`apps/desktop/src/ipc/index.ts`** — `IpcDeps.poller` is always present
  (`main.ts:1436` builds it before `registerIpcHandlers`). `registerIpcHandlers`
  already threads `deps.clock ?? systemClock` into the handlers that need a
  clock (`schedule`, `slackChannels`, `feedback`).
- **`apps/desktop/src/preload.cts`** — one named method per channel (design
  rule 1: no generic passthrough). `assertSource` (line 413) already exists.
  `OkResult` is the shared ack shape. `contextBridge.exposeInMainWorld`.
- **`apps/ui/types/bridge.d.ts`** — hand-kept structural mirror of the
  preload payload types (the renderer cannot import `@cr/desktop`).
- **`apps/ui/components/RailStatus.tsx`** — renders the "Sources" list:
  `health.map((entry) => …)` where `entry` is `{ source, status, lagMs }`,
  each row a flex line `dot • name • lag` (`formatLag`), `title={STATUS_TITLE[…]}`.
  Subscribes via `bridge.health.onSources`. Early-returns a "desktop app
  only" note when `!hasBridge()`.
- **`apps/ui/components/AppShell.tsx`** — precedent for inline-SVG icons as
  module-scope `const`s (`HomeIcon`, `SetupIcon`, `SettingsIcon`), 18×18,
  `stroke="currentColor"`, `aria-hidden`.
- **No icon library.** `@mui/icons-material` is not a dependency and must
  not be added (it is a large dep and the redesign plan pins the MUI/Pigment
  versions deliberately). Icons are hand-rolled inline `<svg>`.
- **`apps/ui/app/globals.css`** — where conditional/animated styling lives
  (Pigment only extracts static `sx`). Already has a
  `@media (prefers-reduced-motion: reduce)` block that neutralizes
  animations except `.MuiCircularProgress-*`.
- **`apps/desktop/test/ipc.slackChannels.test.ts`** — the IPC unit-test
  pattern: `vi.mock('electron', () => ({ ipcMain: { handle } }))`, dynamic
  `import`, a `makeDeps` factory with an injected `clock: { now: () => … }`.
- **`apps/ui/test/briefingView.test.tsx`** — the renderer test pattern:
  build a full fake `bridge`, assign `window.contextRestorer`, delete it in
  `afterEach`.
- **`packages/core/src/config.ts`** — `AppConfig` + `assertValid`. Adding a
  config block means touching the type, the validator, `config/default.json`,
  and being sure `electron-builder.yml`'s `extraResources` still ships it
  (it copies all of `config/`, minus `*.local.json`). This plan does **not**
  add config — see Design decision 4.

## Design decisions

1. **New channel `poll:refresh`, not a reuse of anything.** It is a
   user-initiated mutation with its own failure vocabulary (`cooldown`),
   distinct from `oauth:connect`. One named method per channel is the
   preload's first security rule.

2. **The cooldown is enforced in the main process; the renderer's disabled
   state is cosmetic.** `apps/desktop/src/ipc/poll.ts` keeps a
   `Map<'slack' | 'gmail', number>` of the last *accepted* refresh time and
   compares against an injected clock. A compromised or reloaded renderer
   that calls `poll:refresh` in a loop gets `{ ok: false, reason:
   'cooldown' }` after the first hit. This is the trust boundary, same as
   every other handler re-validating its args.

3. **Reuse `Poller.pollNow` as the mechanism.** It already does exactly the
   right thing (forget backoff, poll at delay 0, coalesce with an in-flight
   cycle). Widen its doc comments to name the second caller; no logic
   change to the poller.

4. **Cooldown length is a module constant, not config.** `const
   MANUAL_REFRESH_COOLDOWN_MS = 60_000` in `ipc/poll.ts`, overridable via a
   `deps` field for tests only. Precedent: `DEFAULT_PUSH_INTERVAL_MS`
   (`health.ts`), `SLACK_REDIRECT_PORT` (`oauth.ts`), `REFRESH_SKEW_MS`
   (`oauth.ts`) are all in-code constants. 60 s is well under the 300 s poll
   interval, so a user clicking every 60 s still polls a healthy source less
   aggressively than… actually *more* often than the 5-min interval but far
   less than a tight loop, and it stops the moment they stop clicking —
   acceptable for a POC and explicitly user-initiated. If a config knob is
   wanted later it is a one-line `polling.manualRefreshCooldownMs` addition;
   out of scope here.

5. **The result carries `retryAfterMs`** so the renderer can disable the
   button for the right duration without hard-coding the cooldown on its
   side (and so a reloaded renderer that lost its timer learns the remaining
   time from the first rejected click). Returned on both outcomes: the full
   cooldown on `ok: true`, the remaining time on `ok: false, reason:
   'cooldown'`.

6. **A `disconnected` source's button stays enabled.** The user may have
   just re-authorised on the provider's side; a forced poll is the cheapest
   way to find out, and `pollNow` clearing the backoff is fine because the
   cooldown still caps the rate.

7. **Spinner while the cycle request is in flight** uses a `@keyframes
   cr-spin` rule in `globals.css` applied to the inline SVG (not
   `CircularProgress` — avoids depending on MUI's component CSS extraction
   for one small case, and matches "animated ⇒ globals.css"). Under
   `prefers-reduced-motion` the existing global rule freezes it; the button
   still visibly disables, so "working" is still conveyed. The in-flight
   window is short (one `ipcRenderer.invoke` round-trip; the actual fetch is
   async in the poller and not awaited), so this is mostly a press
   acknowledgement.

## Files to change

### Main process

1. **`apps/desktop/src/ipc/poll.ts`** — NEW.
   - `export const REFRESH_CHANNEL = 'poll:refresh';`
   - `export const MANUAL_REFRESH_COOLDOWN_MS = 60_000;`
   - `export interface PollRefreshResult { ok: boolean; reason?: string;
     retryAfterMs?: number; }` (mirror in preload).
   - `export interface PollHandlerDeps { poller: Pick<Poller, 'pollNow'>;
     clock: { now(): number }; cooldownMs?: number; }`
   - `parsePollSource(arg: unknown): 'slack' | 'gmail' | null` — same shape
     as `oauth.ts`'s `parseSource` (`(arg as {source?}).source`).
   - `export function requestManualRefresh(arg: unknown, deps:
     PollHandlerDeps, lastAcceptedAt: Map<string, number>): PollRefreshResult`
     — pure but for the `Map` and `deps`; unit-testable directly:
     - `source = parsePollSource(arg)`; `null` ⇒ `{ ok: false, reason:
       'invalid_source' }`.
     - `cooldownMs = deps.cooldownMs ?? MANUAL_REFRESH_COOLDOWN_MS`.
     - `now = deps.clock.now()`; `prev = lastAcceptedAt.get(source)`.
     - if `prev !== undefined && now - prev < cooldownMs` ⇒ `{ ok: false,
       reason: 'cooldown', retryAfterMs: cooldownMs - (now - prev) }`.
     - else `lastAcceptedAt.set(source, now)`, `try {
       deps.poller.pollNow(source) } catch (e) { console.error(…); return {
       ok: false, reason: 'internal_error' } }`, `{ ok: true, retryAfterMs:
       cooldownMs }`.
   - `export function registerPollHandlers(deps: PollHandlerDeps): void` —
     creates the `Map` in closure scope, `ipcMain.handle(REFRESH_CHANNEL,
     (_event, arg) => requestManualRefresh(arg, deps, lastAcceptedAt))`.
   - Module header comment in the house style: why the throttle is here and
     not in the poller or the renderer; that nothing throws out of
     `ipcMain.handle`.

2. **`apps/desktop/src/ipc/index.ts`**
   - `import { registerPollHandlers } from './poll.js';`
   - Re-export block: `export { registerPollHandlers, requestManualRefresh,
     parsePollSource, REFRESH_CHANNEL as POLL_REFRESH_CHANNEL,
     MANUAL_REFRESH_COOLDOWN_MS, type PollHandlerDeps, type PollRefreshResult
     } from './poll.js';`
   - In `registerIpcHandlers`, unconditionally (poller is always present),
     next to `registerOauthHandlers`:
     ```ts
     registerPollHandlers({ poller: deps.poller, clock: deps.clock ?? systemClock });
     ```

3. **`apps/desktop/src/preload.cts`**
   - Add payload type `PollRefreshResult` (structurally identical to
     `ipc/poll.ts`'s), near `OkResult`.
   - In `ContextRestorerBridge`, a new group:
     ```ts
     /**
      * Force a source's next poll cycle now, bypassing the interval/backoff.
      * Rate-limited in the main process (~1/min per source): a rejected call
      * resolves `{ ok: false, reason: 'cooldown', retryAfterMs }`, never throws.
      */
     poll: {
       refresh(source: Source): Promise<PollRefreshResult>;
     };
     ```
   - Implementation in the `bridge` object:
     ```ts
     poll: {
       refresh: (source) => {
         assertSource(source);
         return ipcRenderer.invoke('poll:refresh', { source }) as Promise<PollRefreshResult>;
       },
     },
     ```

4. **`packages/ingest/src/poller.ts`** — comment-only.
   - Class doc bullet (lines 11-13): "…from outside its own clocks:
     `pollNow(source)`, for the moment the user connects a source" → "…for
     the moment the user connects a source, or asks to refresh it by hand".
   - `pollNow` doc comment (lines 174-192): add one sentence that an
     explicit user-initiated refresh (`poll:refresh`, rate-limited in the
     IPC layer) is the second sanctioned caller, with the same "health is
     not touched, only the cycle this schedules may change it" reasoning.

### Renderer

5. **`apps/ui/types/bridge.d.ts`**
   - Add `PollRefreshResult` (mirror of the preload type, with the
     `SourceId` naming the renderer uses is not needed here — it has no
     source field).
   - Add to `ContextRestorerBridge`:
     ```ts
     poll: {
       refresh(source: SourceId): Promise<PollRefreshResult>;
     };
     ```
   - Re-export `PollRefreshResult` from `apps/ui/lib/bridge.ts`'s `export
     type { … }` list.

6. **`apps/ui/components/RailStatus.tsx`**
   - Module-scope `const RefreshIcon = (<svg viewBox="0 0 24 24" width="14"
     height="14" fill="none" stroke="currentColor" strokeWidth="2"
     aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5"
     /></svg>);` (two-thirds of a circle + arrowhead — the conventional
     refresh glyph).
   - New state:
     ```ts
     const [busy, setBusy] = useState<Partial<Record<SourceId, boolean>>>({});
     // epoch ms each source may next be refreshed
     const [readyAt, setReadyAt] = useState<Partial<Record<SourceId, number>>>({});
     const [now, setNow] = useState(() => Date.now());
     ```
   - A `useEffect` that runs a `setInterval(() => setNow(Date.now()), 1000)`
     only while some `readyAt[s] > now`, cleared otherwise (so the row
     re-renders to re-enable the button and tick a countdown; no idle timer).
   - `handleRefresh(source)`:
     ```ts
     setBusy((b) => ({ ...b, [source]: true }));
     try {
       const res = await getBridge().poll.refresh(source);
       if (typeof res.retryAfterMs === 'number') {
         setReadyAt((r) => ({ ...r, [source]: Date.now() + res.retryAfterMs! }));
       }
     } catch { /* bridge gone mid-session — leave the button enabled */ }
     finally { setBusy((b) => ({ ...b, [source]: false })); }
     ```
   - In the row JSX, after the `formatLag` span, an
     `@mui/material/IconButton` (import it):
     ```tsx
     <IconButton
       size="small"
       aria-label={`Refresh ${entry.source} now`}
       title={
         cooling
           ? `Just refreshed — available again in ${secondsLeft}s`
           : `Check ${entry.source} for new activity now`
       }
       disabled={isBusy || cooling}
       onClick={() => void handleRefresh(entry.source)}
       sx={{ p: 0.25, ml: 0.5, color: 'text.secondary' }}
     >
       <Box component="span" className={isBusy ? 'cr-spin' : undefined} sx={{ display: 'inline-flex' }}>
         {RefreshIcon}
       </Box>
     </IconButton>
     ```
     where `cooling = (readyAt[entry.source] ?? 0) > now`, `secondsLeft =
     Math.ceil(((readyAt[entry.source] ?? 0) - now) / 1000)`, `isBusy =
     busy[entry.source] === true`.
   - The row's `ml: 'auto'` currently sits on the lag span; move `ml: 'auto'`
     to the lag span's wrapper so lag + button ride together at the right
     edge, or wrap `{lag}{button}` in one `<Box sx={{ ml: 'auto', display:
     'flex', alignItems: 'center', gap: 0.5 }}>`.

7. **`apps/ui/app/globals.css`** — add near the reduced-motion block:
   ```css
   /* components/RailStatus.tsx — the per-source "refresh now" icon spins
      while its poll request is in flight. A keyframe (not an sx value)
      because Pigment only extracts static sx; frozen under
      prefers-reduced-motion by the block above, which is fine — the button
      also disables, so "working" still reads. */
   @keyframes cr-spin { to { transform: rotate(360deg); } }
   .cr-spin { animation: cr-spin 0.8s linear infinite; }
   ```

## Tests

### `apps/desktop/test/ipc.poll.test.ts` — NEW

Mirror `ipc.slackChannels.test.ts`'s setup (`vi.mock('electron', () => ({
ipcMain: { handle } }))`, dynamic import, `makeDeps` with an injected
`clock`). Drive `requestManualRefresh` directly with a fresh `Map` per case:

- invalid arg (`undefined`, `{}`, `{ source: 'email' }`, `{ source: 3 }`) ⇒
  `{ ok: false, reason: 'invalid_source' }`, `pollNow` not called.
- first call for a source ⇒ `{ ok: true, retryAfterMs: 60000 }` and
  `poller.pollNow` called once with that source.
- second call at `now + 10_000` ⇒ `{ ok: false, reason: 'cooldown',
  retryAfterMs: 50000 }`, `pollNow` not called again.
- call at `now + 60_000` (exactly the cooldown) ⇒ accepted again.
- `slack` and `gmail` cooldowns are independent (refresh slack, then gmail
  immediately ⇒ both accepted).
- `deps.cooldownMs` override is honoured.
- `pollNow` throwing ⇒ `{ ok: false, reason: 'internal_error' }` and the
  timestamp is still recorded (or explicitly decide it is *not* recorded so
  the user can retry — pick "not recorded", and assert a retry succeeds).
- `registerPollHandlers` registers exactly `poll:refresh` on `ipcMain.handle`.

### `apps/ui/test/railStatus.test.tsx` — NEW

`@testing-library/react`, fake `window.contextRestorer` with a `health`
subscription helper (like `briefingView.test.tsx`) plus `poll: { refresh:
vi.fn() }`.

- renders one "Refresh <source> now" button per health row.
- click ⇒ `bridge.poll.refresh` called with that source.
- while the `refresh` promise is unresolved the button is `disabled` and the
  icon wrapper has `class="cr-spin"`.
- after it resolves `{ ok: true, retryAfterMs: 60000 }` the button is
  `disabled` and `title` mentions seconds remaining; advancing fake timers
  past 60 s re-enables it. (Use `vi.useFakeTimers()` + `vi.setSystemTime`.)
- a `{ ok: false, reason: 'cooldown', retryAfterMs: 30000 }` response also
  disables for ~30 s.
- `!hasBridge()` path still renders the "desktop app only" note and no
  button (unchanged behaviour — one assertion to lock it).

### Regression

- `apps/desktop/test/csp.test.ts` — unchanged, but re-run: no new inline
  `<style>` element is introduced (the spin is a `.css` keyframe, the icon
  is inline SVG markup which the CSP allows).
- `packages/ingest` poller tests — unchanged (no logic touched); re-run to
  be sure the comment edit didn't fat-finger code.

## Verification

1. `npm run typecheck` — the preload payload type, the `bridge.d.ts` mirror,
   and the new `ipc/poll.ts` all compile under `strict` +
   `exactOptionalPropertyTypes` (watch the optional `retryAfterMs` — build
   the result object with conditional spread, not `x: undefined`).
2. `npm run test -w apps/desktop -- poll` — the new IPC suite.
3. `npm run test -w apps/ui -- railStatus` — the new renderer suite.
4. `npm run test -w apps/desktop` and `npm run test -w apps/ui` in full —
   nothing else regressed (RailStatus is imported by `AppShell`, exercised
   indirectly elsewhere).
5. `npm run build:ui` then grep `apps/ui/out/*.html` for `<style` ⇒ zero
   (the standing MUI/Pigment invariant).
6. `npm run start`, with Slack and/or Gmail connected:
   - the "Sources" block shows a refresh icon after each source's lag;
   - clicking it: the icon spins briefly, then the button greys out; a
     console line from the poller (`[poll] <source> …` or a successful
     cycle) confirms a cycle ran off-schedule;
   - clicking again immediately does nothing and the tooltip shows a
     countdown; after ~60 s the button is live again;
   - reload the window (Ctrl+R) mid-cooldown, click immediately — the click
     is rejected by the main process and the button re-disables for the
     remaining time (proves the server-side gate).
7. `npm run package:win` is not required for this change but the config
   filter is untouched, so a smoke `npm run build:desktop` is enough.

## Out of scope

- Forcing anything **downstream** of ingestion. A manual refresh triggers a
  poll; Layer 1 extraction (background sweep) and Layer 2 synthesis
  (debounce scheduler, ≤30 s tick) then pick up any new events on their own
  cadence, and the briefing itself is still user-triggered. "Refresh" here
  means "go look at Slack/Gmail now", not "regenerate my briefing".
- A config knob for the cooldown (Design decision 4).
- Any change to the automatic poll interval or backoff behaviour.
- Surfacing "last refreshed at" text — `formatLag` already communicates
  staleness and the tooltip covers the cooldown.
