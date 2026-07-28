import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildInfoHasNamespaces,
  getNamespacedOutput,
  reportNamespacedCompileFailure,
  setNamespacedWarningSink,
  warmNamespacedCache,
} from '../src/utils/namespaced';
import { resolveNamespacedCompileErrors } from '../src/config';

// The namespaced recompile can be absent for a build-info that HAS namespaces
// (compiler too old, or the recompile failed). The result of a recompute is
// cached on disk as a discriminated entry (`{ schema: 2, kind: 'output' |
// 'unsupported' | 'compile-failed', ... }`); no policy is baked into the cache
// itself. `getNamespacedOutput` applies the current `namespacedCompileErrors`
// setting at consumption time, so a cached failure throws, warns, or stays
// silent depending on the config the CALLING process has, not the one that
// produced the cache entry. A raw legacy (pre-schema) cache value is
// ambiguous and is discarded rather than trusted.

// Observe warnings through the plugin's injectable sink rather than the
// upgrades-core channel, so the assertions are independent of the process-global
// `silenceWarnings` flag another suite may have set.
function spyWarnings() {
  const calls: Array<{ title: string; lines: string[] }> = [];
  setNamespacedWarningSink((title, lines) => calls.push({ title, lines }));
  return { calls, restore: () => setNamespacedWarningSink(null) };
}

// A build-info whose output AST carries an ERC-7201 storage-location annotation.
// `input` sources have no `content`, so a real recompute attempt passes them
// through upgrades-core's namespaced-input rewrite untouched instead of
// requiring a full parseable AST.
function namespacedBuildInfo(id: string) {
  return {
    id,
    solcVersion: '0.8.26',
    input: { sources: { 'A.sol': {} } },
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

function tmpHre(setting: 'error' | 'warn' | 'ignore' = 'warn') {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-fallback-'));
  return {
    config: { paths: { artifacts }, tronUpgrades: { namespacedCompileErrors: setting } },
    // Mirrors hre.artifacts.getBuildInfoPaths() for warmNamespacedCache tests:
    // lists real build-info files, not the `.namespaced.json` cache entries.
    artifacts: {
      getBuildInfoPaths: async () => {
        const dir = path.join(artifacts, 'build-info');
        if (!fs.existsSync(dir)) return [];
        return fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.json') && !f.endsWith('.namespaced.json'))
          .map((f) => path.join(dir, f));
      },
    },
  } as any;
}

function seedCache(hre: any, id: string, entry: unknown) {
  const dir = path.join(hre.config.paths.artifacts, 'build-info');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.namespaced.json`), JSON.stringify(entry));
}

function writeBuildInfoFile(hre: any, id: string) {
  const dir = path.join(hre.config.paths.artifacts, 'build-info');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(namespacedBuildInfo(id)));
}

function writeCorruptBuildInfoFile(hre: any, id: string) {
  const dir = path.join(hre.config.paths.artifacts, 'build-info');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), '{ not valid json');
}

const failedEntry = { schema: 2, kind: 'compile-failed', errorLines: ['E: boom'] };
const unsupportedEntry = { schema: 2, kind: 'unsupported' };

// Stubs the two `hre.run` calls `compileNamespaced` makes (solc build lookup,
// then the actual compile) and records every task invoked.
function stubCompile(hre: any, output: { errors?: any[] }) {
  const calls: string[] = [];
  hre.run = async (taskName: string) => {
    calls.push(taskName);
    return calls.length === 1 ? { isSolcJs: true, compilerPath: 'stub' } : output;
  };
  return calls;
}

describe('Namespaced fallback surfacing', function () {
  it('detects a namespaced build-info from its AST annotation', () => {
    expect(buildInfoHasNamespaces(namespacedBuildInfo('detect'))).to.equal(true);
    expect(
      buildInfoHasNamespaces({ output: { sources: { 'B.sol': { ast: { nodes: [] } } } } }),
    ).to.equal(false);
  });

  it('throws from a disk-cached failed compile under error', async () => {
    const hre = tmpHre('error');
    const id = `disk-failed-error-${Date.now()}`;
    seedCache(hre, id, failedEntry);

    await expect(getNamespacedOutput(hre, namespacedBuildInfo(id))).to.be.rejectedWith(/boom/);
  });

  it('warns and degrades from a disk-cached failed compile under warn', async () => {
    const hre = tmpHre('warn');
    const id = `disk-failed-warn-${Date.now()}`;
    seedCache(hre, id, failedEntry);

    const spy = spyWarnings();
    try {
      const out = await getNamespacedOutput(hre, namespacedBuildInfo(id));
      expect(out).to.equal(undefined);
      expect(spy.calls.length).to.be.greaterThan(0);
      expect(spy.calls.some((c) => c.title.includes('boom') || c.lines.some((l) => l.includes('boom')))).to.equal(
        true,
      );
    } finally {
      spy.restore();
    }
  });

  it('stays silent on a cached failed compile under ignore', async () => {
    const hre = tmpHre('ignore');
    const id = `disk-failed-ignore-${Date.now()}`;
    seedCache(hre, id, failedEntry);

    const spy = spyWarnings();
    try {
      const out = await getNamespacedOutput(hre, namespacedBuildInfo(id));
      expect(out).to.equal(undefined);
      expect(spy.calls.length).to.equal(0);
    } finally {
      spy.restore();
    }
  });

  it('never errors on unsupported solc even under error', async () => {
    const hre = tmpHre('error');
    const id = `disk-unsupported-error-${Date.now()}`;
    seedCache(hre, id, unsupportedEntry);

    const spy = spyWarnings();
    try {
      const out = await getNamespacedOutput(hre, namespacedBuildInfo(id));
      expect(out).to.equal(undefined);
    } finally {
      spy.restore();
    }
  });

  it('discards a legacy schema-1 cache instead of trusting it', async () => {
    const hre = tmpHre();
    const id = `legacy-null-${Date.now()}`;
    seedCache(hre, id, null);
    const calls = stubCompile(hre, { errors: [] });

    await getNamespacedOutput(hre, namespacedBuildInfo(id));
    expect(calls.length).to.be.greaterThan(0);
  });

  it('discards a legacy raw-output cache instead of trusting it', async () => {
    const hre = tmpHre();
    const id = `legacy-output-${Date.now()}`;
    seedCache(hre, id, { contracts: {}, sources: {}, errors: [] });
    const calls = stubCompile(hre, { errors: [] });

    await getNamespacedOutput(hre, namespacedBuildInfo(id));
    expect(calls.length).to.be.greaterThan(0);
  });

  it('discards a schema-2 entry with an unrecognized kind instead of guessing', async () => {
    const hre = tmpHre('error');
    const id = `bogus-kind-${Date.now()}`;
    seedCache(hre, id, { schema: 2, kind: 'bogus' });
    const calls = stubCompile(hre, { errors: [] });

    await getNamespacedOutput(hre, namespacedBuildInfo(id));
    expect(calls.length).to.be.greaterThan(0);
  });

  it('discards a malformed compile-failed entry instead of crashing', async () => {
    const hre = tmpHre('error');
    const id = `malformed-failed-${Date.now()}`;
    seedCache(hre, id, { schema: 2, kind: 'compile-failed' });
    const calls = stubCompile(hre, { errors: [] });

    await getNamespacedOutput(hre, namespacedBuildInfo(id));
    expect(calls.length).to.be.greaterThan(0);
  });

  it('warns once per build-info id per process', async () => {
    const hre = tmpHre('warn');
    const id = `dedup-${Date.now()}`;
    seedCache(hre, id, unsupportedEntry);
    const spy = spyWarnings();
    try {
      await getNamespacedOutput(hre, namespacedBuildInfo(id));
      await getNamespacedOutput(hre, namespacedBuildInfo(id));
      expect(spy.calls.length).to.equal(1);
    } finally {
      spy.restore();
    }
  });

  it('stays quiet when an unsupported build-info has no namespaces', async () => {
    const hre = tmpHre('warn');
    const id = `nonamespace-${Date.now()}`;
    seedCache(hre, id, unsupportedEntry);
    const spy = spyWarnings();
    try {
      const out = await getNamespacedOutput(hre, {
        id,
        solcVersion: '0.8.26',
        input: { sources: {} },
        output: { sources: {} },
      });
      expect(out).to.equal(undefined);
      expect(spy.calls.length).to.equal(0);
    } finally {
      spy.restore();
    }
  });

  it('persists the failure sentinel an ignore run computes, and a later error run throws on it', async () => {
    const id = `persist-fail-${Date.now()}`;
    const hreIgnore = tmpHre('ignore');
    stubCompile(hreIgnore, { errors: [{ severity: 'error', formattedMessage: 'E: boom' }] });

    const out = await getNamespacedOutput(hreIgnore, namespacedBuildInfo(id));
    expect(out).to.equal(undefined);

    const cachePath = path.join(hreIgnore.config.paths.artifacts, 'build-info', `${id}.namespaced.json`);
    const persisted = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    expect(persisted.kind).to.equal('compile-failed');

    const hreError = {
      config: { paths: hreIgnore.config.paths, tronUpgrades: { namespacedCompileErrors: 'error' } },
    } as any;
    await expect(getNamespacedOutput(hreError, namespacedBuildInfo(id))).to.be.rejectedWith(/boom/);
  });

  it('a warn-mode warning does not suppress a later error-mode throw in one process', async () => {
    const id = `warn-then-error-${Date.now()}`;
    const hreWarn = tmpHre('warn');
    seedCache(hreWarn, id, failedEntry);
    const spy = spyWarnings();
    try {
      await getNamespacedOutput(hreWarn, namespacedBuildInfo(id));
    } finally {
      spy.restore();
    }

    const hreError = tmpHre('error');
    await expect(getNamespacedOutput(hreError, namespacedBuildInfo(id))).to.be.rejectedWith(/boom/);
  });

  it("throws instead of degrading when namespacedCompileErrors is set to 'error'", () => {
    const hre = tmpHre('error');
    expect(() => reportNamespacedCompileFailure(hre, 'bi-hard', ['E: boom'])).to.throw(/bi-hard/);
    expect(() => reportNamespacedCompileFailure(hre, 'bi-hard-2', ['E: boom'])).to.throw(
      /namespacedCompileErrors/,
    );
  });

  it("degrades with a warning when namespacedCompileErrors is set to 'warn'", () => {
    const hre = tmpHre('warn');
    const spy = spyWarnings();
    try {
      const result = reportNamespacedCompileFailure(hre, `bi-soft-${Date.now()}`, ['E: boom']);
      expect(result).to.equal(null);
      expect(spy.calls.length).to.be.greaterThan(0);
    } finally {
      spy.restore();
    }
  });

  it('stays silent under ignore', function () {
    const hre = tmpHre('ignore');
    const spy = spyWarnings();
    try {
      const out = reportNamespacedCompileFailure(hre as any, 'bi-ignore', ['E: boom']);
      expect(out).to.equal(null);
      expect(spy.calls.length).to.equal(0);
    } finally {
      spy.restore();
    }
  });
});

describe('warmNamespacedCache', function () {
  it('warmNamespacedCache propagates a cached compile failure under error', async function () {
    const hre = tmpHre('error');
    const id = 'bi-warm-strict';
    writeBuildInfoFile(hre, id);
    seedCache(hre, id, failedEntry);
    await expect(warmNamespacedCache(hre as any)).to.be.rejectedWith(/boom/);
  });

  it('warmNamespacedCache still swallows unrelated per-file errors', async function () {
    const hre = tmpHre('error');
    writeCorruptBuildInfoFile(hre, 'bi-corrupt');
    await warmNamespacedCache(hre as any);
  });
});

describe('namespacedCompileErrors rule resolution', function () {
  it('defaults an omitted setting to error', function () {
    expect(resolveNamespacedCompileErrors(undefined)).to.equal('error');
  });
  it('accepts each tri-state value', function () {
    for (const v of ['error', 'warn', 'ignore']) {
      expect(resolveNamespacedCompileErrors(v)).to.equal(v);
    }
  });
  it('rejects booleans and typos eagerly', function () {
    expect(() => resolveNamespacedCompileErrors(true)).to.throw(/'error', 'warn' or 'ignore'/);
    expect(() => resolveNamespacedCompileErrors('warn ')).to.throw(/'error', 'warn' or 'ignore'/);
  });
});
