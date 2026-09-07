/**
 * The MUI theme for the Context Restorer renderer.
 *
 * Plain `.mjs` on purpose: it is imported both by `next.config.js` (Node, at
 * build time, to feed the Pigment plugin) and by the runtime `<ThemeProvider>`
 * in `app/providers.tsx`. Keeping it JS avoids needing a TS loader in the Next
 * config.
 *
 * `cssVariables: true` is what keeps this CSP-compatible: Pigment emits the
 * palette as a `:root { --mui-palette-… }` block into a real stylesheet at
 * BUILD time, so the colours are correct before hydration and nothing injects a
 * `<style>` element at runtime (the shell CSP allows inline style *attributes*
 * but still blocks runtime `<style>` elements — see
 * `apps/desktop/src/security/csp.ts` and
 * `specs/2026-09-07-ui-redesign/mui-redesign-plan.md`).
 *
 * Both colour schemes are declared, switched by `prefers-color-scheme` — the
 * same automatic, JS-free dark mode `app/globals.css` used before the redesign.
 *
 * Palette values are the `--cr-*` tokens that used to live in `globals.css`,
 * with their WCAG contrast notes kept as comments so the ratios are not lost.
 */
import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  cssVariables: true,
  colorSchemes: {
    light: {
      palette: {
        primary: { main: '#0b3fbf' }, // 8.3:1 on #ffffff
        background: {
          default: '#f4f6f8', // app canvas behind panels — a cool grey biased to the accent
          paper: '#ffffff',
        },
        text: {
          primary: '#1a1a1a', // 16.1:1 on #ffffff
          secondary: '#5b6470', // 6.0:1 on #ffffff
        },
        success: { main: '#1a7f37' },
        warning: { main: '#9a6700' },
        error: { main: '#a4262c' }, // 5.6:1 on #ffffff
        divider: '#dadfe5',
      },
    },
    dark: {
      palette: {
        primary: { main: '#58a6ff' },
        background: { default: '#0d1117', paper: '#161b22' },
        text: {
          primary: '#c9d1d9',
          secondary: '#8b949e',
        },
        success: { main: '#3fb950' },
        warning: { main: '#d29922' },
        error: { main: '#f85149' },
        divider: '#2a313c',
      },
    },
  },
  shape: { borderRadius: 6 },
  typography: {
    // No web fonts: the bundle is a static `app://` export and a font loader
    // inlines absolute URLs that break it (see `app/layout.tsx`). System stack
    // only, differentiated by weight/size/spacing — as `globals.css` did.
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    button: { textTransform: 'none', fontWeight: 550 },
  },
  components: {
    // Only `styleOverrides` / `variants` here — Pigment reads those at build
    // time. Runtime `defaultProps` (disableRipple, elevation, …) live in
    // `app/providers.tsx` via `DefaultPropsProvider`, because pure Pigment CSS
    // (no Emotion) cannot carry React defaults through the theme object.
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
  },
});

export default theme;
