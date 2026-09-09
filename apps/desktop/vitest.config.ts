import { defineConfig } from 'vitest/config';

export default defineConfig({
  /**
   * `.cts` needs an explicit transform rule.
   *
   * Vite's default esbuild `include` covers `.ts`/`.tsx` but not `.cts`, so
   * importing `src/preload.cts` — the ONLY `.cts` in the project, and the file
   * that defines the entire renderer-visible IPC surface — reached the bundler
   * as plain JavaScript and died on the first type annotation. That is why the
   * bridge had no test coverage at all, and why a dropped field in it
   * (`projectId`, A-2) could ship unnoticed.
   */
  esbuild: { include: [/\.[cm]?[jt]sx?$/] },
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
