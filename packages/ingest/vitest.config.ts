import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ingest',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
