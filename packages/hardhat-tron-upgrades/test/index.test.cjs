'use strict';

// Hardhat 2 only auto-discovers .ts test files when the CONFIG itself is
// TypeScript (hardhat/builtin-tasks/test.js) — with hardhat.config.cjs this
// discovered loader is the entry point: it transpiles on the fly and loads
// the readiness hook FIRST, then every suite in sorted order. It adds no
// tests of its own, so suite counts are unchanged. Deterministic type
// checking is owned by `tsc -p tsconfig.test.json`, not by ts-node.
require('ts-node').register({ transpileOnly: true });

const fs = require('node:fs');
const path = require('node:path');

require('./_ready-guard.ts');
for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.ts')).sort()) {
  require(path.join(__dirname, file));
}
