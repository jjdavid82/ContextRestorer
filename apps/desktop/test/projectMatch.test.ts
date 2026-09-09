/**
 * Deterministic project detection — `apps/desktop/src/ipc/projectMatch.ts`.
 *
 * The fixtures use this user's REAL declared project names (`DSP`,
 * `AI Academy`, `Q3 migration`, `Q1`, `Q2`) rather than invented ones, because
 * the hard cases here are entirely about short and overlapping names: two-char
 * `Q1`, the acronym `DSP`, and `Q3 migration` sharing a prefix shape with both
 * quarters. A fixture set of `Alpha`/`Beta` would pass while proving nothing.
 *
 * No `vi.mock('electron', …)` needed: this module imports nothing from Electron.
 */
import { describe, expect, it } from 'vitest';
import { containsPhrase, detectProject, normalizeForMatch } from '../src/ipc/projectMatch.js';

const PROJECTS = [
  { projectId: 'p-dsp', name: 'DSP' },
  { projectId: 'p-academy', name: 'AI Academy' },
  { projectId: 'p-q3', name: 'Q3 migration' },
  { projectId: 'p-q1', name: 'Q1' },
  { projectId: 'p-q2', name: 'Q2' },
];

describe('normalizeForMatch', () => {
  it('folds case and collapses punctuation into single spaces', () => {
    expect(normalizeForMatch('Q3-Migration!')).toBe('q3 migration');
    expect(normalizeForMatch('  AI   Academy  ')).toBe('ai academy');
  });

  it('keeps letters and digits from any script', () => {
    expect(normalizeForMatch('Café — 日次')).toBe('café 日次');
  });

  it('reduces punctuation-only text to the empty string', () => {
    expect(normalizeForMatch('--- !!! ---')).toBe('');
  });
});

describe('containsPhrase', () => {
  it('matches on word boundaries, not substrings', () => {
    expect(containsPhrase('the q1 numbers', 'q1')).toBe(true);
    // The whole reason detection is phrase-based: `sq1` and `q10` must not fire
    // a project named `Q1`.
    expect(containsPhrase('the sq1 numbers', 'q1')).toBe(false);
    expect(containsPhrase('bucket q10 totals', 'q1')).toBe(false);
  });

  it('matches a multi-word phrase only when the words are adjacent and in order', () => {
    expect(containsPhrase('the ai academy cohort', 'ai academy')).toBe(true);
    expect(containsPhrase('academy of ai', 'ai academy')).toBe(false);
  });

  it('never matches an empty phrase', () => {
    expect(containsPhrase('anything at all', '')).toBe(false);
  });
});

describe('detectProject', () => {
  it('detects the one project whose name appears in the text', () => {
    expect(detectProject('Can you review the DSP dashboard today?', PROJECTS)).toEqual({
      projectId: 'p-dsp',
      name: 'DSP',
    });
  });

  it('is case- and punctuation-insensitive', () => {
    expect(detectProject('notes from the ai-academy session', PROJECTS)?.projectId).toBe(
      'p-academy',
    );
  });

  it('abstains when no project is named — the blank the user fills in', () => {
    expect(detectProject('Lunch is at noon, see you there.', PROJECTS)).toBeNull();
  });

  it('abstains when two projects are named, rather than guessing between them', () => {
    // The exact situation the user described as "not clear enough": an email
    // about both quarters belongs to neither more than the other.
    expect(detectProject('Compare the Q1 and Q2 targets before Friday.', PROJECTS)).toBeNull();
  });

  it('abstains on empty or punctuation-only text', () => {
    expect(detectProject('', PROJECTS)).toBeNull();
    expect(detectProject('!!! ???', PROJECTS)).toBeNull();
  });

  it('abstains when no projects are declared', () => {
    expect(detectProject('All about DSP, obviously.', [])).toBeNull();
  });

  it('does not fire a short name found inside a longer word', () => {
    // `q1` inside `sq1`/`q10`, and `dsp` inside `dsps`, are the false positives
    // that would make auto-labelling worse than useless.
    expect(detectProject('The sq1 query and the dsps report.', PROJECTS)).toBeNull();
  });

  it('distinguishes "Q3 migration" from the bare quarters', () => {
    expect(detectProject('Status on the Q3 migration is green.', PROJECTS)?.projectId).toBe('p-q3');
    // `Q3 migration` contains no standalone `Q1`/`Q2`, so there is no tie here.
    expect(detectProject('Status on the Q3 migration is green.', PROJECTS)?.name).toBe(
      'Q3 migration',
    );
  });

  it('ignores a project whose name is punctuation only, rather than matching everything', () => {
    const odd = [...PROJECTS, { projectId: 'p-junk', name: '---' }];
    expect(detectProject('Nothing relevant here.', odd)).toBeNull();
    expect(detectProject('A note about DSP.', odd)?.projectId).toBe('p-dsp');
  });

  it('treats a duplicate declaration of the same project as one hit, not a tie', () => {
    // `projects.name` has no UNIQUE constraint, so the same name can legitimately
    // appear twice; that is a duplicate, not ambiguity.
    const dupes = [
      { projectId: 'p-dsp', name: 'DSP' },
      { projectId: 'p-dsp', name: 'DSP' },
    ];
    expect(detectProject('DSP again', dupes)?.projectId).toBe('p-dsp');
  });

  it('treats two DIFFERENT projects sharing a name as ambiguous', () => {
    const clash = [
      { projectId: 'p-a', name: 'DSP' },
      { projectId: 'p-b', name: 'DSP' },
    ];
    expect(detectProject('DSP again', clash)).toBeNull();
  });
});
