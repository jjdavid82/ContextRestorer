/**
 * Persistence for the Slack channel selector (Task 1.7's gap, closed).
 *
 * `VaultBackedSlackClient` (`apps/desktop/src/main.ts`) re-reads {@link list}
 * once per poll cycle and fetches exactly those channels — nothing else. The
 * table is small (a handful of rows at most) and read far more often than
 * written, so `setSelected` simply replaces the whole set in one transaction
 * rather than diffing; a settings page that lets the user check/uncheck boxes
 * and hit "Save" has no per-row add/remove events to diff against anyway.
 */
import type { Database, Statement } from 'better-sqlite3';

export interface SelectedSlackChannel {
  channelId: string;
  name: string;
  addedAt: number;
  /**
   * Declared project this channel's threads belong to (FR-8), or `null` when
   * the user has not tagged it.
   *
   * `null` is the ordinary case, not a defect: an untagged channel is still
   * polled, its threads still appear in briefings, they simply earn no stakes
   * weight — the behaviour every channel had before migration 006.
   */
  projectId: string | null;
}

/**
 * One channel as handed to {@link SlackChannelsRepo.setSelected}.
 *
 * `projectId` is optional and tri-state on purpose: absent means "leave the
 * existing tag alone", `null` means "clear it", and a string sets it. The
 * channel-checkbox save path sends no `projectId` at all and must not wipe tags
 * as a side effect of toggling a checkbox.
 */
export interface SelectedChannelInput {
  channelId: string;
  name: string;
  projectId?: string | null;
}

interface ChannelRow {
  channel_id: string;
  name: string;
  added_at: number;
  project_id: string | null;
}

function toDomain(row: ChannelRow): SelectedSlackChannel {
  return {
    channelId: row.channel_id,
    name: row.name,
    addedAt: row.added_at,
    projectId: row.project_id,
  };
}

/**
 * CRUD over `slack_selected_channels`.
 *
 * Same shape as every other repository in this package: constructed with a
 * live `Database`, prepares its statements once, returns domain objects.
 */
export class SlackChannelsRepo {
  private readonly stmtList: Statement<unknown[], ChannelRow>;
  private readonly stmtDeleteAll: Statement<unknown[], unknown>;
  private readonly stmtInsert: Statement<unknown[], unknown>;

  constructor(private readonly db: Database) {
    this.stmtList = this.db.prepare<unknown[], ChannelRow>(
      `SELECT channel_id, name, added_at, project_id FROM slack_selected_channels
        ORDER BY added_at ASC, channel_id ASC`,
    );
    this.stmtDeleteAll = this.db.prepare(`DELETE FROM slack_selected_channels`);
    this.stmtInsert = this.db.prepare(
      `INSERT INTO slack_selected_channels (channel_id, name, added_at, project_id)
       VALUES (?, ?, ?, ?)`,
    );
  }

  /** Every channel the poller is currently authorized to fetch from. */
  list(): SelectedSlackChannel[] {
    return this.stmtList.all().map(toDomain);
  }

  /**
   * Replace the whole selection in one transaction.
   *
   * `addedAt` is stamped only for channels that were not already selected —
   * re-saving an unchanged selection must not reset the order the settings UI
   * shows them in. Existing rows keep their original `added_at` by reusing the
   * value already on disk when the incoming channel id matches one.
   */
  setSelected(channels: ReadonlyArray<SelectedChannelInput>, now: number): void {
    const previous = this.list();
    const addedAtById = new Map(previous.map((c) => [c.channelId, c.addedAt]));
    // Preserved the same way `addedAt` is: a caller that omits `projectId`
    // entirely (the pre-006 shape, and the channel-checkbox save path) is saying
    // "I am not changing the tags", not "clear every tag". Only an explicit
    // `null` clears one.
    const projectById = new Map(previous.map((c) => [c.channelId, c.projectId]));

    const apply = this.db.transaction((rows: ReadonlyArray<SelectedChannelInput>) => {
      this.stmtDeleteAll.run();
      for (const row of rows) {
        this.stmtInsert.run(
          row.channelId,
          row.name,
          addedAtById.get(row.channelId) ?? now,
          row.projectId === undefined ? (projectById.get(row.channelId) ?? null) : row.projectId,
        );
      }
    });

    apply(channels);
  }

  /** Tag (or, with `null`, untag) one already-selected channel. */
  setProject(channelId: string, projectId: string | null): void {
    this.db
      .prepare(`UPDATE slack_selected_channels SET project_id = ? WHERE channel_id = ?`)
      .run(projectId, channelId);
  }
}
