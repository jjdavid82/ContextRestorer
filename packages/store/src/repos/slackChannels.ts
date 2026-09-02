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
}

interface ChannelRow {
  channel_id: string;
  name: string;
  added_at: number;
}

function toDomain(row: ChannelRow): SelectedSlackChannel {
  return { channelId: row.channel_id, name: row.name, addedAt: row.added_at };
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
      `SELECT channel_id, name, added_at FROM slack_selected_channels ORDER BY added_at ASC, channel_id ASC`,
    );
    this.stmtDeleteAll = this.db.prepare(`DELETE FROM slack_selected_channels`);
    this.stmtInsert = this.db.prepare(
      `INSERT INTO slack_selected_channels (channel_id, name, added_at) VALUES (?, ?, ?)`,
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
  setSelected(channels: ReadonlyArray<{ channelId: string; name: string }>, now: number): void {
    const existing = new Map(this.list().map((c) => [c.channelId, c.addedAt]));

    const apply = this.db.transaction((rows: ReadonlyArray<{ channelId: string; name: string }>) => {
      this.stmtDeleteAll.run();
      for (const row of rows) {
        this.stmtInsert.run(row.channelId, row.name, existing.get(row.channelId) ?? now);
      }
    });

    apply(channels);
  }
}
