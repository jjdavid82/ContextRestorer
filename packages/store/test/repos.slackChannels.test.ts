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
import { GraphRepo } from '../src/repos/graph.js';

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
      { channelId: 'C1', name: 'general', addedAt: 1_000, projectId: null },
      { channelId: 'C2', name: 'random', addedAt: 1_000, projectId: null },
    ]);
  });

  it('replaces the whole selection on a second call — a de-selected channel disappears', () => {
    repo.setSelected([{ channelId: 'C1', name: 'general' }], 1_000);
    repo.setSelected([{ channelId: 'C2', name: 'random' }], 2_000);

    expect(repo.list()).toEqual([{ channelId: 'C2', name: 'random', addedAt: 2_000, projectId: null }]);
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
      { channelId: 'C1', name: 'general-renamed', addedAt: 1_000, projectId: null },
    ]);
  });

  it('setSelected([]) clears every selection', () => {
    repo.setSelected([{ channelId: 'C1', name: 'general' }], 1_000);
    repo.setSelected([], 2_000);

    expect(repo.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A-2 — channel → project tagging (FR-5 / FR-8, migration 006)
// ---------------------------------------------------------------------------

describe('SlackChannelsRepo project tagging', () => {
  /** A declared project the FK can point at. */
  function declareProject(name: string): string {
    return new GraphRepo(db).declareProject({ name, origin: 'declared', stakesWeight: 2 })
      .projectId;
  }

  it('round-trips an explicit tag', () => {
    const projectId = declareProject('Migration');
    repo.setSelected([{ channelId: 'C1', name: 'general', projectId }], 1_000);

    expect(repo.list()).toEqual([
      { channelId: 'C1', name: 'general', addedAt: 1_000, projectId },
    ]);
  });

  it('preserves the tag across a re-save that omits projectId', () => {
    const projectId = declareProject('Migration');
    repo.setSelected([{ channelId: 'C1', name: 'general', projectId }], 1_000);

    // The channel-checkbox save path sends no `projectId` at all. Toggling an
    // unrelated checkbox must not silently wipe every tag the user set.
    repo.setSelected(
      [
        { channelId: 'C1', name: 'general' },
        { channelId: 'C2', name: 'random' },
      ],
      2_000,
    );

    const byId = new Map(repo.list().map((c) => [c.channelId, c.projectId]));
    expect(byId.get('C1')).toBe(projectId);
    expect(byId.get('C2')).toBeNull();
  });

  it('clears the tag only on an explicit null', () => {
    const projectId = declareProject('Migration');
    repo.setSelected([{ channelId: 'C1', name: 'general', projectId }], 1_000);
    repo.setSelected([{ channelId: 'C1', name: 'general', projectId: null }], 2_000);

    expect(repo.list()[0]?.projectId).toBeNull();
  });

  it('setProject tags and untags one channel', () => {
    const projectId = declareProject('Migration');
    repo.setSelected([{ channelId: 'C1', name: 'general' }], 1_000);

    repo.setProject('C1', projectId);
    expect(repo.list()[0]?.projectId).toBe(projectId);

    repo.setProject('C1', null);
    expect(repo.list()[0]?.projectId).toBeNull();
  });

  it('drops the tag when the project is deleted, keeping the channel selected', () => {
    const projectId = declareProject('Migration');
    repo.setSelected([{ channelId: 'C1', name: 'general', projectId }], 1_000);

    db.prepare(`DELETE FROM projects WHERE project_id = ?`).run(projectId);

    // ON DELETE SET NULL, not CASCADE: losing a project must not silently stop
    // the poller fetching from a channel the user selected.
    expect(repo.list()).toEqual([
      { channelId: 'C1', name: 'general', addedAt: 1_000, projectId: null },
    ]);
  });
});
