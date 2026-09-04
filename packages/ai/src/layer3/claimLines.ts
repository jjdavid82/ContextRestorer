/**
 * Layer 3 — NDJSON claim streaming (P4 part 2, F-8).
 *
 * ### What this replaces, and why
 *
 * The generator used to ask the model for markdown — `## headings`, `- bullets`
 * and `[artifact:<id>]` markers — and then recover the structure with three
 * regexes and a section router. That recovery was fragile in a way that is not
 * hypothetical: `renderContext`'s own doc comment records a real bug where
 * labelling context entries `[artifact_id: …]` (one token different from the
 * instructed marker) made a weak model echo the wrong shape back, producing
 * REAL, CORRECT ids inside a marker the gate did not recognise — losing every
 * claim to `no_citation` while citing something genuine.
 *
 * A structured contract removes the class of bug rather than that instance of
 * it. Section and citations become fields; there is nothing to pattern-match,
 * so nothing to accidentally teach the model to pattern-match differently.
 *
 * ### Why NDJSON rather than one JSON document
 *
 * §12.2 requires claim-level streaming: the UI paints each claim as it is
 * accepted, not in one batch at the end. A single JSON object cannot be parsed
 * until its final brace arrives, which would turn a 250-360s generation into
 * 250-360s of blank screen. One self-contained object per line streams exactly
 * as bullets did — the boundary is `\n` instead of a bullet regex — while still
 * carrying the fields structurally.
 *
 * This also means `format: 'json'` must NOT be set on the stream: that
 * constrains the whole response to a single JSON value, which is precisely the
 * shape being avoided.
 *
 * ### Malformed lines fail closed
 *
 * A line that is not parseable JSON, or that lacks the required fields, is
 * DROPPED and counted — never guessed at. That matches how the gate already
 * treats an uncited claim: the only acceptable failure is a briefing that is
 * shorter than it could have been.
 */

/** One claim as the model is asked to emit it, after parsing and validation. */
export interface StructuredClaim {
  /** Section name, verbatim from the model. Canonicalised by the caller. */
  section: string;
  /** The claim sentence. Never contains citation markers — ids are a field. */
  text: string;
  /**
   * Artifact ids this claim cites. Possibly EMPTY — an uncited claim is a
   * well-formed claim that the gate then withholds as `no_citation`, not a
   * malformed line. The gate validates the ids themselves.
   */
  artifactIds: string[];
}

/** Why a streamed line produced no claim. Counted, so silent loss is impossible. */
export type LineDropReason =
  /** Not parseable as JSON at all. */
  | 'unparseable'
  /** Parsed, but not an object with the fields the contract requires. */
  | 'malformed';

/** Non-empty trimmed string, or `undefined`. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Validate one parsed line against the claim contract.
 *
 * Tolerant in exactly one direction: `artifact_ids` may arrive as a single
 * string rather than an array, because that is the shape a small model most
 * commonly degrades to and it is unambiguous. Anything else is `malformed` —
 * coercing further would start inventing structure the model did not emit.
 */
export function toStructuredClaim(value: unknown): StructuredClaim | LineDropReason {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'malformed';

  const row = value as Record<string, unknown>;
  const section = str(row['section']);
  const text = str(row['claim']) ?? str(row['text']);
  if (section === undefined || text === undefined) return 'malformed';

  const raw = row['artifact_ids'] ?? row['artifactIds'];
  // Absent is treated as empty, not as malformed — see below.
  const list = raw === undefined ? [] : typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(list)) return 'malformed';

  // An EMPTY id list is a well-formed claim that cites nothing, and it is
  // deliberately passed through rather than dropped here. The citation gate
  // already has a name and a counter for that exact failure (`no_citation`),
  // and AC-2's accounting lives there. Reclassifying it as a parse failure
  // would move a claim-level event into a transport-level counter and quietly
  // shrink the number the citation guarantee is measured by.
  const artifactIds = list.map(str).filter((id): id is string => id !== undefined);

  return { section, text, artifactIds };
}

/**
 * Reassembles streamed tokens into whole NDJSON claims.
 *
 * The direct replacement for `ClaimBuffer` + `SectionRouter`: one class, one
 * boundary character, no regexes. `onClaim` fires once per valid line, in
 * arrival order; `onDrop` fires once per line that could not be read.
 */
export class ClaimLineBuffer {
  private buffer = '';

  constructor(
    private readonly onClaim: (claim: StructuredClaim) => void,
    private readonly onDrop: (reason: LineDropReason) => void = () => undefined,
  ) {}

  /** Append one streamed token, emitting any lines it completed. */
  push(token: string): void {
    this.buffer += token;

    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index === -1) return;

      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.emit(line);
    }
  }

  /**
   * Flush whatever is buffered as a final line. Safe to call more than once.
   *
   * The generator does NOT call this after an aborted stream: a half-written
   * line is a claim the model never finished making, and one that happens to
   * parse is still incomplete.
   */
  end(): void {
    const remaining = this.buffer;
    this.buffer = '';
    this.emit(remaining);
  }

  private emit(raw: string): void {
    // Tolerated because models wrap NDJSON in fences more or less at random,
    // and a fence is punctuation rather than content.
    const line = raw.trim().replace(/^```(?:json|ndjson)?$/i, '');
    if (line === '') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.onDrop('unparseable');
      return;
    }

    const claim = toStructuredClaim(parsed);
    if (typeof claim === 'string') {
      this.onDrop(claim);
      return;
    }
    this.onClaim(claim);
  }
}
