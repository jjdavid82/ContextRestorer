import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '../src/config.js';

/** A known-good config; each test clones and mutates one field to isolate a rule. */
const validConfig: AppConfig = {
  model: {
    chat: 'qwen2.5:14b-instruct',
    embed: 'nomic-embed-text',
    ollamaBaseUrl: 'http://localhost:11434',
  },
  promptVersions: { layer1: 'l1-v1', layer2: 'l2-v1', layer3: 'l3-v1' },
  debounce: {
    slack: { quietWindowMs: 90_000, hardCapMs: 600_000 },
    gmail: { quietWindowMs: 120_000, hardCapMs: 900_000 },
  },
  polling: {
    slack: { intervalMs: 30_000, maxBackoffMs: 300_000 },
    gmail: { intervalMs: 60_000, maxBackoffMs: 600_000 },
  },
  retrieval: { topK: 24, budgetMs: 1_500 },
  ranking: { wStakes: 0.4, wPendingOnMe: 0.3, wSelfParticipation: 0.2, wRecency: 0.1 },
  budgets: { retrievalMs: 1_500, assemblyMs: 500, generationMs: 20_000, citationMs: 500 },
  retention: { rawEventDays: 30 },
  onboarding: { minDeclaredProjects: 3 },
  briefing: { maxChangedItems: 7, groundingMode: 'observe' as const },
};

const clone = (): AppConfig => structuredClone(validConfig);

let dir: string;

/** Serialize `cfg` to a temp file and return its path, so loadConfig reads real JSON. */
function writeConfig(cfg: unknown): string {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(cfg), 'utf8');
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cr-core-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('loads a valid config and returns the parsed object', () => {
    const cfg = loadConfig(writeConfig(validConfig));
    expect(cfg).toEqual(validConfig);
    expect(cfg.debounce.slack.quietWindowMs).toBe(90_000);
    expect(cfg.ranking.wStakes).toBe(0.4);
  });

  it('throws when model.chat is missing', () => {
    const cfg = clone();
    // @ts-expect-error deliberately invalid shape for the validation path
    delete cfg.model.chat;
    expect(() => loadConfig(writeConfig(cfg))).toThrow(/model\.chat is required/);
  });

  // SEC-6: config must not be able to redirect inference to a remote endpoint.
  it('throws for a non-localhost ollamaBaseUrl', () => {
    const cfg = clone();
    cfg.model.ollamaBaseUrl = 'https://api.example.com';
    expect(() => loadConfig(writeConfig(cfg))).toThrow(/ollamaBaseUrl must be localhost/);
  });

  it('accepts the 127.0.0.1 loopback form', () => {
    const cfg = clone();
    cfg.model.ollamaBaseUrl = 'http://127.0.0.1:11434';
    expect(loadConfig(writeConfig(cfg)).model.ollamaBaseUrl).toBe('http://127.0.0.1:11434');
  });

  // D-7: a hard cap at or below the quiet window could never fire after it.
  it('throws when hardCapMs <= quietWindowMs', () => {
    const cfg = clone();
    cfg.debounce.slack.hardCapMs = cfg.debounce.slack.quietWindowMs;
    expect(() => loadConfig(writeConfig(cfg)))
      .toThrow(/debounce\.slack\.hardCapMs must exceed quietWindowMs/);
  });

  it('throws when hardCapMs is strictly below quietWindowMs', () => {
    const cfg = clone();
    cfg.debounce.gmail.hardCapMs = 1_000;
    expect(() => loadConfig(writeConfig(cfg)))
      .toThrow(/debounce\.gmail\.hardCapMs must exceed quietWindowMs/);
  });

  it.each(['slack', 'gmail'] as const)('throws when debounce.%s is missing', (source) => {
    const cfg = clone();
    delete (cfg.debounce as Partial<AppConfig['debounce']>)[source];
    expect(() => loadConfig(writeConfig(cfg))).toThrow(
      new RegExp(`debounce\\.${source} is required`),
    );
  });

  // OI-3 relaxed: declared-project stakes have no ranking effect yet (nothing
  // creates the `belongs_to` edge `wStakes` reads), so 0 is now a valid floor.
  it('accepts minDeclaredProjects of 0', () => {
    const cfg = clone();
    cfg.onboarding.minDeclaredProjects = 0;
    expect(loadConfig(writeConfig(cfg)).onboarding.minDeclaredProjects).toBe(0);
  });

  it('throws when onboarding.minDeclaredProjects is negative', () => {
    const cfg = clone();
    cfg.onboarding.minDeclaredProjects = -1;
    expect(() => loadConfig(writeConfig(cfg)))
      .toThrow(/minDeclaredProjects must be a non-negative integer/);
  });

  it('throws when onboarding.minDeclaredProjects is not an integer', () => {
    const cfg = clone();
    cfg.onboarding.minDeclaredProjects = 1.5;
    expect(() => loadConfig(writeConfig(cfg)))
      .toThrow(/minDeclaredProjects must be a non-negative integer/);
  });

  // A missing section must surface as a config error, not a TypeError from
  // dereferencing `undefined` — same contract as the `debounce.%s` case above.
  it('throws a config error when onboarding is missing entirely', () => {
    const cfg = clone();
    delete (cfg as Partial<AppConfig>).onboarding;
    expect(() => loadConfig(writeConfig(cfg))).toThrow(/onboarding is required/);
  });

  it('accepts minDeclaredProjects above the floor', () => {
    const cfg = clone();
    cfg.onboarding.minDeclaredProjects = 5;
    expect(loadConfig(writeConfig(cfg)).onboarding.minDeclaredProjects).toBe(5);
  });

  // Real OAuth client secrets must never sit in a tracked config file (they
  // did, once — a since-rotated Slack/Gmail client secret shipped in
  // `config/default.json`'s initial commit). This is the mechanism that
  // replaces that: a gitignored `<name>.local.json` sibling, merged in.
  describe('local override (config/*.local.json)', () => {
    it('merges oauth from a sibling .local.json file when present', () => {
      const path = writeConfig(validConfig);
      writeFileSync(
        path.replace(/\.json$/, '.local.json'),
        JSON.stringify({ oauth: { slack: { clientId: 'S1', clientSecret: 'secret1' } } }),
        'utf8',
      );

      const cfg = loadConfig(path);
      expect(cfg.oauth?.slack).toEqual({ clientId: 'S1', clientSecret: 'secret1' });
      // Everything else from the base file is untouched.
      expect(cfg.model.chat).toBe(validConfig.model.chat);
    });

    it('is a no-op when no .local.json sibling exists', () => {
      const cfg = loadConfig(writeConfig(validConfig));
      expect(cfg.oauth).toBeUndefined();
    });

    it('a local override cannot introduce an invalid config (still validated)', () => {
      const path = writeConfig(validConfig);
      writeFileSync(
        path.replace(/\.json$/, '.local.json'),
        JSON.stringify({ model: { ollamaBaseUrl: 'https://not-local.example.com' } }),
        'utf8',
      );

      expect(() => loadConfig(path)).toThrow(/ollamaBaseUrl must be localhost/);
    });
  });
});
