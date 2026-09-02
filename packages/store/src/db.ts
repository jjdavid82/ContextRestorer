import Database from 'better-sqlite3';

/**
 * Open (or create) the SQLite database at `path` with the pragmas the rest of
 * the system assumes are in force.
 *
 * `foreign_keys = ON` is not optional: SQLite defaults it OFF, and with it off
 * `briefing_claims.citation_artifact_id` would happily accept a dangling id —
 * letting an effectively uncited claim reach the user while every test passed.
 *
 * Note: `journal_mode = WAL` is silently ignored for `:memory:` databases, so
 * in-memory test dbs run in the default rollback-journal mode. That is fine —
 * WAL only matters for the real file-backed db, where workers read while the
 * main process writes.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL'); // workers read while main writes
  db.pragma('foreign_keys = ON'); // citation FKs must actually bite
  db.pragma('synchronous = NORMAL'); // WAL-safe; NFR-6 durability is preserved
  db.pragma('busy_timeout = 5000');
  return db;
}
