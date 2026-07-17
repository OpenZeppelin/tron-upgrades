import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildInfoHasNamespaces,
  getNamespacedOutput,
  reportNamespacedCompileFailure,
  setNamespacedWarningSink,
} from '../src/utils/namespaced';

// The namespaced recompile can be absent for a build-info that HAS namespaces
// (compiler too old, or the recompile failed). Absence is cached as a `null`
// sentinel on disk, so a later process reads null and silently runs AST-only
// checks. These tests pin the surfacing: the fallback must be announced on the
// run that actually uses it, and an opt-in flag must turn the failure hard.

// Observe warnings through the plugin's injectable sink rather than the
// upgrades-core channel, so the assertions are independent of the process-global
// `silenceWarnings` flag another suite may have set.
function spyWarnings() {
  const calls: Array<{ title: string; lines: string[] }> = [];
  setNamespacedWarningSink((title, lines) => calls.push({ title, lines }));
  return { calls, restore: () => setNamespacedWarningSink(null) };
}

// A build-info whose output AST carries an ERC-7201 storage-location annotation.
function namespacedBuildInfo(id: string) {
  return {
    id,
    solcVersion: '0.8.26',
    output: {
      sources: {
        'A.sol': {
          ast: {
            nodeType: 'SourceUnit',
            nodes: [
              {
                nodeType: 'ContractDefinition',
                nodes: [
                  {
                    nodeType: 'StructDefinition',
                    documentation: { text: '@custom:storage-location erc7201:example.main' },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

function tmpHre(hardError = false) {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-fallback-'));
  return {
    config: { paths: { artifacts }, tronUpgrades: { namespacedCompileErrors: hardError } },
  } as any;
}

function seedNullCache(hre: any, id: string) {
  const dir = path.join(hre.config.paths.artifacts, 'build-info');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.namespaced.json`), 'null');
}

describe('Namespaced fallback surfacing', function () {
  it('detects a namespaced build-info from its AST annotation', () => {
    expect(buildInfoHasNamespaces(namespacedBuildInfo('detect'))).to.equal(true);
    expect(
      buildInfoHasNamespaces({ output: { sources: { 'B.sol': { ast: { nodes: [] } } } } }),
    ).to.equal(false);
  });

  it('re-emits the fallback warning when a null-cached namespaced output is used', async () => {
    const hre = tmpHre();
    const id = `cachednull-${Date.now()}`;
    seedNullCache(hre, id);

    const spy = spyWarnings();
    try {
      const out = await getNamespacedOutput(hre, namespacedBuildInfo(id));
      expect(out).to.equal(undefined);
      expect(spy.calls.length).to.be.greaterThan(0);
      expect(spy.calls[0].title).to.match(/fallback/i);

      // Per-process dedup: a second use in the same process does not re-warn.
      const before = spy.calls.length;
      await getNamespacedOutput(hre, namespacedBuildInfo(id));
      expect(spy.calls.length).to.equal(before);
    } finally {
      spy.restore();
    }
  });

  it('stays quiet when a null-cached build-info has no namespaces', async () => {
    const hre = tmpHre();
    const id = `nonamespace-${Date.now()}`;
    seedNullCache(hre, id);

    const spy = spyWarnings();
    try {
      const out = await getNamespacedOutput(hre, { id, solcVersion: '0.8.26', output: { sources: {} } });
      expect(out).to.equal(undefined);
      expect(spy.calls.length).to.equal(0);
    } finally {
      spy.restore();
    }
  });

  it('throws instead of degrading when namespacedCompileErrors is enabled', () => {
    const hre = tmpHre(true);
    expect(() => reportNamespacedCompileFailure(hre, 'bi-hard', ['E: boom'])).to.throw(/bi-hard/);
    expect(() => reportNamespacedCompileFailure(hre, 'bi-hard-2', ['E: boom'])).to.throw(
      /namespacedCompileErrors/,
    );
  });

  it('degrades with a warning when namespacedCompileErrors is disabled', () => {
    const hre = tmpHre(false);
    const spy = spyWarnings();
    try {
      const result = reportNamespacedCompileFailure(hre, `bi-soft-${Date.now()}`, ['E: boom']);
      expect(result).to.equal(null);
      expect(spy.calls.length).to.be.greaterThan(0);
    } finally {
      spy.restore();
    }
  });
});
