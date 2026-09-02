/**
 * Thin wrapper over Electron's native notifications.
 *
 * Kept behind a function so callers never have to branch on platform support, and so a
 * later task can route notifications through user preferences (quiet hours, per-source
 * muting) in exactly one place.
 */
import { Notification } from 'electron';

export interface NotifyOptions {
  title: string;
  body: string;
}

/**
 * Show a desktop notification. No-ops (with a warning) where the OS or desktop
 * environment offers no notification service — e.g. a bare Linux session.
 */
export function notify(opts: NotifyOptions): void {
  if (!Notification.isSupported()) {
    console.warn('[notifications] not supported on this platform; dropping:', opts.title);
    return;
  }
  new Notification({ title: opts.title, body: opts.body }).show();
}
