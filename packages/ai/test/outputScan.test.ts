/**
 * SEC-5 — output-side PII and secret scanning (Task 4.2).
 *
 * The threat this file exists to close is narrow and specific: a secret or a
 * contact detail that was legitimately INGESTED (SEC-4 keeps a `password: …`
 * out of the database, but it cannot keep a colleague's phone number out of a
 * Slack message that genuinely contains one) gets RESTATED by the model in a
 * generated claim, and that claim is then written to `briefing_claims`, written
 * to the narrative markdown, and streamed to the renderer. Input-side redaction
 * cannot help there — the leak is authored on the way out.
 *
 * ## Why the tests go through `CitationGate.accept()`, not `redactOutput()`
 *
 * `redactOutput()` is unit-tested in `packages/redact/test/redact.test.ts`. What
 * that cannot tell us is whether the scan is actually ON the path a generated
 * claim takes. A perfectly correct redactor wired one line too late is a leak,
 * and it is a leak that a redactor-only test suite reports as green. So the
 * cases below drive the real gate, and the end-to-end block drives the real
 * `BriefingGenerator` over a real SQLite database and asserts on what is on
 * disk afterwards.
 *
 * ## The one scan point
 *
 * `CitationGate.accept()` redacts, and it is the last thing it does before
 * returning `{ accepted: true, text }`. `BriefingGenerator` consumes that single
 * `text` for BOTH destinations — `persist()` writes it to `briefing_claims` and
 * `writeNarrative()` to the markdown; `announce()` hands it to
 * `onClaimAccepted`, which the desktop main process forwards as
 * `briefing:chunk`. There is no other copy of an accepted claim: `collected`
 * holds the RAW model text and is never persisted or emitted, only gated.
 *
 * ## The dual-call design (Task 3.4) and why it is safe
 *
 * The generator deliberately runs the gate TWICE per claim — once in
 * `announce()` for the streaming path, once in `gate()` for the persistence
 * path — so a throwing subscriber cannot perturb what gets stored. That means
 * redaction also runs twice, on two independent invocations, and the two results
 * would diverge if `redactOutput` were stateful (a module-level `lastIndex`
 * leak, a memoisation cache, a counter). It is pure, so they cannot. This file
 * ASSERTS that equality end-to-end rather than reasoning about it: the streamed
 * chunk text and the persisted row text are compared byte-for-byte.
 *
 * ## The over-redaction failure mode is treated as a first-class bug
 *
 * A briefing is made of people doing things. "Priya asked you to approve the
 * plan" is the product. A PII scanner that treats human names as PII deletes the
 * subject of every sentence and leaves a briefing that is technically leak-free
 * and completely useless. So the display-name cases below are regressions, not
 * nice-to-haves: they assert ordinary prose full of real-looking names comes
 * back byte-identical, `count === 0`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { FakeClock, type AppConfig, type Artifact } from '@cr/core';
import {
  AiCallsRepo,
  BriefingsRepo,
  DeltasRepo,
  GraphRepo,
  PendingItemsRepo,
  WatermarkRepo,
  migrate,
  openDb,
} from '@cr/store';
import type { GenerateStreamOptions, OllamaClient } from '../src/ollama.js';
import type { RetrievalResult, RetrievalWindow, RetrievedChunk } from '../src/retrieval.js';
import { CitationGate } from '../src/layer3/citationGate.js';
import {
  BriefingGenerator,
  type AcceptedClaimChunk,
  type BriefingRetriever,
} from '../src/layer3/generate.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const MODEL = 'llama3.1:8b';
const PROMPT_VERSION = 'layer3-brief.v1';

const A1 = 'slack:thread:C1:1';
const A2 = 'slack:thread:C2:1';
const MARKER1 = `[artifact:${A1}]`;

const WINDOW = { windowStart: NOW - DAY, windowEnd: NOW + 1 };

/** Ids the generator was shown. Mirrors the gate's own suite. */
const allowed: ReadonlySet<string> = new Set([A1, A2]);

// ---------------------------------------------------------------------------
// Fixture — a REAL GraphRepo over in-memory SQLite, as in citationGate.test.ts.
// A stubbed graph would make the gate agree with itself.
// ---------------------------------------------------------------------------

const artifact = (artifactId: string): Artifact => ({
  artifactId,
  source: 'slack',
  kind: 'thread',
  externalRef: `https://example.test/${artifactId}`,
  title: null,
  state: null,
  ownerId: null,
  firstSeenAt: NOW - DAY,
  lastSeenAt: NOW,
});

let db: Database;
let graph: GraphRepo;
let gate: CitationGate;
let tmp: string;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  graph = new GraphRepo(db);
  gate = new CitationGate(graph);

  for (const id of [A1, A2]) graph.upsertArtifact(artifact(id));

  tmp = mkdtempSync(join(tmpdir(), 'cr-outputscan-'));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Gate a claim that is guaranteed to pass every check except redaction. */
function accept(body: string) {
  const result = gate.accept(`${body} ${MARKER1}`, allowed);
  // Guard: if a case ever trips the injection or citation checks instead, the
  // redaction assertions below would pass vacuously against an empty string.
  expect(result.accepted, `expected an accept, got drop: ${result.reason ?? ''}`).toBe(true);
  return result;
}

// ---------------------------------------------------------------------------
// 1. Secrets restated by the model
// ---------------------------------------------------------------------------

describe('SEC-5 — secrets in model output', () => {
  const secrets: Array<[string, string, string]> = [
    [
      'an AWS access key id',
      'Ravi pasted the staging key AKIAIOSFODNN7EXAMPLE into the channel',
      'AKIAIOSFODNN7EXAMPLE',
    ],
    [
      'a Slack bot token',
      'The webhook broke because xoxb-1234567890-ABCDEFGHIJKLMNOP was rotated',
      'xoxb-1234567890-ABCDEFGHIJKLMNOP',
    ],
    [
      'a GitHub personal access token',
      'CI is using ghp_16C7e42F292c6912E7710c838347Ae178B4a for the release job',
      'ghp_16C7e42F292c6912E7710c838347Ae178B4a',
    ],
    [
      'a JWT',
      'The failing request carried eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123 as its bearer',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123',
    ],
    ['a credential assignment', 'The runbook still says password = hunter2correct', 'hunter2correct'],
    [
      'an unlabelled high-entropy token',
      'The upload used Xy7Qz4Vb9Lm2Np5Rt8Ws3Kd6Hj1Gf0A as its handle',
      'Xy7Qz4Vb9Lm2Np5Rt8Ws3Kd6Hj1Gf0A',
    ],
  ];

  for (const [name, body, secret] of secrets) {
    it(`redacts ${name} out of an accepted claim`, () => {
      const result = accept(body);

      expect(result.text).not.toContain(secret);
      expect(result.text).toContain('[REDACTED:');
      // The claim survives — SEC-5 redacts the secret, it does not drop the
      // sentence. Dropping would lose the (cited, true) fact that a rotation
      // happened at all, which is exactly what the reader needs to know.
      expect(result.text.length).toBeGreaterThan(0);
    });
  }

  it('reports the specific kind, not a generic one', () => {
    expect(accept('Ravi pasted AKIAIOSFODNN7EXAMPLE in the thread').redactionKinds).toEqual([
      'aws_access_key',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. PII — email addresses
// ---------------------------------------------------------------------------

describe('SEC-5 — email addresses in model output', () => {
  it('redacts an address while keeping the surrounding claim intact', () => {
    const result = accept('Dr. Sarah Chen asked to be looped in at sarah.chen@acme.example.com');

    expect(result.text).not.toContain('sarah.chen@acme.example.com');
    expect(result.text).toContain('[REDACTED:email]');
    // The PERSON is not the PII. The name must survive the address being cut.
    expect(result.text).toContain('Dr. Sarah Chen');
    expect(result.redactionKinds).toEqual(['email']);
  });

  it('redacts every address in a claim that names several people', () => {
    const result = accept(
      'Escalations go to alex.johnson@acme.example.com and priya.raman@acme.example.com',
    );

    expect(result.text).not.toContain('@acme.example.com');
    expect(result.redactionCount).toBe(2);
    expect(result.text).toContain('Escalations go to');
  });
});

// ---------------------------------------------------------------------------
// 3. PII — phone numbers
// ---------------------------------------------------------------------------

describe('SEC-5 — phone numbers in model output', () => {
  const numbers: Array<[string, string]> = [
    ['parenthesised US', '(555) 123-4567'],
    ['parenthesised US, no space', '(555)123-4567'],
    ['hyphenated US', '555-123-4567'],
    ['dotted US', '555.123.4567'],
    ['US with trunk prefix', '1-800-555-0199'],
    ['spaced international', '+1 555 123 4567'],
    ['international with area parens', '+1 (555) 123-4567'],
    ['UK grouping', '+44 20 7946 0958'],
    ['E.164, unseparated', '+15551234567'],
  ];

  for (const [name, number] of numbers) {
    it(`redacts a ${name} number`, () => {
      const result = accept(`Marcus Webb left the on-call line ${number} in the runbook`);

      expect(result.text).not.toContain(number);
      expect(result.text).toContain('[REDACTED:phone]');
      expect(result.redactionKinds).toEqual(['phone']);
      // Everything that is not the number is untouched.
      expect(result.text).toContain('Marcus Webb left the on-call line');
      expect(result.text).toContain('in the runbook');
    });
  }

  /**
   * The other half of the phone rule: the numbers a briefing is FULL of, which
   * a naive `\d{10}` rule would shred. Each of these is a live regression on the
   * separator/digit-count guards documented in `detectors.ts`.
   */
  const notPhoneNumbers: Array<[string, string]> = [
    ['an ISO date', 'The cutover is scheduled for 2026-08-24 at the latest'],
    ['a timestamped backup name', 'Restored from 2026-08-24T12-30-00-backup-database.sql'],
    ['a UUID order id', 'Order 550e8400-e29b-41d4-a716-446655440000 shipped on Tuesday'],
    ['a semantic version', 'We bumped the client to 12.4.0-rc.1 this morning'],
    ['an IPv4 address', 'The bad host was 192.168.100.14 in the staging VPC'],
    ['a bare numeric id', 'Invoice 1234567890123 is still unpaid'],
    ['a build number', 'Build 4821 went out behind the flag'],
    ['a currency figure', 'The contract came in at 1,250,000 for the year'],
    ['a fiscal year range', 'The 2026-2027 plan lands next quarter'],
    ['a longer digit group chain', 'The tracking chain is 555-123-4567-8901 in the vendor portal'],
  ];

  for (const [name, body] of notPhoneNumbers) {
    it(`does NOT redact ${name}`, () => {
      const result = accept(body);

      expect(result.text).toBe(body);
      expect(result.redactionCount).toBeUndefined();
      expect(result.redactionKinds).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Display names are NOT PII (the over-redaction regression)
// ---------------------------------------------------------------------------

describe('SEC-5 — display names pass through untouched', () => {
  /**
   * Ordinary briefing prose. Not "prose that happens to contain a name" — prose
   * whose entire content IS who did what. If any of these come back changed,
   * the redactor has started deleting the product.
   */
  const prose: string[] = [
    'Alex Johnson approved the migration plan on Tuesday',
    'Dr. Sarah Chen flagged a regression in the intake flow',
    'Priya Raman and Marcus Webb disagreed about the rollout order',
    'Jean-Luc O’Brien asked for the design review to move to Thursday',
    'María José Fernández-Álvarez signed off on the vendor contract',
    'Li Wei handed the on-call rotation to Tomasz Nowak',
    'Sam asked Dana whether the Q3 forecast still holds',
    'Rebecca Ann Whitfield-Stone owns the incident review',
  ];

  for (const sentence of prose) {
    it(`leaves "${sentence}" completely unchanged`, () => {
      const result = accept(sentence);

      // Byte-for-byte. Not `toContain` — a partial match would hide a redactor
      // that ate a hyphenated surname or an apostrophe.
      expect(result.text).toBe(sentence);
      expect(result.text).not.toContain('[REDACTED:');
      expect(result.redactionCount).toBeUndefined();
    });
  }

  it('keeps names in the same claim as a redacted secret', () => {
    const result = accept('Alex Johnson rotated AKIAIOSFODNN7EXAMPLE after the incident');

    expect(result.text).toBe('Alex Johnson rotated [REDACTED:aws_access_key] after the incident');
  });
});

// ---------------------------------------------------------------------------
// 5. Redaction is COUNTED — the observability hook
// ---------------------------------------------------------------------------

describe('SEC-5 — redactions are counted on the gate result', () => {
  /**
   * A redaction is a different event from a DROP. A drop means the model made a
   * claim it could not source; a redaction means the model restated something we
   * had to remove on the way out — a caught leak. A caught leak that is never
   * counted is indistinguishable from no leak at all, which is precisely the
   * signal an operator needs in order to notice that a channel is full of
   * pasted credentials.
   */
  it('exposes a count and the kinds when an accepted claim was redacted', () => {
    const result = accept('Mail bob@example.com or ring (555) 123-4567 about the rotation');

    expect(result.accepted).toBe(true);
    expect(result.redactionCount).toBe(2);
    // Detector order, not match order.
    expect(result.redactionKinds).toEqual(['email', 'phone']);
  });

  it('reports every distinct kind when a claim mixes a secret and PII', () => {
    const result = accept('Ravi sent AKIAIOSFODNN7EXAMPLE to ops@example.com by mistake');

    expect(result.redactionCount).toBe(2);
    expect(result.redactionKinds).toEqual(['aws_access_key', 'email']);
  });

  it('omits the fields entirely on a clean claim', () => {
    const result = accept('Alex Johnson approved the migration plan');

    expect(result).not.toHaveProperty('redactionCount');
    expect(result).not.toHaveProperty('redactionKinds');
  });

  it('never reports a redaction count on a DROP', () => {
    // A dropped claim is redacted too (`droppedClaim` goes to traces), but the
    // count belongs to the accepted-claim signal — a drop is already counted by
    // `reason`, and conflating the two would double-count the same event.
    const dropped = gate.accept('Token is AKIAIOSFODNN7EXAMPLE, no source.', allowed);

    expect(dropped.accepted).toBe(false);
    expect(dropped.redactionCount).toBeUndefined();
    expect(dropped.droppedClaim).toContain('[REDACTED:aws_access_key]');
  });

  it('carries kinds only — never any fragment of the redacted value', () => {
    const result = accept('Reach Sarah at sarah.chen@acme.example.com or (555) 123-4567');
    const serialised = JSON.stringify(result.redactionKinds);

    expect(serialised).not.toContain('sarah');
    expect(serialised).not.toContain('555');
    expect(serialised).not.toContain('acme');
  });
});

// ---------------------------------------------------------------------------
// 6. Determinism — the property the dual-call design rests on
// ---------------------------------------------------------------------------

describe('SEC-5 — the scan is deterministic', () => {
  const claim = `Ravi mailed AKIAIOSFODNN7EXAMPLE to ops@example.com, call (555) 123-4567 ${MARKER1}`;

  it('produces identical results across repeated calls on the same claim', () => {
    // The generator gates every claim twice (streaming path + persistence path).
    // If `redactOutput` carried state — a stray regex `lastIndex`, a cache — the
    // second call could differ, and the renderer would show text the database
    // does not hold. Ten calls, not two, so a `lastIndex` bug that only shows on
    // an odd/even alternation cannot hide.
    const results = Array.from({ length: 10 }, () => gate.accept(claim, allowed));
    const first = results[0];

    for (const result of results) expect(result).toEqual(first);
  });

  it('is idempotent — re-scanning already-redacted text changes nothing', () => {
    const once = accept('Mail bob@example.com or ring (555) 123-4567');
    const twice = gate.accept(`${once.text} ${MARKER1}`, allowed);

    expect(twice.text).toBe(once.text);
    // Nothing left to find, so no second count is reported.
    expect(twice.redactionCount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. End-to-end: before persistence AND before delivery
// ---------------------------------------------------------------------------

/** Scripted streaming client; mirrors `generate.test.ts`'s double. */
class StubOllama implements OllamaClient {
  tokens: string[] = [];

  generateStream(_options: GenerateStreamOptions): AsyncIterable<string> {
    const stub = this;
    async function* iterate(): AsyncGenerator<string, void, undefined> {
      for (const token of stub.tokens) {
        await Promise.resolve();
        yield token;
      }
    }
    return iterate();
  }

  generateJson<T>(): Promise<T> {
    throw new Error('StubOllama: generateJson is not used by Layer 3');
  }

  embed(): Promise<number[][]> {
    throw new Error('StubOllama: embed is not used by Layer 3');
  }
}

class StubRetrieval implements BriefingRetriever {
  chunks: RetrievedChunk[] = [];

  forBriefing(_window: RetrievalWindow): Promise<RetrievalResult> {
    return Promise.resolve({ chunks: this.chunks, partial: false });
  }
}

const makeConfig = (): AppConfig =>
  ({
    budgets: { retrievalMs: 5_000, assemblyMs: 2_000, generationMs: 30_000, citationMs: 2_000 },
    ranking: { wStakes: 3, wPendingOnMe: 5, wSelfParticipation: 2, wRecency: 1 },
  }) as unknown as AppConfig;

describe('SEC-5 — end to end through BriefingGenerator', () => {
  const SECRET = 'AKIAIOSFODNN7EXAMPLE';
  const EMAIL = 'sarah.chen@acme.example.com';
  const PHONE = '(555) 123-4567';

  const TOKENS = [
    '## What moved\n',
    `- Ravi pasted ${SECRET} into the deploy channel [artifact:${A1}]\n`,
    `- Dr. Sarah Chen asked to be reached at ${EMAIL} [artifact:${A2}]\n`,
    `- Marcus Webb left the on-call line ${PHONE} in the runbook [artifact:${A1}]\n`,
    `- Alex Johnson approved the migration plan on Tuesday [artifact:${A2}]\n`,
  ];

  async function run(): Promise<{
    chunks: AcceptedClaimChunk[];
    stored: string[];
    narrative: string;
  }> {
    const ollama = new StubOllama();
    ollama.tokens = TOKENS;

    const retrieval = new StubRetrieval();
    retrieval.chunks = [A1, A2].map((artifactId, i) => ({
      artifactId,
      eventId: `e-${i + 1}`,
      threadKey: `C${i + 1}:1`,
      occurredAt: NOW - 60_000,
      text: 'Context for the window.',
      score: 0.9,
    }));

    const briefings = new BriefingsRepo(db);
    const generator = new BriefingGenerator(
      ollama,
      retrieval,
      new DeltasRepo(db),
      briefings,
      gate,
      new WatermarkRepo(db),
      graph,
      new PendingItemsRepo(db),
      new AiCallsRepo(db),
      makeConfig(),
      tmp,
      MODEL,
      PROMPT_VERSION,
      new FakeClock(NOW),
      { logsDir: join(tmp, 'logs') },
    );

    const chunks: AcceptedClaimChunk[] = [];
    const result = await generator.generate(WINDOW, {
      onClaimAccepted: (chunk) => chunks.push(chunk),
    });

    return {
      chunks,
      stored: briefings.listClaims(result.briefingId).map((claim) => claim.text),
      narrative: readFileSync(result.narrativePath, 'utf8'),
    };
  }

  it('never writes a secret, an address or a number to briefing_claims', async () => {
    const { stored } = await run();

    expect(stored).toHaveLength(4);
    const joined = stored.join('\n');
    for (const leak of [SECRET, EMAIL, PHONE]) expect(joined).not.toContain(leak);
    expect(joined).toContain('[REDACTED:aws_access_key]');
    expect(joined).toContain('[REDACTED:email]');
    expect(joined).toContain('[REDACTED:phone]');
  });

  it('never streams a secret, an address or a number to the renderer', async () => {
    // These are the `briefing:chunk` payloads: what the UI paints, live, before
    // anything has been persisted.
    const { chunks } = await run();

    expect(chunks).toHaveLength(4);
    const joined = chunks.map((chunk) => chunk.text).join('\n');
    for (const leak of [SECRET, EMAIL, PHONE]) expect(joined).not.toContain(leak);
  });

  it('streams and persists byte-identical text despite gating each claim twice', async () => {
    // The claim-order guarantee differs between the two paths (streamed claims
    // arrive in model order, persisted claims are sorted into section order), so
    // the comparison is set-wise. Both sets come from separate `accept()` calls
    // on the same input; identical content is the determinism property the
    // dual-call design depends on.
    const { chunks, stored } = await run();

    expect([...chunks.map((chunk) => chunk.text)].sort()).toEqual([...stored].sort());
  });

  it('keeps the narrative markdown free of the same values', async () => {
    // The markdown file is a third consumer of the gate's `text`, and it is
    // written to disk outside the database, so it is checked explicitly.
    const { narrative } = await run();

    for (const leak of [SECRET, EMAIL, PHONE]) expect(narrative).not.toContain(leak);
    expect(narrative).toContain('[REDACTED:');
  });

  it('leaves the claim that contained nothing sensitive fully intact', async () => {
    const { stored } = await run();

    // The over-redaction regression, asserted on what is actually on disk.
    expect(stored).toContain('Alex Johnson approved the migration plan on Tuesday');
  });
});
