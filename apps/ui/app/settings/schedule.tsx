'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getBridge } from '../../lib/bridge';
import type { BriefingCadence, BriefingScheduleView, OnboardingStatus } from '../../types/bridge';
import BriefingWindowSettings from './briefingWindow';
import LocalMetricsPanel from './metrics';
import ModelSettings from './model';
import SlackChannelSettings from './channels';

/**
 * Recurring-briefing settings (Task 3.8, FR-3 time-based half; OI-4).
 *
 * One card: existing schedules (each toggled on/off in place, via
 * `schedule:setEnabled` — never deleted, so re-enabling one does not reset
 * `last_fired_at` and re-serve a window it already covered) sit above the
 * form that adds another. No separate "Off" cadence: the per-schedule toggle
 * already covers pausing one, so a second "off" control here would just be
 * two ways to do the same thing.
 *
 * ## No cron, deliberately
 *
 * The obvious implementation of "let the user pick a recurrence" is a cron
 * field, and it is the wrong one. `0 8 * * 1-5` is a small programming language
 * whose failure mode is silence: get it wrong and nothing happens, with no
 * error to read. The three cadences here cover what this product is actually
 * for — "tell me what I missed, each morning / each weekday / once a week" —
 * and every one of them is expressible with a plain dropdown.
 *
 * ## Quiet hours mute, they do not cancel
 *
 * The copy says so explicitly. A user who reads "quiet hours" as "no briefing"
 * would wake up believing they had no overnight context, when in fact it is
 * sitting there. The briefing is always generated; only the notification is
 * withheld.
 *
 * Styled via the same shared tokens/control classes as onboarding
 * (`.card`, `.btn`, `.field-row`, `.status-chip`) — see `globals.css`.
 */

const RECURRENCE_OPTIONS: ReadonlyArray<{ value: BriefingCadence; label: string }> = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays only' },
  { value: 'weekly', label: 'Once a week' },
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
 * Split an `<input type="time">` value into whole hours and minutes.
 *
 * Returns `null` for the empty string, which is what the control reports while
 * the user is still typing — treating that as `00:00` would silently save a
 * midnight briefing nobody asked for.
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
    void refresh();
  }, [refresh]);

  useEffect(() => {
    getBridge()
      .onboarding.status()
      .then(setStatus)
      .catch((cause: unknown) => setStatusError(describe(cause)));
  }, []);

  const save = useCallback(async (): Promise<void> => {
    const at = parseTime(time);
    if (at === null) {
      setSaveError('pick a time first');
      return;
    }

    // Quiet hours are stored as whole local hours, so the minutes of these two
    // inputs are ignored rather than silently rounded — see the hint text.
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
    <main className="stack-main">
      <h1 className="page-title">Recurring briefings</h1>
      <p>
        Context Restorer can put together a briefing on a schedule, covering everything since your
        last one.
      </p>

      {loadError !== null ? <p role="alert">Could not load your schedules: {loadError}</p> : null}

      {/* The range "Brief me on what I missed" defaults to — moved here from
          Home, edited here rather than on the page whose job is showing the
          result. */}
      <BriefingWindowSettings />

      <section className="card">
        <h2>Status</h2>
        {statusError !== null ? (
          <p role="alert">Could not load status: {statusError}</p>
        ) : status === null ? (
          <p>Loading status…</p>
        ) : (
          <dl>
            <dt>Projects declared</dt>
            <dd>
              {status.projectsDeclared.length > 0 ? status.projectsDeclared.join(', ') : 'none'}
            </dd>
            <dt>Ollama</dt>
            <dd>{status.ollamaReady ? 'Ready to generate briefings' : 'Not ready yet'}</dd>
          </dl>
        )}
      </section>

      {/* Chat-model picker: a separate component and a separate channel,
          reachable from the same settings screen — same reasoning as
          `SlackChannelSettings`/`LocalMetricsPanel` below. */}
      <ModelSettings />

      <section className="card">
        <h2>Schedule</h2>

        {saved.length > 0 ? (
          <>
            <h3>Active</h3>
            <ul className="schedule-list list-reset">
              {saved.map((schedule) => (
                <li key={schedule.scheduleId} className="schedule-list__item">
                  <span>{summarize(schedule)}</span>{' '}
                  <span
                    className={`status-chip ${schedule.enabled ? 'status-chip--on' : 'status-chip--off'}`}
                  >
                    {schedule.enabled ? 'on' : 'off'}
                  </span>{' '}
                  <button
                    type="button"
                    className="btn btn--secondary"
                    disabled={busy}
                    onClick={() => void toggle(schedule)}
                  >
                    {schedule.enabled ? 'Turn off' : 'Turn on'}
                  </button>
                </li>
              ))}
            </ul>
            <h3>Add another</h3>
          </>
        ) : (
          <p>Nothing scheduled yet — set one up below.</p>
        )}

        <div className="field-row">
          <label>
            How often:{' '}
            <select
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value as BriefingCadence)}
            >
              {RECURRENCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {recurrence === 'weekly' ? (
          <div className="field-row">
            <label>
              Day:{' '}
              <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                {WEEKDAY_LABELS.map((label, index) => (
                  <option key={label} value={index}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        <div className="field-row">
          <label>
            At:{' '}
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>{' '}
          <small>Your local time. Daylight saving is handled for you.</small>
        </div>

        <div className="field-row">
          <label>
            <input
              type="checkbox"
              checked={quietEnabled}
              onChange={(e) => setQuietEnabled(e.target.checked)}
            />{' '}
            Quiet hours — do not notify me during these hours
          </label>
        </div>
        {quietEnabled ? (
          <div className="field-row">
            <label>
              From:{' '}
              <input type="time" value={quietFrom} onChange={(e) => setQuietFrom(e.target.value)} />
            </label>{' '}
            <label>
              To:{' '}
              <input type="time" value={quietTo} onChange={(e) => setQuietTo(e.target.value)} />
            </label>{' '}
            {/* Load-bearing copy: a user who reads this as "no briefing" would
                wake up thinking they had lost the overnight context. */}
            <small>
              The briefing is still written during quiet hours — only the notification is held
              back. Quiet hours are set to the nearest hour.
            </small>
          </div>
        ) : null}

        {saveError !== null ? <p role="alert">Could not save: {saveError}</p> : null}

        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Add schedule'}
        </button>
      </section>

      {/* Slack channel selector: closes Task 1.7's gap. A separate component
          and separate channels, reachable from the same settings screen. */}
      <SlackChannelSettings />

      {/* Task 4.4 step 4: the local metrics view. A separate component, and a
          separate channel, because it shares nothing with the recurrence editor
          beyond being reachable from the same screen. */}
      <LocalMetricsPanel />
    </main>
  );
}
