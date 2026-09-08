/**
 * Recent *individual* pipeline events from the trace log (Diagnostics redesign).
 *
 * `traceLog.ts` answers "how many, over 7 days" and its header is emphatic that
 * it returns counts and never content. The Diagnostics "recent activity" feed
 * needs the other shape: a short, time-ordered list of the last few things that
 * went wrong or got discarded, each with a timestamp. That is a different
 * question with a different safety story (a timestamp and a reason code, still
 * no content), so it lives here rather than bending `readTraceMetrics`.
 *
 * Same forgiving-read contract as `traceLog.ts`: a missing directory yields an
 * empty list, an unreadable file is skipped, a malformed line is ignored. This
 * is a debugging surface for a local app reading append-only files that may be
 * mid-write.
 *
 * What it recognises, and where the annotation comes from:
 *
 *   - `gate_injection` / `gate_drops` — `event: 'briefing'` traces carrying a
 *     `gateDrops` reason→count map (Layer 3 citation gate). An `injection_pattern`
 *     drop is split out because it is the one the user should actually look at.
 *   - `thread_parked` — `event: 'layer2_parked'` traces, written when the
 *     debounce scheduler gives up on a thread after `maxAttempts`.
 *   - `noise_skipped` — `event: 'layer1_sweep'` traces, carrying the count of
 *     events the deterministic pre-filter classified as noise this sweep.
 *
 * The last two are emitted by `packages/ai` changes that may not have landed
 * yet; this reader simply returns nothing for them until they do.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listTraceFiles } from './traceLog.js';

/** The kinds of trace-derived event the feed knows how to render. */
export type TraceEventKind =
  | 'gate_injection'
  | 'gate_drops'
  | 'thread_parked'
  | 'noise_skipped';

/** One notable thing the pipeline did, at a point in time. Never any content. */
export interface TraceEvent {
  /** Epoch ms — the trace's `startedAtMs`. */
  atMs: number;
  kind: TraceEventKind;
  /** Affected items, where the event aggregates several (drops, skips). >= 1. */
  count: number;
}

export interface ReadTraceEventsOptions {
  /** Ignore trace lines older than this (epoch ms). Default: no lower bound. */
  sinceMs?: number;
  /** Day-files to read, newest first. Default 7. */
  days?: number;
  /** Cap on events returned, newest first. Default 50. */
  limit?: number;
  /** Cap on lines read per file. Default 20 000. */
  maxLinesPerFile?: number;
}

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_LINES = 20_000;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A finite, positive integer count, or 0. Guards a hand-edited log. */
function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Read the trace log and return recent notable events, newest first.
 *
 * Never throws. Ordering is by `atMs` descending, then truncated to `limit`.
 */
export function readTraceEvents(
  logsDir: string,
  options: ReadTraceEventsOptions = {},
): TraceEvent[] {
  const sinceMs = options.sinceMs ?? Number.NEGATIVE_INFINITY;
  const maxLines = options.maxLinesPerFile ?? DEFAULT_MAX_LINES;
  const events: TraceEvent[] = [];

  for (const file of listTraceFiles(logsDir).slice(0, options.days ?? DEFAULT_DAYS)) {
    let text: string;
    try {
      text = readFileSync(join(resolve(logsDir), file), 'utf8');
    } catch {
      continue;
    }

    for (const line of text.split('\n').filter((l) => l.length > 0).slice(0, maxLines)) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPlainObject(entry)) continue;

      const atMs = entry['startedAtMs'];
      if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs < sinceMs) continue;

      const annotations = entry['annotations'];
      if (!isPlainObject(annotations)) continue;

      switch (annotations['event']) {
        case 'briefing': {
          const drops = annotations['gateDrops'];
          if (!isPlainObject(drops)) break;
          let injection = 0;
          let other = 0;
          for (const [reason, raw] of Object.entries(drops)) {
            const n = asCount(raw);
            if (reason === 'injection_pattern') injection += n;
            else other += n;
          }
          if (injection > 0) events.push({ atMs, kind: 'gate_injection', count: injection });
          if (other > 0) events.push({ atMs, kind: 'gate_drops', count: other });
          break;
        }
        case 'layer2_parked': {
          events.push({ atMs, kind: 'thread_parked', count: 1 });
          break;
        }
        case 'layer1_sweep': {
          const skipped = asCount(annotations['prefiltered']);
          if (skipped > 0) events.push({ atMs, kind: 'noise_skipped', count: skipped });
          break;
        }
        default:
          break;
      }
    }
  }

  events.sort((a, b) => b.atMs - a.atMs);
  return events.slice(0, options.limit ?? DEFAULT_LIMIT);
}
