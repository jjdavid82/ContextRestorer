/**
 * `AppSettingsRepo` — generic key/value persistence for user-facing settings
 * that live outside `config/default.json` (currently: the chat-model
 * override behind `model:setChat`).
 *
 * Run against a real `openDb(':memory:')` + `migrate`, like every other repo
 * test in this package — `app_settings` ships with migration 005, so a
 * failure here is either the repo's SQL or a schema drift.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb, migrate } from '../src/index.js';
import { AppSettingsRepo } from '../src/repos/appSettings.js';

let db: Database;
let repo: AppSettingsRepo;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  repo = new AppSettingsRepo(db);
});

afterEach(() => {
  db.close();
});

describe('AppSettingsRepo', () => {
  it('reports null for a key that was never set', () => {
    expect(repo.get('model.chat')).toBeNull();
  });

  it('set then get round-trips the value', () => {
    repo.set('model.chat', 'qwen2.5:3b');
    expect(repo.get('model.chat')).toBe('qwen2.5:3b');
  });

  it('a second set REPLACES the value rather than erroring or duplicating', () => {
    repo.set('model.chat', 'qwen2.5:3b');
    repo.set('model.chat', 'qwen2.5:14b');

    expect(repo.get('model.chat')).toBe('qwen2.5:14b');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM app_settings`).get()).toEqual({ n: 1 });
  });

  it('keys are independent of one another', () => {
    repo.set('model.chat', 'qwen2.5:3b');
    repo.set('some.other.key', 'x');

    expect(repo.get('model.chat')).toBe('qwen2.5:3b');
    expect(repo.get('some.other.key')).toBe('x');
    expect(repo.get('never.set')).toBeNull();
  });
});
