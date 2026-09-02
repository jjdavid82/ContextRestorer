/**
 * `SlackChannelsRepo` — the Slack channel selector's persistence (closes Task
 * 1.7's gap: `VaultBackedSlackClient` reads `list()` once per poll cycle).
 *
 * Run against a real `openDb(':memory:')` + `migrate`, like every other repo
 * test in this package — `slack_selected_channels` ships with migration 004,
 * so a failure here is either the repo's SQL or a schema drift.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb, migrate } from '../src/index.js';
import { SlackChannelsRepo } from '../src/repos/slackChannels.js';

let db: Database;
let repo: SlackChannelsRepo;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  repo = new SlackChannelsRepo(db);
});

afterEach(() => {
  db.close();
});

describe('SlackChannelsRepo', () => {
  it('starts empty', () => {
    expect(repo.list()).toEqual([]);
  });

  it('setSelected persists the given channels, ordered by addedAt then id', () => {
    // Same addedAt for both, so `list()`'s tiebreak (channel_id ASC) is what
    // determines order here — insertion order is not the contract.
    repo.setSelected(
      [
        { channelId: 'C2', name: 'random' },
        { channelId: 'C1', name: 'general' },
      ],
      1_000,
    );

    expect(repo.list()).toEqual([
      { channelId: 'C1', name: 'general', addedAt: 1_000 },
      { channelId: 'C2', name: 'random', addedAt: 1_000 },
    ]);
  });

  it('replaces the whole selection on a second call — a de-selected channel disappears', () => {
    repo.setSelected([{ channelId: 'C1', name: 'general' }], 1_000);
    repo.setSelected([{ channelId: 'C2', name: 'random' }], 2_000);

    expect(repo.list()).toEqual([{ channelId: 'C2', name: 'random', addedAt: 2_000 }]);
  });

  it('preserves the original addedAt for a channel that stays selected across a re-save', () => {
    repo.setSelected([{ channelId: 'C1', name: 'general' }], 1_000);
    // Re-saved later alongside a new channel — C1's addedAt must NOT jump to 2_000,
    // or the settings UI's "added order" would reshuffle on every unrelated edit.
    repo.setSelected(
      [
        { channelId: 'C1', name: 'general' },
        { channelId: 'C2', name: 'random' },
      ],
      2_000,
    );

    const byId = new Map(repo.list().map((c) => [c.channelId, c.addedAt]));
    expect(byId.get('C1')).toBe(1_000);
    expect(byId.get('C2')).toBe(2_000);
  });

  it('picks up a renamed channel on the next save', () => {
    repo.setSelected([{ channelId: 'C1', name: 'general' }], 1_000);
    repo.setSelected([{ channelId: 'C1', name: 'general-renamed' }], 2_000);

    expect(repo.list()).toEqual([
      { channelId: 'C1', name: 'general-renamed', addedAt: 1_000 },
    ]);
  });

  it('setSelected([]) clears every selection', () => {
    repo.setSelected([{ channelId: 'C1', name: 'general' }], 1_000);
    repo.setSelected([], 2_000);

    expect(repo.list()).toEqual([]);
  });
});
