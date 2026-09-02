/**
 * `npm run eval` — the offline eval entry point (Task 5.1).
 *
 * A plain Node script, deliberately: no CLI framework, no flags to learn, no
 * argument parsing to get wrong. It does exactly four things.
 *
 *   1. loads `config/default.json` from the repo root,
 *   2. runs the harness over `packages/eval/fixtures`,
 *   3. writes `specs/2026-08-23-context-restorer/context-restorer-eval-report.md`,
 *   4. prints a summary — including `n` — to stdout.
 *
 * **This makes real calls to a real local model.** It is the one suite in the
 * build that does, and it is slow: every fixture event costs one chat call plus
 * one embedding, every thread costs another chat call, and the briefing is
 * streamed. Measured at roughly **25 minutes per fixture** for `qwen2.5:14b` on
 * a 16 GB machine, so a full pass over the committed set is HOURS. Run it
 * deliberately.
 *
 * ### Narrowing a run
 *
 * Fixture ids may be passed as positional arguments, or in the
 * `CR_EVAL_FIXTURES` environment variable as a comma-separated list:
 *
 * ```
 * npm run eval -w packages/eval -- eng-mgr-vacation-01 injection-01
 * CR_EVAL_FIXTURES=eng-mgr-vacation-01,injection-01 npm run eval
 * ```
 *
 * The env var exists because `npm run eval` at the repo root delegates through
 * a second `npm run`, and forwarding `--` through both layers is fragile. An
 * unknown id is a hard error, and a narrowed run writes a report carrying a
 * prominent SUBSET banner plus `n = <selected> of <available>` — a partial pass
 * must never be quotable as the eval result for the set (RO-2).
 *
 * ### Path resolution
 *
 * Every path is resolved from `import.meta.dirname`, never from `process.cwd()`.
 * Under `npm run eval -w packages/eval` the cwd is `packages/eval`, so
 * `loadConfig()`'s default of `config/default.json` would miss, and the report
 * would land in `packages/eval/specs/...`. This file is emitted to
 * `packages/eval/dist/cli.js`, so the repo root is three levels up — the same
 * `import.meta.dirname`-relative pattern `CONFIG_PATH` uses in
 * `apps/desktop/src/main.ts`, and for the same reason.
 *
 * ### Exit code
 *
 * `0` when the run completed, whatever the metrics said; `1` only when the run
 * itself could not complete (no Ollama, an invalid fixture, an unwritable
 * report). A failing acceptance criterion is a RESULT and must be readable in
 * the report rather than swallowed by a non-zero exit — the acceptance gate is a
 * human reading the numbers, not this script's status. Fixtures that failed
 * individually are listed on stdout and in the report.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '@cr/core';
import { runEval } from './harness.js';
import { renderHeadline, renderMarkdown } from './report.js';

/** Repo root: `packages/eval/dist/` → three levels up. */
const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const CONFIG_PATH = join(REPO_ROOT, 'config', 'default.json');
const FIXTURES_DIR = join(REPO_ROOT, 'packages', 'eval', 'fixtures');
const REPORT_PATH = join(
  REPO_ROOT,
  'specs',
  '2026-08-23-context-restorer',
  'context-restorer-eval-report.md',
);

/**
 * Fixture ids the operator asked for, from argv then `CR_EVAL_FIXTURES`.
 *
 * Empty means "the whole set". Blank entries are dropped so a stray comma or a
 * trailing space cannot become a fixture id that then fails the unknown-id check.
 */
function requestedFixtureIds(): string[] {
  const fromArgv = process.argv.slice(2);
  const fromEnv = (process.env['CR_EVAL_FIXTURES'] ?? '').split(',');
  return [...fromArgv, ...fromEnv].map((id) => id.trim()).filter((id) => id !== '');
}

async function main(): Promise<void> {
  const config = loadConfig(CONFIG_PATH);
  const fixtureIds = requestedFixtureIds();

  process.stdout.write('Context Restorer — offline eval (Task 5.1)\n');
  process.stdout.write(`  fixtures : ${FIXTURES_DIR}\n`);
  process.stdout.write(`  model    : ${config.model.chat} @ ${config.model.ollamaBaseUrl}\n`);
  process.stdout.write(`  embed    : ${config.model.embed}\n`);
  if (fixtureIds.length > 0) {
    process.stdout.write(`  SUBSET   : ${fixtureIds.join(', ')}\n`);
    process.stdout.write('  The report will be labelled as a partial run (RO-2).\n');
  }
  process.stdout.write(
    '  NOTE: this makes real calls to your local Ollama. Budget ~25 min per fixture.\n\n',
  );

  const report = await runEval({
    fixturesDir: FIXTURES_DIR,
    config,
    ...(fixtureIds.length > 0 ? { fixtureIds } : {}),
    onProgress: (progress) => {
      const position = `[${progress.index}/${progress.total}]`;
      if (progress.phase === 'start') {
        process.stdout.write(`${position} ${progress.fixtureId} … `);
        return;
      }
      const result = progress.result;
      if (result === undefined) {
        process.stdout.write('done\n');
        return;
      }
      if (result.error !== undefined) {
        process.stdout.write(`FAILED (${result.error})\n`);
        return;
      }
      process.stdout.write(
        `${result.matchedItems}/${result.groundTruthItems} items, ` +
          `${result.surfacedItems} surfaced, ${result.claims} claims ` +
          `(${result.hallucinatedClaims} unsupported), ${result.claimsDropped} dropped, ` +
          `${result.briefingStep}/${result.briefingOutcome}, ${result.durationMs}ms\n`,
      );
    },
  });

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, renderMarkdown(report), 'utf8');

  process.stdout.write('\n');
  process.stdout.write(`${renderHeadline(report)}\n`);
  if (report.failedFixtures !== undefined) {
    process.stdout.write(`Fixtures that failed to run: ${report.failedFixtures.join(', ')}\n`);
  }
  process.stdout.write(`Report written to ${REPORT_PATH}\n`);
}

await main().catch((error: unknown) => {
  // A run that could not complete is an operator problem (Ollama down, a model
  // not pulled, an invalid fixture), not an eval result. Fail loudly.
  process.stderr.write(`eval: run failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
