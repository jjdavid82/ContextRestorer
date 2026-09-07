import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

// MUI base component styles — a real, static stylesheet emitted at build time by
// Pigment CSS, so it is served from `app://` as a normal `'self'` resource and
// nothing is injected at runtime. Must be imported before `globals.css` so the
// app's own app-shell rules win on any genuine collision.
import '@mui/material-pigment-css/styles.css';

import { AppShell } from '../components/AppShell';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Context Restorer',
  description: 'Local-first briefing on what you missed.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * Root layout for the App Router.
 *
 * No font loaders — they fetch at build time and inline absolute URLs that
 * break the `app://` static export; the theme (`mui-theme.mjs`) uses the system
 * font stack. Styling is MUI + Pigment CSS (build-time extraction, no runtime
 * `<style>`); `globals.css` is now just a handful of app-shell rules MUI does
 * not own.
 *
 * `AppShell` (the persistent nav rail + `<main>`) is a client component because
 * its active-link highlight needs `usePathname`; the links inside it stay plain
 * `<a href="/…/index.html">` for the `app://` fixed-host scheme (see `AppShell`
 * and `next.config.js`).
 */
export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
