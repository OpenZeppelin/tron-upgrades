import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import packageJson from '../package.json';
import {
  buildArtifactAmbiguityIndex,
  compilerConfigLineageFields,
  configLineageFields,
  EnvironmentIncompleteError,
  fileSystemBuildInfoReader,
  networkConfigLineageFields,
  pathConfigLineageFields,
  resolveEnvironment,
  slotNames,
  slotRequirements,
  type EnvironmentDependencies,
} from '../src/environment';
import { createArtifactAccess } from '../src/environment/artifacts';
import { buildNetworkEnvironment } from '../src/environment/network';
import { buildProjectPaths } from '../src/environment/paths';
import { networkEntry } from './helpers/config-fixtures';
import {
  artifactsOnlyHandles,
  deployerOnlyHandles,
  handles,
  migrateShapedHandles,
  typedInterceptFixture,
} from './helpers/handles';
import { collectLeaves, serializedTree, sortedOwnKeys } from './helpers/introspect';
import { packageRoot, srcDir } from './helpers/locate';
import { pathScalarValues, projectPathsFixture } from './helpers/paths-fixtures';
import {
  absentReader,
  absolute,
  collidingReader,
  countingReader,
  existenceProbeReader,
  filesReader,
  inMemoryReader,
  singleContractReader,
  unreadableReader,
  DEFAULT_BUILD_INFO_DIR,
} from './helpers/readers';
import {
  environmentSources,
  nonEnvironmentSources,
  valueIdentifierNames,
} from './helpers/source-scan';

/**
 * Performance, Scalability & Re-usability — INV-43 … INV-47.
 *
 * Two sub-techniques, and both ship here.
 *
 * *Load* has an unusual shape for this sub-feature. SF-0 serves no callers over a
 * network and does no I/O on its default path, so there is no throughput budget to
 * probe — the cost model is "how many host property reads per resolution", and the
 * property that matters is that the count depends on the *declared slot list* and
 * not on the size of the user's configuration. A project with fifty networks and
 * two hundred config keys must cost what a minimal one costs. That is asserted
 * directly below rather than approximated with a timer, which would be flaky and
 * would measure the fixture rather than the seam.
 *
 * *Portability* gets the strongest form the skill describes: the artifact embedded
 * in a second host. `createArtifactAccess` is driven with a hand-built intercept, a
 * hand-built `ProjectPaths` and an in-memory reader — no `resolveEnvironment`
 * around it, no TronBox installed, no filesystem touched, and no source change.
 */

const ISO_LIKE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function caught(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, and it returned normally');
}

/** Distinct host property paths a resolution read — the seam's cost unit. */
function readCost(
  spec: Parameters<typeof resolveEnvironment>[1],
  shape = migrateShapedHandles(),
  deps: EnvironmentDependencies = {},
): number {
  return resolveEnvironment(shape.handles, spec, deps).provenance
    .internalPathsRead.length;
}

// ---------------------------------------------------------------------------
// INV-43
// ---------------------------------------------------------------------------

describe('INV-43: exactly one injected dependency, no concrete singleton, no fs outside ambiguity.ts', () => {
  it('declares exactly one dependency on the injection surface', () => {
    const resolveSource = environmentSources().find(
      source => source.relative === 'resolve.ts',
    );
    expect(resolveSource).toBeDefined();
    const declaration =
      /export interface EnvironmentDependencies \{([^}]*)\}/.exec(
        resolveSource?.text ?? '',
      );
    expect(declaration).not.toBeNull();
    const members = (declaration?.[1] ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('//'));
    expect(members).toEqual(['readonly buildInfoReader?: BuildInfoReader;']);
  });

  it('defaults the reader, so injection is available and not mandatory', () => {
    // Optional by design: a consumer that does not care gets the real filesystem,
    // and a test that does gets a fixture without a wrapper module in between.
    const shape = migrateShapedHandles({
      buildInfoDirectory: '/proj/build/build-info-that-does-not-exist',
    });
    const env = resolveEnvironment(shape.handles, { require: ['artifacts'] });
    const report = env.artifacts.ambiguities();
    expect(report.status).toBe('indeterminate');
    if (report.status !== 'indeterminate') {
      throw new Error('unreachable');
    }
    expect(report.reason.kind).toBe('build-info-absent');
  });

  it('imports no logger, clock, config loader or process module anywhere in the seam', () => {
    const forbidden =
      /^(node:)?(os|child_process|worker_threads|perf_hooks|readline|process|vm|module|url|crypto)$/;
    for (const source of environmentSources()) {
      expect(
        source.importSpecifiers.filter(specifier =>
          forbidden.test(specifier),
        ),
        `${source.relative}`,
      ).toEqual([]);
    }
  });

  it('imports fs only in the module that owns the default reader', () => {
    const fsImporters = environmentSources().filter(source =>
      source.importSpecifiers.some(specifier => /(^|:)fs$/.test(specifier)),
    );
    expect(fsImporters.map(source => source.relative)).toEqual(['ambiguity.ts']);
  });

  it('covers all three indeterminate branches with plain fixtures and no build tree', () => {
    // The point of injecting the reader: the three `indeterminate` branches are
    // routine states (INV-34), so they need cheap tests. An `fs`-coupled module
    // would make each of these build and tear down a deliberately corrupt build
    // tree — the kind of test that gets skipped once it turns flaky, which is how
    // a routine degraded path ends up uncovered in violation of SC-003.
    const branches = [
      absentReader(),
      unreadableReader(`${DEFAULT_BUILD_INFO_DIR}/a.output.json`, 'EACCES'),
      filesReader([{ name: 'a.output.json', output: { sources: {} } }]),
    ].map(reader => {
      const report = buildArtifactAmbiguityIndex(
        projectPathsFixture(),
        reader,
      ).report;
      if (report.status !== 'indeterminate') {
        throw new Error('expected an indeterminate report');
      }
      return report.reason.kind;
    });
    expect([...branches].sort()).toEqual([
      'build-info-absent',
      'build-info-lacks-contract-map',
      'build-info-unreadable',
    ]);
  });

  it('embeds the artifact layer in a second host with no source change', () => {
    // The portability test in its strongest form. A different host supplies its
    // own intercept, its own `ProjectPaths` and its own in-memory reader; no
    // `resolveEnvironment` is involved, no TronBox is installed, no filesystem is
    // touched, and nothing in `src/environment/**` changes to make it work.
    //
    // Every host dependency is a parameter: `createArtifactAccess(intercept,
    // paths, reader)`. If any of the three were an imported singleton this test
    // could not be written at all — which is the re-usability property, not a
    // packaging detail.
    const intercept = typedInterceptFixture();
    const paths = buildProjectPaths(
      pathScalarValues({
        root: '/second-host',
        buildInfoDirectory: '/second-host/out/build-info',
      }),
    );
    const store = new Map<string, unknown>([
      [
        'alpha.output.json',
        { contracts: { 'src/Token.sol': { Token: {}, Shared: {} } } },
      ],
      [
        'beta.output.json',
        { contracts: { 'vendor/Shared.sol': { Shared: {} } } },
      ],
    ]);

    const access = createArtifactAccess(intercept, paths, inMemoryReader(store));

    const unique = access.resolve('Token');
    expect(unique.status).toBe('unique');
    if (unique.status !== 'unique') {
      throw new Error('unreachable');
    }
    expect(unique.sourcePath).toBe('src/Token.sol');
    expect(unique.contract).toBe(intercept.require('Token'));

    const ambiguous = access.resolve('Shared');
    expect(ambiguous.status).toBe('ambiguous');
    if (ambiguous.status !== 'ambiguous') {
      throw new Error('unreachable');
    }
    expect(ambiguous.candidates.map(candidate => candidate.sourcePath)).toEqual([
      'src/Token.sol',
      'vendor/Shared.sol',
    ]);

    const report = access.ambiguities();
    expect(report.status).toBe('indexed');
    if (report.status !== 'indexed') {
      throw new Error('unreachable');
    }
    expect([...report.indexedFrom]).toEqual([
      path.join('/second-host/out/build-info', 'alpha.output.json'),
      path.join('/second-host/out/build-info', 'beta.output.json'),
    ]);
    expect(access.intercept).toBe(intercept);
  });

  it('swaps the target project, network and build tree with no source change', () => {
    // The second half of the portability claim: no source change is required to
    // point the seam at a different project, network or build tree. Everything the
    // projections need arrives as arguments, so a second host reconfigures by
    // passing different values.
    const alternate = buildNetworkEnvironment({
      network: 'shasta',
      network_id: '2',
      'networks[network].network_id': '2',
      from: 'TAlternateSender',
      feeLimit: 5_000_000,
      userFeePercentage: 30,
      originEnergyLimit: 1,
      callValue: null,
      tokenValue: null,
      tokenId: null,
      signingKeyConfigured: false,
    });
    expect(alternate.name).toBe('shasta');
    expect(alternate.configuredId).toEqual({ value: '2', syntax: 'exact' });
    expect(alternate.sender.kind).toBe('configured-not-authoritative');

    const alternatePaths = buildProjectPaths(
      pathScalarValues({
        root: '/other-project',
        contractsBuildDirectory: '/tmp/external-build',
      }),
    );
    expect(alternatePaths.root).toBe('/other-project');
    expect(alternatePaths.contractsBuildDirectoryIsExternal).toBe(true);
  });

  it('ships the reference fixtures the second host imports rather than copies', () => {
    // "Test fixtures and reference setups ship with the artifact and the second
    // host imports them." The second host above imported `inMemoryReader`,
    // `typedInterceptFixture` and `pathScalarValues` from `test/helpers/` rather
    // than restating them, and this pins that those entry points exist.
    expect(typeof inMemoryReader).toBe('function');
    expect(typeof typedInterceptFixture).toBe('function');
    expect(typeof pathScalarValues).toBe('function');
    expect(typeof absolute).toBe('function');
    const store = new Map<string, unknown>();
    expect(
      inMemoryReader(store).read(projectPathsFixture().buildInfoDirectory),
    ).toEqual({ status: 'absent' });
  });

  it('exposes the real reader as a value the second host can decline to use', () => {
    // Two members, and the count is the assertion: INV-31 fixes the
    // interface at `read` and `exists`, so a third would be a widening that has to
    // pass through the invariant rather than arrive with a commit.
    expect(Object.isFrozen(fileSystemBuildInfoReader)).toBe(true);
    expect(sortedOwnKeys(fileSystemBuildInfoReader)).toEqual([
      'exists',
      'read',
    ]);
  });

  it('still declares exactly one injected dependency after the probe was added', () => {
    // INV-43's actual subject, which the second method does not touch: the count
    // that matters is *dependencies*, not methods. `exists` arrived on the object
    // already threaded through `EnvironmentDependencies`, so nothing new is
    // constructed, defaulted, or mocked separately — asserted here rather than
    // argued, because "one dependency" is the property SF-11 will re-check.
    const resolveSource = environmentSources().find(
      source => source.relative === 'resolve.ts',
    );
    const declaration =
      /export interface EnvironmentDependencies \{([^}]*)\}/.exec(
        resolveSource?.text ?? '',
      );
    const members = (declaration?.[1] ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('//'));
    expect(members).toEqual(['readonly buildInfoReader?: BuildInfoReader;']);

    // And both methods are answered by the one injected value, not by a second
    // seam: a reader whose `exists` is a distinguishable spy is honoured.
    const probe = existenceProbeReader(true);
    const shape = migrateShapedHandles({}, { mode: 'null' });
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: probe },
    );
    expect(() =>
      env.artifacts.resolvePackaged('pkg/artifacts/Box.json'),
    ).toThrow(EnvironmentIncompleteError);
    expect(probe.probeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// INV-44
// ---------------------------------------------------------------------------

describe('INV-44: no dependence on ambient process state', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env.TRONBOX_NETWORK;
    delete process.env.TRONBOX_WORKING_DIRECTORY;
  });

  it('resolves identically before and after a chdir', () => {
    // `build/components/Require.js:Require.file` chdirs to the migration's
    // directory for the file's top-level evaluation and restores it before the
    // exported function runs, so cwd differs between plugin-require time and
    // operation-call time and equals the project root in neither. Anything
    // cwd-derived would therefore depend silently on *when* it was computed.
    const first = resolveEnvironment(
      migrateShapedHandles().handles,
      { require: ['paths', 'network', 'artifacts'] },
      { buildInfoReader: collidingReader() },
    );
    const before = serializedTree(first);
    const beforeReport = first.artifacts.ambiguities();

    process.chdir(path.dirname(originalCwd));
    expect(process.cwd()).not.toBe(originalCwd);

    const second = resolveEnvironment(
      migrateShapedHandles().handles,
      { require: ['paths', 'network', 'artifacts'] },
      { buildInfoReader: collidingReader() },
    );
    expect(serializedTree(second)).toEqual(before);
    expect(second.artifacts.ambiguities()).toEqual(beforeReport);
  });

  it('refuses a relative project anchor identically from any cwd', () => {
    // The cwd-independence of the *refusal*, which is INV-2's mechanism seen from
    // here: a seam that resolved instead of refusing would produce a different
    // absolute path per cwd, and the difference would be invisible.
    const message = (): string => {
      const error = caught(() =>
        resolveEnvironment(migrateShapedHandles({ root: '../shared' }).handles, {
          require: ['paths'],
        }),
      );
      return (error as Error).message;
    };
    const fromOriginal = message();
    process.chdir(path.dirname(originalCwd));
    expect(message()).toBe(fromOriginal);
    expect(fromOriginal).toContain('must be absolute');
    expect(fromOriginal).toContain('"../shared"');
  });

  it('ignores process.env entirely', () => {
    const baseline = serializedTree(
      resolveEnvironment(migrateShapedHandles().handles, {
        require: ['paths', 'network'],
      }),
    );
    process.env.TRONBOX_NETWORK = 'nile';
    process.env.TRONBOX_WORKING_DIRECTORY = '/hijacked';
    expect(
      serializedTree(
        resolveEnvironment(migrateShapedHandles().handles, {
          require: ['paths', 'network'],
        }),
      ),
    ).toEqual(baseline);
  });

  it('puts no timestamp anywhere in the provenance or the composite', () => {
    // A clock would make INV-21's determinism unachievable for no gain, and a
    // timestamp is the one field that looks harmless and breaks deep equality.
    const env = resolveEnvironment(
      migrateShapedHandles().handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );
    for (const leaf of collectLeaves(serializedTree(env))) {
      expect(
        /time|timestamp|date|resolvedAt|generatedAt/i.test(leaf.path),
        `${leaf.path} looks like a clock reading`,
      ).toBe(false);
      if (typeof leaf.value === 'string') {
        expect(ISO_LIKE.test(leaf.value), `${leaf.path}`).toBe(false);
      }
    }
  });

  it('names no ambient-state identifier anywhere in the seam', () => {
    const forbidden =
      /^(process|global|globalThis|Date|performance|__dirname|__filename|require)$/;
    for (const source of environmentSources()) {
      expect(
        valueIdentifierNames(source).filter(name => forbidden.test(name)),
        `${source.relative}`,
      ).toEqual([]);
      expect(
        source.accessChains.filter(chain =>
          /^(process\.|global\.|globalThis\.|Date\.|Math\.random|performance\.)/.test(
            chain,
          ),
        ),
        `${source.relative}`,
      ).toEqual([]);
    }
  });

  it('is a function of its arguments and the injected reader alone', () => {
    // Stated positively: the same handles and the same reader give a deep-equal
    // composite every time, and a different reader is the only thing besides the
    // handles that can change the answer.
    const shape = migrateShapedHandles();
    const withCollisions = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: collidingReader() },
    ).artifacts.ambiguities();
    const withoutCollisions = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: singleContractReader() },
    ).artifacts.ambiguities();
    expect(withCollisions).not.toEqual(withoutCollisions);
    expect(withCollisions.status).toBe('indexed');
    expect(withoutCollisions.status).toBe('indexed');
  });
});

// ---------------------------------------------------------------------------
// INV-45
// ---------------------------------------------------------------------------

describe('INV-45: default-path resolution does no I/O and costs O(declared slots)', () => {
  it('performs zero reads for a full-slot resolution that never asks for ambiguities', () => {
    // The invariant's own stated test. Eager indexing would turn a run of dozens
    // of migrations into dozens of megabyte-scale reads of files most runs do not
    // consult — and under `tronbox test`, of a build-info tree the run has already
    // been told is never freshly written.
    const reader = countingReader(collidingReader());
    const env = resolveEnvironment(
      migrateShapedHandles().handles,
      { require: slotNames },
      { buildInfoReader: reader },
    );
    expect(env.provenance.slots.artifacts).toBe('present');
    expect(reader.callCount).toBe(0);

    // And the first ask is what pays for it.
    expect(env.artifacts.ambiguities().status).toBe('indexed');
    expect(reader.callCount).toBe(1);
  });

  it('does no I/O even when resolving a contract, until the index is consulted', () => {
    // `resolve()` goes through the intercept first, so a name that does not
    // resolve at all fails with its own diagnosis rather than after megabytes of
    // build-info I/O. The index is only reached for a name that did resolve.
    const reader = countingReader(collidingReader());
    const shape = migrateShapedHandles({}, { resolvable: [] });
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: reader },
    );
    expect(caught(() => env.artifacts.resolve('Missing'))).toBeInstanceOf(Error);
    expect(reader.callCount).toBe(0);
  });

  it('costs nothing extra as the configuration grows', () => {
    // The load assertion, in the unit that matters. A project with fifty networks
    // and two hundred extra config keys must cost exactly what a minimal one
    // costs, because the compared field list is fixed and the networks map is
    // indexed by name rather than enumerated.
    const manyNetworks: Record<string, unknown> = {
      development: networkEntry(),
    };
    for (let index = 0; index < 50; index += 1) {
      manyNetworks[`net${index}`] = networkEntry({ networkId: String(index) });
    }
    const extra: Record<string, unknown> = {};
    for (let index = 0; index < 200; index += 1) {
      extra[`unrelatedKey${index}`] = index;
    }

    const minimal = readCost({ require: ['paths', 'network'] });
    const large = readCost(
      { require: ['paths', 'network'] },
      migrateShapedHandles({ networks: manyNetworks, extra }),
    );
    expect(large).toBe(minimal);
  });

  it('costs nothing extra as the build tree grows, until the index is consulted', () => {
    const many = Array.from({ length: 200 }, (_unused, index) => ({
      name: `f${String(index).padStart(4, '0')}.output.json`,
      contracts: [
        { sourcePath: `contracts/C${index}.sol`, contractNames: [`C${index}`] },
      ],
    }));
    const reader = countingReader(filesReader(many));
    const env = resolveEnvironment(
      migrateShapedHandles().handles,
      { require: slotNames },
      { buildInfoReader: reader },
    );
    expect(reader.callCount).toBe(0);
    expect(env.artifacts.ambiguities().status).toBe('indexed');
    expect(reader.callCount).toBe(1);
  });

  it('grows monotonically and boundedly with the declared slot list', () => {
    const shape = migrateShapedHandles();
    const costs = {
      chainOnly: readCost({ require: ['chain'] }, shape),
      pathsOnly: readCost({ require: ['paths'] }, shape),
      pathsAndNetwork: readCost({ require: ['paths', 'network'] }, shape),
      everything: readCost({ require: slotNames }, shape, {
        buildInfoReader: absentReader(),
      }),
    };
    expect(costs.chainOnly).toBeLessThan(costs.pathsOnly);
    expect(costs.pathsOnly).toBeLessThan(costs.pathsAndNetwork);
    expect(costs.pathsAndNetwork).toBeLessThanOrEqual(costs.everything);
    // The bound: two lineages times the fifteen compared fields, plus the lineage
    // hops, the handle probes and the network-entry reads. Pinned as a ceiling so
    // a change that doubled the read count would fail here rather than pass review.
    expect(costs.everything).toBeLessThan(2 * configLineageFields.length + 20);
  });

  it('compares a fixed field list, split into the groups a slot list needs', () => {
    expect(pathConfigLineageFields).toHaveLength(4);
    expect(networkConfigLineageFields).toHaveLength(11);
    expect(compilerConfigLineageFields).toHaveLength(5);
    expect(configLineageFields).toHaveLength(20);
    expect(Object.isFrozen(configLineageFields)).toBe(true);

    // A paths-only resolution compares four fields, not fifteen: the group split
    // is what makes "linear in the declared slots" true rather than "constant but
    // always the maximum".
    const shape = migrateShapedHandles();
    const pathsRead = resolveEnvironment(shape.handles, {
      require: ['paths'],
    }).provenance.internalPathsRead;
    for (const field of networkConfigLineageFields) {
      if (field === 'network' || field.includes('[')) {
        continue;
      }
      expect(
        pathsRead.filter(read => read.endsWith(`.${field}`)),
        `paths-only resolution read ${field}`,
      ).toEqual([]);
    }
  });

  it('pays nothing for a slot nobody declared', () => {
    const single = readCost({ require: ['chain'] });
    expect(single).toBeLessThan(readCost({ require: ['chain', 'network'] }));
  });
});

// ---------------------------------------------------------------------------
// INV-46
// ---------------------------------------------------------------------------

describe('INV-46: the TypeScript >= 5.0 floor is an invariant, not a preference', () => {
  it('declares a floor of at least 5.0 in the package manifest', () => {
    // The declared floor has to live in the package's own configuration, because
    // below 5.0 `const` type parameters do not exist and INV-1's narrowing
    // silently widens to the full `SlotName` union — the property is not degraded,
    // it is absent.
    const declared = packageJson.devDependencies.typescript;
    expect(declared).toBeDefined();
    const major = Number(/(\d+)\./.exec(declared)?.[1] ?? '0');
    expect(major).toBeGreaterThanOrEqual(5);
  });

  it('runs on a compiler at or above that floor', () => {
    const [major] = ts.version.split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(5);
  });

  it('narrows the composite type to the declared slots and nothing else', () => {
    // The type-level test the invariant asks for, and it cannot pass vacuously:
    // on a compiler without `const` type parameters the narrowing widens, `network`
    // becomes a valid key, and the `@ts-expect-error` below turns into an unused
    // directive that fails the build outright.
    const env = resolveEnvironment(migrateShapedHandles().handles, {
      require: ['paths'],
    });
    expect(env.paths.root).toBe('/proj');
    // @ts-expect-error INV-46 / INV-1: `network` was not declared, so it is absent from the type.
    expect(env.network).toBeUndefined();
  });

  it('keeps the runtime half refusing, which is what makes the compile-time loss silent', () => {
    // On an older compiler the code still compiles, every consumer's
    // undeclared-slot read starts type-checking, and the failure appears as a
    // runtime error in a module that type-checked cleanly. The runtime half is
    // still there — `provenance.slots` states the absence as data.
    const env = resolveEnvironment(migrateShapedHandles().handles, {
      require: ['paths'],
    });
    expect(env.provenance.slots).toEqual({
      paths: 'present',
      network: 'absent',
      artifacts: 'absent',
      chain: 'absent',
      receipts: 'absent',
      scheduling: 'absent',
      output: 'absent',
      compiler: 'absent',
    });
    expect(
      Object.prototype.hasOwnProperty.call(env, 'network'),
    ).toBe(false);
  });

  it('declares the const type parameters the floor exists for', () => {
    const resolveSource = environmentSources().find(
      source => source.relative === 'resolve.ts',
    );
    expect(resolveSource?.text).toContain('const R extends readonly SlotName[]');
    expect(resolveSource?.text).toContain('const O extends readonly SlotName[]');
  });
});

// ---------------------------------------------------------------------------
// INV-47
// ---------------------------------------------------------------------------

describe('INV-47: host-shaped but consumer-agnostic', () => {
  it('names no proxy, upgrade, validation or manifest concept as an identifier', () => {
    // Identifiers, not raw text: the seam's doc comments legitimately reference
    // `TronWebProxy.js` and the plugin's own manifest while explaining the upstream
    // mechanisms the absences exist to avoid, so a text grep would report a
    // violation for every comment that documents one.
    const domainVocabulary =
      /^(proxy|beacon|implementation|upgradeable|upgrades|erc1967|erc1822|storageLayout|proxyAdmin|initializer|manifest|deployProxy|upgradeProxy|validateUpgrade)$/i;
    for (const source of environmentSources()) {
      const hits = source.identifiers
        .filter(use => domainVocabulary.test(use.name))
        .map(use => use.name);
      expect(hits, `${source.relative}`).toEqual([]);
    }
  });

  it('imports nothing outside node builtins, the seam itself and the manifest', () => {
    // The dependency direction, checkable. `../../package.json` is the one
    // non-relative-within-seam specifier and it is INV-19's single home for the
    // declared peer range.
    for (const source of environmentSources()) {
      for (const specifier of source.importSpecifiers) {
        const permitted =
          /^node:(fs|path)$/.test(specifier) ||
          /^\.\/[a-z-]+$/.test(specifier) ||
          specifier === '../../package.json';
        expect(
          permitted,
          `${source.relative} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('imports no sibling sub-feature module, in either direction', () => {
    // One-way: consumers depend on the seam, the seam depends on nothing in the
    // package. The first import back from `environment/` into an operation module
    // creates the cycle that makes the check unenforceable in both directions.
    for (const source of environmentSources()) {
      expect(
        source.importSpecifiers.filter(specifier =>
          /^\.\.\/(?!\.\/)(?!\.\.\/package\.json)/.test(specifier),
        ),
        `${source.relative} reaches out of the seam`,
      ).toEqual([]);
    }
    // The mirror of INV-28, and live rather than prospective: `src/chain`,
    // `src/options`, `src/output`, `src/results` and `src/index.ts` are all under
    // this scan today, and each does depend on the seam — so what is being asserted
    // is that every one of those dependencies goes through `environment/index` and
    // none reaches a seam internal directly. The subject is asserted non-empty
    // because a rule this cheap to satisfy vacuously is worth proving it is not.
    const outside = nonEnvironmentSources();
    for (const source of outside) {
      expect(
        source.importSpecifiers.filter(specifier =>
          /environment\/(?!index)/.test(specifier),
        ),
        `${source.relative} imports past the seam's face`,
      ).toEqual([]);
    }
    expect(outside.length).toBeGreaterThan(0);
    expect(
      outside.some(source =>
        source.importSpecifiers.some(specifier =>
          /(^|\/)environment(\/index)?$/.test(specifier),
        ),
      ),
    ).toBe(true);
    expect(path.relative(packageRoot, srcDir)).toBe('src');
  });

  it('exports the slot table as frozen data, so tests and messages read the matrix', () => {
    // "Exported as data" is load-bearing rather than decorative: `errors.ts`
    // renders `providedIn` / `absentIn` from this table, so a table edit cannot
    // leave a hand-written message contradicting it.
    expect(Object.isFrozen(slotNames)).toBe(true);
    expect(Object.isFrozen(slotRequirements)).toBe(true);
    for (const slot of slotNames) {
      const requirement = slotRequirements[slot];
      expect(Object.isFrozen(requirement), slot).toBe(true);
      expect(Object.isFrozen(requirement.handles), slot).toBe(true);
      expect(Object.isFrozen(requirement.providedIn), slot).toBe(true);
      expect(Object.isFrozen(requirement.absentIn), slot).toBe(true);
      expect(
        requirement.providedIn.length + requirement.absentIn.length,
        slot,
      ).toBe(5);
    }
    expect(sortedOwnKeys(slotRequirements)).toEqual([...slotNames].sort());
  });

  it('needs no proxy fixture to exercise a config projection', () => {
    // The practical cost INV-47 avoids, asserted as a fact about this very suite:
    // every fixture is a plain object, and none of them mentions a proxy, an
    // implementation address or a manifest. A seam that knew about proxies could
    // not be reasoned about independently of the operations.
    const env = resolveEnvironment(
      migrateShapedHandles().handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );
    const serialized = JSON.stringify(serializedTree(env));
    for (const term of ['proxy', 'implementation', 'admin', 'manifest']) {
      expect(serialized.toLowerCase()).not.toContain(term);
    }
  });

  it('exposes the same seam face to every invocation shape', () => {
    // Host-shaped, consumer-agnostic: the same entry point serves the migrate
    // shape, the mocha-file shape and the deployer-only shape with no shape-specific
    // branch in the caller. This is also what keeps SF-4's mocha-scope question
    // open — nothing here presupposes a deployer.
    const shapes = [
      ['migrate', migrateShapedHandles().handles, ['paths', 'network']],
      ['artifacts only', artifactsOnlyHandles().handles, ['paths', 'network']],
      ['deployer only', deployerOnlyHandles().handles, ['paths', 'network']],
    ] as const;
    for (const [label, handleSet, require] of shapes) {
      const env = resolveEnvironment(handleSet, { require });
      expect(env.paths.root, label).toBe('/proj');
      expect(env.network.name, label).toBe('development');
    }
    // And a shape with no handles at all is a named diagnosis, not a crash.
    expect(
      caught(() => resolveEnvironment(handles({}), { require: ['paths'] })),
    ).toBeInstanceOf(Error);
  });
});
