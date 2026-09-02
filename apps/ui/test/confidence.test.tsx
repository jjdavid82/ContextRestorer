import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ClaimBullet,
  DEFAULT_LOW_CONFIDENCE_NOTE,
  LOW_CONFIDENCE_FLAG_THRESHOLD,
  LOW_CONFIDENCE_PREFIX,
} from '../components/ClaimBullet';
import { PENDING_LOW_CONFIDENCE_NOTE, PendingSection } from '../components/PendingSection';
import type { PendingItemView } from '../types/bridge';

/**
 * Confidence flagging in the UI (Task 4.5, design §7.6, T-4).
 *
 * §7.6 draws a distinction that is easy to blur in code and expensive to get
 * wrong, so it is pinned here in two directions:
 *
 *   - "Low-confidence items are still shown to the user but with a visible flag
 *     (e.g. 'this might be waiting on you — verify in the source')." Low
 *     confidence is a LABEL, never a filter.
 *   - "items without source references are suppressed" (T-4). Missing citations
 *     are a FILTER, never a label.
 *
 * These tests drive the components directly with props rather than through
 * `BriefingView` and a mocked bridge (as `briefingView.test.tsx` does). That is
 * deliberate: the subject here is the rendering rule, not the IPC plumbing, and
 * a prop-level test can construct the input the bridge is *supposed* to make
 * impossible — which is exactly what the defence-in-depth case below needs.
 */

/** A confident, properly cited pending item. Overrides carve out each case. */
function pendingItem(overrides: Partial<PendingItemView> = {}): PendingItemView {
  return {
    pendingId: 'p-1',
    description: 'Reply to Marcus about the adapter layer.',
    confidence: 0.92,
    citationArtifactId: 'art-1',
    ...overrides,
  };
}

/** Comfortably below the flag threshold, without hard-coding 0.4. */
const LOW = LOW_CONFIDENCE_FLAG_THRESHOLD - 0.1;
/** Comfortably above it. */
const HIGH = LOW_CONFIDENCE_FLAG_THRESHOLD + 0.4;

afterEach(() => {
  cleanup();
});

/* -------------------------------------------------------------------------- */
/* 1. The §7.6 wording                                                        */
/* -------------------------------------------------------------------------- */

describe('PendingSection — low-confidence flag wording (§7.6)', () => {
  it('flags a below-threshold pending item with the §7.6 advisory, verbatim', () => {
    render(<PendingSection items={[pendingItem({ confidence: LOW })]} />);

    const flag = screen.getByTestId('low-confidence-flag');

    // The exact §7.6 phrase, em dash included. Asserted as a substring of the
    // flag's own text so the "low confidence" prefix may precede it, but the
    // advisory itself must survive intact — a paraphrase fails here.
    expect(flag.textContent).toContain('this might be waiting on you — verify in the source');
    expect(PENDING_LOW_CONFIDENCE_NOTE).toBe(
      'this might be waiting on you — verify in the source',
    );
  });

  it('names the state in words, not only in the advisory', () => {
    render(<PendingSection items={[pendingItem({ confidence: LOW })]} />);

    // Reachable by text query, i.e. really in the document's text — this is the
    // half of NFR-9 that a coloured border alone would not satisfy.
    expect(screen.getByText(new RegExp(LOW_CONFIDENCE_PREFIX, 'i'))).toBeTruthy();
  });

  it('attaches the flag to the item it belongs to, not to the section', () => {
    render(
      <PendingSection
        items={[
          pendingItem({ pendingId: 'p-sure', description: 'Sign the SRE reqs.', confidence: HIGH }),
          pendingItem({
            pendingId: 'p-unsure',
            description: 'Maybe you owe Lin a decision.',
            confidence: LOW,
            citationArtifactId: 'art-unsure',
          }),
        ]}
      />,
    );

    const flagged = screen.getByText('Maybe you owe Lin a decision.').closest('li');
    const confident = screen.getByText('Sign the SRE reqs.').closest('li');
    expect(flagged).not.toBeNull();
    expect(confident).not.toBeNull();

    expect(within(flagged as HTMLElement).getByTestId('low-confidence-flag')).toBeTruthy();
    expect(within(confident as HTMLElement).queryByTestId('low-confidence-flag')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Not colour alone (NFR-9)                                                */
/* -------------------------------------------------------------------------- */

describe('low-confidence flag — perceivable without colour (NFR-9)', () => {
  it('carries an accessible label as well as visible text', () => {
    render(<PendingSection items={[pendingItem({ confidence: LOW })]} />);

    const labelled = screen.getByLabelText(/low confidence/i);
    expect(labelled.getAttribute('aria-label')).toContain(PENDING_LOW_CONFIDENCE_NOTE);
    // Same element, reached two ways: the flag is in the accessible tree AND in
    // the visual text, so neither a screen reader nor a greyscale display loses it.
    expect(labelled).toBe(screen.getByTestId('low-confidence-flag'));
  });

  it('survives greyscale: stripping every colour leaves the message readable', () => {
    render(<PendingSection items={[pendingItem({ confidence: LOW })]} />);

    const flag = screen.getByTestId('low-confidence-flag');

    // Simulate the colour-blind / greyscale / high-contrast-override case by
    // discarding the decorative styling entirely. What remains must still say it.
    flag.style.color = '';
    flag.style.border = '';
    flag.style.background = '';

    const text = (flag.textContent ?? '').trim();
    expect(text.length).toBeGreaterThan(0);
    expect(text.toLowerCase()).toContain(LOW_CONFIDENCE_PREFIX);
  });

  it('hides the decorative glyph from assistive tech instead of reading it aloud', () => {
    render(<PendingSection items={[pendingItem({ confidence: LOW })]} />);

    const flag = screen.getByTestId('low-confidence-flag');
    const glyph = flag.querySelector('[aria-hidden="true"]');

    expect(glyph?.textContent?.trim()).toBe('⚠');
    // The icon is reinforcement. The words next to it are the message, so the
    // flag does not depend on an emoji font rendering, either.
    expect((flag.textContent ?? '').replace('⚠', '').trim().length).toBeGreaterThan(0);
  });

  it('does not flag a high-confidence pending item at all', () => {
    render(<PendingSection items={[pendingItem({ confidence: HIGH })]} />);

    expect(screen.getByText('Reply to Marcus about the adapter layer.')).toBeTruthy();
    expect(screen.queryByTestId('low-confidence-flag')).toBeNull();
    expect(screen.queryByText(/low confidence/i)).toBeNull();
    expect(screen.queryByText(/might be waiting on you/i)).toBeNull();
  });

  it('treats the threshold as exclusive: exactly at it is not low', () => {
    render(<PendingSection items={[pendingItem({ confidence: LOW_CONFIDENCE_FLAG_THRESHOLD })]} />);

    // Mirrors `confidence < LOW_CONFIDENCE_FLAG_THRESHOLD` in `@cr/ai`'s
    // `pending.ts`; if the AI layer's comparison flips, this test says so.
    expect(screen.queryByTestId('low-confidence-flag')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Low confidence never hides — only uncited content is suppressed         */
/* -------------------------------------------------------------------------- */

describe('§7.6 — flag, do not suppress', () => {
  it('renders a low-confidence but properly cited pending item in full', () => {
    render(
      <PendingSection
        items={[
          pendingItem({
            description: 'Marcus may still need your sign-off.',
            confidence: 0.11,
            citationArtifactId: 'art-cited',
          }),
        ]}
      />,
    );

    // Present, not filtered: text, citation chip and flag, all three.
    expect(screen.getByText('Marcus may still need your sign-off.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'sources' })).toBeTruthy();
    expect(screen.getByTestId('low-confidence-flag')).toBeTruthy();
    expect(screen.queryByText(/nothing is waiting on you/i)).toBeNull();
  });

  it('keeps a low-confidence claim bullet whole: text, chip and flag together', () => {
    render(
      <ul>
        <ClaimBullet
          text="Acme escalation looks resolved."
          claimId="art-9"
          citationLabel="slack · art-9"
          externalUrl="https://slack.example/archives/C1/p9"
          confidence={0.2}
        />
      </ul>,
    );

    const bullet = screen.getByText('Acme escalation looks resolved.').closest('li');
    expect(bullet).not.toBeNull();

    const scope = within(bullet as HTMLElement);
    // Provenance is not withheld from a hedged claim — if anything it matters more.
    const chip = scope.getByRole('button', { name: 'slack · art-9' });
    expect(chip.tagName).toBe('BUTTON');
    expect(scope.getByRole('link', { name: /open in source/i })).toBeTruthy();
    expect(scope.getByTestId('low-confidence-flag')).toBeTruthy();
  });

  it('uses the claim-level advisory for streamed claims, not the pending wording', () => {
    render(
      <ul>
        <ClaimBullet text="Vendor thread wrapped." claimId="art-2" citationLabel="gmail · art-2" confidence={0.1} />
      </ul>,
    );

    const flag = screen.getByTestId('low-confidence-flag');
    expect(flag.textContent).toContain(DEFAULT_LOW_CONFIDENCE_NOTE);
    // "waiting on you" is a claim about a *pending item*; a "What moved" bullet
    // must not borrow it.
    expect(flag.textContent).not.toContain('waiting on you');
  });

  /*
   * Defence in depth for the *other* half of §7.6: suppression.
   *
   * An uncited factual claim cannot reach this layer through the normal data
   * flow. Two independent gates stand in front of it:
   *
   *   1. Task 3.3/3.4's citation gate drops the claim before persistence, and
   *      `briefing_claims.citation_artifact_id` is NOT NULL (design §8.2), so
   *      `briefing:chunk` cannot carry one.
   *   2. `ClaimChunk.citation` in `types/bridge.d.ts` is a required, non-nullable
   *      `Citation`, so a streamed uncited claim is not even constructible in
   *      TypeScript — that case is structurally prevented by the type system and
   *      needs no runtime test.
   *
   * Pending items are the exception worth testing: `pending_items
   * .citation_artifact_id` IS nullable, and therefore so is
   * `PendingItemView.citationArtifactId`. An uncited pending row is constructible,
   * so the UI must refuse it rather than trust its input.
   */
  it('suppresses an uncited pending item instead of flagging it (T-4)', () => {
    render(
      <PendingSection
        items={[
          pendingItem({
            pendingId: 'p-uncited',
            description: 'Someone, somewhere, is waiting on something.',
            confidence: 0.99,
            citationArtifactId: null,
          }),
        ]}
      />,
    );

    // Suppressed on the citation, despite high confidence: the two rules are
    // orthogonal, and this one wins.
    expect(screen.queryByText('Someone, somewhere, is waiting on something.')).toBeNull();
    expect(screen.queryByTestId('low-confidence-flag')).toBeNull();
    // And the section degrades honestly rather than showing an empty list.
    expect(screen.getByText(/nothing is waiting on you/i)).toBeTruthy();
  });

  it('also suppresses a blank citation id, not just null', () => {
    render(
      <PendingSection
        items={[pendingItem({ description: 'Blank id, no provenance.', citationArtifactId: '  ' })]}
      />,
    );

    // `''` survives a JSON round-trip across the context bridge where `null`
    // might not; it is just as uncitable.
    expect(screen.queryByText('Blank id, no provenance.')).toBeNull();
  });

  it('drops only the uncited items, keeping their cited neighbours flagged', () => {
    render(
      <PendingSection
        items={[
          pendingItem({
            pendingId: 'p-bad',
            description: 'Uncited and unwelcome.',
            confidence: 0.9,
            citationArtifactId: null,
          }),
          pendingItem({
            pendingId: 'p-good',
            description: 'Cited but hedged.',
            confidence: LOW,
            citationArtifactId: 'art-good',
          }),
        ]}
      />,
    );

    expect(screen.queryByText('Uncited and unwelcome.')).toBeNull();
    expect(screen.getByText('Cited but hedged.')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByTestId('low-confidence-flag')).toBeTruthy();
  });

  it('does not offer a drill-down slot for a suppressed item', () => {
    const seen: string[] = [];
    render(
      <PendingSection
        items={[pendingItem({ citationArtifactId: null })]}
        renderDetail={(claimId) => {
          seen.push(claimId);
          return <span>detail for {claimId}</span>;
        }}
      />,
    );

    // A suppressed item must not even ask for provenance it cannot show.
    expect(seen).toEqual([]);
  });
});
