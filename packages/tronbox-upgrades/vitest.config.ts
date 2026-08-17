import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Type errors are checked first by `npm test` through
    // `tsc -p tsconfig.test.json`; enabling Vitest's typecheck here repeats
    // that work and more than doubles focused-run time.
    // The real-TronBox suites spawn `evidence/probes.js`, which drives two
    // sequential migrations through TronBox's own `Migration.prototype.run`.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
