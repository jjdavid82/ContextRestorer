import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ProjectSettings from '../app/settings/projects';
import type { ContextRestorerBridge, DeclaredProject, OkResult } from '../types/bridge';

/**
 * Settings → Projects panel (`app/settings/projects.tsx`).
 *
 * The panel is a thin shell over three bridge calls; what is worth pinning is
 * that remove is a two-tap (arm, then confirm) and that both add and remove
 * re-fetch the list rather than mutating it locally.
 */

interface BridgeParts {
  list: () => Promise<DeclaredProject[]>;
  declare?: (names: string[]) => Promise<OkResult>;
  remove?: (projectId: string) => Promise<OkResult>;
}

function installBridge(parts: BridgeParts): void {
  const bridge = {
    projects: {
      suggest: vi.fn(async () => ({ candidates: [] })),
      list: parts.list,
      declare: parts.declare ?? vi.fn(async () => ({ ok: true })),
      remove: parts.remove ?? vi.fn(async () => ({ ok: true })),
    },
  };
  window.contextRestorer = bridge as unknown as ContextRestorerBridge;
}

const P = (id: string, name: string): DeclaredProject => ({ projectId: id, name });

afterEach(() => {
  cleanup();
  // @ts-expect-error — the global is declared always-present; tests own it.
  delete window.contextRestorer;
});

describe('ProjectSettings', () => {
  it('lists the declared projects', async () => {
    installBridge({ list: vi.fn(async () => [P('p1', 'Migration'), P('p2', 'Billing')]) });
    render(<ProjectSettings />);

    expect(await screen.findByText('Migration')).toBeTruthy();
    expect(screen.getByText('Billing')).toBeTruthy();
  });

  it('shows the empty state when nothing is declared', async () => {
    installBridge({ list: vi.fn(async () => []) });
    render(<ProjectSettings />);

    expect(await screen.findByText(/No projects declared yet/i)).toBeTruthy();
  });

  it('removes a project only after the confirm tap, then re-fetches', async () => {
    const list = vi
      .fn<() => Promise<DeclaredProject[]>>()
      .mockResolvedValueOnce([P('p1', 'Migration')])
      .mockResolvedValue([]);
    const remove = vi.fn(async () => ({ ok: true }));
    installBridge({ list, remove });
    render(<ProjectSettings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    // Armed, not fired.
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('p1'));
    expect(list).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/No projects declared yet/i)).toBeTruthy();
  });

  it('adds a project through projects.declare and clears the field', async () => {
    const list = vi
      .fn<() => Promise<DeclaredProject[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValue([P('p9', 'Q3 migration')]);
    const declare = vi.fn(async () => ({ ok: true }));
    installBridge({ list, declare });
    render(<ProjectSettings />);

    await screen.findByText(/No projects declared yet/i);
    const field = screen.getByLabelText('Add a project') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '  Q3 migration  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(declare).toHaveBeenCalledWith(['Q3 migration']));
    expect(await screen.findByText('Q3 migration')).toBeTruthy();
    expect(field.value).toBe('');
  });

  it('surfaces a rejected removal', async () => {
    installBridge({
      list: vi.fn(async () => [P('p1', 'Migration')]),
      remove: vi.fn(async () => ({ ok: false, reason: 'not_found' })),
    });
    render(<ProjectSettings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));

    expect(await screen.findByText(/not_found/)).toBeTruthy();
  });
});
