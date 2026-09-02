/**
 * Generic key/value persistence for user-facing app settings that live
 * outside `config/default.json` (`005_app_settings.sql`).
 *
 * The config file is loaded once at process start and is not meant to be
 * edited by the app itself; a setting the user changes from inside the app
 * (currently: which chat model to use) needs somewhere durable to live
 * across restarts instead. Key/value rather than one column per setting so
 * the next such setting does not need its own migration.
 */
import type { Database, Statement } from 'better-sqlite3';

interface SettingRow {
  value: string;
}

/**
 * CRUD over `app_settings`. Same shape as every other repo in this package:
 * constructed with a live `Database`, prepares its statements once.
 */
export class AppSettingsRepo {
  private readonly stmtGet: Statement<[string], SettingRow>;
  private readonly stmtSet: Statement<unknown[], unknown>;

  constructor(private readonly db: Database) {
    this.stmtGet = this.db.prepare<[string], SettingRow>(
      `SELECT value FROM app_settings WHERE key = ?`,
    );
    this.stmtSet = this.db.prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
  }

  /** `null` when the key has never been set — the caller falls back to its own default. */
  get(key: string): string | null {
    const row = this.stmtGet.get(key);
    return row?.value ?? null;
  }

  /** Insert-or-replace: a setting has at most one current value. */
  set(key: string, value: string): void {
    this.stmtSet.run(key, value);
  }
}

export default AppSettingsRepo;
