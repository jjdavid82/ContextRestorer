/**
 * System tray icon and menu.
 *
 * The app is tray-resident: closing the window hides it, it does not quit. The tray is
 * therefore the only guaranteed way back into the UI and must always be present.
 *
 * Since Task 1.7 the tray is also the app's always-visible health readout: the tooltip
 * and a disabled first menu item carry the aggregate source status, so a user whose
 * Slack token expired finds out from the notification area instead of from a briefing
 * that quietly stopped mentioning Slack.
 */
import {
  app,
  Menu,
  Tray,
  nativeImage,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import type { Poller } from '@cr/ingest';
import type { SourceHealth } from './preload.cjs';

/** Tray icon edge length in pixels (16pt is the standard menu-bar/notification-area size). */
const ICON_SIZE = 16;

/**
 * Aggregate health, in the vocabulary the user sees.
 *
 * - `paused`  — the user turned polling off; nothing else matters, it is not a fault.
 * - `auth needed` — at least one source needs the user to reconnect. Only actionable state.
 * - `backoff` — at least one source is failing or being throttled; self-correcting.
 * - `syncing` — no source has reported a successful cycle yet this session.
 * - `ok`      — every source last synced cleanly.
 */
export type TrayStatus = 'ok' | 'syncing' | 'backoff' | 'auth needed' | 'paused';

const STATUS_LABEL: Readonly<Record<TrayStatus, string>> = {
  ok: 'All sources up to date',
  syncing: 'Syncing…',
  backoff: 'Retrying — a source is throttled or failing',
  'auth needed': 'Reconnect required',
  paused: 'Polling paused',
};

let tray: Tray | null = null;
let pollingPaused = false;

/** Latest pushed health, so a pause toggle can re-derive without waiting for a push. */
let lastHealth: SourceHealth[] = [];

/** Set by `createTray`, so the menu can rebuild itself and the pause toggle can act. */
let mainWindow: BrowserWindow | null = null;
let boundPoller: Poller | null = null;

/**
 * Collapse per-source health into the single word the tray shows.
 *
 * Severity order, worst first — the tray has one line and it must spend it on the state
 * that most needs the user's attention, not on an average:
 *
 *   paused > disconnected ("auth needed") > rate-limited/degraded ("backoff") > ok
 *
 * `disconnected` outranks throttling because it is the only state the user can act on;
 * a backoff resolves itself. An empty array is `syncing`, not `ok`: before the first
 * push we genuinely do not know, and claiming "up to date" would be a guess.
 *
 * Pure and exported for `test/tray.test.ts` — the derivation is the one piece of real
 * logic in this module and the rest cannot be unit tested without a running Electron.
 */
export function deriveTrayStatus(statuses: SourceHealth[], paused: boolean): TrayStatus {
  if (paused) return 'paused';
  if (statuses.length === 0) return 'syncing';
  if (statuses.some((s) => s.status === 'disconnected')) return 'auth needed';
  if (statuses.some((s) => s.status === 'rate-limited' || s.status === 'degraded')) {
    return 'backoff';
  }
  return 'ok';
}

/**
 * Build a 16x16 filled-circle icon in memory.
 *
 * Placeholder until real icon art exists — `Tray` refuses to render a zero-byte image on
 * some platforms, and blocking this task on missing assets would be worse than a dot.
 * Replace with `nativeImage.createFromPath(...)` once the asset pipeline lands.
 */
function placeholderIcon(): NativeImage {
  // Electron expects BGRA, premultiplied, row-major.
  const buffer = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4);
  const centre = (ICON_SIZE - 1) / 2;
  const radius = ICON_SIZE / 2 - 1;
  for (let y = 0; y < ICON_SIZE; y += 1) {
    for (let x = 0; x < ICON_SIZE; x += 1) {
      const inside = (x - centre) ** 2 + (y - centre) ** 2 <= radius ** 2;
      if (!inside) continue;
      const offset = (y * ICON_SIZE + x) * 4;
      buffer[offset] = 0x33; // B
      buffer[offset + 1] = 0x33; // G
      buffer[offset + 2] = 0x33; // R
      buffer[offset + 3] = 0xff; // A
    }
  }
  const image = nativeImage.createFromBitmap(buffer, { width: ICON_SIZE, height: ICON_SIZE });
  // Let macOS recolour the icon for light/dark menu bars.
  image.setTemplateImage(true);
  return image;
}

/** Bring the main window to the foreground, restoring it if minimised or hidden. */
function showWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** `slack: ok · 2m behind` — one line per source, shown under the tooltip headline. */
function describeSource(health: SourceHealth): string {
  const lag =
    health.lagMs === null
      ? 'lag unknown'
      : `${Math.max(0, Math.round(health.lagMs / 60_000))}m behind`;
  return `${health.source}: ${health.status} · ${lag}`;
}

function buildMenu(win: BrowserWindow): Menu {
  const status = deriveTrayStatus(lastHealth, pollingPaused);
  const template: MenuItemConstructorOptions[] = [
    // Non-clickable status readout; the menu is rebuilt on every health push.
    { label: STATUS_LABEL[status], enabled: false },
    ...lastHealth.map(
      (health): MenuItemConstructorOptions => ({
        label: `  ${describeSource(health)}`,
        enabled: false,
      }),
    ),
    { type: 'separator' },
    {
      label: 'Open briefing',
      click: () => showWindow(win),
    },
    {
      label: 'Pause polling',
      type: 'checkbox',
      checked: pollingPaused,
      click: (item) => {
        pollingPaused = item.checked;
        // Wired to the real scheduler since Task 1.7. `pause()` stops ALL sources
        // and keeps every cursor, so resuming does not trigger a backfill.
        if (pollingPaused) boundPoller?.pause();
        else boundPoller?.resume();
        refresh();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ];
  return Menu.buildFromTemplate(template);
}

/** Re-render tooltip and menu from `lastHealth` + `pollingPaused`. */
function refresh(): void {
  if (tray === null || mainWindow === null) return;
  const status = deriveTrayStatus(lastHealth, pollingPaused);
  const lines = [`Context Restorer — ${STATUS_LABEL[status]}`, ...lastHealth.map(describeSource)];
  tray.setToolTip(lines.join('\n'));
  tray.setContextMenu(buildMenu(mainWindow));
}

/**
 * Create the tray icon and attach its context menu.
 *
 * @param win The main window, shown by the *Open briefing* item.
 * @param poller Optional scheduler driven by the *Pause polling* toggle. Omitted in
 *               tests and in any startup path where polling is not running.
 * @returns The `Tray` instance; hold a reference or it will be garbage collected and
 *          silently disappear from the notification area.
 */
export function createTray(win: BrowserWindow, poller?: Poller): Tray {
  mainWindow = win;
  boundPoller = poller ?? null;
  tray = new Tray(placeholderIcon());
  refresh();
  // Windows/Linux convention: a plain click opens the app.
  tray.on('click', () => showWindow(win));
  return tray;
}

/**
 * Push the latest source health into the tray. Safe to call before `createTray`
 * (the value is retained and applied when the tray appears) and after `destroyTray`.
 */
export function updateTrayStatus(statuses: SourceHealth[]): void {
  lastHealth = statuses;
  refresh();
}

/** Whether polling is currently paused from the tray. */
export function isPollingPaused(): boolean {
  return pollingPaused;
}

/** Release the tray icon (used on quit and in tests). */
export function destroyTray(): void {
  tray?.destroy();
  tray = null;
  mainWindow = null;
  boundPoller = null;
}
