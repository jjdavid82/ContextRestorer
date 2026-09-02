import { defineConfig } from 'vitest/config';

/**
 * Vitest project for the renderer.
 *
 * Two deviations from the node-side packages' configs, both forced by the fact
 * that this project renders React:
 *
 *  - `environment: 'jsdom'` — component tests need a DOM to render into.
 *  - `esbuild.jsx: 'automatic'` — `tsconfig.json` sets `jsx: "preserve"`
 *    because Next's SWC pipeline owns the JSX transform in the real build.
 *    esbuild reads that same tsconfig and would faithfully emit untransformed
 *    JSX, which is a syntax error at import time. Overriding it here uses the
 *    React 17+ automatic runtime, so no `import React` is needed in components.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    name: 'ui',
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
