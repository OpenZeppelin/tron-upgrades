import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { packageRoot } from './helpers/locate';
import {
  allSources,
  chainSources,
  environmentSources,
  nonEnvironmentSources,
  resolverCallSites,
  typedInterpolations,
} from './helpers/source-scan';

/*
 * SF-11 — the package's published shape, asserted against what npm would
 * actually publish, plus the scan-subject meta-check: every census helper the
 * suite's absence scans are built on must range over a non-empty subject, so
 * no scan can pass by scanning nothing.
 */

describe('the tarball npm would publish', () => {
  const listing = (() => {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw) as ReadonlyArray<{
      files: ReadonlyArray<{ path: string }>;
    }>;
    return (parsed[0]?.files ?? []).map(entry => entry.path);
  })();

  it('carries the manifest, the compiled entry, and the consumer-import contract file', () => {
    expect(listing).toContain('package.json');
    expect(listing).toContain('dist/index.js');
    expect(listing).toContain('dist/index.d.ts');
    // The one-import-file setup every deploy refusal's remedy names: if this
    // stops shipping, the remedy tells users to import a file that is not in
    // the package.
    expect(listing).toContain('contracts/Proxies.sol');
  });

  it('ships nothing from src/, test/, docs/ or the evidence trees', () => {
    for (const entry of listing) {
      expect(
        /^(src|test|docs|artifacts)\//.test(entry),
        `${entry} should not be published`,
      ).toBe(false);
    }
  });

  it('keeps the build-graph pin: the manifest carries the peer range the seam quotes', () => {
    // src/environment/errors.ts statically imports ../../package.json and
    // renders peerDependencies.tronbox into a message — so the key must exist
    // in the manifest that ships, or a published package crashes at require
    // time in a way no source-tree test would see.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as { peerDependencies?: Record<string, string> };
    expect(typeof manifest.peerDependencies?.['tronbox']).toBe('string');
  });
});

describe('scan subjects: no absence scan can range over nothing', () => {
  /*
   * The suite's absence scans assert emptiness ("no module does X"), and an
   * emptiness assertion over an empty subject is vacuously green. The census
   * helpers below are the subjects those scans are built on; each is pinned
   * non-empty here, once, so a renamed directory or a broken walker fails this
   * file by name instead of silently blessing every scan built on it.
   */
  const subjects: ReadonlyArray<readonly [string, () => number]> = [
    ['allSources', () => allSources().length],
    ['environmentSources', () => environmentSources().length],
    ['nonEnvironmentSources', () => nonEnvironmentSources().length],
    ['chainSources', () => chainSources().length],
    ['resolverCallSites', () => resolverCallSites().length],
    ['typedInterpolations', () => typedInterpolations().length],
  ];

  it.each(subjects)('%s ranges over a non-empty subject', (_name, count) => {
    expect(count()).toBeGreaterThan(0);
  });

  it('the full census covers every operation directory the package now has', () => {
    const directories = new Set(
      allSources().map(source => source.relative.split(path.sep)[0]),
    );
    for (const expected of [
      'admin',
      'adopt',
      'beacon',
      'chain',
      'deploy',
      'environment',
      'options',
      'output',
      'proxy',
      'record',
      'results',
      'standalone',
      'validation-input',
    ]) {
      expect(directories.has(expected), `${expected}/ missing from the census`).toBe(
        true,
      );
    }
  });
});
