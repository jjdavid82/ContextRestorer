import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'redact',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
