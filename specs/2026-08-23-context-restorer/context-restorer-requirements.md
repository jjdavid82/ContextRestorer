# Context Restorer (POC) — Requirements

**Status:** Ported, not re-derived
**Source of truth:** `source/context_restorer_design.docx` (§ references below point into it)
**Build guidance:** `source/context_restorer_implementation_prompt.md`
**Date:** 2026-08-23

> This document is a POC-scoped restatement of an already-approved design. It does not
> introduce requirements the source documents do not contain. Where the source is silent,
> that is called out explicitly under **Open Items** rather than filled with a guess.
> If anything here conflicts with the design doc, **the design doc wins**.

---

## 1. Problem and Outcome

A knowledge worker returning from an absence (overnight, weekend, focus block, vacation)
pays a large cost scrolling their tools to work out what still matters. Dashboards show
status; they do not synthesize a narrative of *state changes* weighted by what this
person cares about.

Context Restorer polls the user's connected tools, continuously derives what meaningfully
changed, and — on demand — writes a short, cited, streamed narrative briefing.

**Outcome metric (NFR-10):** time-to-re-entry — elapsed time from briefing delivered to
the user tapping "I'm caught up" (FR-11). Speed and accuracy are proxies; this is the goal.

**Launch persona (D-1):** engineering managers.

---

## 2. POC Scope

### In scope

| # | Item | Source |
|---|---|---|
| S-1 | Two data sources: **Slack and Gmail only** | D-2, §1.1 |
| S-2 | Full three-layer AI pipeline: Event Extraction → State Synthesis → Briefing Synthesis | §7.1 |
| S-3 | All three layers on the **same medium open-weight tier (~14B)** via local Ollama | D-4 |
| S-4 | Complete guardrail set: prompt-injection defense, citation enforcement, hallucination ceiling, confidence flagging, PII/secret redaction | §7.6 |
| S-5 | FR-11 completion signal + NFR-10 outcome metric | §2.2, §3 |
| S-6 | Electron shell hosting the Next.js UI; tray icon; native OS notifications; `safeStorage` keychain; login-item autostart | §6.2, §6.3 |
| S-7 | Offline eval harness with hand-labeled examples | §7.5 |
| S-8 | Deterministic-template fallback when Ollama is unavailable | §7.8 |

### Explicitly deferred — do not build, and do not leave half-built stubs

| # | Deferred item | Source |
|---|---|---|
| X-1 | Additional sources: GitHub/GitLab, Jira/Linear, Calendar, Microsoft Teams | §1.1, §5.1 |
| X-2 | Layer 4 personalization / learned ranking — ranking uses **stated** declarations only (FR-8) | §1.1, §7.1 |
| X-3 | Vendor / frontier-model opt-in for Layer 3 — **local-only, every layer, full stop** | §1.1, §7.1 |
| X-4 | Additional delivery channels (Slack DM, email digest) | D-5 |
| X-5 | Application-level encryption (TLS beyond OAuth's own needs, AES-256 at rest) — POC relies on OS-level disk encryption | §4.2, T-3 |
| X-6 | Horizontal scale-out for the ~10k-user target — single per-user local process | NFR-3 |
| X-7 | Team/SSO/MFA/Workspace-Admin auth — single-user-per-install, no application-level user auth | §6.2 |

Building toward a deferred item "to make it more complete" is scope creep against a
deliberate decision, not a gap.

---

## 3. Functional Requirements

Scoped to the POC. IDs preserved from §2.2 so they remain traceable to the source doc.

| ID | Requirement | POC scope note |
|---|---|---|
| **FR-1** | User connects a data source via OAuth with least-privilege scopes. | Slack + Gmail only. Scopes per §5.1: Slack `channels:history`, `channels:read`, `im:history`, `users:read`; Gmail `mail.readonly`. `channels:read` added 2026-08-28 (user decision) specifically to enable channel discovery for the channel-selector feature — `conversations.list` is not authorized by `channels:history` alone. |
| **FR-2** | User requests a briefing for a time window; system returns a narrative summary, streamed. | P95 < 60s, first token < 5s, for a 5-day window across 2 sources. Every factual claim cited. |
| **FR-3** | User configures recurring briefings. | **Partial** — time-based recurrence only (e.g. Monday 8am, weekday daily). Post-vacation auto-trigger on calendar return is deferred with the Calendar source (X-1). See OI-4. |
| **FR-4** | Briefing explicitly flags items waiting on the user, with linked source artifacts. | Recall ≥ 90%, precision ≥ 75%. Leads the briefing — not a chronological log. |
| **FR-5** | Items ordered by relevance to the user's interests, not recency. | **Stated declarations only.** No learned signals (X-2). |
| **FR-6** | User can click any claim to see the underlying source messages. | 100% of claims linked to a retrievable source artifact. |
| **FR-7** | User can mark items relevant / irrelevant / missed / wrong. | Captured within 1s. Feeds offline eval only — no personalization loop (X-2). |
| **FR-8** | User declares projects they care about; used as ranking priors. | **Mandatory, assisted** — see OI-3. |
| **FR-11** | User taps "I'm caught up" at the end of a briefing; timestamped and stored. | Powers the NFR-10 outcome metric. |

### Deferred functional requirements (specified in source, not built in POC)

| ID | Requirement | Why deferred |
|---|---|---|
| FR-3 (partial) | Post-vacation auto-trigger on calendar return | Requires calendar-return detection, and Calendar is a deferred source (X-1). The time-based half of FR-3 **is** in scope — see OI-4. |
| FR-9 | Handoff mode (briefing-for-someone-else) | Multi-user concern; POC is single-user-per-install (X-7). |
| FR-10 | Daily wrap / end-of-day snapshot | Not required by any POC acceptance criterion. |

### Read-only constraint

**v1 is read-only, permanently.** No replies, posts, or calendar writes back to any source
— ever. This is not a POC shortcut; it is a v1 design constraint (§2 preamble, §7.3).
Not agentic: no autonomous multi-step actions on the user's behalf.

---

## 4. Non-Functional Requirements

| ID | Category | POC target |
|---|---|---|
| **NFR-1** | Performance | Briefing P50 < 30s, P95 < 60s (5-day window, 2 sources). First streamed token < 5s. Measured at the 16 GB RAM floor, not on a headroom dev machine. |
| **NFR-2** | Performance | Ingestion lag P95 < 5 min, source event → entity-store availability. |
| **NFR-4** | Availability | Briefing flow 99.5% monthly. Ingestion tolerates downtime; events replay safely. |
| **NFR-5** | Reliability | Briefings reproducible — same window + same data → semantically equivalent output. Requires append-only StateDeltas (D-6). |
| **NFR-6** | Durability | Zero event loss. Ingestion is idempotent — replaying the same event twice does not duplicate it. |
| **NFR-7** | Maintainability | Prompts and model version are config-controlled; rollback to a prior prompt or model is fast. |
| **NFR-8** | Observability | Every AI call logged: model, prompt version, latency, token counts. End-to-end per-briefing trace (ingestion → extraction → synthesis → delivery). |
| **NFR-9** | Accessibility | WCAG 2.1 AA for the briefing UI; briefing text screen-reader friendly. |
| **NFR-10** | Outcome | Time-to-re-entry captured (briefing delivered → FR-11 signal). No target yet — instrument it. |
| NFR-3 | Scalability | **Deferred** (X-6). Validate at pilot scale — a handful of users. |

**Host requirement:** 16 GB RAM minimum (D-4). One model stack for every user; no
per-RAM-tier selection logic.

---

## 5. Security Requirements

| ID | Requirement | Status |
|---|---|---|
| SEC-1 | OAuth 2.0 per source, minimum read-only scopes (§5.1). | Required |
| SEC-2 | **OAuth tokens in the OS keychain via Electron `safeStorage`** — never in the app database or a plain config file. | Required — explicitly *not* deferred |
| SEC-3 | User can revoke any source connection in settings; revoking purges cached credentials. | Required |
| SEC-4 | Secret/credential detection and redaction in the ingestion pipeline, **before content reaches any LLM**. | Required |
| SEC-5 | PII/secret scanning on **outputs**, not just inputs; matches redacted before storage and delivery. | Required |
| SEC-6 | No data leaves the machine. No LLM API calls to any external endpoint. | Required |
| SEC-7 | Names and emails treated as PII; redacted in logs. | Required |
| SEC-8 | Right to delete: deletion propagates through raw store, entity graph, vector index, and briefings. | Required |
| SEC-9 | TLS 1.3 in transit / AES-256 at rest (application-level). | **Deferred** (X-5) — relies on OS disk encryption |
| SEC-10 | SSO / MFA / role separation. | **Deferred** (X-7) — single-user install |

### Threats to mitigate

| ID | Threat | POC mitigation |
|---|---|---|
| **T-1** | Prompt injection from ingested content | Wrap all ingested content in clearly delimited, explicitly-labeled-as-data blocks in **every** prompt; system prompt states the block is data, never instructions; post-filter outputs for suspicious patterns; no outbound network from the briefing path. |
| **T-2** | Over-scoped OAuth tokens | Request the minimum scopes in §5.1; nothing broader. |
| **T-3** | Laptop loss or compromise | POC relies solely on the user having OS-level disk encryption. Documented as a known limitation, not silently assumed. |
| **T-4** | Hallucinated content reaching the user | Citation enforcement — uncited claims are **omitted, not flagged-and-shown**. Confidence flagging on low-confidence pending items. |

---

## 6. Data Requirements

### Entities (§5.2)

`User`, `Project`, `Artifact`, `Event` (immutable, append-only), `StateDelta` (derived,
**append-only and versioned with a `supersedes` pointer** per D-6), `PendingItem`
(derived; confidence score + citation), `Decision` (derived), `Briefing` (generated).

### Storage (§5.3)

| Store | Technology |
|---|---|
| Raw Event Store | SQLite, append-only. Source of truth. Replayable. |
| Entity Graph | SQLite tables (users, projects, artifacts, relationships), indexed by user/project/artifact. |
| StateDelta Store | SQLite, append-only + versioned (D-6). |
| PendingItem Store | SQLite. |
| Briefing Store | SQLite metadata + local files for narrative text. |
| Feedback Store | SQLite, append-only; joins to briefings for offline eval. |
| Vector Index | Chroma or LanceDB, **embedded** — no server. |

### Governance (§5.4)

- Retention: raw events 90 days; entity graph indefinite; briefings per user setting; audit logs 1 year.
- Schema validation at ingestion; per-source completeness metrics; alert when ingestion lag exceeds threshold.
- Lineage: every briefing claim carries a source artifact ID; every StateDelta carries the event IDs that produced it.

### Open question inherited from §5.5

Store full message content, or embeddings + reference only? Content makes retrieval and
citation easier but grows the local store. **POC resolution:** store full content — FR-6
drill-down and 100%-citation (§2.5) both require the original text be retrievable, and a
90-day retention window bounds the growth. Flagged here because the source doc leaves it open.

---

## 7. Acceptance Criteria — Definition of Done

Nothing counts as complete until it has been **measured**, not just implemented.

| # | Criterion | Source |
|---|---|---|
| AC-1 | Briefing returned P95 < 60s; first streamed token < 5s; 5-day window, 2 sources | FR-2, NFR-1 |
| AC-2 | **100%** of factual claims cited to a retrievable source artifact | FR-6, §2.5 |
| AC-3 | Pending-item recall ≥ 90% against the hand-labeled eval set | FR-4 |
| AC-4 | Pending-item precision ≥ 75% | FR-4 |
| AC-5 | Hallucination rate < 2% — **release gate** | §7.5 |
| AC-6 | Citation accuracy ≥ 95% (citation links to the artifact it claims) | §7.5 |
| AC-7 | Ranking: top-3 items contain user-relevant content in ≥ 80% of labeled cases | FR-5 |
| AC-8 | Ingestion lag P95 < 5 min, source event → entity store | NFR-2 |
| AC-9 | Feedback events captured within 1s of user action | FR-7 |
| AC-10 | Zero event loss; ingestion idempotent (replay does not duplicate) | NFR-6 |
| AC-11 | All targets validated on a **16 GB RAM** machine | R-4, D-4 |

---

## 8. Resolved Open Items

The implementation prompt §6 flagged three items the design doc leaves genuinely open.
All three were resolved with the design owner on 2026-08-23 rather than guessed.

### OI-1 — Latency budget split: **thin synchronous path, 45s cap**

Background pre-computation owns all extraction and synthesis (consistent with D-3).
The synchronous briefing path gets a 45s P95 target, allocated:

| Stage | Budget |
|---|---|
| Retrieval (vector + graph) | ≤ 5s |
| Prompt assembly | ≤ 2s |
| Streamed generation | ≤ 30s |
| Citation post-process | ≤ 5s |
| **Total** | **42s** (≈18s headroom against the 60s P95 at the 16 GB floor) |

Consequences that must be built, not assumed:
- **First token < 5s is gated on retrieval.** Mitigation: render the "Waiting on you"
  section directly from the PendingItem store (no LLM) while retrieval runs, so the user
  sees real content within ~1s and the LLM stream appends beneath it.
- **Staleness is accepted and disclosed.** Threads still inside the D-7 debounce window
  are *not* synthesized on demand. The briefing footer states "N threads still processing."
- Per-stage timings are emitted into the NFR-8 trace so a missed NFR-1 is attributable to a stage.

### OI-2 — Model configuration: **fixed stack, config-file only**

One ~14B open-weight model (e.g. Qwen 2.5 14B or Mistral Nemo 12B) for all three layers.
**No preset selector and no raw model dropdown in the UI.** The model name and prompt
versions live in a config file, satisfying NFR-7 (config-controlled, fast rollback) and
letting an advanced user edit it without shipping selection logic that D-4 rules out.
Keeps eval results comparable across users.

### OI-3 — Onboarding project declaration: **mandatory, assisted**

Onboarding requires 3–5 project declarations before the first briefing can be generated
(direct mitigation of R-6, cold-start). To hold the friction down, declaration happens
*after* the initial sync so the app can suggest candidates derived from ingested Slack
channel names and Gmail labels/frequent threads — the user picks and edits rather than
typing from a blank field. First briefings are still labeled "learning your preferences."

### OI-4 — FR-3 scheduling: **time-based recurrence in scope, calendar trigger deferred**

FR-3 has two halves with different dependencies, and only one of them needs a deferred
source:

| FR-3 half | Needs Calendar? | POC |
|---|---|---|
| Recurring briefings (e.g. Monday 8am, weekday daily) | No | **In scope** |
| Post-vacation auto-trigger on calendar return | Yes (X-1) | Deferred |

Workflow B names its trigger as "scheduled (e.g. weekday 8am) **or** user-initiated," so
the time-based half is required for that workflow to exist at all. Native OS notification
wiring (§4.1, §6.3) is in scope regardless, and Workflow A's notification-links-to-briefing
path works from any trigger — scheduled or manual.

Scope note: a scheduled briefing fires the same generation path as a manual one. Quiet
hours and notification categories are user-configurable in-app, per D-5.

### OI-5 — Eval set size: **~70 labeled examples**

§7.5 targets ~200 initially; the implementation prompt permits starting smaller but not
skipping. ~70 is chosen because **AC-5 is the binding constraint, not AC-3**:

| Examples | ≈ pending items | AC-3 recall CI | ≈ claims | AC-5 hallucination CI |
|---|---|---|---|---|
| 30 | ~90 | ±6.2 pts | ~400 | ±1.4 pts |
| **70** | **~210** | **±4.1 pts** | **~950** | **±0.9 pts** |
| 200 | ~600 | ±2.4 pts | ~2,700 | ±0.5 pts |

At 30 examples a measured 2.0% hallucination rate carries a 0.6–3.4% interval — the
"< 2%" release gate could be estimated but not demonstrated. ~70 halves that interval at
roughly double the labeling cost, which §7.5 names as the known bottleneck. The eval-set
size must still be reported alongside every metric (see RO-2 note below).

---

## 9. Remaining Open Items

Flag these rather than inventing an answer (per the implementation prompt's standing instruction):

| ID | Item | Note |
|---|---|---|
| RO-1 | Per-source debounce tuning **values** | *Approach decided:* ship D-7's defaults (5-min quiet / 30-min hard cap) identically for both sources, with per-source config wired but unused, then tune against real traffic in Phase 5 and record the result. The values themselves remain an empirical output, not a design-time choice — do not ship a guessed difference between Slack and Gmail as though it were settled. |
| RO-2 | Reporting eval metrics | Size is now fixed at ~70 (OI-5), but the standing rule remains: **every metric claim states the eval-set size alongside the number.** An unqualified percentage is not an acceptable result. |
| RO-3 | Fine-tuning Layer 2 | §7.9 recommends prompt engineering first, revisit at 6 months with eval data. Out of POC scope; recorded so it isn't rediscovered. |

**Standing rule for anything else not covered:** prefer the more conservative, more local,
more privacy-preserving option — the design's consistent bias throughout.
