# Archived baseline — 2026-08-28, `qwen2.5:14b`

Verbatim copies of the eval and bench reports as they stood on 2026-09-03, before the
re-baseline on the shipped config began. Archived because both CLIs write to fixed paths in
`specs/2026-08-23-context-restorer/` and overwrite the previous report in place.

These are the numbers `briefing-experience-proposal.md` §1 was written against.

| Field | This baseline | Shipped config (`config/default.json`, 2026-09-03) |
|---|---|---|
| Chat model | `qwen2.5:14b` | `qwen2.5:7b` |
| `budgets.generationMs` | 30,000 | 360,000 |
| Embedding model | `nomic-embed-text` | `nomic-embed-text` |
| Prompt versions | layer1=v1, layer2=v1, layer3=v1 | unchanged |

Neither report describes the shipped configuration — that mismatch is finding §1 of the
proposal, and the reason for the re-baseline.

**Bench** (n=20): first-token P95 254,393 ms, total P95 254,501 ms, 20/20 runs truncated at
the then-30s budget. **Eval** (n=35): recall 33.3%, precision 48.0%, hallucination 23.6%,
citation accuracy 76.4%, top-3 73.1%.

The eval copy is archived alongside the bench copy even though only the bench is being
re-run, so the pair stays internally consistent: quoting a new bench number next to an old
eval number without saying they came from different models is exactly the kind of unqualified
claim RO-2 exists to prevent.
