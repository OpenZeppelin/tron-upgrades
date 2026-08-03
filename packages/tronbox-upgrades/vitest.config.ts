import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The real-TronBox suites spawn `evidence/probes.js`, which drives two
    // sequential migrations through TronBox's own `Migration.prototype.run`.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
