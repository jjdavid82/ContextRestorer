/**
 * Eval report assembly and rendering (Task 5.1).
 *
 * ---------------------------------------------------------------------------
 * RO-2 — THE SAMPLE SIZE IS NOT OPTIONAL.
 *
 * `EvalReport.n` is a REQUIRED field, and {@link buildReport} is the only way to
 * construct one. It throws when `n` is absent. That is the whole mechanism:
 * "92% recall on 12 examples is not a 92% recall" (design §10) can only be
 * enforced by making the number unable to travel without its denominator, and a
 * required field plus a single guarded constructor is the cheapest way to make
 * that structural rather than a review habit.
 *
 * `test/metrics.test.ts` asserts the throw. Do not add a default, do not infer
 * `n` from `perFixture.length`, and do not relax the field to optional — every
 * one of those turns a hard guarantee back into a convention.
 * ---------------------------------------------------------------------------
 *
 * ### What `n` means
 *
 * `n` is the **number of labeled examples (fixtures) in the eval set** — the
 * quantity Task 5.2 grows to ~70 and the quantity the plan's acceptance table
 * means by "state `n`". It is deliberately NOT the number of ground-truth items,
 * nor the number of claims.
 *
 * The per-metric denominators are a different, finer thing, and they are
 * reported separately in {@link EvalReport.counts}: recall is per ITEM,
 * hallucination rate is per CLAIM, citation accuracy is per CITATION, and top-3
 * relevance is per SCOREABLE CASE. Collapsing those into one number would make
 * every metric look like it had the same sample size, which is exactly the
 * misreporting RO-2 exists to stop. Both levels are printed.
 */

import type { MetricDetail } from './metrics.js';

/** Per-metric numerator/denominator, so no percentage travels unqualified. */
export interface EvalReportCounts {
  /** Per ground-truth pending item. */
  recall: MetricDetail;
  /** Per surfaced pending item. */
  precision: MetricDetail;
  /** Per generated claim. */
  hallucinationRate: MetricDetail;
  /** Per citation on a generated claim. */
  citationAccuracy: MetricDetail;
  /** Per scoreable case; `top3Skipped` cases had no ground truth to rank. */
  top3Relevance: MetricDetail;
  /** Cases excluded from the AC-7 denominator (`expect_no_pending`). */
  top3Skipped: number;
}

/** One fixture's contribution, for the detail table. */
export interface PerFixtureResult {
  id: string;
  failureModeTags: string[];
  /** Labeled obligations. `0` for an `expect_no_pending` fixture. */
  groundTruthItems: number;
  /** Obligations the system produced. */
  surfacedItems: number;
  /** Labeled obligations surfaced with a correct citation. */
  matchedItems: number;
  /** Labeled obligations described correctly but cited wrongly (AC-6 failures). */
  wrongCitationItems: number;
  /** Claims that reached the briefing (i.e. passed the citation gate). */
  claims: number;
  /** Claims with no supporting artifact. */
  hallucinatedClaims: number;
  /** Claims matching a `ground_truth.unsupported_claims` label. Informational. */
  labeledUnsupportedClaims: number;
  citations: number;
  supportedCitations: number;
  /** `null` when the fixture has no ground-truth items to rank. */
  top3Relevant: boolean | null;
  /** Which fallback-chain step produced the briefing (`ollama` / `template`). */
  briefingStep: string;
  /** The layer-3 `ai_calls` outcome for the run. */
  briefingOutcome: string;
  /** Claims the citation gate withheld. */
  claimsDropped: number;
  /**
   * {@link claimsDropped} broken down by the gate's own reason, rendered as
   * `reason=count` pairs.
   *
   * Recorded because the first real run of this harness produced
   * `outcome: 'all_claims_dropped'` on every fixture, and a bare drop COUNT
   * cannot distinguish the four causes — `no_citation` (the model never emitted a
   * marker), `not_in_context` (it invented an id), `unknown_artifact` (the id is
   * not in the graph) and `injection_pattern` (T-1 fired). Those call for four
   * completely different fixes, so a report that omitted the breakdown would say
   * "the briefing was empty" without saying why. `BriefingGenerator` has always
   * returned it; nothing was reading it.
   */
  claimsDroppedByReason?: string;
  /**
   * F-4: accepted claims whose cited source text did NOT support them.
   *
   * Under `briefing.groundingMode: 'observe'` — the shipped default — these
   * claims were published anyway, and this is the count of what switching to
   * `'enforce'` would have withheld. It is the number the enforce/observe
   * decision rests on, which is why the eval reports it rather than leaving it
   * in a trace file: enforcing a lexical grounding check without knowing its
   * false-positive rate would trade a measured hallucination rate for an
   * unmeasured recall loss.
   */
  groundingFailures: number;
  /** Wall-clock ms spent on this fixture, model calls included. */
  durationMs: number;
  /** Present only when the fixture failed to run at all. */
  error?: string;
}

/** Environment facts a number is only interpretable against. */
export interface EvalReportEnvironment {
  /** Chat model, e.g. `qwen2.5:14b`. */
  chatModel: string;
  /** Embedding model, e.g. `nomic-embed-text`. */
  embedModel: string;
  /** `promptVersions.layer1/2/3`, joined. */
  promptVersions: string;
  /** The description-similarity threshold that produced these matches. */
  descriptionMatchThreshold: number;
  /**
   * Granularity at which a predicted citation was compared to a labeled one.
   *
   * `'thread'` for the current pipeline: Layer 1 files every chunk under the
   * conversation-level artifact `(source, 'thread', threadKey)`, so a citation
   * can name the thread a fact came from but not the individual message. See
   * `harness.ts` — this is a real property of the system under test, and stating
   * it is the difference between an honest AC-6 number and an overstated one.
   */
  citationGranularity: 'thread' | 'message';
}

export interface EvalReport {
  /**
   * Eval-set size: the number of labeled examples. MANDATORY (RO-2).
   *
   * See the module comment for why this is the fixture count and not an item
   * count, and for why {@link buildReport} refuses to build a report without it.
   */
  n: number;
  /**
   * How many fixtures exist in the fixtures directory, when `n` is a SUBSET of
   * them.
   *
   * Absent when the whole set was run. Present when it was not, and rendered as
   * "n = 5 of 30 available" — because "recall 80%, n=5" read out of context is
   * exactly the unqualified claim RO-2 forbids if the reader cannot tell that 25
   * other labeled examples were not attempted. A subset run is legitimate (a full
   * pass is hours of live inference); silently reporting it as the set is not.
   */
  available?: number;
  /** The fixture ids actually scored, when `n` is a subset. */
  selectedFixtureIds?: string[];
  /** AC-3, target ≥ 0.90. */
  recall: number;
  /** AC-4, target ≥ 0.75. */
  precision: number;
  /** AC-5, release gate < 0.02. */
  hallucinationRate: number;
  /** AC-6, target ≥ 0.95. */
  citationAccuracy: number;
  /** AC-7, target ≥ 0.80. */
  top3Relevance: number;
  /** Numerators and denominators behind the five rates. */
  counts?: EvalReportCounts;
  /** Model, prompt versions and matching parameters. */
  environment?: EvalReportEnvironment;
  /** Fixtures that could not be run at all, by id. */
  failedFixtures?: string[];
  /** Free-form caveats rendered into the report's Method section. */
  notes?: string[];
  /** Optional per-fixture detail. */
  perFixture?: PerFixtureResult[];
  /** Epoch ms the report was built. */
  generatedAt: number;
}

/**
 * Build a report, refusing to build one without a sample size.
 *
 * @throws Error when `n` is `undefined`. This is RO-2's enforcement point and
 *   the reason no other code path constructs an {@link EvalReport} literal.
 */
export function buildReport(input: Omit<EvalReport, 'n'> & { n?: number }): EvalReport {
  if (input.n === undefined) {
    throw new Error('eval report: n (eval-set size) is required — RO-2');
  }
  return { ...input, n: input.n };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One row of the acceptance-criteria table. */
interface MetricRow {
  criterion: string;
  label: string;
  value: number;
  target: string;
  /** True when the measured value meets the target. */
  pass: boolean;
  detail: MetricDetail | undefined;
  /** What one unit of the denominator is. */
  unit: string;
}

/** `0.9` → `90.0%`. */
function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** `4/5 items` — never a bare percentage (RO-2). */
function counted(detail: MetricDetail | undefined, unit: string): string {
  if (detail === undefined) return '—';
  return `${detail.numerator}/${detail.denominator} ${unit}`;
}

function rows(report: EvalReport): MetricRow[] {
  const counts = report.counts;
  return [
    {
      criterion: 'AC-3',
      label: 'Pending-item recall',
      value: report.recall,
      target: '≥ 90%',
      pass: report.recall >= 0.9,
      detail: counts?.recall,
      unit: 'items',
    },
    {
      criterion: 'AC-4',
      label: 'Pending-item precision',
      value: report.precision,
      target: '≥ 75%',
      pass: report.precision >= 0.75,
      detail: counts?.precision,
      unit: 'items',
    },
    {
      criterion: 'AC-5',
      label: 'Hallucination rate',
      value: report.hallucinationRate,
      target: '< 2%',
      pass: report.hallucinationRate < 0.02,
      detail: counts?.hallucinationRate,
      unit: 'claims',
    },
    {
      criterion: 'AC-6',
      label: 'Citation accuracy',
      value: report.citationAccuracy,
      target: '≥ 95%',
      pass: report.citationAccuracy >= 0.95,
      detail: counts?.citationAccuracy,
      unit: 'citations',
    },
    {
      criterion: 'AC-7',
      label: 'Top-3 relevance',
      value: report.top3Relevance,
      target: '≥ 80%',
      pass: report.top3Relevance >= 0.8,
      detail: counts?.top3Relevance,
      unit: 'cases',
    },
  ];
}

/**
 * The one-line summary a human reads first.
 *
 * `n` is in it, unconditionally. A summary line that could be copied into a
 * status update without its sample size is the exact failure RO-2 describes.
 */
export function renderHeadline(report: EvalReport): string {
  const size =
    report.available === undefined || report.available === report.n
      ? `n=${report.n} examples`
      : `n=${report.n} of ${report.available} examples (SUBSET)`;
  return (
    `${size} · recall ${pct(report.recall)} · precision ${pct(report.precision)} · ` +
    `hallucination ${pct(report.hallucinationRate)} · citations ${pct(report.citationAccuracy)} · ` +
    `top-3 ${pct(report.top3Relevance)}`
  );
}

/** The full markdown document written to `context-restorer-eval-report.md`. */
export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  const generated = new Date(report.generatedAt).toISOString();

  lines.push('# Context Restorer — Eval Report');
  lines.push('');
  lines.push(`_Generated ${generated} by \`npm run eval\` (Task 5.1)._`);
  lines.push('');
  const isSubset = report.available !== undefined && report.available !== report.n;
  lines.push(
    isSubset
      ? `**Eval-set size: n = ${report.n} labeled examples, selected from ${report.available ?? report.n} available.**`
      : `**Eval-set size: n = ${report.n} labeled examples.**`,
  );
  lines.push('');
  if (isSubset) {
    lines.push(
      '> **This is a SUBSET run, not a full pass over the committed fixture set.** ' +
        `${(report.available ?? 0) - report.n} labeled example(s) in ` +
        '`packages/eval/fixtures/` were not attempted, so none of the numbers below ' +
        'may be quoted as the eval result for the set (RO-2). Run `npm run eval` with ' +
        'no arguments for the full pass.',
    );
    lines.push('');
    const selected = report.selectedFixtureIds;
    if (selected !== undefined && selected.length > 0) {
      lines.push(`Scored: ${selected.map((id) => `\`${id}\``).join(', ')}.`);
      lines.push('');
    }
  }
  lines.push(
    'Every percentage below is stated with the sample it was measured on (RO-2). ' +
      'The per-metric denominators differ from `n` on purpose: `n` counts examples, ' +
      'while recall is per pending item, hallucination rate per claim, citation ' +
      'accuracy per citation, and top-3 relevance per scoreable case.',
  );
  lines.push('');

  // ---- metrics ------------------------------------------------------------
  lines.push('## Metrics');
  lines.push('');
  lines.push('| Criterion | Metric | Measured | Sample | Target | Status |');
  lines.push('|---|---|---|---|---|---|');
  for (const row of rows(report)) {
    lines.push(
      `| ${row.criterion} | ${row.label} | ${pct(row.value)} | ` +
        `${counted(row.detail, row.unit)} | ${row.target} | ${row.pass ? 'PASS' : 'FAIL'} |`,
    );
  }
  lines.push('');

  if (report.counts !== undefined && report.counts.top3Skipped > 0) {
    lines.push(
      `_${report.counts.top3Skipped} example(s) are excluded from the AC-7 denominator: ` +
        'they are labeled `expect_no_pending`, so there is no relevant item for a top-3 ' +
        'slice to contain. Excluding them is stated rather than silent — a hidden ' +
        'exclusion misstates the sample size._',
    );
    lines.push('');
  }

  // ---- environment --------------------------------------------------------
  const env = report.environment;
  if (env !== undefined) {
    lines.push('## Environment');
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    lines.push(`| Chat model | \`${env.chatModel}\` |`);
    lines.push(`| Embedding model | \`${env.embedModel}\` |`);
    lines.push(`| Prompt versions | ${env.promptVersions} |`);
    lines.push(`| Description match threshold | ${env.descriptionMatchThreshold} (Sørensen–Dice) |`);
    lines.push(`| Citation comparison granularity | ${env.citationGranularity} |`);
    lines.push('');
  }

  // ---- per fixture --------------------------------------------------------
  const perFixture = report.perFixture;
  if (perFixture !== undefined && perFixture.length > 0) {
    lines.push('## Per-fixture detail');
    lines.push('');
    lines.push(
      '| Fixture | Tags | GT items | Surfaced | Matched | Wrong citation | Claims | ' +
        'Halluc. | Citations | Cited OK | Top-3 | Step | Outcome | Dropped | Ungrounded | ms |',
    );
    lines.push('|---|---|--:|--:|--:|--:|--:|--:|--:|--:|:--:|---|---|--:|--:|--:|');
    for (const fixture of perFixture) {
      const top3 =
        fixture.top3Relevant === null ? 'n/a' : fixture.top3Relevant ? 'yes' : 'no';
      lines.push(
        `| \`${fixture.id}\` | ${fixture.failureModeTags.join(', ')} | ` +
          `${fixture.groundTruthItems} | ${fixture.surfacedItems} | ${fixture.matchedItems} | ` +
          `${fixture.wrongCitationItems} | ${fixture.claims} | ${fixture.hallucinatedClaims} | ` +
          `${fixture.citations} | ${fixture.supportedCitations} | ${top3} | ` +
          `${fixture.briefingStep} | ${fixture.briefingOutcome} | ${fixture.claimsDropped} | ` +
          `${fixture.groundingFailures} | ${fixture.durationMs} |`,
      );
    }
    lines.push('');

    // F-4: what enforcing the grounding check would have cost.
    const ungrounded = perFixture.reduce((sum, f) => sum + f.groundingFailures, 0);
    const publishedClaims = perFixture.reduce((sum, f) => sum + f.claims, 0);
    lines.push('### F-4 grounding check (observe mode)');
    lines.push('');
    if (publishedClaims === 0) {
      lines.push('_No claims were published, so the grounding check had nothing to evaluate._');
    } else {
      const pct = ((ungrounded / publishedClaims) * 100).toFixed(1);
      lines.push(
        `**${ungrounded} of ${publishedClaims} published claim(s) (${pct}%) were NOT supported ` +
          "by their cited source text**, under the same 0.60 containment rule this harness " +
          'uses to score AC-5.',
      );
      lines.push('');
      lines.push(
        'These claims WERE shown to the user: `briefing.groundingMode` ships as ' +
          "`'observe'`, which counts without withholding. This number is the cost of " +
          "switching to `'enforce'` — it is how many claims would have been dropped, and it " +
          'includes both genuine fabrications AND faithful abstractive summaries that share ' +
          'too few literal tokens with their source. Read it against the hallucination rate ' +
          'above before flipping the mode: if it materially exceeds the hallucination count, ' +
          'enforcing would delete more true claims than false ones.',
      );
    }
    lines.push('');

    // Why the gate dropped what it dropped. Four causes, four different fixes.
    const withDrops = perFixture.filter(
      (fixture) => fixture.claimsDroppedByReason !== undefined && fixture.claimsDropped > 0,
    );
    if (withDrops.length > 0) {
      lines.push('### Citation-gate drops, by reason');
      lines.push('');
      lines.push('| Fixture | Dropped | Reasons |');
      lines.push('|---|--:|---|');
      for (const fixture of withDrops) {
        lines.push(
          `| \`${fixture.id}\` | ${fixture.claimsDropped} | ${fixture.claimsDroppedByReason ?? ''} |`,
        );
      }
      lines.push('');
      lines.push(
        '_`no_citation` means the model emitted no `[artifact:<id>]` marker at all. ' +
          '`not_in_context` means it emitted an id that was never in the retrieval ' +
          'allowlist — i.e. it invented or mangled one. `unknown_artifact` means the id ' +
          'does not exist in the graph. `injection_pattern` means the T-1 shape detector ' +
          'fired on the claim text._',
      );
      lines.push('');
    }

    // The two kinds of "unsupported" are worth separating: one is confirmed by a
    // human label, the other is a lexical guess. A reader deciding whether AC-5
    // is met needs to know which kind produced the number.
    const labeledNegatives = perFixture.reduce(
      (total, fixture) => total + fixture.labeledUnsupportedClaims,
      0,
    );
    const hallucinated = perFixture.reduce(
      (total, fixture) => total + fixture.hallucinatedClaims,
      0,
    );
    // Suppressed when nothing was unsupported: "of 0 claims, 0 were…" is noise
    // that makes a clean result look like a missing one.
    if (hallucinated > 0) {
      lines.push(
        `_Of ${hallucinated} unsupported claim(s), ${labeledNegatives} asserted a ` +
          'hand-labeled `unsupported_claims` entry — a confirmed fabrication. The ' +
          `remaining ${Math.max(0, hallucinated - labeledNegatives)} were judged unsupported ` +
          'by the lexical grounding check alone and are the ones worth reading by hand._',
      );
      lines.push('');
    }

    const failed = perFixture.filter((fixture) => fixture.error !== undefined);
    if (failed.length > 0) {
      lines.push('### Fixtures that failed to run');
      lines.push('');
      for (const fixture of failed) {
        lines.push(`- \`${fixture.id}\`: ${fixture.error ?? 'unknown error'}`);
      }
      lines.push('');
    }
  }

  // ---- method -------------------------------------------------------------
  lines.push('## Method');
  lines.push('');
  lines.push(
    '- **Real pipeline, real model.** Each fixture is scored by seeding a fresh ' +
      'in-memory SQLite database and a fresh temporary LanceDB directory, ingesting ' +
      "the fixture's events through the real `IngestionPipeline`, then running the " +
      'real `Layer1Extractor`, `Layer2Synthesizer` and `generateWithFallback` against ' +
      'the local Ollama instance. No layer is stubbed.',
  );
  lines.push(
    '- **Matching is fuzzy on description, strict on citation.** Descriptions are ' +
      'compared by Sørensen–Dice similarity over content-token sets; citations are ' +
      'compared exactly. A right-sounding pending item with the wrong citation counts ' +
      'as **both a recall miss and a citation error** — never as a pass.',
  );
  lines.push(
    '- **Layer 2 is invoked directly, not through the debounce scheduler.** The ' +
      'eval needs deterministic, immediate execution; waiting out real-time quiet ' +
      'windows would make a run take hours and would test the scheduler rather than ' +
      'the synthesis it triggers. `DebounceScheduler` has its own unit tests.',
  );
  const notes = report.notes;
  if (notes !== undefined) {
    for (const note of notes) lines.push(`- ${note}`);
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push(`_${renderHeadline(report)}_`);
  lines.push('');

  return `${lines.join('\n').trimEnd()}\n`;
}
