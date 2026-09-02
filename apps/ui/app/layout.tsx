import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

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
 * Intentionally dependency-free: no font loaders (they fetch at build time and
 * inline absolute URLs, which breaks the `app://` static export) and no CSS
 * framework — see `globals.css` for the design tokens that back everything
 * below instead.
 *
 * The nav here is plain server-rendered markup, not a client component: no
 * `usePathname()`/active-link highlighting, on purpose, to keep this file free
 * of client-only APIs under the static export. Links are root-relative
 * (`/onboarding/index.html`, not `./onboarding/index.html`) because the app's
 * custom `app://` protocol is a registered "standard" scheme with a fixed host
 * (`local`) — a root-relative URL resolves against that host from any route
 * depth, where a relative one only resolves correctly from the page that wrote
 * it (see the same reasoning in `next.config.js` for `/_next/...` assets).
 */
export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return (
    <html lang="en">
      <body>
        <header className="app-nav">
          <span className="app-nav__brand">Context Restorer</span>
          <nav className="app-nav__links" aria-label="Main">
            <a className="app-nav__link" href="/index.html">
              Home
            </a>
            <a className="app-nav__link" href="/onboarding/index.html">
              Setup
            </a>
            <a className="app-nav__link" href="/settings/index.html">
              Settings
            </a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
