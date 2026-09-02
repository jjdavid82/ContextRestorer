import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { loadConfig } from '../src/config.js';

// Resolve the repo-root config regardless of vitest's cwd: this file lives at
// <repoRoot>/packages/core/test/, so three levels up is the repo root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const configPath = join(repoRoot, 'config/default.json');

describe('config/default.json', () => {
  it('is a valid shipped config', () => {
    expect(() => loadConfig(configPath)).not.toThrow();

    const cfg = loadConfig(configPath);
    expect(cfg.model.chat).toBe('qwen2.5:7b');
    expect(cfg.model.ollamaBaseUrl).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):11434$/);
    expect(cfg.debounce.slack.hardCapMs).toBeGreaterThan(cfg.debounce.slack.quietWindowMs);
    expect(cfg.debounce.gmail.hardCapMs).toBeGreaterThan(cfg.debounce.gmail.quietWindowMs);
    expect(cfg.onboarding.minDeclaredProjects).toBeGreaterThanOrEqual(0);
  });
});
