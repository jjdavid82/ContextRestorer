/**
 * `projectLinks.ts` — the channel → project → artifact write path (A-2).
 *
 * Run against a real database rather than a graph double: the whole point of
 * this module is that `belongs_to` edges actually exist in `relationships`
 * afterwards, because that is the only thing `@cr/ai`'s `toRankableDelta` and
 * `RetrievalService.stakesWeightFor` ever look at. A stubbed graph would assert
 * that the module calls `relate()`, which is not the same claim.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb, migrate } from '../src/index.js';
import { GraphRepo } from '../src/repos/graph.js';
import type { SelectedSlackChannel } from '../src/repos/slackChannels.js';
import {
  PROJECT_REL,
  rebuildProjectLinks,
  SlackChannelProjectResolver,
} from '../src/projectLinks.js';

let db: Database;
let graph: GraphRepo;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  graph = new GraphRepo(db);
});

afterEach(() => {
  db.close();
});

/** A Slack thread artifact, shaped exactly as `artifactFor` builds one. */
function seedThread(channelId: string, ts: string): string {
  const artifactId = `slack:thread:${channelId}:${ts}`;
  graph.upsertArtifact({
    artifactId,
    source: 'slack',
    kind: 'thread',
    externalRef: `${channelId}:${ts}`,
    title: null,
    state: null,
    ownerId: null,
    firstSeenAt: 1_000,
    lastSeenAt: 1_000,
  });
  return artifactId;
}

function channel(channelId: string, projectId: string | null): SelectedSlackChannel {
  return { channelId, name: channelId, addedAt: 1_000, projectId };
}

function declare(name: string): string {
  return graph.declareProject({ name, origin: 'declared', stakesWeight: 2 }).projectId;
}

describe('rebuildProjectLinks', () => {
  it('links every already-ingested thread in a tagged channel', () => {
    const projectId = declare('Migration');
    const a = seedThread('C1', '100.1');
    const b = seedThread('C1', '200.2');
    seedThread('C2', '300.3'); // untagged channel

    const summary = rebuildProjectLinks([channel('C1', projectId), channel('C2', null)], graph);

    // Backfill is the point: tagging a channel must affect threads already on
    // disk, not only ones that arrive afterwards.
    expect(summary).toEqual({ linked: 2, unlinked: 0, taggedChannels: 1 });
    expect(graph.relatedIds(a, PROJECT_REL)).toEqual([projectId]);
    expect(graph.relatedIds(b, PROJECT_REL)).toEqual([projectId]);
  });

  it('leaves threads in untagged channels with no edges', () => {
    const artifactId = seedThread('C2', '300.3');

    rebuildProjectLinks([channel('C2', null)], graph);

    expect(graph.relatedIds(artifactId, PROJECT_REL)).toEqual([]);
  });

  it('is idempotent — a second run changes nothing', () => {
    const projectId = declare('Migration');
    seedThread('C1', '100.1');

    rebuildProjectLinks([channel('C1', projectId)], graph);
    const second = rebuildProjectLinks([channel('C1', projectId)], graph);

    // Safe to run on every settings save and every app start.
    expect(second).toEqual({ linked: 0, unlinked: 0, taggedChannels: 1 });
  });

  it('MOVES the edge when a channel is re-tagged, rather than adding a second', () => {
    const oldProject = declare('Old');
    const newProject = declare('New');
    const artifactId = seedThread('C1', '100.1');

    rebuildProjectLinks([channel('C1', oldProject)], graph);
    const summary = rebuildProjectLinks([channel('C1', newProject)], graph);

    // An artifact linked to two projects takes the HIGHEST stakes weight, so a
    // surviving stale edge could outrank the answer the user just gave.
    expect(summary.unlinked).toBe(1);
    expect(graph.relatedIds(artifactId, PROJECT_REL)).toEqual([newProject]);
  });

  it('removes edges when a channel is untagged', () => {
    const projectId = declare('Migration');
    const artifactId = seedThread('C1', '100.1');

    rebuildProjectLinks([channel('C1', projectId)], graph);
    const summary = rebuildProjectLinks([channel('C1', null)], graph);

    expect(summary.unlinked).toBe(1);
    expect(graph.relatedIds(artifactId, PROJECT_REL)).toEqual([]);
  });

  it('treats a tag naming a missing project as untagged', () => {
    const artifactId = seedThread('C1', '100.1');

    const summary = rebuildProjectLinks([channel('C1', 'proj-does-not-exist')], graph);

    // The FK is ON DELETE SET NULL, so this covers only the narrow window where
    // a project vanished without the column being updated. It must not throw
    // and must not write an edge pointing at nothing.
    expect(summary).toEqual({ linked: 0, unlinked: 0, taggedChannels: 0 });
    expect(graph.relatedIds(artifactId, PROJECT_REL)).toEqual([]);
  });

  it('does not link a channel whose id is a prefix of another', () => {
    const projectId = declare('Migration');
    seedThread('C1', '100.1');
    const decoy = seedThread('C10', '100.1');

    rebuildProjectLinks([channel('C1', projectId)], graph);

    // The prefix query matches on `C1:` — with the colon — precisely so `C10`
    // is not swept in. Without it, tagging one channel would silently tag every
    // channel whose id starts with the same characters.
    expect(graph.relatedIds(decoy, PROJECT_REL)).toEqual([]);
  });

  it('ignores non-Slack artifacts sharing an external ref shape', () => {
    const projectId = declare('Migration');
    graph.upsertArtifact({
      artifactId: 'gmail:thread:C1:100.1',
      source: 'gmail',
      kind: 'thread',
      externalRef: 'C1:100.1',
      title: null,
      state: null,
      ownerId: null,
      firstSeenAt: 1_000,
      lastSeenAt: 1_000,
    });

    rebuildProjectLinks([channel('C1', projectId)], graph);

    expect(graph.relatedIds('gmail:thread:C1:100.1', PROJECT_REL)).toEqual([]);
  });
});

describe('SlackChannelProjectResolver', () => {
  it('resolves a thread key to its channel tag', () => {
    const resolver = new SlackChannelProjectResolver([channel('C1', 'proj-1')]);

    expect(resolver.projectFor('slack', 'C1:1712345678.000200')).toBe('proj-1');
  });

  it('returns null for an untagged channel, an unknown channel and a non-Slack source', () => {
    const resolver = new SlackChannelProjectResolver([
      channel('C1', 'proj-1'),
      channel('C2', null),
    ]);

    expect(resolver.projectFor('slack', 'C2:1.1')).toBeNull();
    expect(resolver.projectFor('slack', 'C9:1.1')).toBeNull();
    // A Gmail thread key is an opaque id with no channel in it; matching one
    // against the Slack map could only ever be a coincidence.
    expect(resolver.projectFor('gmail', 'C1:1.1')).toBeNull();
  });

  it('returns null for a thread key with no channel segment', () => {
    const resolver = new SlackChannelProjectResolver([channel('C1', 'proj-1')]);

    expect(resolver.projectFor('slack', 'C1')).toBeNull();
    expect(resolver.projectFor('slack', ':1.1')).toBeNull();
    expect(resolver.projectFor('slack', '')).toBeNull();
  });

  it('splits on the first colon only', () => {
    const resolver = new SlackChannelProjectResolver([channel('C1', 'proj-1')]);

    expect(resolver.projectFor('slack', 'C1:1712345678.000200:extra')).toBe('proj-1');
  });

  it('reports isEmpty so a caller can skip the work', () => {
    expect(new SlackChannelProjectResolver([channel('C1', null)]).isEmpty).toBe(true);
    expect(new SlackChannelProjectResolver([channel('C1', 'proj-1')]).isEmpty).toBe(false);
  });
});
