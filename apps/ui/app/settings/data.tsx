'use client';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getBridge, hasBridge } from '../../lib/bridge';
import type { DataSummary, DeleteEverythingReport } from '../../types/bridge';
import { PanelHeading } from './PanelHeading';

/**
 * "Your data" — SEC-8's right to delete, and the retention promise, as a
 * screen.
 *
 * Both halves existed in `packages/store/src/retention.ts` from Phase 0 with no
 * caller anywhere, while the README told whoever received a build that raw
 * payloads age out after 90 days and that erasure was available on demand.
 * This panel and `scheduler/retentionPurge.ts` are what make those two
 * sentences true.
 *
 * ### Why the counts come first
 *
 * Erasure is irreversible and the app is the only copy: there is no export, no
 * sync, and no undo. A user cannot consent to erasing something they were never
 * shown, so the numbers are the top of the panel and the button is the bottom
 * of it. `totalRows` is stated alongside the friendly counts because the
 * friendly ones are a selection — the wipe empties every table, including ones
 * with no human-readable name.
 *
 * ### Why a typed phrase and not a dialog
 *
 * `window.confirm` is blocked by this window's configuration, and a second
 * button is not friction, it is just a second click. Typing the word is the
 * cheapest gesture that cannot be produced by a mis-click, and the same phrase
 * is re-checked in the main process (`ipc/privacy.ts`) so the gate is not
 * merely cosmetic.
 */

/** The phrase the user types to confirm. Mirrors `CONFIRM_PHRASE` in `ipc/privacy.ts`. */
const CONFIRM_PHRASE = 'DELETE';

/** Render an unknown thrown value as something a human can read. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** `1,234` — thousands separators, so six-figure row counts stay readable. */
function count(n: number): string {
  return n.toLocaleString();
}

/** A stored date as a plain local date, or a dash when nothing is stored. */
function since(atMs: number | null): string {
  if (atMs === null) return '—';
  return new Date(atMs).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** One `label — value` row of the summary. */
function SummaryRow({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <Box
      component="li"
      sx={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 2,
        py: 0.75,
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Typography component="span" sx={{ fontSize: 14, color: 'text.secondary' }}>
        {label}
      </Typography>
      <Typography component="span" sx={{ fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </Typography>
    </Box>
  );
}

/**
 * Turn a completed report into one honest sentence.
 *
 * A wipe whose SQLite half committed IS a successful erasure — that is where
 * the messages live — so a failed vector eviction or an unlinkable narrative
 * file is disclosed as a remainder rather than presented as a failure. The
 * inverse (a green tick over a partial wipe) is the failure mode this function
 * exists to prevent.
 */
function describeReport(report: DeleteEverythingReport): { severity: 'success' | 'warning'; text: string } {
  const parts = [`Deleted ${count(report.rowsDeleted ?? 0)} stored records`];
  if (report.vectorsDeleted !== null && report.vectorsDeleted !== undefined) {
    parts.push(`${count(report.vectorsDeleted)} search index entries`);
  }
  if (report.filesDeleted !== undefined && report.filesDeleted > 0) {
    parts.push(`${count(report.filesDeleted)} briefing files`);
  }
  if (report.credentialsRevoked !== undefined && report.credentialsRevoked.length > 0) {
    parts.push(`and disconnected ${report.credentialsRevoked.join(' and ')}`);
  }

  const incomplete = report.incomplete ?? [];
  if (incomplete.length === 0) {
    return { severity: 'success', text: `${parts.join(', ')}.` };
  }

  const remainder: Record<string, string> = {
    vectors: 'the local search index could not be cleared',
    files: 'some briefing files could not be removed',
    credentials: 'a source credential could not be revoked',
  };
  const named = incomplete.map((step) => remainder[step] ?? step);
  return {
    severity: 'warning',
    text: `${parts.join(', ')}. Your messages and summaries are gone, but ${named.join('; ')} — restart the app and try again to finish clearing it.`,
  };
}

export default function DataSettings(): ReactNode {
  const [summary, setSummary] = useState<DataSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<DeleteEverythingReport | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      setSummary(await getBridge().privacy.stats());
    } catch (cause) {
      // Deliberately NOT degraded to zeroes: "we could not read your data" and
      // "you have no data" must never look the same on this screen.
      setLoadError(describe(cause));
    }
  }, []);

  useEffect(() => {
    if (!hasBridge()) {
      setLoadError('Your data is only available inside the Context Restorer desktop app.');
      return;
    }
    void refresh();
  }, [refresh]);

  const erase = useCallback(async (): Promise<void> => {
    setBusy(true);
    setDeleteError(null);
    setReport(null);
    try {
      const result = await getBridge().privacy.deleteEverything(CONFIRM_PHRASE);
      if (result.ok) {
        setReport(result);
        setConfirm('');
        await refresh();
      } else {
        setDeleteError(
          result.reason === 'not_confirmed'
            ? 'the confirmation did not match, so nothing was deleted'
            : result.reason === 'store_error'
              ? 'the database could not be cleared, so nothing was deleted'
              : (result.reason ?? 'the request was rejected'),
        );
      }
    } catch (cause) {
      setDeleteError(describe(cause));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const armed = confirm.trim().toUpperCase() === CONFIRM_PHRASE;
  const outcome = report === null ? null : describeReport(report);

  return (
    <Box>
      <PanelHeading
        title="Your data"
        lead="Everything Context Restorer knows lives on this machine — a database, a local search index, and your source credentials in the OS keychain. Nothing is uploaded, and nothing here is recoverable once deleted."
      />

      {loadError !== null ? (
        <Typography role="alert" sx={{ color: 'error.main' }}>
          Could not read your data: {loadError}
        </Typography>
      ) : summary === null ? (
        <Typography sx={{ color: 'text.secondary' }}>Loading…</Typography>
      ) : (
        <>
          <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0, mb: 2, maxWidth: 460 }}>
            <SummaryRow label="Messages stored" value={count(summary.messages)} />
            <SummaryRow label="Changes summarized" value={count(summary.summaries)} />
            <SummaryRow label="Briefings written" value={count(summary.briefings)} />
            <SummaryRow label="Things needing you" value={count(summary.obligations)} />
            <SummaryRow label="Oldest message" value={since(summary.oldestEventAt)} />
            <SummaryRow label="Records in total" value={count(summary.totalRows)} />
          </Box>

          <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem', mb: 3, maxWidth: '58ch' }}>
            Raw message text is deleted automatically after {summary.retentionDays} days; the
            summaries derived from it are kept, because those are what a briefing is made of.
            {summary.expiredRawEvents > 0
              ? ` ${count(summary.expiredRawEvents)} message${summary.expiredRawEvents === 1 ? '' : 's'} ${summary.expiredRawEvents === 1 ? 'is' : 'are'} past that point and will go on the next daily sweep.`
              : ' Nothing is past that point right now.'}
          </Typography>

          <Typography component="h3" sx={{ fontSize: '1rem', fontWeight: 650, mb: 1 }}>
            Delete everything
          </Typography>
          <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem', mb: 2, maxWidth: '58ch' }}>
            Erases every message, summary, briefing and project from this machine, clears the
            local search index, and{' '}
            {summary.connectedSources.length > 0
              ? `disconnects ${summary.connectedSources.join(' and ')}`
              : 'removes any stored source credentials'}
            . There is no undo and no copy anywhere else. Type{' '}
            <Box component="strong">{CONFIRM_PHRASE}</Box> to confirm.
          </Typography>

          <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <TextField
              size="small"
              label={`Type ${CONFIRM_PHRASE}`}
              value={confirm}
              disabled={busy}
              onChange={(e) => setConfirm(e.target.value)}
              sx={{ width: 200 }}
              slotProps={{ htmlInput: { autoComplete: 'off', spellCheck: false } }}
            />
            <Button
              variant="contained"
              color="error"
              disabled={busy || !armed}
              onClick={() => void erase()}
              sx={{ mt: 0.25 }}
            >
              {busy ? 'Deleting…' : 'Delete everything'}
            </Button>
          </Box>
        </>
      )}

      {outcome !== null ? (
        <Alert severity={outcome.severity} role="status" sx={{ mt: 2.5, maxWidth: '58ch' }}>
          {outcome.text}
        </Alert>
      ) : null}
      {deleteError !== null ? (
        <Typography role="alert" sx={{ color: 'error.main', mt: 2.5 }}>
          Could not delete: {deleteError}
        </Typography>
      ) : null}
    </Box>
  );
}
