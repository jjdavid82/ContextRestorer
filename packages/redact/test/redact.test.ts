import { describe, it, expect } from 'vitest';
import { redact, redactOutput } from '../src/index.js';

const cases: Array<[string, string, string]> = [
  ['aws_access_key', 'key is AKIAIOSFODNN7EXAMPLE ok',        '[REDACTED:aws_access_key]'],
  ['aws_secret',     'secret=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', '[REDACTED:aws_secret]'],
  ['private_key',    '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----', '[REDACTED:private_key]'],
  ['jwt',            'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123', '[REDACTED:jwt]'],
  ['slack_token',    'xoxb-1234567890-ABCDEFGHIJKLMNOP',       '[REDACTED:slack_token]'],
  ['github_pat',     'ghp_16C7e42F292c6912E7710c838347Ae178B4a', '[REDACTED:github_pat]'],
  ['assignment',     'password = hunter2correct',                '[REDACTED:credential]'],
  ['high_entropy',   'token: 9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a', '[REDACTED:high_entropy]'],
];

describe('redact', () => {
  for (const [name, input, placeholder] of cases) {
    it(`redacts ${name}`, () => {
      const r = redact(input);
      expect(r.text).toContain(placeholder);
      expect(r.count).toBeGreaterThan(0);
      const secret = input.match(/[A-Za-z0-9\/+_-]{16,}/g)?.at(-1);
      if (secret) expect(r.text).not.toContain(secret);
    });
  }

  it('leaves ordinary prose untouched and reports count 0', () => {
    const r = redact('Can you review the migration plan before Thursday?');
    expect(r.count).toBe(0);
    expect(r.text).toBe('Can you review the migration plan before Thursday?');
  });

  it('does not redact a normal English sentence as high-entropy', () => {
    expect(redact('The quick brown fox jumped over the lazy dog').count).toBe(0);
  });

  it('is idempotent — redacting twice does not double-wrap', () => {
    const once = redact('key is AKIAIOSFODNN7EXAMPLE').text;
    expect(redact(once).text).toBe(once);
  });
});

/**
 * The false-positive guards matter as much as the true positives: an over-eager
 * high-entropy rule that eats ordinary prose silently degrades every downstream
 * extraction, and it presents as a model-quality problem rather than as a
 * redaction bug. Every string below sits in the same 3.7-4.0 bits/char band as
 * a real hex digest, so each one is a live test of the structural pre-filters.
 */
describe('redact — false positives', () => {
  const benign: Array<[string, string]> = [
    ['a long hyphenated URL slug', 'see https://blog.example.com/how-we-migrated-our-database-to-postgres'],
    ['a long camelCase identifier and a file path', 'see getUserAccountBalanceById in src/components/dashboard/RevenueChart.tsx'],
    ['a UUID used as a business id', 'order 550e8400-e29b-41d4-a716-446655440000 shipped on Tuesday'],
    ['a timestamped backup filename', 'restored from 2026-08-24T12-30-00-backup-database.sql'],
    ['a git branch name', 'branch feature/add-user-preferences-panel is ready for review'],
    ['a long single English word', 'the internationalization work is nearly done'],
    ['a semantic version and package name', 'bumped @cr/observability to 12.4.0-rc.1 this morning'],
  ];

  for (const [name, input] of benign) {
    it(`leaves ${name} untouched`, () => {
      const r = redact(input);
      expect(r.text).toBe(input);
      expect(r.count).toBe(0);
      expect(r.kinds).toEqual([]);
    });
  }
});

describe('redact — kinds and counts', () => {
  it('tags a structured token with its specific kind, not high_entropy', () => {
    // AKIAIOSFODNN7EXAMPLE would also satisfy the generic entropy rule; detector
    // order is what guarantees the specific kind wins.
    expect(redact('key is AKIAIOSFODNN7EXAMPLE').kinds).toEqual(['aws_access_key']);
    expect(redact('ghp_16C7e42F292c6912E7710c838347Ae178B4a').kinds).toEqual(['github_pat']);
  });

  it('reports every distinct kind and counts each secret once', () => {
    const r = redact('key AKIAIOSFODNN7EXAMPLE and token xoxb-1234567890-ABCDEFGHIJKLMNOP');
    expect(r.count).toBe(2);
    expect(r.kinds).toEqual(['aws_access_key', 'slack_token']);
  });

  it('keeps the key name of an assignment and redacts only the value', () => {
    expect(redact('password = hunter2correct').text).toBe('password = [REDACTED:credential]');
    expect(redact('secret=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY').text).toBe(
      'secret=[REDACTED:aws_secret]',
    );
  });

  it('redacts a whole PEM block as a single match', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF0qwWWt7bQnRmVOtEXAMPLEKEYDATA',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const r = redact(`here it is:\n${pem}\nthanks`);
    expect(r.count).toBe(1);
    expect(r.kinds).toEqual(['private_key']);
    expect(r.text).toBe('here it is:\n[REDACTED:private_key]\nthanks');
  });

  it('catches an unlabelled random token via the entropy fallback', () => {
    const r = redact('upload token Xy7Qz4Vb9Lm2Np5Rt8Ws3Kd6Hj1Gf0A');
    expect(r.kinds).toEqual(['high_entropy']);
    expect(r.text).not.toContain('Xy7Qz4Vb9Lm2Np5Rt8Ws3Kd6Hj1Gf0A');
  });

  it('is idempotent across every case, including assignments', () => {
    for (const [, input] of cases) {
      const once = redact(input).text;
      const twice = redact(once);
      expect(twice.text).toBe(once);
      expect(twice.count).toBe(0);
    }
  });
});

describe('redactOutput', () => {
  it('redacts email addresses (SEC-5 PII)', () => {
    const r = redactOutput('contact bob@example.com');
    expect(r.text).toContain('[REDACTED:email]');
    expect(r.text).not.toContain('bob@example.com');
    expect(r.count).toBe(1);
    expect(r.kinds).toEqual(['email']);
  });

  it('still applies every input-side detector', () => {
    const r = redactOutput('mail alice@example.com the key AKIAIOSFODNN7EXAMPLE');
    expect(r.count).toBe(2);
    expect(r.kinds).toEqual(['aws_access_key', 'email']);
    expect(r.text).toBe('mail [REDACTED:email] the key [REDACTED:aws_access_key]');
  });

  it('leaves prose without PII untouched', () => {
    const input = 'Can you review the migration plan before Thursday?';
    expect(redactOutput(input)).toEqual({ text: input, count: 0, kinds: [] });
  });

  it('is idempotent', () => {
    const once = redactOutput('contact bob@example.com').text;
    expect(redactOutput(once).text).toBe(once);
  });
});

/**
 * SEC-5 phone numbers. The detector is documented in `detectors.ts` as trading
 * recall for precision: it requires SEPARATORS or an explicit `+`, because a
 * bare digit run is indistinguishable from an order id. Both halves of that
 * trade are tested — the shapes it must catch, and the far more common numeric
 * shapes it must leave alone.
 */
describe('redactOutput — phone numbers', () => {
  const numbers: Array<[string, string]> = [
    ['parenthesised US', '(555) 123-4567'],
    ['parenthesised US without a space', '(555)123-4567'],
    ['hyphenated US', '555-123-4567'],
    ['dotted US', '555.123.4567'],
    ['space-separated US', '555 123 4567'],
    ['US with a trunk prefix', '1-800-555-0199'],
    ['spaced international', '+1 555 123 4567'],
    ['international with parenthesised area code', '+1 (555) 123-4567'],
    ['UK grouping', '+44 20 7946 0958'],
    ['German grouping', '+49 30 901820'],
    ['E.164 with no separators', '+15551234567'],
  ];

  for (const [name, number] of numbers) {
    it(`redacts a ${name} number`, () => {
      const r = redactOutput(`call me on ${number} tomorrow`);

      expect(r.text).toBe('call me on [REDACTED:phone] tomorrow');
      expect(r.count).toBe(1);
      expect(r.kinds).toEqual(['phone']);
    });
  }

  it('redacts each of several numbers in one string', () => {
    const r = redactOutput('desk 555-123-4567, mobile +44 20 7946 0958');
    expect(r.count).toBe(2);
    expect(r.text).toBe('desk [REDACTED:phone], mobile [REDACTED:phone]');
  });

  it('is idempotent', () => {
    const once = redactOutput('call 555-123-4567').text;
    expect(redactOutput(once).text).toBe(once);
  });

  it('does not fire on the input-side pass', () => {
    // Phone numbers are PII, not secrets: SEC-4 keeps them so that Layer 1/2 can
    // still reason over the raw thread. Only the output pass strips them.
    expect(redact('call 555-123-4567').count).toBe(0);
  });
});

/**
 * The numeric shapes a briefing is genuinely full of. Every one of these would
 * be destroyed by a naive ten-digit rule, and each failure would present as a
 * content bug rather than a redaction bug.
 */
describe('redactOutput — phone false positives', () => {
  const benign: Array<[string, string]> = [
    ['an ISO date', 'the cutover is on 2026-08-24'],
    ['an ISO timestamp in a filename', 'restored from 2026-08-24T12-30-00-backup-database.sql'],
    ['a UUID', 'order 550e8400-e29b-41d4-a716-446655440000 shipped'],
    ['a semantic version', 'bumped the client to 12.4.0-rc.1'],
    ['an IPv4 address', 'the bad host was 192.168.100.14'],
    ['a bare 13-digit id', 'invoice 1234567890123 is unpaid'],
    ['a bare 10-digit id', 'order 5551234567 shipped'],
    ['a short build number', 'build 4821 went out'],
    ['a formatted currency figure', 'the contract came in at 1,250,000'],
    ['a fiscal year range', 'the 2026-2027 plan lands next quarter'],
    ['a five-group tracking id', 'chain 555-123-4567-8901 in the portal'],
    ['a port range', 'opened 8080-8090 on the staging box'],
    ['a signed metric', 'throughput moved +12 percent this week'],
    ['a date range', 'the freeze runs 08-24 to 09-02'],
  ];

  for (const [name, input] of benign) {
    it(`leaves ${name} untouched`, () => {
      const r = redactOutput(input);
      expect(r.text).toBe(input);
      expect(r.count).toBe(0);
      expect(r.kinds).toEqual([]);
    });
  }

  it('does not redact a plain human name', () => {
    // Names are the substance of a briefing. `redactOutput` handles CONTACT
    // IDENTIFIERS, never people.
    const input = 'Dr. Sarah Chen and Alex Johnson approved the plan';
    expect(redactOutput(input)).toEqual({ text: input, count: 0, kinds: [] });
  });
});
