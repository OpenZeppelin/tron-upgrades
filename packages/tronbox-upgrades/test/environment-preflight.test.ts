import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  packageRoot,
  repoRoot,
  tronBoxIsInstalled,
  tronBoxRoot,
  tronBoxVersionsUnderTest,
} from './helpers/locate';

/*
 * The preflight that turns a silently shrunken suite into one loud failure.
 *
 * Six suites drive the REAL installed TronBox trees, and every one of them
 * elides gracefully when a tree is absent — `describe.skipIf`,
 * `describe.each([])` — because absence used to be a legitimate state: the
 * aliased trees were declared in no manifest, so a fresh checkout genuinely
 * did not have them. That grace had a cost measured the hard way: a fresh
 * `npm ci` ran a suite dozens of tests smaller and reported green.
 *
 * The trees are declared devDependencies now (npm aliases `tronbox-4.9.0` /
 * `tronbox-4.8.0`), so absence stopped being legitimate — it means the
 * install is broken — and this file is where that fact fails, once, by name,
 * with the remedy. The per-suite skips stay: they can now only fire in a
 * state this file has already made red, and they keep those suites honest
 * about their own preconditions instead of crashing in a helper.
 */

describe('preflight: the trees the real-host suites need are actually installed', () => {
  it.each(tronBoxVersionsUnderTest)(
    '%s is installed — absence means `npm ci` was not run or failed',
    installName => {
      expect(
        tronBoxIsInstalled(installName),
        `${installName} is missing from ${path.relative(packageRoot, tronBoxRoot(installName))}. ` +
          `It is a devDependency (an npm alias), so a plain \`npm ci\` at the ` +
          `workspace root installs it. Without it, the real-host suites elide ` +
          `and the suite passes while measuring less than it claims.`,
      ).toBe(true);
    },
  );

  it('both runtime peer dependencies resolve from the workspace', () => {
    // `src/record/address.ts` imports both at runtime. They are peers of the
    // published package and devDependencies of this workspace, so a resolvable
    // copy is an install invariant, not a hope.
    for (const name of ['tronweb', 'ethers']) {
      expect(
        fs.existsSync(path.join(repoRoot, 'node_modules', name, 'package.json')),
        `${name} is not installed at the workspace root — \`npm ci\` restores it`,
      ).toBe(true);
    }
  });

  it('the two trees are the two versions the suites claim to cover', () => {
    for (const installName of tronBoxVersionsUnderTest) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(tronBoxRoot(installName), 'package.json'), 'utf8'),
      ) as { name: string; version: string };
      expect(manifest.name).toBe('tronbox');
      expect(`tronbox-${manifest.version}`).toBe(installName);
    }
  });
});
