import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'observability',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    /**
     * `test/e2eTrace.test.ts` drives the REAL `@cr/ai` layers through the REAL
     * trace sink, and both packages are edited by the same task. Left to bare
     * package resolution, `@cr/ai` would load `packages/ai/dist` and — worse —
     * its own `import '@cr/observability'` would load `packages/observability/
     * dist`, so the test would assert against whatever was last built rather
     * than against the sources it is meant to be checking.
     *
     * These aliases point both packages at their `src` entry points. `@cr/store`
     * and `@cr/redact` are deliberately NOT aliased: they are unchanged by this
     * task, their `dist` is what the rest of the suite already exercises, and
     * `@cr/store` loads a native module.
     */
    alias: {
      '@cr/observability': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      '@cr/ai': fileURLToPath(new URL('../ai/src/index.ts', import.meta.url)),
    },
  },
});
