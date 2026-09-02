import { createHash, randomUUID } from 'node:crypto';

export type SourceId = 'slack' | 'gmail';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Deterministic — the DB-level idempotency key for ingestion (NFR-6 / AC-10). */
export const eventId = (source: SourceId, sourceEventId: string): string =>
  sha256(`${source}|${sourceEventId}`);

export const artifactId = (source: SourceId, kind: string, externalRef: string): string =>
  sha256(`${source}|${kind}|${externalRef}`);

export const deltaId = (threadKey: string, version: number): string =>
  sha256(`delta|${threadKey}|${version}`);

export const chunkId = (evId: string, ordinal: number): string => `${evId}:${ordinal}`;

/** Non-deterministic ids, for rows with no natural key. */
export const newId = (): string => randomUUID();
