'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getBridge, hasBridge } from '../../lib/bridge';
import type { BriefingCadence, BriefingScheduleView, OnboardingStatus } from '../../types/bridge';
import { PanelHeading } from './PanelHeading';

/**
 * Recurring-briefing settings (Task 3.8, FR-3 time-based half; OI-4). One of the
 * panels in the two-pane `settings/page.tsx`.
 *
 * Existing schedules are toggled on/off in place via `schedule:setEnabled` —
 * never deleted, so re-enabling one does not reset `last_fired_at` and re-serve
 * a window it already covered.
 *
 * ## No cron, deliberately
 * `0 8 * * 1-5` is a small programming language whose failure mode is silence.
 * The three cadences here — "each morning / each weekday / once a week" — cover
 * what this product is for and are each a plain choice.
 *
 * ## Quiet hours mute, they do not cancel
 * The briefing is always generated; only the notification is withheld. The copy
 * says so explicitly — a user who reads "quiet hours" as "no briefing" would
 * wake up believing they had lost the overnight context.
 */

const RECURRENCE_OPTIONS: ReadonlyArray<{ value: BriefingCadence; label: string; hint: string }> = [
  { value: 'daily', label: 'Every day', hint: 'A single catch-up, every day' },
  { value: 'weekdays', label: 'Weekdays only', hint: 'Monday to Friday' },
  { value: 'weekly', label: 'Once a week', hint: 'On the day you pick' },
];

/** 0 = Sunday … 6 = Saturday, matching `briefing_schedules.weekday`. */
const WEEKDAY_LABELS: readonly string[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const DEFAULT_TIME = '08:00';
const DEFAULT_QUIET_FROM = '22:00';
const DEFAULT_QUIET_TO = '07:00';

/** Render an unknown thrown value as something a human can read. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Split an `<input type="time">` value into whole hours and minutes. Returns
 * `null` for the empty string (what the control reports mid-type) — treating
 * that as `00:00` would silently save a midnight briefing nobody asked for.
 */
function parseTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** `8, 0` → `"08:00"`, the only format `<input type="time">` accepts. */
function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** One-line human summary of a saved schedule. */
function summarize(schedule: BriefingScheduleView): string {
  const at = formatTime(schedule.hourLocal, schedule.minuteLocal);
  const when =
    schedule.cadence === 'daily'
      ? 'Every day'
      : schedule.cadence === 'weekdays'
        ? 'Weekdays'
        : `Every ${WEEKDAY_LABELS[schedule.weekday ?? 1] ?? 'week'}`;
  const quiet =
    schedule.quietFrom !== null && schedule.quietTo !== null
      ? ` — notifications muted ${formatTime(schedule.quietFrom, 0)}–${formatTime(schedule.quietTo, 0)}`
      : '';
  return `${when} at ${at}${quiet}`;
}

const FIELD_SX = { display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 420 } as const;

export default function ScheduleSettings(): ReactNode {
  const [saved, setSaved] = useState<BriefingScheduleView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [recurrence, setRecurrence] = useState<BriefingCadence>('daily');
  const [time, setTime] = useState(DEFAULT_TIME);
  const [weekday, setWeekday] = useState(1); // Monday
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [quietFrom, setQuietFrom] = useState(DEFAULT_QUIET_FROM);
  const [quietTo, setQuietTo] = useState(DEFAULT_QUIET_TO);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await getBridge().schedule.list();
      setSaved(list);
      setLoadError(null);
    } catch (cause) {
      setLoadError(describe(cause));
    }
  }, []);

  useEffect(() => {
    // `getBridge()` throws synchronously outside the Electron shell — guard so
    // the whole settings screen does not fall to an error boundary in a plain
    // browser / during static export.
    if (!hasBridge()) {
      setLoadError('Schedules are only available inside the Context Restorer desktop app.');
      return;
    }
    void refresh();
    try {
      getBridge()
        .onboarding.status()
        .then(setStatus)
        .catch((cause: unknown) => setStatusError(describe(cause)));
    } catch (cause) {
      setStatusError(describe(cause));
    }
  }, [refresh]);

  const save = useCallback(async (): Promise<void> => {
    const at = parseTime(time);
    if (at === null) {
      setSaveError('pick a time first');
      return;
    }
    // Quiet hours are stored as whole local hours; the minutes of these inputs
    // are ignored rather than silently rounded — see the hint text.
    const from = quietEnabled ? parseTime(quietFrom) : null;
    const to = quietEnabled ? parseTime(quietTo) : null;
    if (quietEnabled && (from === null || to === null)) {
      setSaveError('quiet hours need both a start and an end');
      return;
    }

    setBusy(true);
    setSaveError(null);
    try {
      const result = await getBridge().schedule.create({
        cadence: recurrence,
        hourLocal: at.hour,
        minuteLocal: at.minute,
        weekday: recurrence === 'weekly' ? weekday : null,
        quietFrom: from?.hour ?? null,
        quietTo: to?.hour ?? null,
      });
      if (!result.ok) {
        setSaveError(result.reason ?? 'the schedule was rejected');
        return;
      }
      await refresh();
    } catch (cause) {
      setSaveError(describe(cause));
    } finally {
      setBusy(false);
    }
  }, [quietEnabled, quietFrom, quietTo, recurrence, refresh, time, weekday]);

  const toggle = useCallback(
    async (schedule: BriefingScheduleView): Promise<void> => {
      setBusy(true);
      try {
        const result = await getBridge().schedule.setEnabled(schedule.scheduleId, !schedule.enabled);
        if (!result.ok) setSaveError(result.reason ?? 'could not change the schedule');
        await refresh();
      } catch (cause) {
        setSaveError(describe(cause));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return (
    <Box>
      <PanelHeading
        title="Briefing schedule"
        lead="Context Restorer can put a briefing together on a schedule, covering everything since the last one."
      />

      {loadError !== null ? (
        <Typography role="alert" sx={{ color: 'error.main', mb: 2 }}>
          {loadError}
        </Typography>
      ) : null}

      {statusError !== null ? (
        <Typography role="alert" sx={{ color: 'error.main', mb: 2 }}>
          Could not load status: {statusError}
        </Typography>
      ) : status !== null ? (
        <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem', mb: 3 }}>
          {status.projectsDeclared.length > 0
            ? `Projects declared: ${status.projectsDeclared.join(', ')}. `
            : 'No projects declared yet. '}
          {status.ollamaReady ? 'Ollama is ready to generate briefings.' : 'Ollama is not ready yet.'}
        </Typography>
      ) : null}

      {saved.length > 0 ? (
        <Box sx={{ mb: 3 }}>
          <Typography component="h3" sx={{ fontSize: '0.95rem', fontWeight: 650, mb: 1 }}>
            Active
          </Typography>
          <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {saved.map((schedule) => (
              <Box
                component="li"
                key={schedule.scheduleId}
                sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}
              >
                <Typography sx={{ fontSize: '0.9rem' }}>{summarize(schedule)}</Typography>
                <Chip
                  size="small"
                  variant="outlined"
                  color={schedule.enabled ? 'success' : 'default'}
                  label={schedule.enabled ? 'on' : 'off'}
                />
                <Button size="small" variant="outlined" disabled={busy} onClick={() => void toggle(schedule)}>
                  {schedule.enabled ? 'Turn off' : 'Turn on'}
                </Button>
              </Box>
            ))}
          </Box>
        </Box>
      ) : (
        <Typography sx={{ color: 'text.secondary', mb: 3 }}>
          Nothing scheduled yet — set one up below.
        </Typography>
      )}

      <Typography component="h3" sx={{ fontSize: '0.95rem', fontWeight: 650, mb: 1.5 }}>
        {saved.length > 0 ? 'Add another' : 'New schedule'}
      </Typography>

      <Box sx={FIELD_SX}>
        <FormControl>
          <FormLabel id="cadence-label" sx={{ fontSize: '0.8rem', mb: 0.5 }}>
            How often
          </FormLabel>
          <RadioGroup
            aria-labelledby="cadence-label"
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value as BriefingCadence)}
          >
            {RECURRENCE_OPTIONS.map((option) => (
              <FormControlLabel
                key={option.value}
                value={option.value}
                control={<Radio size="small" />}
                label={
                  <Box>
                    <Typography sx={{ fontSize: '0.9rem' }}>{option.label}</Typography>
                    <Typography sx={{ fontSize: '0.78rem', color: 'text.secondary' }}>
                      {option.hint}
                    </Typography>
                  </Box>
                }
              />
            ))}
          </RadioGroup>
        </FormControl>

        {recurrence === 'weekly' ? (
          <TextField
            select
            size="small"
            label="Day"
            value={weekday}
            onChange={(e) => setWeekday(Number(e.target.value))}
          >
            {WEEKDAY_LABELS.map((label, index) => (
              <MenuItem key={label} value={index}>
                {label}
              </MenuItem>
            ))}
          </TextField>
        ) : null}

        <TextField
          type="time"
          size="small"
          label="At"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          helperText="Your local time. Daylight saving is handled for you."
          slotProps={{ inputLabel: { shrink: true } }}
        />

        <FormControlLabel
          control={
            <Switch
              checked={quietEnabled}
              onChange={(e) => setQuietEnabled(e.target.checked)}
            />
          }
          label="Quiet hours — do not notify me during these hours"
        />

        {quietEnabled ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Box sx={{ display: 'flex', gap: 1.5 }}>
              <TextField
                type="time"
                size="small"
                label="From"
                value={quietFrom}
                onChange={(e) => setQuietFrom(e.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <TextField
                type="time"
                size="small"
                label="To"
                value={quietTo}
                onChange={(e) => setQuietTo(e.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
              />
            </Box>
            {/* Load-bearing copy: a user who reads this as "no briefing" would
                wake up thinking they had lost the overnight context. */}
            <Typography sx={{ fontSize: '0.78rem', color: 'text.secondary' }}>
              The briefing is still written during quiet hours — only the notification is held
              back. Quiet hours are set to the nearest hour.
            </Typography>
          </Box>
        ) : null}

        {saveError !== null ? (
          <Typography role="alert" sx={{ color: 'error.main' }}>
            Could not save: {saveError}
          </Typography>
        ) : null}

        <Box>
          <Button variant="contained" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Add schedule'}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
