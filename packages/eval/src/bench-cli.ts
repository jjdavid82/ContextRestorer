/**
 * `npm run bench:briefing` — the AC-1 latency benchmark entry point (Task 5.3).
 *
 * A separate script from `cli.ts` rather than a mode flag on it. The two runs
 * share no output, no report file and no failure policy: `npm run eval` grades
 * quality over a labeled fixture set and writes the eval report, while this one
 * seeds a synthetic corpus and writes the bench report. Folding both into one
 * entry point would mean an `if (mode)` at the top of a script whose two halves
 * have nothing in common, and would make `npm run eval` able to accidentally
 * overwrite a latency report.
 *
 * **This makes real calls to a real local model**, and it is slow: seeding runs
 * one Layer 1 chat call per signal event plus one Layer 2 call per signal thread,
 * and then every briefing is a real streamed generation. Budget tens of minutes.
 *
 * ### Scaling a run
 *
 * Everything is env-var driven, because `npm run bench:briefing` at the repo root
 * delegates through a second `npm run` and forwarding `--` through both layers is
 * fragile (the same reason `cli.ts` reads `CR_EVAL_FIXTURES`):
 *
 * ```
 * CR_BENCH_BRIEFINGS=8 npm run bench:briefing     # 8 real generations, not 20
 * CR_BENCH_EVENTS=500 CR_BENCH_THREADS=4 npm run bench:briefing
 * ```
 *
 *   - `CR_BENCH_BRIEFINGS`  — briefings to time (default 20)
 *   - `CR_BENCH_EVENTS`     — bulk events to ingest (default 3000)
 *   - `CR_BENCH_THREADS`    — threads given real Layer 1 + Layer 2 (default 8)
 *   - `CR_BENCH_THREAD_EVENTS` — events per signal thread (default 3)
 *   - `CR_BENCH_WINDOW_HOURS`  — briefing window width (default 48)
 *   - `CR_BENCH_LLM=1`         — ALSO time the background generation path.
 *                             Off by default since P0: the request path no
 *                             longer calls a model, so the LLM run measures
 *                             the pre-computer and takes hours.
 *   - `CR_BENCH_NOTE`          — a caveat about the machine's condition, rendered
 *                                above the table (e.g. "another eval job was
 *                                streaming on the same Ollama instance")
 *
 * A reduced `CR_BENCH_BRIEFINGS` is legitimate — 20 real generations on a busy
 * machine is a long time — and the report says so in a banner with the actual `n`.
 * It is never silently reduced.
 *
 * ### Path resolution
 *
 * Every path is resolved from `import.meta.dirname`, never `process.cwd()`: under
 * `npm run bench -w packages/eval` the cwd is `packages/eval`, so
 * `config/default.json` would miss and the report would land in
 * `packages/eval/specs/…`. This file is emitted to `packages/eval/dist/`, so the
 * repo root is three levels up.
 *
 * ### Exit code
 *
 * `0` when the run completed, whatever the numbers said; `1` only when the run
 * itself could not complete (no Ollama, seeding failed, an unwritable report). A
 * failing AC-1 threshold is a RESULT and must be readable in the report rather
 * than swallowed by a non-zero exit — same policy as `cli.ts`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '@cr/core';
import {
  DEFAULT_BRIEFING_COUNT,
  DEFAULT_EVENTS_PER_SIGNAL_THREAD,
  DEFAULT_EVENT_COUNT,
  DEFAULT_SIGNAL_THREAD_COUNT,
  evaluateAc1,
  renderBenchTable,
  runBench,
  type BenchResult,
} from './bench.js';

/** Repo root: `packages/eval/dist/` → three levels up. */
const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const CONFIG_PATH = join(REPO_ROOT, 'config', 'default.json');
const REPORT_PATH = join(
  REPO_ROOT,
  'specs',
  '2026-08-23-context-restorer',
  'context-restorer-bench-report.md',
);

/** Positive integer from `name`, or `fallback`. A malformed value is a hard error. */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`bench: ${name} must be a positive integer, got '${raw}'`);
  }
  return value;
}

/** The markdown document written to `context-restorer-bench-report.md`. */
function renderReport(result: BenchResult): string {
  const lines: string[] = [];
  lines.push('# Context Restorer — Latency Benchmark (AC-1)');
  lines.push('');
  lines.push(
    `_Generated ${new Date(result.generatedAt).toISOString()} by \`npm run bench:briefing\` (Task 5.3)._`,
  );
  lines.push('');
  lines.push(
    'This is the only measurement of AC-1 in the build. The Task 5.1 eval harness pins ' +
      "the clock inside each fixture's window, which makes every latency it records 0 and " +
      'makes the §7.8 generation budget unable to elapse; it measures quality, not latency.',
  );
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push(renderBenchTable(result));
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push(
    '- **Real pipeline, real model, live clock.** A fresh file-backed SQLite database and ' +
      'a fresh LanceDB directory are seeded with a synthetic 5-day, 2-source corpus through ' +
      'the real `IngestionPipeline`; the signal threads then run through the real ' +
      '`Layer1Extractor` and `Layer2Synthesizer` against local Ollama. The clock is pinned ' +
      'inside the period while seeding (so `state_deltas.created_at` spreads across the five ' +
      'days rather than landing in one instant) and is switched to `Date.now()` before the ' +
      'first timed call.',
  );
  lines.push(
    '- **`BriefingGenerator.generate()` is called directly, not through ' +
      '`generateWithFallback`.** A template-mode briefing takes milliseconds because no ' +
      'model runs, so a fallback in the loop would let a measurement of SQLite be published ' +
      'as a measurement of the LLM path. An iteration that throws is skipped and counted.',
  );
  lines.push(
    '- **First paint is measured separately from first token.** First paint is the Task 3.5 ' +
      '`briefing:pending` path — one SELECT over `pending_items`, ranked by stakes × ' +
      'confidence, with no model client in scope — timed as its own call. First token comes ' +
      "from the LLM run's own `firstToken` span. Deriving one from the other would hide a " +
      'regression in either.',
  );
  lines.push(
    '- **Percentiles are nearest-rank**, using the same arithmetic as ' +
      '`BriefingsRepo.percentiles` (`packages/store/src/repos/briefings.ts`), so the number ' +
      "printed here and the number the app's own metrics view prints are the same " +
      'statistic. No interpolation: every value is traceable to one real run.',
  );
  lines.push(
    '- **`DebounceScheduler` is skipped**, exactly as in the eval harness: waiting out real ' +
      'quiet windows would test the scheduler rather than the generation being timed.',
  );
  lines.push(
    '- **These latencies INCLUDE queueing behind anything else using the same local Ollama.** ' +
      'That is a real property of a single-machine product and is not corrected for: the ' +
      'numbers describe the machine as it was, not the model in isolation. If another ' +
      'inference job was running during the measurement, it is stated in the conditions ' +
      'above (`CR_BENCH_NOTE`) — a latency table with no such note should be read as ' +
      'claiming the machine was otherwise idle.',
  );
  lines.push('');

  // ---- per-run detail ------------------------------------------------------
  if (result.samples.length > 0) {
    lines.push('## Per-run detail');
    lines.push('');
    lines.push(
      '| # | Window (UTC) | First paint ms | Total ms | retrieval | assembly | firstToken | generation | citation | Claims | Dropped | Partial | Outcome |',
    );
    lines.push('|--:|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|:--:|---|');
    for (const sample of result.samples) {
      const cell = (value: number | undefined): string =>
        value === undefined ? '—' : String(Math.round(value));
      lines.push(
        `| ${sample.index} | ${new Date(sample.windowStart).toISOString().slice(5, 16)} → ` +
          `${new Date(sample.windowEnd).toISOString().slice(5, 16)} | ` +
          `${sample.firstPaintMs < 1 ? '<1' : Math.round(sample.firstPaintMs)} | ` +
          `${Math.round(sample.totalMs)} | ${cell(sample.timings.retrievalMs)} | ` +
          `${cell(sample.timings.assemblyMs)} | ${cell(sample.timings.firstTokenMs)} | ` +
          `${cell(sample.timings.generationMs)} | ${cell(sample.timings.citationMs)} | ` +
          `${sample.claimsAccepted} | ${sample.claimsDropped} | ` +
          `${sample.partial ? 'yes' : 'no'} | ${sample.outcome} |`,
      );
    }
    lines.push('');
    lines.push(
      '_A `no_context` row made no model call and is excluded from every LLM latency ' +
        'distribution above; its first-paint measurement still counts, because first paint ' +
        'does not depend on the model._',
    );
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

async function main(): Promise<void> {
  const config = loadConfig(CONFIG_PATH);
  const briefingCount = intFromEnv('CR_BENCH_BRIEFINGS', DEFAULT_BRIEFING_COUNT);
  const eventCount = intFromEnv('CR_BENCH_EVENTS', DEFAULT_EVENT_COUNT);
  const signalThreadCount = intFromEnv('CR_BENCH_THREADS', DEFAULT_SIGNAL_THREAD_COUNT);
  const eventsPerSignalThread = intFromEnv(
    'CR_BENCH_THREAD_EVENTS',
    DEFAULT_EVENTS_PER_SIGNAL_THREAD,
  );
  const windowHours = intFromEnv('CR_BENCH_WINDOW_HOURS', 48);
  const note = (process.env['CR_BENCH_NOTE'] ?? '').trim();
  // P0: the model is no longer on the request path, so the LLM run measures the
  // background pre-computer — hours long, and not what AC-1 asks about.
  const measureLlm = (process.env['CR_BENCH_LLM'] ?? '').trim() === '1';

  process.stdout.write('Context Restorer — latency benchmark (Task 5.3, AC-1)\n');
  process.stdout.write(`  model     : ${config.model.chat} @ ${config.model.ollamaBaseUrl}\n`);
  process.stdout.write(`  embed     : ${config.model.embed}\n`);
  process.stdout.write(`  events    : ${eventCount} ingested\n`);
  process.stdout.write(
    `  seeding   : ${signalThreadCount} signal thread(s) × ${eventsPerSignalThread} event(s) ` +
      `= ${signalThreadCount * eventsPerSignalThread} Layer 1 call(s) + ${signalThreadCount} Layer 2 call(s)\n`,
  );
  process.stdout.write(`  briefings : ${briefingCount} × ${windowHours}h rolling windows\n`);
  if (briefingCount !== DEFAULT_BRIEFING_COUNT) {
    process.stdout.write(
      `  NOTE: the plan calls for ${DEFAULT_BRIEFING_COUNT}; this run is labelled as a reduced sample.\n`,
    );
  }
  process.stdout.write('  NOTE: this makes real calls to your local Ollama and is SLOW.\n\n');

  const startedAt = Date.now();
  const result = await runBench({
    config,
    eventCount,
    briefingCount,
    signalThreadCount,
    eventsPerSignalThread,
    windowWidthMs: windowHours * 60 * 60 * 1000,
    measureLlm,
    ...(note === '' ? {} : { notes: [note] }),
    onProgress: (progress) => {
      const position =
        progress.index === undefined || progress.total === undefined
          ? ''
          : `[${progress.index}/${progress.total}] `;
      const elapsed = `${Math.round((Date.now() - startedAt) / 1000)}s`;
      process.stdout.write(`${elapsed.padStart(6)} ${progress.phase} ${position}${progress.message}\n`);
    },
  });

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, renderReport(result), 'utf8');

  process.stdout.write('\n');
  process.stdout.write(`${renderBenchTable(result)}\n`);
  process.stdout.write('\n');
  for (const check of evaluateAc1(result)) {
    process.stdout.write(
      `${check.status.padEnd(7)} ${check.label} — measured ` +
        `${check.measuredP95 === null ? 'no data' : `${Math.round(check.measuredP95)} ms`} ` +
        `vs < ${check.thresholdMs} ms, n=${check.count}\n`,
    );
  }
  process.stdout.write(`\nReport written to ${REPORT_PATH}\n`);
}

await main().catch((error: unknown) => {
  // A run that could not complete is an operator problem (Ollama down, seeding
  // failed), not a benchmark result. Fail loudly — and print `cause`, because the
  // failure this run actually hits is `TypeError: fetch failed`, whose whole
  // diagnostic content (`UND_ERR_HEADERS_TIMEOUT`, `ECONNREFUSED`) is in there.
  process.stderr.write(
    `bench: run failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  const cause: unknown = (error as { cause?: unknown } | null)?.cause;
  if (cause !== undefined && cause !== null) {
    process.stderr.write(
      `bench: cause: ${cause instanceof Error ? `${(cause as { code?: string }).code ?? cause.name}: ${cause.message}` : String(cause)}\n`,
    );
  }
  process.exitCode = 1;
});
