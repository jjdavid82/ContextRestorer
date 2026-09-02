/**
 * Repository over the entity graph: `artifacts`, `people` and `projects`.
 *
 * Unlike `events`, these tables are mutable — the same artifact is re-observed
 * every time a thread moves, and each sighting refreshes its title/state. The
 * one thing that must never move is `first_seen_at`: "when did this first enter
 * my world" is what makes a briefing able to say *new* rather than *updated*, so
 * the upsert deliberately excludes that column from its UPDATE clause.
 *
 * `projects` carries the X-2 constraint: the POC only supports user-*declared*
 * projects. Inferred project clustering is explicitly out of scope, and letting
 * an `origin='inferred'` row exist would silently enable ranking behaviour that
 * has never been evaluated — so it is rejected in code, before any write.
 */

import type Database from 'better-sqlite3';
import { newId, systemClock, type Artifact, type Clock, type Person, type Project, type SourceId } from '@cr/core';

/** Raw `artifacts` row (snake_case, as SQLite returns it). */
interface ArtifactRow {
  artifact_id: string;
  source: string;
  kind: string;
  external_ref: string;
  title: string | null;
  state: string | null;
  owner_id: string | null;
  first_seen_at: number;
  last_seen_at: number;
}

/** Raw `people` row — `is_self` is an INTEGER 0/1. */
interface PersonRow {
  person_id: string;
  display_name: string | null;
  email_hash: string | null;
  is_self: number | null;
}

/**
 * Raw `relationships` row — the edge table that joins the three entity tables.
 *
 * Edges are deliberately untyped at the schema level (`rel` is free text) so a
 * new edge kind never needs a migration. The vocabulary in use today:
 *
 * - `artifact --belongs_to--> project`  (stakes weighting, see retrieval)
 * - `artifact --participant--> person`  (shared-participant neighbours)
 */
interface RelationshipRow {
  from_id: string;
  rel: string;
  to_id: string;
  confidence: number | null;
}

/** Raw `projects` row. */
interface ProjectRow {
  project_id: string;
  name: string;
  origin: string;
  stakes_weight: number;
  declared_at: number | null;
}

/** The only project origin permitted in the POC (X-2). */
const DECLARED_ORIGIN = 'declared';

function artifactToRow(a: Artifact): ArtifactRow {
  return {
    artifact_id: a.artifactId,
    source: a.source,
    kind: a.kind,
    external_ref: a.externalRef,
    title: a.title,
    state: a.state,
    owner_id: a.ownerId,
    first_seen_at: a.firstSeenAt,
    last_seen_at: a.lastSeenAt,
  };
}

function artifactFromRow(r: ArtifactRow): Artifact {
  return {
    artifactId: r.artifact_id,
    source: r.source as SourceId,
    kind: r.kind,
    externalRef: r.external_ref,
    title: r.title,
    state: r.state,
    ownerId: r.owner_id,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
  };
}

function personToRow(p: Person): PersonRow {
  return {
    person_id: p.personId,
    display_name: p.displayName,
    email_hash: p.emailHash,
    is_self: p.isSelf ? 1 : 0,
  };
}

function personFromRow(r: PersonRow): Person {
  return {
    personId: r.person_id,
    displayName: r.display_name ?? '',
    emailHash: r.email_hash,
    isSelf: r.is_self === 1,
  };
}

function projectFromRow(r: ProjectRow): Project {
  return {
    projectId: r.project_id,
    name: r.name,
    origin: r.origin,
    stakesWeight: r.stakes_weight,
    declaredAt: r.declared_at ?? 0,
  };
}

export class GraphRepo {
  private readonly stmtUpsertArtifact: Database.Statement<ArtifactRow>;
  private readonly stmtGetArtifact: Database.Statement<[string]>;
  private readonly stmtUpsertPerson: Database.Statement<PersonRow>;
  private readonly stmtGetPerson: Database.Statement<[string]>;
  private readonly stmtInsertProject: Database.Statement<[string, string, string, number, number]>;
  private readonly stmtGetProject: Database.Statement<[string]>;
  private readonly stmtGetProjectByName: Database.Statement<[string]>;
  private readonly stmtListProjects: Database.Statement<[]>;
  private readonly stmtGetSelf: Database.Statement<[]>;
  private readonly stmtUpsertRelationship: Database.Statement<RelationshipRow>;
  private readonly stmtRelatedIds: Database.Statement<[string, string]>;
  private readonly stmtRelatedFromIds: Database.Statement<[string, string]>;

  constructor(
    private db: Database.Database,
    private clock: Clock = systemClock,
  ) {
    // `first_seen_at` is absent from the DO UPDATE clause on purpose: it is set
    // once, on first sighting, and is never rewritten. `last_seen_at` uses MAX so
    // that an out-of-order backfill of an older sighting cannot rewind recency.
    this.stmtUpsertArtifact = this.db.prepare(
      `INSERT INTO artifacts
         (artifact_id, source, kind, external_ref, title, state, owner_id,
          first_seen_at, last_seen_at)
       VALUES
         (@artifact_id, @source, @kind, @external_ref, @title, @state, @owner_id,
          @first_seen_at, @last_seen_at)
       ON CONFLICT(artifact_id) DO UPDATE SET
         source       = excluded.source,
         kind         = excluded.kind,
         external_ref = excluded.external_ref,
         title        = excluded.title,
         state        = excluded.state,
         owner_id     = excluded.owner_id,
         last_seen_at = MAX(artifacts.last_seen_at, excluded.last_seen_at)`,
    );

    this.stmtGetArtifact = this.db.prepare(`SELECT * FROM artifacts WHERE artifact_id = ?`);

    this.stmtUpsertPerson = this.db.prepare(
      `INSERT INTO people (person_id, display_name, email_hash, is_self)
       VALUES (@person_id, @display_name, @email_hash, @is_self)
       ON CONFLICT(person_id) DO UPDATE SET
         display_name = excluded.display_name,
         email_hash   = excluded.email_hash,
         is_self      = excluded.is_self`,
    );

    this.stmtGetPerson = this.db.prepare(`SELECT * FROM people WHERE person_id = ?`);

    this.stmtInsertProject = this.db.prepare(
      `INSERT INTO projects (project_id, name, origin, stakes_weight, declared_at)
       VALUES (?, ?, ?, ?, ?)`,
    );

    this.stmtGetProject = this.db.prepare(`SELECT * FROM projects WHERE project_id = ?`);

    // `projects.name` has NO UNIQUE constraint (see 001_initial.sql) — the PK is
    // `project_id`, a fresh uuid per call. Callers that must not create a second
    // row for the same name therefore have to look it up first; that is what
    // `getProjectByName` is for. `COLLATE NOCASE` because the name is free text
    // typed by a human: "API Redesign" and "api redesign" are one project.
    // (SQLite's NOCASE folds ASCII only — good enough for a dedupe check that is
    // an ergonomic guard, not a correctness boundary.)
    this.stmtGetProjectByName = this.db.prepare(
      `SELECT * FROM projects WHERE name = ? COLLATE NOCASE
       ORDER BY declared_at ASC, project_id ASC LIMIT 1`,
    );

    this.stmtListProjects = this.db.prepare(
      `SELECT * FROM projects ORDER BY declared_at ASC, project_id ASC`,
    );

    this.stmtGetSelf = this.db.prepare(
      `SELECT * FROM people WHERE is_self = 1 ORDER BY person_id ASC LIMIT 1`,
    );

    // Edges are idempotent on their full primary key: re-observing the same
    // relationship refreshes only its confidence.
    this.stmtUpsertRelationship = this.db.prepare(
      `INSERT INTO relationships (from_id, rel, to_id, confidence)
       VALUES (@from_id, @rel, @to_id, @confidence)
       ON CONFLICT(from_id, rel, to_id) DO UPDATE SET confidence = excluded.confidence`,
    );

    this.stmtRelatedIds = this.db.prepare(
      `SELECT to_id FROM relationships WHERE from_id = ? AND rel = ? ORDER BY to_id ASC`,
    );

    this.stmtRelatedFromIds = this.db.prepare(
      `SELECT from_id FROM relationships WHERE to_id = ? AND rel = ? ORDER BY from_id ASC`,
    );
  }

  /**
   * Insert `a`, or refresh the mutable columns of an existing artifact.
   *
   * `firstSeenAt` is honoured only on insert; on update it is left untouched and
   * `lastSeenAt` advances (never rewinds).
   */
  upsertArtifact(a: Artifact): void {
    this.stmtUpsertArtifact.run(artifactToRow(a));
  }

  /** The artifact, or `undefined` when no such id has ever been seen. */
  getArtifact(id: string): Artifact | undefined {
    const row = this.stmtGetArtifact.get(id) as ArtifactRow | undefined;
    return row === undefined ? undefined : artifactFromRow(row);
  }

  /** Insert `p`, or overwrite the identity fields of an existing person. */
  upsertPerson(p: Person): void {
    this.stmtUpsertPerson.run(personToRow(p));
  }

  /** The person, or `undefined` when unknown. */
  getPerson(id: string): Person | undefined {
    const row = this.stmtGetPerson.get(id) as PersonRow | undefined;
    return row === undefined ? undefined : personFromRow(row);
  }

  /**
   * Create a user-declared project (FR-8).
   *
   * @throws Error when `origin` is anything other than `'declared'` — inferred
   * projects are out of scope for the POC (X-2). The check runs before the
   * INSERT, so a rejected call leaves no row behind.
   */
  declareProject(input: { name: string; origin: string; stakesWeight?: number }): Project {
    if (input.origin !== DECLARED_ORIGIN) {
      throw new Error("X-2: only origin='declared' projects are permitted in the POC");
    }

    const project: Project = {
      projectId: newId(),
      name: input.name,
      origin: DECLARED_ORIGIN,
      stakesWeight: input.stakesWeight ?? 1.0,
      declaredAt: this.clock.now(),
    };

    this.stmtInsertProject.run(
      project.projectId,
      project.name,
      project.origin,
      project.stakesWeight,
      project.declaredAt,
    );

    return project;
  }

  /** The project, or `undefined` when unknown. */
  getProject(id: string): Project | undefined {
    const row = this.stmtGetProject.get(id) as ProjectRow | undefined;
    return row === undefined ? undefined : projectFromRow(row);
  }

  /**
   * The earliest-declared project whose name matches `name`, ignoring ASCII case.
   *
   * Exists so a caller can make declaration idempotent by name without changing
   * {@link declareProject}, which stays a plain INSERT: "create a project" and
   * "create it only if it is new" are different operations, and collapsing them
   * would silently swallow a genuine attempt to create a second, distinct
   * project that happens to share a name.
   */
  getProjectByName(name: string): Project | undefined {
    const row = this.stmtGetProjectByName.get(name.trim()) as ProjectRow | undefined;
    return row === undefined ? undefined : projectFromRow(row);
  }

  /** Every declared project, oldest first. */
  listProjects(): Project[] {
    return (this.stmtListProjects.all() as ProjectRow[]).map(projectFromRow);
  }

  /** The person flagged `is_self`, or `undefined` before identity is resolved. */
  getSelf(): Person | undefined {
    const row = this.stmtGetSelf.get() as PersonRow | undefined;
    return row === undefined ? undefined : personFromRow(row);
  }

  /**
   * Record (or refresh) one edge of the entity graph.
   *
   * Idempotent on `(fromId, rel, toId)`: re-asserting an edge updates its
   * confidence rather than duplicating the row.
   */
  relate(input: { fromId: string; rel: string; toId: string; confidence?: number }): void {
    this.stmtUpsertRelationship.run({
      from_id: input.fromId,
      rel: input.rel,
      to_id: input.toId,
      confidence: input.confidence ?? null,
    });
  }

  /** Ids reachable from `fromId` along `rel` (the outbound half of an edge). */
  relatedIds(fromId: string, rel: string): string[] {
    return (this.stmtRelatedIds.all(fromId, rel) as Array<{ to_id: string }>).map((r) => r.to_id);
  }

  /** Ids that point at `toId` along `rel` (the inbound half of an edge). */
  relatedFromIds(toId: string, rel: string): string[] {
    return (this.stmtRelatedFromIds.all(toId, rel) as Array<{ from_id: string }>).map((r) => r.from_id);
  }
}
