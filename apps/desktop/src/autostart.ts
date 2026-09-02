/**
 * Launch-at-login registration.
 *
 * The app is a resident tray application, so it starts hidden: the user gets a tray icon
 * and background polling, not a window stealing focus at every boot.
 */
import { app } from 'electron';

/**
 * Register (or clear) the OS login item.
 *
 * @param enabled `true` to start at login, `false` to remove the login item.
 *
 * No-ops during development: `setLoginItemSettings` would otherwise register the
 * Electron dev binary rather than the packaged app.
 */
export function registerAutostart(enabled = true): void {
  if (!app.isPackaged) {
    console.warn('[autostart] skipped: not a packaged build');
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
}

/** Whether the OS currently reports the app as a login item. */
export function isAutostartEnabled(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}
