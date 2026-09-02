'use client';

import type { CSSProperties, MouseEvent, ReactNode } from 'react';

import { getBridge } from '../lib/bridge';

/**
 * An FR-6 source deep link (Task 4.6).
 *
 * Still a real `<a href>`: it must stay keyboard reachable, announce itself as a
 * link to assistive tech, and show its target in a hover/status affordance.
 * But the click is intercepted and routed through the `shell:openExternal` IPC
 * channel instead of being allowed to navigate, because the Electron shell now
 * refuses navigation to anything outside `app://` and denies every
 * `window.open` — the window renders untrusted ingested content, and the shell
 * cannot tell "the user clicked our own source link" from "injected markup
 * navigated the window". Routing explicit clicks through IPC keeps the deep link
 * working while leaving that lockdown absolute.
 *
 * `preventDefault()` is unconditional, including when the bridge is missing (a
 * plain browser, or a preload that failed to load): allowing the fallback
 * navigation there would be a behaviour that only exists outside the shipped
 * app, which is exactly the kind of divergence that hides bugs.
 */
export interface ExternalLinkProps {
  /** Absolute `https:` deep link. Validated again in the main process. */
  href: string;
  /** Link text. */
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function ExternalLink({
  href,
  children,
  className,
  style,
}: ExternalLinkProps): ReactNode {
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    try {
      // Fire-and-forget: a refusal is logged by the main process, and there is no
      // useful in-panel recovery for "the OS would not open your browser".
      void getBridge().shell.openExternal(href);
    } catch (cause) {
      // `getBridge()` throws synchronously outside Electron.
      console.warn('cannot open external link without the Electron bridge', cause);
    }
  };

  return (
    <a
      className={className}
      href={href}
      onClick={onClick}
      // Belt and braces if a future change ever lets this navigate: no referrer
      // (which would leak the app origin) and no `window.opener` handle.
      rel="noreferrer noopener"
      style={style}
    >
      {children}
    </a>
  );
}

export default ExternalLink;
