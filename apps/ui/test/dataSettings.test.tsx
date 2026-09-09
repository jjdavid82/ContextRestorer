import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DataSettings from '../app/settings/data';
import type {
  ContextRestorerBridge,
  DataSummary,
  DeleteEverythingReport,
} from '../types/bridge';

/**
 * The "Your data" settings panel (`app/settings/data.tsx`) — SEC-8's user-facing
 * half.
 *
 * This is the only screen in the app that can destroy data, so the properties
 * pinned here are about what it refuses to do and what it refuses to hide:
 *
 *  - the delete button is unreachable until the confirmation phrase is typed;
 *  - a read failure never renders as zeroes ("we could not read your data" and
 *    "you have no data" must not look the same here);
 *  - a partial wipe is reported as a warning that names the remainder, not as a
 *    success tick.
 *
 * Only the `privacy` member is stubbed; the object is cast at the `window`
 * assignment, the same way `railStatus.test.tsx` does it.
 */

const SUMMARY: DataSummary = {
  messages: 1_204,
  summaries: 87,
  briefings: 12,
  obligations: 5,
  totalRows: 1_308,
  oldestEventAt: Date.UTC(2026, 5, 1),
  expiredRawEvents: 300,
  retentionDays: 90,
  connectedSources: ['slack', 'gmail'],
};

function installBridge(overrides: {
  stats?: () => Promise<DataSummary>;
  deleteEverything?: (confirm: string) => Promise<DeleteEverythingReport>;
}) {
  const deleteEverything = vi.fn(
    overrides.deleteEverything ?? (async () => ({ ok: true, rowsDeleted: 1_308 })),
  );
  const stats = vi.fn(overrides.stats ?? (async () => SUMMARY));

  window.contextRestorer = {
    privacy: { stats, deleteEverything },
  } as unknown as ContextRestorerBridge;

  return { stats, deleteEverything };
}

/** Type the phrase into the confirmation field. */
function type(value: string): void {
  fireEvent.change(screen.getByLabelText(/type delete/i), { target: { value } });
}

function deleteButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /delete everything/i }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  delete (window as { contextRestorer?: unknown }).contextRestorer;
});

describe('what is stored', () => {
  it('shows the friendly counts and the total across every table', async () => {
    installBridge({});
    render(<DataSettings />);

    expect(await screen.findByText('1,204')).toBeTruthy();
    expect(screen.getByText('87')).toBeTruthy();
    // The total is deliberately larger than the four named counts: the wipe
    // empties tables the panel does not name, and this number discloses that.
    expect(screen.getByText('1,308')).toBeTruthy();
  });

  it('states the retention promise as a number, with what is already past it', async () => {
    installBridge({});
    render(<DataSettings />);

    expect(await screen.findByText(/deleted automatically after 90 days/i)).toBeTruthy();
    expect(screen.getByText(/300 messages are past that point/i)).toBeTruthy();
  });

  it('says nothing is expiring when nothing is', async () => {
    installBridge({ stats: async () => ({ ...SUMMARY, expiredRawEvents: 0 }) });
    render(<DataSettings />);

    expect(await screen.findByText(/nothing is past that point right now/i)).toBeTruthy();
  });

  it('names the sources a wipe would disconnect', async () => {
    installBridge({});
    render(<DataSettings />);

    expect(await screen.findByText(/disconnects slack and gmail/i)).toBeTruthy();
  });

  it('renders a read failure as a failure, never as zeroes', async () => {
    installBridge({
      stats: async () => {
        throw new Error('database is locked');
      },
    });
    render(<DataSettings />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not read your data/i);
    expect(alert.textContent).toMatch(/database is locked/i);
    // And crucially: no delete control at all, because the panel cannot say
    // what would be deleted.
    expect(screen.queryByRole('button', { name: /delete everything/i })).toBeNull();
  });
});

describe('the confirmation gate', () => {
  it('keeps the button disabled until the exact phrase is typed', async () => {
    const { deleteEverything } = installBridge({});
    render(<DataSettings />);
    await screen.findByText('1,204');

    expect(deleteButton().disabled).toBe(true);

    type('DELET');
    expect(deleteButton().disabled).toBe(true);

    type('delete everything');
    expect(deleteButton().disabled).toBe(true);

    type('DELETE');
    expect(deleteButton().disabled).toBe(false);

    expect(deleteEverything).not.toHaveBeenCalled();
  });

  it('accepts the phrase in any case, trimmed — the friction is intent, not spelling', async () => {
    installBridge({});
    render(<DataSettings />);
    await screen.findByText('1,204');

    type('  delete ');
    expect(deleteButton().disabled).toBe(false);
  });

  it('sends the canonical phrase, not whatever the user typed', async () => {
    const { deleteEverything } = installBridge({});
    render(<DataSettings />);
    await screen.findByText('1,204');

    type('delete');
    fireEvent.click(deleteButton());

    await waitFor(() => expect(deleteEverything).toHaveBeenCalledWith('DELETE'));
  });
});

describe('reporting the outcome', () => {
  it('reports a clean wipe as a success, naming each step', async () => {
    installBridge({
      deleteEverything: async () => ({
        ok: true,
        rowsDeleted: 1_308,
        vectorsDeleted: 940,
        filesDeleted: 12,
        credentialsRevoked: ['slack', 'gmail'],
        incomplete: [],
      }),
    });
    render(<DataSettings />);
    await screen.findByText('1,204');

    type('DELETE');
    fireEvent.click(deleteButton());

    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/deleted 1,308 stored records/i);
    expect(status.textContent).toMatch(/940 search index entries/i);
    expect(status.textContent).toMatch(/disconnected slack and gmail/i);
    expect(status.className).not.toMatch(/Warning/);
  });

  it('reports a partial wipe as a warning that names the remainder', async () => {
    installBridge({
      deleteEverything: async () => ({
        ok: true,
        rowsDeleted: 1_308,
        vectorsDeleted: null,
        filesDeleted: 0,
        incomplete: ['vectors'],
      }),
    });
    render(<DataSettings />);
    await screen.findByText('1,204');

    type('DELETE');
    fireEvent.click(deleteButton());

    const status = await screen.findByRole('status');
    // Both halves of the truth: the messages are gone, and the index is not.
    expect(status.textContent).toMatch(/your messages and summaries are gone/i);
    expect(status.textContent).toMatch(/search index could not be cleared/i);
  });

  it('turns a rejection reason into a sentence, and does not claim anything was deleted', async () => {
    installBridge({
      deleteEverything: async () => ({ ok: false, reason: 'store_error' }),
    });
    render(<DataSettings />);
    await screen.findByText('1,204');

    type('DELETE');
    fireEvent.click(deleteButton());

    await waitFor(() => {
      const alerts = screen.getAllByRole('alert');
      const text = alerts.map((el) => el.textContent).join(' ');
      expect(text).toMatch(/database could not be cleared, so nothing was deleted/i);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('re-reads the summary after a wipe, so the panel does not show stale counts', async () => {
    const { stats } = installBridge({});
    render(<DataSettings />);
    await screen.findByText('1,204');
    expect(stats).toHaveBeenCalledTimes(1);

    type('DELETE');
    fireEvent.click(deleteButton());

    await waitFor(() => expect(stats).toHaveBeenCalledTimes(2));
  });
});

describe('outside Electron', () => {
  it('explains itself instead of throwing when there is no bridge', async () => {
    render(<DataSettings />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/only available inside the context restorer desktop app/i);
  });
});
