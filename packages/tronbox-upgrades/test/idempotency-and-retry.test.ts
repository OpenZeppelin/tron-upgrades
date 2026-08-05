import { describe, expect, it } from 'vitest';
import {
  buildArtifactAmbiguityIndex,
  EnvironmentIncompleteError,
  resolveEnvironment,
  slotNames,
} from '../src/environment';
import { networkEntry } from './helpers/config-fixtures';
import { migrateShapedHandles } from './helpers/handles';
import {
  collectKeys,
  collectStrings,
  serializedTree,
} from './helpers/introspect';
import { projectPathsFixture } from './helpers/paths-fixtures';
import {
  collidingReader,
  countingReader,
  filesReader,
  singleContractReader,
} from './helpers/readers';
import { environmentSources } from './helpers/source-scan';

/**
 * Idempotency & Retry, covering module-scope statelessness, deterministic
 * resolution, migration-scoped freshness, the lazy ambiguity index, and routing
 * through the injected intercept.
 *
 * Technique: replay. Every test either drives the same inputs twice and compares,
 * or drives two different handle sets through one loaded module and asserts the
 * second carries nothing from the first. The two-sequential-migration harness
 * against the real host lives in `real-tronbox.test.ts`; this file covers the
 * unit-level half plus the mechanical absences the property rests on.
 */

describe('no module-scope mutable state in src/environment/**', () => {
  it('declares no module-scope let or var', () => {
    for (const source of environmentSources()) {
      expect(
        source.topLevelMutableBindings,
        `${source.relative} declares a module-scope mutable binding`,
      ).toEqual([]);
    }
  });

  it('initializes every module-scope const to something unmutatable', () => {
    // Enumerated as a positive allow-list of *forms*, so a new module-scope
    // binding of any other shape — a cache, a lazily-initialized singleton, a
    // bare array — fails here rather than passing review.
    const offenders: string[] = [];
    for (const source of environmentSources()) {
      for (const entry of source.topLevelConsts) {
        if (entry.isDeclare && entry.initializerKind === undefined) {
          continue;
        }
        const text = entry.text;
        const initializer = text.slice(text.indexOf('=') + 1).trim();
        const allowed =
          initializer.startsWith('Object.freeze(') ||
          /^['"`]/.test(initializer) ||
          /^\//.test(initializer) ||
          /^-?\d/.test(initializer) ||
          /^(true|false)$/.test(initializer) ||
          /^[A-Za-z_$][\w$]*(\.[\w$]+)+$/.test(initializer);
        if (!allowed) {
          offenders.push(`${source.relative}: ${entry.name} = ${initializer}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('creates no collection at module scope', () => {
    for (const source of environmentSources()) {
      for (const entry of source.topLevelConsts) {
        expect(
          entry.text,
          `${source.relative}: ${entry.name}`,
        ).not.toMatch(/new\s+(Map|Set|WeakMap|WeakSet|Array)\s*\(/);
      }
    }
  });

  it('two resolutions from different handles share nothing observable', () => {
    // The behavioural half of the absence: with no module-scope binding, a module
    // loaded once cannot bind a migration's handles once.
    const first = migrateShapedHandles({ root: '/proj-one' });
    const second = migrateShapedHandles({ root: '/proj-two' });
    const envOne = resolveEnvironment(first.handles, { require: ['paths', 'artifacts'] }, {
      buildInfoReader: singleContractReader(
        'Box',
        'contracts/Box.sol',
        '/proj-one/build/build-info',
      ),
    });
    const envTwo = resolveEnvironment(second.handles, { require: ['paths', 'artifacts'] }, {
      buildInfoReader: singleContractReader(
        'Box',
        'contracts/Box.sol',
        '/proj-two/build/build-info',
      ),
    });

    expect(envOne.paths.root).toBe('/proj-one');
    expect(envTwo.paths.root).toBe('/proj-two');
    expect(envTwo.artifacts.intercept).toBe(second.intercept);
    expect(envTwo.artifacts.intercept).not.toBe(first.intercept);
    expect(collectStrings(serializedTree(envTwo))).not.toContain('/proj-one');
  });
});

describe('resolution is deterministic and repeatable', () => {
  it('returns observationally equal composites for the same inputs', () => {
    const shape = migrateShapedHandles();
    const reader = singleContractReader();
    const first = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: reader },
    );
    const second = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: reader },
    );
    expect(serializedTree(second)).toEqual(serializedTree(first));
    expect(second.provenance).toEqual(first.provenance);
    expect(second.provenance.internalPathsRead).toEqual(
      first.provenance.internalPathsRead,
    );
  });

  it('carries no timestamp in provenance', () => {
    // A clock would defeat this invariant and would make the two-migration
    // staleness test unable to distinguish "carried state" from "resolved
    // differently this time", which is why provenance was designed without one.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['paths'] });
    const keys = collectKeys(serializedTree(env.provenance));
    expect(
      keys.filter(key => /time|timestamp|date|resolvedAt|when/i.test(key)),
    ).toEqual([]);
  });

  it('orders candidates and collisions totally, independent of reader order', () => {
    const paths = projectPathsFixture();
    const forward = filesReader([
      {
        name: 'aaa.output.json',
        contracts: [
          { sourcePath: 'contracts/Box.sol', contractNames: ['Box', 'Aux'] },
        ],
      },
      {
        name: 'bbb.output.json',
        contracts: [
          { sourcePath: 'contracts/vendor/Box.sol', contractNames: ['Box'] },
        ],
      },
    ]);
    const reversed = filesReader([
      {
        name: 'bbb.output.json',
        contracts: [
          { sourcePath: 'contracts/vendor/Box.sol', contractNames: ['Box'] },
        ],
      },
      {
        name: 'aaa.output.json',
        contracts: [
          { sourcePath: 'contracts/Box.sol', contractNames: ['Aux', 'Box'] },
        ],
      },
    ]);
    const one = buildArtifactAmbiguityIndex(paths, forward);
    const two = buildArtifactAmbiguityIndex(paths, reversed);
    expect(one.report.status).toBe('indexed');
    if (one.report.status !== 'indexed' || two.report.status !== 'indexed') {
      throw new Error('unreachable');
    }
    expect(two.report.collisions).toEqual(one.report.collisions);
    expect(two.candidates('Box')).toEqual(one.candidates('Box'));
    // `indexedFrom` follows the reader's order, which the default reader sorts.
    expect([...two.report.indexedFrom].sort()).toEqual(
      [...one.report.indexedFrom].sort(),
    );
  });

  it('builds the same index twice from the same reader', () => {
    const paths = projectPathsFixture();
    const reader = collidingReader();
    expect(buildArtifactAmbiguityIndex(paths, reader).report).toEqual(
      buildArtifactAmbiguityIndex(paths, reader).report,
    );
  });
});

describe('migration-scoped freshness, and memoization never keys on the Config', () => {
  it('derives every slot of the second composite from the second handles', () => {
    const first = migrateShapedHandles({
      root: '/proj-one',
      networks: { development: networkEntry({ from: 'TOne' }) },
    });
    const second = migrateShapedHandles({
      root: '/proj-two',
      networks: { development: networkEntry({ from: 'TTwo' }) },
    });
    const envOne = resolveEnvironment(first.handles, {
      require: ['paths', 'network', 'scheduling'],
    });
    const envTwo = resolveEnvironment(second.handles, {
      require: ['paths', 'network', 'scheduling'],
    });
    expect(envOne.network.sender.address).toBe('TOne');
    expect(envTwo.network.sender.address).toBe('TTwo');
    expect(envTwo.scheduling.deployer).toBe(second.deployer);
    expect(envTwo.scheduling.deployer).not.toBe(first.deployer);
    const secondStrings = collectStrings(serializedTree(envTwo));
    expect(secondStrings).not.toContain('TOne');
    expect(secondStrings).not.toContain('/proj-one');
  });

  it('keeps the ambiguity memo inside the composite, so a second composite re-reads', () => {
    const shape = migrateShapedHandles();
    const reader = countingReader(collidingReader());
    const envOne = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: reader },
    );
    envOne.artifacts.ambiguities();
    expect(reader.callCount).toBe(1);

    const envTwo = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: reader },
    );
    envTwo.artifacts.ambiguities();
    expect(reader.callCount).toBe(2);
    expect(envTwo.artifacts.ambiguities()).not.toBe(
      envOne.artifacts.ambiguities(),
    );
  });

  it('a WeakMap keyed on the deployer gives one entry per migration', () => {
    // The memoization rule the deploy seam inherits. Keying on the `deployer` — a
    // fresh object per migration — is compatible with this invariant; keying on
    // the `Config`, which is shared across the whole run, reproduces the staleness
    // the module-scope statelessness guarantee forbids while looking like a
    // per-invocation cache.
    const first = migrateShapedHandles({ root: '/proj-one' });
    const second = migrateShapedHandles({ root: '/proj-two' });
    const byDeployer = new WeakMap<object, number>();
    let builds = 0;
    for (const shape of [first, second, first]) {
      const deployer = shape.deployer;
      if (typeof deployer !== 'object' || deployer === null) {
        throw new Error('fixture deployer must be an object');
      }
      if (!byDeployer.has(deployer)) {
        byDeployer.set(deployer, ++builds);
      }
    }
    expect(builds).toBe(2);
  });
});

describe('the ambiguity index is lazy, computed once, stable within its composite', () => {
  it('performs no build-info I/O for a resolution that never consults the index', () => {
    const shape = migrateShapedHandles();
    const reader = countingReader(collidingReader());
    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: reader },
    );
    expect(env.paths.buildInfoDirectory).toBe('/proj/build/build-info');
    expect(reader.callCount).toBe(0);
  });

  it('computes the index at most once per composite, however often it is read', () => {
    const shape = migrateShapedHandles();
    const reader = countingReader(collidingReader());
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: reader },
    );
    const first = env.artifacts.ambiguities();
    const second = env.artifacts.ambiguities();
    env.artifacts.resolve('Box');
    env.artifacts.resolve('Unique');
    const third = env.artifacts.ambiguities();

    expect(reader.callCount).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('asks the reader for the composite buildInfoDirectory and nothing else', () => {
    const shape = migrateShapedHandles({ root: '/somewhere' });
    const reader = countingReader(
      singleContractReader('Box', 'contracts/Box.sol', '/somewhere/build/build-info'),
    );
    const env = resolveEnvironment(
      shape.handles,
      { require: ['paths', 'artifacts'] },
      { buildInfoReader: reader },
    );
    env.artifacts.ambiguities();
    expect(reader.directories).toEqual([env.paths.buildInfoDirectory]);
  });

  it('triggers exactly one read when resolve needs the index', () => {
    const shape = migrateShapedHandles();
    const reader = countingReader(collidingReader());
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: reader },
    );
    expect(reader.callCount).toBe(0);
    env.artifacts.resolve('Box');
    expect(reader.callCount).toBe(1);
  });
});

describe('resolve routes through the injected intercept', () => {
  it('returns the identical abstraction for repeated resolves of one name', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: singleContractReader() },
    );
    const first = env.artifacts.resolve('Box');
    const second = env.artifacts.resolve('./Box.sol');
    if (first.status !== 'unique' || second.status !== 'unique') {
      throw new Error('expected both resolutions to be unique');
    }
    expect(second.contract).toBe(first.contract);
  });

  it('leaves the abstraction in the intercept cache, so the write-back sees it', () => {
    // `ResolverIntercept.prototype.contracts` returns exactly the cache's
    // values, and that set is what `artifactor.saveAll` writes back at the end
    // of the migration. An abstraction obtained from a fresh resolver is
    // functionally identical and absent from the cache, so it works for the
    // whole operation and its address is silently missing afterwards.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: singleContractReader() },
    );
    const resolution = env.artifacts.resolve('Box');
    if (resolution.status !== 'unique') {
      throw new Error('expected a unique resolution');
    }
    expect(shape.intercept.contracts()).toContain(resolution.contract);
    expect(env.artifacts.intercept).toBe(shape.intercept);
  });

  it('never obtains an abstraction through config.resolver', () => {
    // This invariant as it now stands: *"no path yields a `ContractAbstraction`
    // except the injected intercept"*. `config.resolver` is read — the
    // deployer-resolver pairing check compares it — and that read is permitted
    // and enumerated, so the property under test is about what the read is
    // *used for*, not whether it happens. A throwing `require` on the Config's
    // own resolver proves it: any path
    // that reached for an abstraction there would fail loudly instead of silently
    // returning a functionally identical object that is absent from the write-back
    // cache.
    const shape = migrateShapedHandles();
    shape.resolver.require = (): never => {
      throw new Error(
        'config.resolver must never be used to obtain an abstraction',
      );
    };
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: singleContractReader() },
    );
    expect(env.artifacts.resolve('Box').status).toBe('unique');
    expect(env.artifacts.resolvePackaged('pkg/Box.json')).toBeDefined();
    expect(shape.intercept.calls).toEqual(['Box', 'pkg/Box.json']);
  });

  it('records the one read of config.resolver that the deployer-resolver pairing check requires', () => {
    // This was flagged as a contradiction: this invariant's original wording
    // ("`config.resolver` is never read") could not hold alongside the
    // deployer-resolver pairing check, whose check *is* that read. It is resolved
    // by narrowing this invariant to "no path yields a `ContractAbstraction`" and
    // enumerating the one permitted read — and recording it in
    // `internalPathsRead` is a feature, not a leak: that is what makes the actual
    // surface checkable rather than aspirational, and it is the canary that fires
    // if a second read of the reference appears.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['paths'] });
    expect(env.provenance.internalPathsRead).toContain(
      'deployer.options.options.resolver',
    );
    // "The one read" made precise, because the recorded set contains two
    // resolver-shaped paths and only one of them is this invariant's.
    // `artifacts.resolver` is the *lineage hop* — the intercept's resolver is how
    // the seam reaches the Config behind the `artifacts` handle at all, and every
    // path-and-network slot depends on it. `deployer.options.options.resolver` is
    // the identity comparison the deployer-resolver pairing check requires and
    // this invariant enumerates as permitted. Conflating them would let a second
    // comparison read slip in behind the lineage traversal.
    const resolverReads = env.provenance.internalPathsRead.filter(read =>
      /\.resolver$/.test(read),
    );
    expect([...resolverReads].sort()).toEqual([
      'artifacts.resolver',
      'deployer.options.options.resolver',
    ]);
    expect(
      resolverReads.filter(read => read.startsWith('deployer.')),
    ).toEqual(['deployer.options.options.resolver']);
  });

  it('constructs no resolver of its own anywhere in the seam', () => {
    for (const source of environmentSources()) {
      const constructed = source.identifiers.filter(
        use =>
          !use.inTypePosition &&
          /^(Resolver|ResolverIntercept|Artifactor|Provisioner)$/.test(use.name),
      );
      expect(constructed, `${source.relative}`).toEqual([]);
      expect(
        source.importSpecifiers.filter(specifier =>
          specifier.includes('tronbox'),
        ),
        `${source.relative} imports the host`,
      ).toEqual([]);
    }
  });

  it('fails informatively rather than falling back when the intercept cannot resolve', () => {
    const shape = migrateShapedHandles({}, { resolvable: ['Box'] });
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: singleContractReader() },
    );
    expect(() => env.artifacts.resolve('Absent')).toThrow(
      EnvironmentIncompleteError,
    );
    expect(shape.intercept.calls).toEqual(['Absent']);
  });
});
