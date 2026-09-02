# Implementation Prompt: Context Restorer (POC)

You are implementing the **Context Restorer** proof-of-concept: a local-first, AI-powered app that reads what happened across a knowledge worker's tools during an absence and produces a readable briefing of what changed and what's waiting on them.

**The design document (`context_restorer_design.docx`) is the source of truth.** Read it in full before writing code. This prompt exists so you don't have to re-derive the build order or hunt for the decisions that constrain implementation choices — but if anything here seems to conflict with the doc, the doc wins, and if the doc is silent on something this prompt doesn't cover, don't guess: flag it rather than inventing a default.

---

## 1. What you're building, in one paragraph

A background desktop app that polls a user's Slack and Gmail, quietly figures out what meaningfully changed (a decision made, an item now waiting on them), and — only when the user asks — writes a short, cited, streamed narrative briefing. Everything runs locally: local model inference via Ollama, local storage via SQLite/Chroma, no data leaves the machine by default.

---

## 2. POC scope — build this, not more, not less

**In scope:**
- Two data sources: **Slack and Gmail only**
- The full three-layer AI pipeline (Event Extraction → State Synthesis → Briefing Synthesis), all on the **same local model tier**
- The complete guardrail set (prompt-injection defense, citation enforcement, hallucination ceiling, confidence flagging, PII/secret redaction) — these are not optional for a "quick POC," they're load-bearing for user trust and should be built from day one, not bolted on later
- The new outcome-metric completion signal (FR-11 / NFR-10)

**Explicitly deferred — do not build these, and don't leave half-built stubs that look like broken features:**
- Additional sources: GitHub, Jira, Calendar, Teams
- Layer 4 personalization (learned ranking) — ranking uses only the user's *stated* project declarations (FR-8), nothing learned from behavior
- Vendor/frontier model opt-in for Layer 3 — **local-only, full stop, for every layer**
- Additional delivery channels (Slack DM, email digest) — local UI + native OS notifications only
- Application-level encryption (TLS beyond what OAuth needs, AES-256 at rest) — the POC relies on the user's own OS-level disk encryption; don't build a custom encryption layer
- Scaling infrastructure for the ~10k-user target — this runs as a single per-user local process; no horizontal scale-out concerns apply

If you find yourself building toward any of the deferred items "just to make it more complete," stop — that's scope creep against a deliberate decision, not a gap.

---

## 3. Hard constraints — do not deviate from these without going back to the design doc owner

These are resolved decisions (D-1 through D-7 in §8.1), not suggestions:

| # | Constraint |
|---|---|
| D-2 | Launch sources are **Slack + Gmail**, not Slack + GitHub (an earlier draft decision, superseded) |
| D-3 | Layer 2 (State Synthesis) runs **continuous/batched**, not lazily at briefing time — do the heavy work ahead of time so the on-demand path stays thin |
| D-4 | **All three layers use the same medium-tier open-weight model (~14B)** via Ollama — e.g. Qwen 2.5 14B or Mistral Nemo 12B. Do not give Layer 1 a smaller/cheaper model; that was tried and reversed for consistency and quality. One model stack for every user; the only requirement is 16 GB RAM minimum on the host machine — don't build per-RAM-tier model selection logic |
| D-5 | Delivery is **local UI + native OS notification only** — no Slack DM, no email digest |
| D-6 | **StateDeltas are append-only and versioned.** When the same thread produces a new StateDelta, do not overwrite the prior one — write a new record with a `supersedes` pointer back to it. This is required for reproducibility (NFR-5) and for briefings to be able to narrate reversals ("X was decided, then changed to Y") |
| D-7 | Layer 2's synthesis trigger is a **5-minute quiet-window debounce with a 30-minute hard cap**, both configurable per source (Slack and Gmail will likely need different tuning). Do not synthesize on every single incoming message — that fragments one real conversation into disjointed, incoherent StateDeltas |

Also non-negotiable, from §6.2/§6.3 (technology choices):
- **App shell: Electron**, hosting the Next.js UI directly
- **OAuth tokens go in the OS keychain via Electron's `safeStorage`** — never in the application database or a plain config file. This is one of the few security items that is *not* deferred for the POC (unlike the encryption items above)
- Event store, entity store, and briefing store are all **SQLite** (embedded, per-user, single file each)
- Vector index is **Chroma or LanceDB**, embedded — no server
- **v1 is read-only.** No replies, posts, or calendar writes back to any source, ever. This isn't a POC shortcut — it's a permanent v1 design constraint (§7.3 has the rationale if you need it)

---

## 4. Suggested build order

Build in this order — each phase produces something runnable and testable before the next begins, and later phases depend on earlier ones actually working, not just existing as stubs.

### Phase 0 — Scaffolding
- Electron shell with system tray icon, native OS notification wiring, `safeStorage` keychain integration, login-item autostart
- Next.js UI shell hosted inside the Electron window
- SQLite schemas for: Raw Event Store (append-only), Entity Graph, StateDelta Store (versioned per D-6), PendingItem Store
- Embedded Chroma/LanceDB vector store
- Verify Ollama is reachable at `localhost:11434` and the chosen ~14B model is pulled; fail loudly and clearly if not, rather than silently degrading

### Phase 1 — Ingestion Plane
- OAuth flows for Slack and Gmail only, least-privilege scopes (§5.1 has the exact scope list per source), tokens straight into the keychain
- Per-source pollers (not webhooks — this is a polling-based design per §6.4)
- Normalizer + secret/credential redaction *before* anything reaches an LLM
- Write normalized events to the Raw Event Store

### Phase 2 — Understanding Plane (Layers 1 & 2)
- **Layer 1 (Event Extraction):** continuous, per-event, using the medium Ollama tier. Classify (decision / question / status update / noise) and extract participants and referenced artifacts. Write to the Entity Graph + Vector Index
- **Layer 2 (State Synthesis):** implement the D-7 debounce/cap trigger *before* wiring up generation — this is easy to get wrong and hard to notice being wrong until you test with a real bursty conversation. On trigger, retrieve relevant prior context (graph + vector search, per §7.4) and produce a StateDelta (versioned per D-6) and/or PendingItem, only for changes that are actually meaningful — most messages should produce nothing
- Build the failure-mode taxonomy categories from §7.5 into your test fixtures early (missed pending item, false pending item, fabricated claim, wrong citation) — you'll need labeled examples for eval regardless, so start collecting them as you build rather than after

### Phase 3 — Briefing Plane (Layer 3)
- User Profile: stated project declarations only (FR-8) — no learned-signal ranking
- Stakes Ranker: order by declared relevance, not recency
- Briefing Generator: on-demand, streamed token-by-token, medium Ollama tier, local only
- **Citation enforcement is not a post-hoc check you bolt on — build the post-processor alongside the generator from the start.** Every claim needs a source artifact ID; uncited claims get omitted, not flagged-and-shown
- FR-11 completion signal: a simple "I'm caught up" action in the UI, timestamped, stored for the NFR-10 outcome metric

### Phase 4 — Guardrails, Fallback, Observability
- Prompt-injection defense: wrap all ingested content in clearly delimited, explicitly-labeled-as-data blocks in every prompt; post-filter outputs for suspicious patterns
- Confidence flagging in the UI for low-confidence pending items
- PII/secret scanning on outputs, not just inputs
- Fallback chain for the POC is exactly: **Local Ollama → deterministic template built from raw StateDeltas** (no vendor step — that's deferred). If Ollama is down or the model isn't pulled, serve the template version, clearly labeled "simplified briefing," never a hard failure
- Observability per NFR-8: log every AI call (model, prompt version, latency, tokens); build the end-to-end per-briefing trace (ingestion → extraction → synthesis → delivery) since you'll need it for debugging Layer 2's debounce behavior most of all

### Phase 5 — Eval and Validation
- Build the offline eval harness before you trust any quality claim: hand-labeled examples per §7.5 (start smaller than the doc's 200-example target if needed, but don't skip this phase)
- Validate against the acceptance criteria in §2.5 and the NFR targets in §3 — see the checklist below
- Test specifically on a 16 GB RAM machine, not just a dev machine with headroom to spare — R-4 in the risk table exists because this is a real, live constraint

---

## 5. Definition of done — acceptance criteria to validate against

Pull these directly from §2.5 and §3; don't consider a phase complete until it's been measured, not just implemented:

- Briefing returned **P95 < 60s**, first streamed token **< 5s**, for a 5-day window across 2 sources
- Every factual claim in a briefing is cited to a retrievable source artifact — **100%**, not "most"
- Pending-item recall **≥ 90%**, precision **≥ 75%**, against your hand-labeled eval set
- Hallucination rate **< 2%** — this is a release-gate metric, not a nice-to-have
- Citation accuracy **≥ 95%** (citations that correctly link to the artifact they claim to)
- Ingestion lag **P95 < 5 minutes** from source event to entity-store availability
- Feedback events captured within 1s of the user action
- Zero event loss; ingestion is idempotent (replaying the same event twice doesn't duplicate it)

---

## 6. If you hit ambiguity

A few things the design doc leaves genuinely open (§6.5, §7.9) — don't silently pick an answer and move on if you hit these; flag them:
- Exact latency budget split between the synchronous briefing path and background pre-computation
- Whether to offer model presets ("fast/balanced/best") or expose raw model selection to the user
- How explicit the project-declaration step should be during onboarding (cold-start accuracy vs. friction trade-off)

For anything else not covered by the doc or this prompt, prefer the more conservative, more local, more privacy-preserving option — that's the design's consistent bias throughout, and it's the safer default to extend from.
