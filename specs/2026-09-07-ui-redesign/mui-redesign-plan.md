# MUI Component Library + UI Redesign (Option 3) — Implementation Plan

**Status:** Implemented 2026-09-07 (Phases 0–6). Uncommitted on `main`. See §9.
**Date:** 2026-09-07
**Scope:** `apps/ui` (the Next.js static-export renderer) and one directive in
`apps/desktop/src/security/csp.ts`. No change to `packages/*`, the IPC surface,
the poller, or the LLM pipeline.
**Depends on:** the MUI + Pigment CSS spike already in the working tree
(`apps/ui/app/mui-demo/`, `apps/ui/mui-theme.mjs`, `apps/ui/types/pigment.d.ts`,
the `withPigment` wrapper in `apps/ui/next.config.js`, the `styles.css` import in
`apps/ui/app/layout.tsx`, four deps in `apps/ui/package.json`).
**Amends:** the "no `'unsafe-inline'` anywhere" property asserted in
`apps/desktop/test/csp.test.ts` (see §3).
**Design reference:** the interactive mockup published 2026-09-07
(`Context Restorer Redesign`) — sidebar shell, briefing-first home, briefing
grouped by channel.

---

## 1. Bottom line

Adopt **MUI Material v7 styled through Pigment CSS** (build-time CSS extraction,
zero runtime `<style>` injection) as the component library for `apps/ui`, and
rebuild the three screens (home, settings, onboarding) to the **Option 3**
design: a persistent left navigation rail with ambient source/pipeline status,
a briefing-first home with the briefing grouped by channel, and a two-pane
settings screen.

The one security-relevant change is a **surgical CSP loosening**: allow inline
`style` *attributes* (`style-src-attr 'unsafe-inline'`) while keeping runtime
`<style>` *elements* blocked (`style-src-elem 'self'`). This is required by MUI
and by essentially any component library with positioned overlays; it was
verified in the spike to still block the dangerous case.

Effort: a handful of focused sessions (~2–4 working days of implementation),
plus design-review round-trips. Not multi-week.

---

## 2. What the spike already established

- `next build` static export works with the Pigment plugin. `npm run typecheck`
  and the 57 `apps/ui` tests still pass with MUI added.
- All component CSS and the theme (light + dark `:root`, switched by
  `prefers-color-scheme` — the same JS-free dark mode `globals.css` uses today)
  extract to static `.css` files served from `_next/static/css/` as `'self'`.
- Verified in a browser under the **exact** production CSP (`default-src 'self';
  connect-src 'none'; …`, per-response script nonce): **zero runtime `<style>`
  injection**, before and after interaction.
- **One gap:** MUI's `Paper` (base of `Card`, `Alert`, `Dialog`, `Menu`,
  `Popover`, …) writes `--Paper-shadow` / `--Paper-overlay` as an inline `style`
  attribute on the client. Blocked by today's CSP → elevated surfaces lose their
  shadow + one `style-src-attr` console violation per mount. `variant="outlined"`
  Paper does not emit it.
- `@mui/material`'s `Stack` / Emotion `Box` / `Grid` compute styles from runtime
  props and fall back to a blocked `<style>`. `@mui/material` `Box` + a static
  `sx` object extracts cleanly and is the layout primitive to standardise on.

---

## 3. Open decisions

Three choices are still open. Recommended answer first.

### D-1 — CSP change  → **surgical carve-out**

Add to `buildContentSecurityPolicy` in `apps/desktop/src/security/csp.ts`:

```
style-src-elem 'self'; style-src-attr 'unsafe-inline'
```

- `style-src-attr 'unsafe-inline'` — allows inline `style` attributes. Needed for
  MUI's `Paper` CSS vars and for **any** floating component (Popper/Floating-UI
  computes `transform` inline from runtime measurements — `Menu`, `Select`,
  `Tooltip`, `Autocomplete`, date pickers).
- `style-src-elem 'self'` — keeps runtime `<style>` **element** injection
  blocked. This is the load-bearing protection: untrusted ingested content
  (Slack/email/model output rendered in the briefing) still cannot inject a
  stylesheet. Spike-verified that this pair blocks `<style>` while allowing the
  attribute.
- `script-src` is untouched — no `'unsafe-inline'` script, ever (SEC-6 intent
  preserved).

**Test change required.** `apps/desktop/test/csp.test.ts`:
- the exact-string assertions (lines ~71–79) get the two new directives appended;
- the "allows no unsafe-inline" assertion (lines ~92–95) narrows from
  `policy.not.toContain('unsafe-inline')` to asserting no `'unsafe-inline'` in
  `default-src` / `script-src` / `style-src-elem`, while `style-src-attr` is
  explicitly expected to carry it. Add a comment block explaining the exception
  and pointing here.

Alternative (rejected): keep the CSP fully locked and constrain MUI to
outlined-only surfaces plus headless/custom overlays. More custom code, and
`Menu`/`Select`/`Tooltip`/`Dialog` come off the table — a poor trade for a
marginal security gain given `connect-src 'none'` already kills CSS-based
exfiltration.

### D-2 — briefing grouping  → **RESOLVED: flat list for now** (2026-09-07)

The wire `Citation` (`types/bridge.d.ts`) carries only `source` (`slack`/`gmail`)
— no channel name, no project — so "group by channel/project" is not buildable
without an IPC change, which §1's scope excludes. Decision: keep the single
"N things changed" list; channel grouping becomes a follow-up that adds
`channelName` to `Citation` in the bridge + `apps/desktop/src/ipc/briefing.ts` +
the generator's citation builder. Original analysis kept below for that
follow-up.

<details><summary>Original D-2 analysis</summary>

The mockup groups "what changed" under `#channel` / source subheads.
`components/BriefingView.tsx` today renders one flat "N things changed" list and
carries a deliberate comment that the renderer only *regroups* the four
generator sections, never departs from them. Grouping by channel is new
presentation logic on the same claim data — it does not touch the generator, the
persisted `briefing_claims.section`, the eval harness, or section ordering, but
it **does** cross that documented boundary.

Action if chosen: update the `CHANGED_SECTIONS` / `P2` comment block in
`BriefingView.tsx` to record the new grouping and why; keep the fallback to a
flat list when a claim has no channel/source key.

Alternative: keep the flat list, ship only the shell + layout + pinned
"Waiting on you" block. Lower risk, keeps the contract boundary intact.

</details>

### D-3 — rollout  → **home first**

Build the home screen fully to lock the shell + theme + briefing patterns, land
it, review the running app, then roll the settled patterns to settings +
onboarding + shared components. Alternative: all screens in one pass — faster to
"done", one big review, harder to course-correct.

---

## 4. Target architecture

### 4.1 Dependencies (already installed by the spike)

| Package | Version | Role |
|---|---|---|
| `@mui/material` | 7.3.x | components |
| `@mui/material-pigment-css` | 9.4.x | Pigment-native `Box`/`Stack`/`Grid`, `styles.css` |
| `@pigment-css/react` | 0.0.31 | Pigment runtime primitives |
| `@pigment-css/nextjs-plugin` (dev) | 0.0.31 | build-time extraction (`withPigment`) |

`@pigment-css/*` is pre-1.0 and pins to specific Next/React ranges — call out in
`CLAUDE.md`'s "Environment gotchas" once adopted, next to the `npmRebuild: false`
note.

### 4.2 Theme  (`apps/ui/mui-theme.mjs`, shared by `next.config.js` and a runtime provider)

- `cssVariables: true` — palette emitted as `:root { --mui-* }` into static CSS.
- `colorSchemes: { light, dark }` mapped to the existing `--cr-*` hexes (already
  drafted in the spike file). Dark switches on `prefers-color-scheme` — no toggle,
  matching current behaviour.
- `styleOverrides` only in the theme's `components` (Pigment reads those at
  build); `button.textTransform: 'none'`, `shape.borderRadius: 6`.
- **No runtime `<ThemeProvider>`.** With `cssVariables` it SSRs a `<style>`
  element the CSP now blocks (`style-src-elem 'self'`), and Pigment already put
  the palette vars in the static stylesheet. Runtime component defaults
  (`disableRipple`, `Card variant="outlined"`, `AppBar elevation={0}`, …) go
  through `<DefaultPropsProvider>` in `app/providers.tsx` — a context-only
  provider that injects nothing (MUI's prescribed pure-Pigment path). Avoid
  `useTheme()`/`useMediaQuery()` in our components; use CSS media queries.
- **Pigment `sx` rule:** every `sx` must be statically analyzable — a literal
  object, or a module-const object referenced directly (no spread, no
  `MAP[runtimeKey]`, no `cond ? a : b`). A dynamic value is not a build error;
  Pigment serialises its AST into an inline `style` attribute. Runtime-dependent
  styling goes in a plain `style={{}}` attr (CSP-allowed) or a CSS class keyed
  off a data attribute / MUI state class. Grep built HTML for
  `&quot;type&quot;:&quot;…Expression` every verification.

### 4.3 CSP  — see D-1.

### 4.4 App shell  (`app/layout.tsx` + a new `components/AppShell.tsx`)

- Permanent left `Drawer` (~244px): app mark + name, primary nav
  (`Home` / `Setup` / `Settings`) as MUI `List` items, `aria-current` on the
  active route. Nav becomes a client component (`usePathname`) — a small,
  deliberate departure from today's server-rendered nav.
- Rail footer: the `SourceHealth` + `PipelineStatus` strips move here as a
  compact always-visible block. They keep their existing `health:sources` /
  `pipeline:status` subscriptions unchanged.
- Main pane: sticky top toolbar (`AppBar`, `position="sticky"`, no elevation) for
  per-screen context (on home: window range + Refresh + "I'm caught up").
- Links stay root-relative with explicit `index.html` (the `app://` fixed-host
  reasoning in `next.config.js` / `layout.tsx` is unchanged).

### 4.5 Per-screen

**Home (`app/page.tsx` + `components/BriefingView.tsx` + children)**
- No hero "Brief me" button — briefing auto-requests on mount (the OI-3
  declared-project gate stays; show an inline prompt + link when unmet). Manual
  refresh + window range live in the toolbar.
- `BriefingView` keeps its entire lifecycle, effects, dedupe, `aria-live` /
  `aria-busy` streaming region, resume-point + `maxChangedItems` logic. Only the
  markup inside changes.
- "Waiting on you" → pinned block, `Paper` outlined with a 3px accent left
  border, inline "Mark resolved" per item.
- "What changed" → grouped by channel (D-2), each claim = primary `Typography` +
  a chip meta-row (`source`, msg count, citation, low-confidence) + inline
  `Collapse` drill-down carrying the source excerpts.
- Feedback → `ToggleButtonGroup` (Relevant / Not relevant / Wrong), one verdict
  per claim, still submitting a new `feedback` row on each change (FR-7).
- Footer keeps the OI-1 "threads still processing" note and the citation-gate
  count.

**Settings (`app/settings/*`)**
- Two-pane: section list (`Briefing schedule`, `Slack channels`, `Chat model`,
  `Briefing window`, `Diagnostics`) → panel. Route stays `/settings`; panels can
  be state-switched or become `/settings/[section]` sub-routes (state-switch is
  simpler and matches the mockup).
- Fields → `TextField` / `Select` / `Switch` / `RadioGroup`. Each existing panel
  component (`schedule.tsx`, `channels.tsx`, `model.tsx`, `briefingWindow.tsx`,
  `metrics.tsx`) keeps its bridge calls and state; markup only changes.
- Diagnostics "at a glance" keeps its bordered-rows shape (rebuilt with `List` +
  a status `Chip`); the collapsed "Details" stays a `<details>`/`Collapse`.
- Model picker keeps the "takes effect next launch" note verbatim (OI-2).

**Onboarding (`app/onboarding/page.tsx`)**
- Custom `StepIndicator` → MUI `Stepper` (`components/StepIndicator.tsx` is
  deleted or becomes a thin wrapper). The 4-step machine
  (`connect → sync → declare → done`) is unchanged.
- Each step a `Card`. Project selection → `Chip` with `onDelete`; the
  suggestion list keeps checkboxes; custom entry optionally becomes an
  `Autocomplete` (`multiple` + `freeSolo`).

### 4.6 `globals.css`

Shrinks to: the CSP-comment header, a handful of app-shell rules Pigment/MUI
does not own, and nothing else. All `--cr-*` tokens and every component class
(`.btn`, `.card`, `.cr-briefing`, `.status-chip`, `.diag-*`, `.step-indicator`,
…) are removed as their consumers migrate. The per-rule WCAG contrast
annotations move to the theme file as comments on the palette values, and the
AA contrast of every default MUI text/background pairing is re-verified (NFR-9).

---

## 5. Phased task breakdown

| Phase | Work | Rough size |
|---|---|---|
| **0. Foundations** | Land the spike properly: theme finalised, `AppRouterCacheProvider` + provider wired, CSP directive + `csp.test.ts` update + SEC comment, `mui-demo` route deleted. `CLAUDE.md` gotcha note. | ~0.5 session |
| **1. App shell** | `components/AppShell.tsx` — `Drawer` nav (client, `usePathname`), rail status footer (move `SourceHealth` + `PipelineStatus`), sticky `AppBar`. `layout.tsx` rew* to host it. | ~1 session |
| **2. Home + briefing** | `app/page.tsx` toolbar/auto-request; `BriefingView` + `PendingSection` + `ClaimBullet` + `DrillDown` + `FeedbackControls` + `CaughtUpButton` rebuilt in MUI; channel grouping (D-2). Preserve every effect and the aria-live region. | ~1–2 sessions |
| **3. Settings** | Two-pane wrapper; migrate `schedule` / `channels` / `model` / `briefingWindow` / `metrics` panels. | ~1 session |
| **4. Onboarding** | `Stepper`, per-step `Card`s, chip selection. | ~0.5 session |
| **5. Tests + a11y sweep** | Fix the 57 `apps/ui` tests (selectors change with MUI DOM); re-run `@testing-library` queries against roles/labels rather than classes; manual keyboard + screen-reader pass on the briefing stream; AA contrast check. | ~1 session |
| **6. Real-shell verification** | `npm run build:ui && npm run start`; walk every screen in the Electron window; confirm devtools shows no CSP violations and no runtime `<style>`; check both `prefers-color-scheme` states. | folded in |

`npm run typecheck` and `npm run test` green at the end of every phase.

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Test churn** — briefing tests coupled to current markup (`briefingView.test.tsx` = 34 tests). | High | Query by `role`/`aria-label`/text, not class. Budget the phase-5 session for it; do not let it bleed into feature phases. |
| **a11y regression** in the streaming briefing (`aria-live`, `aria-busy`, section roles). | Medium | Keep the exact live-region structure; the MUI change is inside it. Explicit keyboard + SR pass in phase 5. |
| **D-2 contract departure** drifts into a generator change. | Low | Grouping is renderer-only on existing claim data; no `@cr/ai` edit. Guard with the comment update. |
| **Pigment `0.0.x`** breaks on a Next/React bump. | Medium (later) | Pin all four deps exactly; note in `CLAUDE.md`; the flat-CSS fallback is `@mui/material` with a hand-rolled critical CSS if Pigment is ever dropped. |
| **`Paper` inline-style** violations if D-1 is not taken. | High without D-1 | Take D-1. Otherwise force `variant="outlined"` everywhere and avoid `Menu`/`Select`/`Tooltip`/`Dialog`. |
| **Bundle size** — `/mui-demo` measured 69.7 kB route / 172 kB first-load vs 6 kB / 109 kB today. | Low impact | Local Electron app, no network delivery. Note it, don't fight it. |
| **First-paint flash.** | Low (resolved) | No runtime `ThemeProvider`; Pigment's static `:root` vars mean colours are right pre-hydration. Confirmed in Phase 1. |
| **Pigment silently AST-dumps a dynamic `sx`** into an inline `style`. | Medium | The `sx` rule in §4.2; grep built HTML each verification. Hit and fixed twice in Phase 1. |

---

## 7. Files touched

**`apps/desktop`** (1 file + 1 test)
- `src/security/csp.ts` — two directives added to `buildContentSecurityPolicy`.
- `test/csp.test.ts` — string assertions + the unsafe-inline property test.

**`apps/ui`** (essentially all UI files)
- `next.config.js`, `mui-theme.mjs` (+ `mui-theme.d.mts`), `types/pigment.d.ts`
  — done, Phase 0.
- `app/layout.tsx` — hosts `<Providers>` (`DefaultPropsProvider`) + `AppShell`.
  Done, Phase 0–1.
- `components/AppShell.tsx`, `components/RailStatus.tsx` — new, done Phase 1.
- `app/page.tsx`, `app/onboarding/page.tsx`, `app/settings/page.tsx` +
  `app/settings/{schedule,channels,model,briefingWindow,metrics}.tsx` — pending
  (Phases 2–4). Each needs a synchronous `getBridge()` guard added.
- `components/*` — `BriefingView` + children, `StepIndicator` (likely removed):
  pending Phases 2/4. `SourceHealth.tsx` / `PipelineStatus.tsx` deleted Phase 1.
- `app/globals.css` — MUI-override + legacy-token split started Phase 1; shrinks
  further as each screen migrates.
- `test/{briefingView,confidence,briefingWindow}.test.tsx` — selector updates,
  Phase 5.
- `app/mui-demo/` — deleted, Phase 0.

**Not touched:** `lib/*`, `types/bridge.d.ts`, everything under `packages/`,
`apps/desktop/src/ipc/*`, `preload.cts`.

---

## 8. Acceptance criteria

1. `npm run typecheck`, `npm run test`, `npm run build:ui` all green.
2. In the running Electron app (`npm run start`), on every screen: devtools
   Console shows **no CSP violation**, and the Elements panel shows **no
   `<style>` element** added after load (inline `style` attributes on MUI
   components are expected and allowed).
3. Both `prefers-color-scheme: light` and `dark` render correctly with no
   unstyled flash.
4. The briefing still streams: `aria-live` announces new bullets, `aria-busy`
   clears on `briefing:done`, sections render in canonical order.
5. Every default MUI text/surface pairing used meets WCAG AA (NFR-9).
6. OI-1 (threads-still-processing note), OI-3 (declared-project gate), OI-2
   (model note) behaviours unchanged.
7. `apps/desktop/test/csp.test.ts` documents the `style-src-attr` exception.

---

## 9. Progress log

- **2026-09-07 — Phase 0 (Foundations): done.** CSP carve-out + `csp.test.ts` +
  SEC comment (`csp.ts`); `mui-theme.mjs` finalised; `app/providers.tsx` uses
  `DefaultPropsProvider` (no runtime `ThemeProvider` — it would SSR a `<style>`);
  `mui-demo` route deleted; `CLAUDE.md` updated. Verified in-browser under the
  real CSP: zero `<style>` elements, zero violations. typecheck + build + 57 ui
  + 267 desktop tests green.
- **2026-09-07 — Phase 1 (App shell): done.** `components/AppShell.tsx`
  (permanent `Drawer` rail, `usePathname` active highlight) +
  `components/RailStatus.tsx` (condensed source/pipeline status, moved off the
  home dashboard into the rail foot); `layout.tsx` rewired; old
  `SourceHealth.tsx` / `PipelineStatus.tsx` deleted; `app/page.tsx` stripped of
  the status cards; `globals.css` gains a `.Mui-selected` nav rule + a "legacy"
  banner. Verified on `/`: rail renders, active state correct, zero `<style>`,
  zero CSP violations, no Pigment AST-in-`style` dumps.
  - **Pigment gotcha learned:** a runtime-dependent value in `sx`
    (`sx={{ bgcolor: MAP[status] }}`, `sx={{ x: cond ? a : b }}`, an object
    spread) is not a build error — Pigment silently serialises the AST into an
    inline `style` attribute. Rule: `sx` must be statically analyzable; runtime
    values go in a plain `style={{}}` attr (now CSP-allowed) or a CSS class.
    Grep built HTML for `&quot;type&quot;:&quot;...Expression` as part of every
    verification.
  - **Known pre-existing issue (not Phase 1):** `/settings/` throws
    "Application error" in a plain browser because `schedule.tsx` calls
    `getBridge()` synchronously in a `useEffect` body (not inside its own
    try/catch). (`/onboarding/` does not — its `getBridge()` calls sit inside
    async try/catch blocks.) Works in the Electron shell either way. Phase 3
    added a `hasBridge()` guard; full preview needs real Electron (Phase 6).

- **2026-09-07 — Phase 2 (Home + briefing): done, pending Electron visual check.**
  All of `BriefingView` + `PendingSection` + `ClaimBullet` + `FeedbackControls`
  + `DrillDown` + `CaughtUpButton` + `SectionInfoIcon` rebuilt in MUI; new
  `components/PageToolbar.tsx` (sticky `AppBar`); `app/page.tsx` auto-requests
  the briefing on OI-3 gate open (no "Brief me" hero) with a Refresh button.
  Every `useEffect` / lifecycle / dedupe / `aria-live`+`aria-busy` region in
  `BriefingView` preserved verbatim — only JSX changed. Drill-down is now a
  `Collapse` (`unmountOnExit`, so `claim:drilldown` still fetches only on open).
  Feedback verdicts are a `ToggleButtonGroup` (per-button `onClick` + explicit
  `selected`, NOT the group's `onChange` — keeps "one click = one submit" and
  re-click re-submits).
  - **D-2 resolved → flat list for now** (user decision). The wire `Citation`
    carries only `source` (slack/gmail), no channel/project, so channel
    grouping is a later follow-up that adds `channelName` to the Citation IPC.
    §4.5 / §7 updated; a code comment marks the spot in `BriefingView`.
  - **Test churn: 1 line.** The a11y tree (roles, `aria-label`s, `data-testid`s,
    heading levels, `<ul>/<li>`) was preserved through the restyle, so 56/57 ui
    tests passed untouched. The one failure (`confidence.test.tsx` — the
    decorative `⚠` glyph must be a nested `aria-hidden` element) was a real
    check; re-added the hidden glyph inside the MUI `Chip` label. 57/57 green.
  - **Not visually verified yet:** the briefing *content* (pending cards,
    claim chips, feedback, drill-down) renders only with the Electron bridge —
    same constraint as settings/onboarding. Phase 6.

- **2026-09-07 — Phase 3 (Settings): done, verified in browser.**
  `settings/page.tsx` is now the two-pane container (section list ↔ panel,
  state-switched); the 5 panels (`schedule` / `channels` / `model` /
  `briefingWindow` / `metrics`) are each a standalone MUI component with a
  `hasBridge()` guard, so `/settings` no longer falls to an error boundary in a
  plain browser. New `settings/PanelHeading.tsx`. Form controls are MUI
  (`RadioGroup` / `TextField select` / `Switch` / `Checkbox` / `Chip`). Every
  bridge call, state machine and copy string preserved. Diagnostics: summary +
  chrome are MUI; the collapsed Details tables keep the `.diag-*` / `.data-table`
  classes (dense read-only tables — a later cleanup). Verified: all 5 panels
  render + switch, zero `<style>`, zero CSP violations, no page overflow.
  - **globals.css minimal reset added** — `box-sizing: border-box` + `body{margin:0}`.
    `<CssBaseline>` would give these but it is a runtime `<style>` the CSP blocks;
    without `box-sizing` every `sx` `maxWidth` was content-box (panels 48px wide
    of intent).
  - Test churn: **zero** (no settings tests exist; ui 57/57, desktop 267/267).

- **2026-09-07 — Phase 4 (Onboarding): done, verified in browser.**
  `onboarding/page.tsx` rebuilt in MUI — `PageToolbar` + `Stepper`
  (`alternativeLabel`) + per-step `Card`s; connect buttons + status `Chip`s,
  `CircularProgress` on sync, `Checkbox` suggestions, `Chip onDelete` for
  selected projects. `components/StepIndicator.tsx` deleted (only consumer).
  `hasBridge()` guard added. The 4-step machine
  (`connect → sync → declare → done`) and every handler unchanged. Verified:
  stepper advances, Continue → sync → declare transition, chip add/delete work;
  zero `<style>`, zero CSP violations, zero AST dumps. Test churn: zero.

  **Phases 0–4 complete.** Remaining: Phase 5 (final a11y sweep — the automated
  churn was ~1 line total across all phases; a manual keyboard + screen-reader
  pass on the briefing stream and the settings/onboarding forms is still owed)
  and Phase 6 (`npm run start` — first look at briefing / settings / onboarding
  *content* under the real Electron bridge; both `prefers-color-scheme` states;
  confirm no CSP violation in the Electron devtools console).

- **2026-09-07 — Phase 5 (a11y sweep): done.** Automated test churn across all
  phases totalled ~1 line. Manual/scripted audit of home, settings, onboarding:
  - **Fixed:** the nav rail was not a landmark (`Drawer` `aria-label` doesn't
    make one) → `List component="nav" aria-label="Main"`. MUI `Stepper` had no
    `aria-current` on the active step (the old `StepIndicator` did) → added, plus
    `role="group"` + a "step N of M" label on the stepper.
  - **Added to `globals.css`:** an explicit `:focus-visible` ring for bare `<a>`
    / `<summary>` / `[tabindex]` and for `.Mui-focusVisible` (MUI's flat-button
    default is a faint tint); a `prefers-reduced-motion` block (MUI doesn't
    honour it by default — Collapse/Fade become instant, the spinner keeps
    turning).
  - **Verified:** landmark structure is `<header>` (AppBar) + `<nav aria-label>`
    ×2 + `<main>`; heading order 1→2→3 on every screen; no unnamed control; the
    briefing `aria-live`/`aria-busy` region is byte-identical to before.
    Light-theme contrast (scripted): body/heading 17:1, secondary text 6.0:1,
    error 7.3:1, contained + outlined buttons 8.5:1 — all past AA. Dark-theme
    contrast to be confirmed in Phase 6.

- **2026-09-07 — Phase 6 (Electron verification): done. All phases complete.**
  Built `packages/store` + `apps/desktop`, launched the real Electron app
  (`electron.exe apps/desktop --remote-debugging-port`) against a live Ollama
  (`qwen2.5:14b` + `nomic-embed-text` present), and drove it over CDP through
  home / settings / onboarding in **both `prefers-color-scheme` states**:
  - **Zero CSP violations, zero console errors, zero runtime `<style>` elements,
    zero Pigment AST dumps** on every screen, every theme.
  - Light: `body` bg `#f4f6f8`, text `#1a1a1a`. Dark: `body` bg `#0d1117`, text
    `#c9d1d9` — `prefers-color-scheme` switch confirmed live.
  - Real IPC works through the redesign: onboarding shows real OAuth connection
    state; settings shows real `schedule.list()` + "Ollama is ready"; the rail
    shows live `health:sources` / `pipeline:status`; the home OI-3 gate blocks
    correctly with no declared projects.
  - **One fix during Phase 6:** `globals.css` `body` had no explicit
    background/color — the Electron window painted the main content area OS-white
    (wrong in dark mode). Added `body { background: var(--mui-palette-background-default);
    color: var(--mui-palette-text-primary) }`.
  - **Full monorepo suite green:** `npm run test` → 1409 passed / 1 skipped
    (73 files); `npm run typecheck` clean.

  **Not done (deliberately out of scope / needs real data):** a full end-to-end
  briefing render (needs connected Slack/Gmail OAuth + ingested content — the
  briefing *component* is unit-tested at 34 cases and its a11y tree is
  unchanged, but its redesigned visual has not been seen with real claims on
  screen); the `.diag-*` diagnostics-table internals (still legacy classes);
  channel/project grouping of the changed list (D-2 follow-up — needs a
  `channelName` on the `Citation` IPC).

## 10. Backout

Phase 0 is the reversible checkpoint. To abandon after any later phase:
`git revert` the UI phases, restore `globals.css`, `npm uninstall -w apps/ui
@mui/material @mui/material-pigment-css @pigment-css/react
@pigment-css/nextjs-plugin`, revert `next.config.js` / `layout.tsx`, and revert
the `csp.ts` + `csp.test.ts` change. No data, migration, or IPC contract is
affected, so backout is a pure renderer revert.
