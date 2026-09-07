import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { loadConfig } from '../src/config.js';

// Resolve the repo-root config regardless of vitest's cwd: this file lives at
// <repoRoot>/packages/core/test/, so three levels up is the repo root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const shippedPath = join(repoRoot, 'config/default.json');

/**
 * `loadConfig` deep-merges a sibling `default.local.json` when one exists, and
 * that file is a per-developer, gitignored override (a real OAuth client id, a
 * smaller chat model for a slow machine). This test is about the file the repo
 * SHIPS, so it must not be able to see that override — otherwise it asserts
 * whatever the developer running it happens to have configured, and fails on
 * their machine for a reason that has nothing to do with the shipped config.
 *
 * Loading a copy from an empty temp directory is the least invasive way to get
 * a merge-free read: no `.local.json` sibling exists there, so the loader's own
 * `existsSync` guard skips the merge and every other behaviour (parse,
 * `assertValid`) is exercised exactly as in production.
 */
let scratch: string;
let configPath: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cr-shipped-config-'));
  configPath = join(scratch, 'default.json');
  copyFileSync(shippedPath, configPath);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('config/default.json', () => {
  it('is a valid shipped config', () => {
    expect(() => loadConfig(configPath)).not.toThrow();

    const cfg = loadConfig(configPath);
    // Reverted from 7b on 2026-09-03: the n=9 eval measured hallucination at
    // 43.5% vs 23.6% on 14b and citation accuracy 20 points lower, while the
    // bench showed 7b failing AC-1 by 6x regardless — so the smaller model cost
    // accuracy and bought nothing.
    expect(cfg.model.chat).toBe('qwen2.5:14b');
    expect(cfg.model.ollamaBaseUrl).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):11434$/);
    expect(cfg.debounce.slack.hardCapMs).toBeGreaterThan(cfg.debounce.slack.quietWindowMs);
    expect(cfg.debounce.gmail.hardCapMs).toBeGreaterThan(cfg.debounce.gmail.quietWindowMs);
    expect(cfg.onboarding.minDeclaredProjects).toBeGreaterThanOrEqual(0);
  });
});
