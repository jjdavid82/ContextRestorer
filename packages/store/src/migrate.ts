import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';

/** `NNN_name.sql` — the leading number is the migration version. */
const MIGRATION_FILE_RE = /^(\d+)_.*\.sql$/;

interface Migration {
  readonly version: number;
  readonly file: string;
  readonly path: string;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the migrations directory relative to *this module's own file*, never
 * relative to `process.cwd()` — the caller may be a worker, a test runner, or
 * the packaged desktop app, each with a different cwd.
 *
 * Two candidates are probed so the same code works whether we are running from
 * `src/` (vitest, ts execution) or from a compiled `dist/` (tsc emits .js but
 * does not copy .sql assets, so `dist/migrate.js` falls back to `../src`).
 */
function defaultMigrationsDir(): string {
  const candidates = [join(moduleDir, 'migrations'), resolve(moduleDir, '..', 'src', 'migrations')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `store: could not locate a migrations directory (tried: ${candidates.join(', ')})`,
  );
}

/** Read `NNN_*.sql` from `dir`, sorted numerically by the leading number. */
function loadMigrations(dir: string): Migration[] {
  const migrations: Migration[] = [];

  for (const file of readdirSync(dir)) {
    const match = MIGRATION_FILE_RE.exec(file);
    if (match === null) continue;

    const digits = match[1];
    if (digits === undefined) continue;

    const version = Number.parseInt(digits, 10);
    if (!Number.isFinite(version)) continue;

    migrations.push({ version, file, path: join(dir, file) });
  }

  // Numeric sort — a lexical sort would break at 010 vs 9.
  migrations.sort((a, b) => a.version - b.version);

  for (let i = 1; i < migrations.length; i++) {
    const prev = migrations[i - 1];
    const curr = migrations[i];
    if (prev !== undefined && curr !== undefined && prev.version === curr.version) {
      throw new Error(
        `store: duplicate migration version ${curr.version} (${prev.file} and ${curr.file})`,
      );
    }
  }

  return migrations;
}

/**
 * Current schema version, or 0 when the bookkeeping table does not exist yet
 * (fresh database) or exists but is empty.
 */
export function currentSchemaVersion(db: Database): number {
  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`)
    .get();
  if (table === undefined) return 0;

  const row = db.prepare(`SELECT MAX(version) AS version FROM schema_version`).get() as
    | { version: number | null }
    | undefined;

  return row?.version ?? 0;
}

/**
 * Apply every migration whose version exceeds the recorded schema version, each
 * in its own transaction, then stamp `schema_version`.
 *
 * Idempotent by construction: a second call sees the stamped version and does
 * nothing, so it neither throws nor re-applies (and never duplicates rows).
 */
export function migrate(db: Database, migrationsDir?: string): void {
  const dir = migrationsDir ?? defaultMigrationsDir();
  const migrations = loadMigrations(dir);
  const from = currentSchemaVersion(db);

  for (const migration of migrations) {
    if (migration.version <= from) continue;

    const sql = readFileSync(migration.path, 'utf8');

    // `exec` runs multi-statement SQL; `prepare` accepts only a single statement.
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`).run(
        migration.version,
        Date.now(),
      );
    });

    try {
      apply();
    } catch (cause) {
      throw new Error(`store: migration ${migration.file} failed: ${(cause as Error).message}`, {
        cause,
      });
    }
  }
}
