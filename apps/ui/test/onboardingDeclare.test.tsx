import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import OnboardingPage from '../app/onboarding/page';
import type {
  ContextRestorerBridge,
  OkResult,
  OnboardingStatus,
  ProjectSuggestions,
} from '../types/bridge';

/**
 * Onboarding step 3 — the declaration gate (OI-3, F6).
 *
 * This screen and `ipc/projects.ts` had drifted: the config floor was 3 and the
 * handler rejected anything smaller, while the screen called the step
 * "optional" and offered a "Skip for now" button whose ONLY possible outcome
 * was `too_few_projects` printed at the user as a raw slug.
 *
 * So the properties worth pinning are the ones that keep the two in agreement:
 * the floor comes from `onboarding:status` rather than a local constant, the
 * button is gated on that same number, and a rejection is rendered as a
 * sentence. The last of those is asserted by forcing a rejection the UI would
 * now normally prevent — the handler is still the trust boundary, so its
 * reasons must stay renderable.
 */

const CANDIDATES = ['api-redesign', 'billing-migration', 'q4-planning', 'hiring'];

function statusWith(overrides: Partial<OnboardingStatus> = {}): OnboardingStatus {
  return {
    sourcesConnected: ['slack'],
    projectsDeclared: [],
    ollamaReady: true,
    minDeclaredProjects: 3,
    ...overrides,
  };
}

function installBridge(options: {
  status?: OnboardingStatus;
  declare?: (names: string[]) => Promise<OkResult>;
} = {}) {
  const declare = vi.fn(options.declare ?? (async () => ({ ok: true })));
  const status = vi.fn(async () => options.status ?? statusWith());
  const suggest = vi.fn(
    async (): Promise<ProjectSuggestions> => ({
      candidates: CANDIDATES.map((name) => ({
        name,
        source: 'slack' as const,
        evidenceCount: 12,
      })),
    }),
  );

  window.contextRestorer = {
    onboarding: { status },
    projects: { suggest, declare, list: vi.fn(async () => []) },
    oauth: { connect: vi.fn(async () => ({ ok: true })), revoke: vi.fn(async () => ({ ok: true })) },
    // Bridge-contract only; nothing in this flow reads it.
    pipeline: { onStatus: () => () => undefined },
  } as unknown as ContextRestorerBridge;

  return { status, suggest, declare };
}

/** Walk from step 1 to step 3, where the gate lives. */
async function reachDeclareStep(): Promise<void> {
  render(<OnboardingPage />);
  fireEvent.click(await screen.findByRole('button', { name: /continue/i }));
  await screen.findByText(/3\. declare your projects/i);
}

function saveButton(): HTMLButtonElement {
  return screen
    .getAllByRole('button')
    .find((el) => /pick \d+ more|save projects|saving/i.test(el.textContent ?? '')) as
    | HTMLButtonElement;
}

function pick(name: string): void {
  fireEvent.click(screen.getByLabelText(new RegExp(name, 'i')));
}

afterEach(() => {
  cleanup();
  delete (window as { contextRestorer?: unknown }).contextRestorer;
});

describe('the declaration floor', () => {
  it('states the number the handler enforces, not a local constant', async () => {
    installBridge({ status: statusWith({ minDeclaredProjects: 2 }) });
    await reachDeclareStep();

    // The heading no longer says "(optional)", and the lead quotes the reported
    // floor — a config change moves both without touching this component.
    expect(screen.getByText(/pick at least 2 of the things you are working on/i)).toBeTruthy();
    expect(screen.queryByText(/optional/i)).toBeNull();
  });

  it('disables the save button until the floor is met, and says how many are left', async () => {
    const { declare } = installBridge();
    await reachDeclareStep();

    expect(saveButton().textContent).toMatch(/pick 3 more/i);
    expect(saveButton().disabled).toBe(true);

    pick('api-redesign');
    expect(saveButton().textContent).toMatch(/pick 2 more/i);
    expect(saveButton().disabled).toBe(true);

    pick('billing-migration');
    expect(saveButton().disabled).toBe(true);

    pick('q4-planning');
    expect(saveButton().textContent).toMatch(/save projects/i);
    expect(saveButton().disabled).toBe(false);

    // The old screen's failure mode: a button offering an action whose only
    // outcome was a rejection. Nothing was submitted on the way here.
    expect(declare).not.toHaveBeenCalled();
  });

  it('offers no "Skip for now" path, because the handler would reject it', async () => {
    installBridge();
    await reachDeclareStep();

    expect(screen.queryByRole('button', { name: /skip/i })).toBeNull();
  });

  it('declares the selection once the floor is met', async () => {
    const { declare } = installBridge();
    await reachDeclareStep();

    pick('api-redesign');
    pick('billing-migration');
    pick('q4-planning');
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(declare).toHaveBeenCalledWith(['api-redesign', 'billing-migration', 'q4-planning']),
    );
  });

  it('respects a floor of zero without rendering "pick at least 0"', async () => {
    // `minDeclaredProjects` is a config value and may legitimately be 0.
    installBridge({ status: statusWith({ minDeclaredProjects: 0 }) });
    await reachDeclareStep();

    expect(screen.queryByText(/at least 0/i)).toBeNull();
    expect(screen.getByText(/pick a few of the things you are working on/i)).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
  });
});

describe('rejection reasons', () => {
  it('renders too_few_projects as a sentence, never as the slug', async () => {
    installBridge({
      status: statusWith({ minDeclaredProjects: 0 }),
      declare: async () => ({ ok: false, reason: 'too_few_projects' }),
    });
    await reachDeclareStep();

    // Reachable only because this install's floor is 0 while the handler's is
    // higher — i.e. exactly the drift this fix removes. The handler stays the
    // trust boundary, so its reason still has to read as English.
    fireEvent.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(/too_few_projects/);
    expect(alert.textContent).toMatch(/pick at least/i);
  });

  it('renders an unknown reason verbatim rather than swallowing it', async () => {
    installBridge({
      status: statusWith({ minDeclaredProjects: 0 }),
      declare: async () => ({ ok: false, reason: 'something_new' }),
    });
    await reachDeclareStep();

    fireEvent.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/something_new/);
  });
});
