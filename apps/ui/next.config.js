/**
 * Next.js configuration for the Context Restorer renderer.
 *
 * The UI ships as a fully static bundle that Electron serves from a custom
 * `app://` protocol handler, so there is no Node server at runtime.
 *
 * NOTE: `@cr/ui` is `"type": "module"`, so this `.js` file is ESM and must use
 * `export default` rather than `module.exports`.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  // Emit a static site into `out/` instead of a server bundle.
  output: 'export',
  // The next/image optimizer needs a server; disable it for static export.
  images: { unoptimized: true },
  // No assetPrefix: leave Next's default root-relative `/_next/...` hrefs.
  // `app://` is registered in `protocol.ts` as a *standard* scheme with a
  // fixed host (`local`), so a root-relative URL resolves against that host
  // exactly like it would under `https://local/...` — regardless of which
  // route's document it appears in. A relative `./` prefix was tried instead
  // and looked right for the root page, but broke every nested route: from
  // `app://local/onboarding/`, `./_next/...` resolves to
  // `app://local/onboarding/_next/...`, which doesn't exist, so the page's JS
  // 404s and never hydrates. Next also rejects a custom-scheme absolute
  // `assetPrefix` outright at build time, so root-relative is the only option
  // that both builds and resolves correctly at every route depth.
  // Emit `index.html` inside a directory per route so relative asset paths and
  // `app://` directory-style URLs resolve consistently.
  trailingSlash: true,
};

export default nextConfig;
