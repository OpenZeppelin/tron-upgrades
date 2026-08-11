import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  repoRoot,
  tronBoxIsInstalled,
  tronBoxRoot,
  tronBoxVersionsUnderTest,
} from './helpers/locate';

/*
 * The base-slot canary — pinning a confirmed upstream defect and the compiler
 * ceiling that currently keeps this plugin out of its blast radius.
 *
 * The defect, confirmed by the upstream maintainer (2026-08-04, "broken since
 * 1.44.0"): `extractStorageLayout` records a custom storage layout's base slot
 * (`layout at <expr>`, Solidity >= 0.8.29) on `layout.baseSlot`, and the
 * comparison's slot-less arm checks it (`validateBaseSlotUnchanged`) — but
 * `unfoldStorageLayout`, the function every without-storage-layouts consumer
 * reads layouts through, rebuilds the layout WITHOUT `baseSlot` in both of its
 * branches. `undefined === undefined` passes, so a base-slot change is
 * silently accepted on exactly the path this plugin validates on. The upstream
 * fix must preserve `baseSlot` through `unfoldStorageLayout`; this file notices
 * when that mechanism changes.
 *
 * Why this plugin is not exposed TODAY, and the two facts that keep it so:
 *
 * 1. `unfoldStorageLayout` still drops `baseSlot` at the installed engine —
 *    when an upstream release fixes it, the assertion below fails and the
 *    plugin re-verifies deliberately instead of carrying a stale limitation
 *    note.
 * 2. TronBox's compiler ceiling is 0.8.26, below the 0.8.29 that introduced
 *    `layout at` — so no TronBox-compiled contract can carry a base slot for
 *    the defect to drop. When a TronBox release raises the ceiling past
 *    0.8.29, the assertion below fails and the exposure question reopens
 *    BEFORE a user can compile the first affected contract.
 *
 * The one base-slot change a TronBox user CAN express — renaming an ERC-7201
 * `@custom:storage-location` id, which moves the derived slot — is refused in
 * both validation modes (`delete-namespace`; measured, probe persisted), so no
 * plugin-side guard is built: the gate for building one was a measured silent
 * pass, and there is none to flip.
 */

const CORE_DIST = path.join(
  repoRoot,
  'node_modules',
  '@openzeppelin',
  'upgrades-core',
  'dist',
);

function coreSource(relative: string): string {
  return fs.readFileSync(path.join(CORE_DIST, relative), 'utf8');
}

describe('the upstream defect, pinned at the installed engine', () => {
  it('extract sets baseSlot, the slot-less comparison checks it — the two healthy ends', () => {
    // Each landmark asserted present before anything is claimed about the gap
    // between them.
    const extract = coreSource('storage/extract.js');
    expect(extract).toContain('layout.baseSlot = ');
    expect(extract).toContain('baseSlotExpression');

    const compare = coreSource('storage/index.js');
    expect(compare).toContain('function validateBaseSlotUnchanged');
    expect(compare).toContain('original.baseSlot');
    // The gate that makes this OUR mode's protection: it runs exactly when
    // slots are absent.
    expect(compare).toContain("storage.some(item => item.slot === undefined)");
  });

  it('unfoldStorageLayout still drops baseSlot — the defect is present, so the limitation note is current', () => {
    const query = coreSource('validate/query.js');
    const start = query.indexOf('function unfoldStorageLayout');
    expect(start, 'unfoldStorageLayout not found — upstream moved it').toBeGreaterThanOrEqual(0);
    const end = query.indexOf('function', start + 'function '.length);
    const body = query.slice(start, end === -1 ? undefined : end);
    // The rebuilt layout omits baseSlot in both branches. The day this fails,
    // `unfoldStorageLayout` has begun preserving the field: retire the docs
    // limitation note and re-run the persisted repro to confirm, rather than
    // deleting this test.
    expect(body).not.toContain('baseSlot');
  });
});

describe('the compiler ceiling that keeps the class unreachable from TronBox', () => {
  const installed = tronBoxVersionsUnderTest.filter(tronBoxIsInstalled);

  it.each(installed)('%s caps Tron Solidity at a version below `layout at`', installName => {
    const root = tronBoxRoot(installName);
    const tronSolc = createRequire(path.join(root, 'package.json'))(
      path.join(root, 'build', 'components', 'TronSolc'),
    ) as { maxVersion: string };

    // Exact pin: a raised ceiling is a deliberate re-verification of the
    // base-slot exposure, not a silent widening.
    expect(tronSolc.maxVersion).toBe('0.8.26');

    const [major, minor, patch] = tronSolc.maxVersion.split('.').map(Number);
    const introducesLayoutAt = [0, 8, 29];
    const below =
      (major as number) < (introducesLayoutAt[0] as number) ||
      ((major as number) === introducesLayoutAt[0] &&
        ((minor as number) < (introducesLayoutAt[1] as number) ||
          ((minor as number) === introducesLayoutAt[1] &&
            (patch as number) < (introducesLayoutAt[2] as number))));
    expect(below).toBe(true);
  });
});
