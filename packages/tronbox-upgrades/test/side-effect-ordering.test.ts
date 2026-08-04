import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildArtifactAmbiguityIndex,
  EnvironmentIncompleteError,
  fileSystemBuildInfoReader,
  resolveEnvironment,
  slotNames,
  type ArtifactAmbiguityReport,
  type IndeterminateReason,
  type SlotName,
} from '../src/environment';
import { networkEntry } from './helpers/config-fixtures';
import { allFixtureProbes } from './helpers/fixture-catalogue';
import {
  artifactsOnlyHandles,
  deployerHandle,
  deployerOnlyHandles,
  handles,
  hostileTronWrapHandle,
  interceptFixture,
  migrateShapedHandles,
  testShapedHandles,
  tronWrapHandle,
} from './helpers/handles';
import { serializedTree, sortedOwnKeys } from './helpers/introspect';
import { makeTempDir } from './helpers/locate';
import { projectPathsFixture } from './helpers/paths-fixtures';
import {
  absentReader,
  absolute,
  collidingReader,
  countingReader,
  escapingUnreadableReader,
  existenceProbeReader,
  filesReader,
  singleContractReader,
  throwingReader,
  unreadableReader,
  DEFAULT_BUILD_INFO_DIR,
} from './helpers/readers';
import {
  emittedIdentifierNames,
  environmentSources,
  interfaceMembers,
  valueIdentifierNames,
} from './helpers/source-scan';

/**
 * Side-Effect Ordering & Observability — INV-30 … INV-36.
 *
 * SF-0 has almost no side effects to order, and that is the point: five of these
 * seven invariants are *absences* (no network, no chain read, no write, no
 * emission, no promise-adjacent scheduling), and an absence is only testable two
 * ways — drive the seam with a fixture that would fail loudly if the absence
 * were violated, and scan the source for the identifiers that could violate it.
 * Both techniques appear below, deliberately paired: the fixture proves today's
 * behaviour, the scan proves the next edit cannot quietly introduce it.
 *
 * The two invariants that *are* about observability — INV-33's `internalPathsRead`
 * and INV-34's two reduced-verification modes — get the sequence-interleaving
 * treatment in the shape that applies here. There is no concurrency to interleave,
 * so the equivalent is driving the same resolution through different *reachability*
 * shapes and asserting the reported state tracks what was actually read rather
 * than a static declaration.
 */

const ALL_SLOTS: readonly SlotName[] = slotNames;

function caught(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error('expected the resolution to throw, and it returned normally');
}

function indeterminateReason(
  report: ArtifactAmbiguityReport,
): IndeterminateReason {
  if (report.status !== 'indeterminate') {
    throw new Error(
      `expected an indeterminate report, and the status is "${report.status}"`,
    );
  }
  return report.reason;
}

function indexedReport(
  report: ArtifactAmbiguityReport,
): Extract<ArtifactAmbiguityReport, { status: 'indexed' }> {
  if (report.status !== 'indexed') {
    throw new Error(
      `expected an indexed report, and the status is "${report.status}"`,
    );
  }
  return report;
}

// ---------------------------------------------------------------------------
// INV-30
// ---------------------------------------------------------------------------

describe('INV-30: SF-0 performs no network I/O and no chain read', () => {
  it('resolves every slot against a tronWrap whose every method throws', () => {
    // This is the invariant's own stated test, and it doubles as documentation:
    // the `chain` slot is a handle pass-through, not a client. If any part of the
    // seam reached for `trx.getCurrentBlock`, `getChainParameters`, or a dev-node
    // probe, the hostile proxy would throw with a message naming the method.
    const shape = migrateShapedHandles();
    const hostile = hostileTronWrapHandle();
    const env = resolveEnvironment(
      handles({
        deployer: shape.deployer,
        artifacts: shape.intercept,
        tronWrap: hostile,
        waitForTransactionReceipt: (): void => {},
      }),
      { require: ALL_SLOTS },
      { buildInfoReader: singleContractReader() },
    );
    expect(env.chain.tronWrap).toBe(hostile);
    expect(env.provenance.slots.chain).toBe('present');
  });

  it('resolves a bare artifact and the ambiguity report without touching the chain', () => {
    // The lazy surfaces too, not just `resolveEnvironment` — an eager chain read
    // hidden behind `resolve()` would pass the assertion above.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      handles({
        deployer: shape.deployer,
        artifacts: shape.intercept,
        tronWrap: hostileTronWrapHandle(),
      }),
      { require: ['artifacts', 'chain', 'network'] },
      { buildInfoReader: collidingReader() },
    );
    expect(env.artifacts.resolve('Box').status).toBe('ambiguous');
    expect(env.artifacts.ambiguities().status).toBe('indexed');
    expect(env.network.name).toBe('development');
  });

  it("leaves '*' unresolved rather than asking the chain what it means", () => {
    // INV-6 owns the field shape; what this asserts is the *absence* of the
    // resolution step. TronBox never resolves `'*'` either, so a seam that did
    // would put chain-identity resolution in two places — SF-0's and SF-1's —
    // which is how one wildcard becomes two different answers.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      handles({
        deployer: shape.deployer,
        artifacts: shape.intercept,
        tronWrap: hostileTronWrapHandle(),
      }),
      { require: ['network', 'chain'] },
    );
    expect(env.network.configuredId).toEqual({
      value: '*',
      syntax: 'wildcard',
    });
    expect(env.network.artifactNetworkId).toBe('*');
  });

  it('imports no network module and names no fetch primitive anywhere in the seam', () => {
    const networkModules =
      /^(node:)?(http|https|net|tls|dns|dgram|http2)$/;
    const fetchPrimitives =
      /^(fetch|XMLHttpRequest|WebSocket|EventSource|Request|Response)$/;
    for (const source of environmentSources()) {
      expect(
        source.importSpecifiers.filter(specifier =>
          networkModules.test(specifier),
        ),
        `${source.relative} imports a network module`,
      ).toEqual([]);
      expect(
        valueIdentifierNames(source).filter(name =>
          fetchPrimitives.test(name),
        ),
        `${source.relative} names a fetch primitive`,
      ).toEqual([]);
    }
  });

  it('reads no chain-state property path anywhere in the seam', () => {
    // The seam reads exactly one property off the chain handle — `trx` — and only
    // to prove the handle is shaped like a client. Anything past that is a chain
    // read wearing a property access.
    const chainReads = /^(getCurrentBlock|getChainParameters|getContract|getTransactionInfo|getAccount|getBalance|getBlockByNumber|implementation|admin)$/;
    for (const source of environmentSources()) {
      expect(
        source.accessChains.filter(chain =>
          chainReads.test(chain.split('.').pop() ?? ''),
        ),
        `${source.relative}`,
      ).toEqual([]);
      expect(
        source.readPropertyKeys.filter(key => chainReads.test(key)),
        `${source.relative}`,
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// INV-31
// ---------------------------------------------------------------------------

describe('INV-31: disk reads only through the injected reader, only under buildInfoDirectory, and no writes', () => {
  it('exposes exactly two methods, and the probe is typed to carry no content', () => {
    // Revision 2's amendment, asserted as a count rather than argued in a comment.
    // The interface is the enforcement: `exists` returns `boolean`, so no byte of
    // the packaged artifact can flow out of the weaker capability even by mistake
    // (which is what keeps INV-42 intact while INV-18 gains its third message).
    const ambiguitySource = environmentSources().find(
      source => source.relative === 'ambiguity.ts',
    );
    const declaration = /export interface BuildInfoReader \{([^}]*)\}/.exec(
      ambiguitySource?.text ?? '',
    );
    expect(declaration).not.toBeNull();
    const members = interfaceMembers(declaration?.[1] ?? '');
    expect(members).toEqual([
      'read(buildInfoDirectory: AbsolutePath): BuildInfoReadResult;',
      'exists(file: AbsolutePath): boolean;',
    ]);
    expect(sortedOwnKeys(fileSystemBuildInfoReader)).toEqual([
      'exists',
      'read',
    ]);
    expect(typeof fileSystemBuildInfoReader.exists(absolute('/nope/nope.json')))
      .toBe('boolean');
  });

  it('probes only the host-arithmetic path, and only from resolvePackaged', () => {
    // The probe's confinement, which is a different property from `read`'s: `read`
    // is confined by *containment* in `buildInfoDirectory`, `exists` by being
    // asked only about `<root>/node_modules/<validated>`. A probe asked about an
    // arbitrary path would be a general filesystem oracle inside the seam.
    const probe = existenceProbeReader(false);
    const shape = migrateShapedHandles({ root: '/proj' }, { mode: 'null' });
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: probe },
    );
    caught(() => env.artifacts.resolvePackaged('pkg/artifacts/Box.json'));
    expect(probe.probedPaths).toEqual([
      path.join('/proj', 'node_modules', 'pkg/artifacts/Box.json'),
    ]);
    // One probe per failed resolution — not one per candidate, and not a retry.
    expect(probe.probeCount).toBe(1);
  });

  it('never probes on the happy path, so a successful resolve does no I/O at all', () => {
    // INV-45's zero-I/O claim survives the amendment: the probe runs *after* the
    // host has already failed, so a resolution that succeeds never touches the
    // filesystem through either method.
    const probe = existenceProbeReader(true);
    const shape = migrateShapedHandles(
      {},
      { mode: 'resolve', resolvable: ['pkg/artifacts/Box.json'] },
    );
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: probe },
    );
    expect(env.artifacts.resolvePackaged('pkg/artifacts/Box.json')).toBeDefined();
    expect(probe.probeCount).toBe(0);
    expect(probe.callCount).toBe(0);
  });

  it('never probes a path that failed containment, since containment is decided first', () => {
    // INV-18's check order is load-bearing here, not stylistic. If existence were
    // decided first, `../../../etc/shadow.json` would become a filesystem oracle
    // for paths outside the project — the probe answers a question the seam should
    // refuse to ask.
    const probe = existenceProbeReader(true);
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: probe },
    );
    for (const escaping of [
      './local.json',
      '/etc/passwd.json',
      '../escape.json',
      'pkg/../../escape.json',
      'C:/secrets.json',
      '..',
      '',
      'pkg/a\0b.json',
      'pkg/Box',
    ]) {
      caught(() => env.artifacts.resolvePackaged(escaping));
    }
    expect(probe.probedPaths).toEqual([]);
  });

  it('calls exists from exactly one place in the seam', () => {
    // "One enumerated call site" made mechanical. A second call site is how the
    // probe's confinement stops being checkable — every new one would need its own
    // argument-provenance argument, and the invariant states there is one.
    const callers = environmentSources().filter(source =>
      source.accessChains.some(chain => /\.exists$/.test(chain)),
    );
    expect(callers.map(source => source.relative)).toEqual(['artifacts.ts']);
    const artifactsSource = callers[0];
    expect(
      artifactsSource?.accessChains.filter(chain => /\.exists$/.test(chain)),
    ).toEqual(['reader.exists']);
  });

  it('imports fs in ambiguity.ts alone', () => {
    const importers = environmentSources().filter(source =>
      source.importSpecifiers.some(specifier =>
        /^(node:)?fs(\/promises)?$/.test(specifier),
      ),
    );
    expect(importers.map(source => source.relative)).toEqual(['ambiguity.ts']);
  });

  it("takes the plugin manifest as a static import, not as a second fs read", () => {
    // INV-31 enumerates the manifest read as the one other read. It is a static
    // module import resolved by the loader, so it is not a runtime `fs` call at
    // all — which is stronger than the invariant claims and worth pinning, since
    // rewriting it as `readFileSync` would make `errors.ts` a second fs importer
    // and fail the assertion above.
    const errorsSource = environmentSources().find(
      source => source.relative === 'errors.ts',
    );
    expect(errorsSource).toBeDefined();
    expect(errorsSource?.importSpecifiers).toContain('../../package.json');
    expect(
      errorsSource?.importSpecifiers.filter(specifier =>
        /fs/.test(specifier),
      ),
    ).toEqual([]);
  });

  it('names no filesystem write primitive anywhere in the seam', () => {
    // A write would make SF-0 a state-holder and would put durable data in a
    // directory that may be `contractsBuildDirectory` and therefore evaporate —
    // SF-3's hazard, reintroduced by the module that exists to warn about it.
    const writes =
      /^(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|createWriteStream|open|openSync|write|writeSync|truncate|truncateSync|chmod|chmodSync|utimes|utimesSync|symlink|symlinkSync|link|linkSync|mkdtemp|mkdtempSync)$/;
    for (const source of environmentSources()) {
      expect(
        emittedIdentifierNames(source).filter(name => writes.test(name)),
        `${source.relative}`,
      ).toEqual([]);
    }
  });

  it('reads exactly one directory, and it is buildInfoDirectory', () => {
    const reader = countingReader(singleContractReader());
    const paths = projectPathsFixture();
    const index = buildArtifactAmbiguityIndex(paths, reader);
    expect(index.report.status).toBe('indexed');
    expect(reader.directories).toEqual([paths.buildInfoDirectory]);
  });

  it('asks for buildInfoDirectory rather than root, contracts or the build tree', () => {
    // The reader receives one path and it must be the build-info anchor. Handing
    // it `root` would turn a bounded listing into a walk of the whole project.
    const reader = countingReader(absentReader());
    const paths = projectPathsFixture({
      root: '/proj',
      buildInfoDirectory: '/proj/artifacts/build-info',
    });
    buildArtifactAmbiguityIndex(paths, reader);
    expect(reader.directories).toEqual(['/proj/artifacts/build-info']);
    expect(reader.directories).not.toContain(paths.root);
    expect(reader.directories).not.toContain(paths.contractsBuildDirectory);
  });

  it('refuses a reader-named unreadable file outside buildInfoDirectory', () => {
    // The reader is injected, so its output is untrusted input. A reason naming
    // `/etc/passwd` would put an arbitrary path into a user-visible diagnostic.
    const reason = indeterminateReason(
      buildArtifactAmbiguityIndex(
        projectPathsFixture(),
        escapingUnreadableReader(),
      ).report,
    );
    expect(reason).toEqual({
      kind: 'build-info-unreadable',
      file: projectPathsFixture().buildInfoDirectory,
      cause: 'the build-info reader named a file outside buildInfoDirectory',
    });
    expect(JSON.stringify(reason)).not.toContain('/etc/passwd');
  });

  it('refuses a reader-returned build-info file outside buildInfoDirectory', () => {
    const reason = indeterminateReason(
      buildArtifactAmbiguityIndex(
        projectPathsFixture(),
        filesReader([
          {
            name: 'aaa.output.json',
            absolutePath: '/elsewhere/aaa.output.json',
            contracts: [
              { sourcePath: 'contracts/Box.sol', contractNames: ['Box'] },
            ],
          },
        ]),
      ).report,
    );
    expect(reason).toEqual({
      kind: 'build-info-unreadable',
      file: projectPathsFixture().buildInfoDirectory,
      cause: 'the build-info reader named a file outside buildInfoDirectory',
    });
  });

  it('accepts a file nested below buildInfoDirectory, since containment is the rule', () => {
    // Containment, not "direct child". The rule INV-31 states is containment; the
    // no-recursion rule is INV-37's and belongs to the default reader.
    const report = buildArtifactAmbiguityIndex(
      projectPathsFixture(),
      filesReader([
        {
          name: path.join('nested', 'aaa.output.json'),
          contracts: [
            { sourcePath: 'contracts/Box.sol', contractNames: ['Box'] },
          ],
        },
      ]),
    ).report;
    expect(report.status).toBe('indexed');
  });

  it('writes nothing to disk across a full resolution and every lazy surface', () => {
    // Belt and braces over the source scan: a real temp directory, and the seam
    // driven through every surface that could plausibly want to cache something.
    const dir = makeTempDir('no-writes');
    const buildInfo = path.join(dir, 'build', 'build-info');
    fs.mkdirSync(buildInfo, { recursive: true });
    fs.writeFileSync(
      path.join(buildInfo, 'aaa.output.json'),
      JSON.stringify({
        contracts: { 'contracts/Box.sol': { Box: { abi: [] } } },
      }),
    );
    const before = fs.readdirSync(buildInfo).sort();

    const shape = migrateShapedHandles({
      root: dir,
      buildInfoDirectory: buildInfo,
      contractsBuildDirectory: path.join(dir, 'build', 'contracts'),
      contractsDirectory: path.join(dir, 'contracts'),
    });
    const env = resolveEnvironment(shape.handles, {
      require: ['paths', 'artifacts', 'network'],
    });
    expect(env.artifacts.ambiguities().status).toBe('indexed');
    expect(env.artifacts.resolve('Box').status).toBe('unique');

    expect(fs.readdirSync(buildInfo).sort()).toEqual(before);
    expect(fs.readdirSync(dir).sort()).toEqual(['build']);
    expect(fs.existsSync(path.join(dir, 'build', 'contracts'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INV-32
// ---------------------------------------------------------------------------

describe('INV-32: SF-0 emits nothing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('touches no console method across every fixture in the catalogue', () => {
    // Every fixture, not one: `build/components/Require.js:Require` always injects
    // the real `console` into the sandbox, so plugin output written to `console`
    // ignores `--quiet` entirely. A single stray `console.warn` on one failure
    // path is enough to bypass the host's quiet mode, and the failure paths are
    // where a warning is most tempting to write.
    const spies = (
      ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'] as const
    ).map(method => ({
      method,
      spy: vi.spyOn(console, method).mockImplementation(() => undefined),
    }));

    const probes = allFixtureProbes();
    expect(probes.length).toBeGreaterThan(20);

    for (const { method, spy } of spies) {
      expect(spy, `console.${method} was called`).not.toHaveBeenCalled();
    }
  });

  it('never calls the logger it exposes, on success or on any diagnosis', () => {
    const shapes = [
      migrateShapedHandles(),
      testShapedHandles({}, { network: 'nile' }),
      artifactsOnlyHandles(),
      deployerOnlyHandles(),
      migrateShapedHandles({ networks: {} }),
      migrateShapedHandles({ throwOn: ['contracts_directory'] }),
    ];
    for (const shape of shapes) {
      try {
        const env = resolveEnvironment(
          shape.handles,
          { require: ['paths', 'network', 'output'] },
          { buildInfoReader: singleContractReader() },
        );
        expect(env.provenance.slots.output).toBe('present');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      expect(shape.loggerCalls).toEqual([]);
    }
  });

  it('leaves the logger untouched even when the lazy surfaces fail', () => {
    const shape = migrateShapedHandles({}, { mode: 'throw' });
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts', 'output'] },
      { buildInfoReader: throwingReader(new TypeError('reader exploded')) },
    );
    expect(caught(() => env.artifacts.resolve('Box'))).toBeInstanceOf(
      EnvironmentIncompleteError,
    );
    expect(env.artifacts.ambiguities().status).toBe('indeterminate');
    expect(shape.loggerCalls).toEqual([]);
  });

  it('names no console, stdout or stderr identifier anywhere in the seam', () => {
    for (const source of environmentSources()) {
      expect(
        valueIdentifierNames(source).filter(name =>
          /^(console|stdout|stderr)$/.test(name),
        ),
        `${source.relative}`,
      ).toEqual([]);
      expect(
        source.accessChains.filter(chain =>
          /^(process\.stdout|process\.stderr|console\.)/.test(chain),
        ),
        `${source.relative}`,
      ).toEqual([]);
    }
  });

  it('calls no method on the logger anywhere in the seam', () => {
    // The `output` slot is a capability handed to SF-10, not a channel SF-0 uses.
    // `output.ts` reads `logger.log` to prove it is callable and never calls it.
    for (const source of environmentSources()) {
      expect(
        source.accessChains.filter(chain =>
          /(^|\.)logger\.(log|warn|error|info|debug)$/.test(chain),
        ),
        `${source.relative} calls through the logger`,
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// INV-33
// ---------------------------------------------------------------------------

describe('INV-33: internalPathsRead is exactly the set of internal paths this resolution read', () => {
  it('reports the exact path set for a both-lineages paths-only resolution', () => {
    // Pinned exactly rather than by containment, because the failure mode this
    // invariant exists to catch is a *static* list — and a static list satisfies
    // every `toContain` assertion anyone would think to write.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['paths'] });
    expect([...env.provenance.internalPathsRead].sort()).toEqual([
      'artifacts.resolver',
      'artifacts.resolver.options',
      'artifacts.resolver.options.build_info_directory',
      'artifacts.resolver.options.contracts_build_directory',
      'artifacts.resolver.options.contracts_directory',
      'artifacts.resolver.options.working_directory',
      'deployer.options',
      'deployer.options.options',
      'deployer.options.options.build_info_directory',
      'deployer.options.options.contracts_build_directory',
      'deployer.options.options.contracts_directory',
      'deployer.options.options.resolver',
      'deployer.options.options.working_directory',
    ]);
  });

  it('does not report a lineage it never traversed', () => {
    // The single-lineage shapes. A resolution that skips a lineage must not
    // report that lineage's paths — the invariant's own wording.
    const artifactsOnly = resolveEnvironment(
      artifactsOnlyHandles().handles,
      { require: ['paths'] },
    );
    expect(
      artifactsOnly.provenance.internalPathsRead.filter(read =>
        read.startsWith('deployer.options'),
      ),
    ).toEqual([]);
    expect(artifactsOnly.provenance.internalPathsRead).toContain(
      'artifacts.resolver.options.working_directory',
    );

    const deployerOnly = resolveEnvironment(deployerOnlyHandles().handles, {
      require: ['paths'],
    });
    expect(
      deployerOnly.provenance.internalPathsRead.filter(read =>
        read.startsWith('artifacts.resolver'),
      ),
    ).toEqual([]);
    expect(deployerOnly.provenance.internalPathsRead).toContain(
      'deployer.options.options.working_directory',
    );
  });

  it('differs between a both-lineages and a single-lineage resolution', () => {
    const both = resolveEnvironment(migrateShapedHandles().handles, {
      require: ['paths'],
    }).provenance.internalPathsRead;
    const single = resolveEnvironment(deployerOnlyHandles().handles, {
      require: ['paths'],
    }).provenance.internalPathsRead;
    expect([...both].sort()).not.toEqual([...single].sort());
    expect(both.length).toBeGreaterThan(single.length);
  });

  it('reports no network field path for a paths-only resolution, and no path field for a network-only one', () => {
    // Not a superset either. A superset makes tests assert paths that were never
    // read, and the first genuine removal looks like a regression.
    const pathsOnly = resolveEnvironment(migrateShapedHandles().handles, {
      require: ['paths'],
    }).provenance.internalPathsRead;
    for (const field of ['networks', 'feeLimit', 'network_id', 'from']) {
      expect(
        pathsOnly.filter(read => read.endsWith(`.${field}`)),
        `paths-only resolution reported ${field}`,
      ).toEqual([]);
    }

    const networkOnly = resolveEnvironment(migrateShapedHandles().handles, {
      require: ['network'],
    }).provenance.internalPathsRead;
    for (const field of [
      'contracts_directory',
      'contracts_build_directory',
      'build_info_directory',
    ]) {
      expect(
        networkOnly.filter(read => read.endsWith(`.${field}`)),
        `network-only resolution reported ${field}`,
      ).toEqual([]);
    }
    expect(networkOnly).toContain('deployer.options.options.networks');
  });

  it('grows with the declared slot list rather than being fixed', () => {
    const shape = migrateShapedHandles();
    const oneSlot = resolveEnvironment(shape.handles, { require: ['paths'] })
      .provenance.internalPathsRead;
    const everySlot = resolveEnvironment(
      migrateShapedHandles().handles,
      { require: ALL_SLOTS },
      { buildInfoReader: singleContractReader() },
    ).provenance.internalPathsRead;
    expect(new Set(everySlot).size).toBeGreaterThan(new Set(oneSlot).size);
    for (const read of oneSlot) {
      expect(everySlot, `${read} disappeared from the wider resolution`).toContain(
        read,
      );
    }
  });

  it('records the network entry by its configured name, not by a placeholder', () => {
    const shape = migrateShapedHandles({
      network: 'nile',
      networks: { nile: networkEntry({ networkId: '3' }) },
    });
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    expect(env.provenance.internalPathsRead).toContain(
      'deployer.options.options.networks.nile',
    );
    expect(env.provenance.internalPathsRead).toContain(
      'deployer.options.options.networks.nile.privateKey',
    );
    expect(
      env.provenance.internalPathsRead.filter(read =>
        read.includes('development'),
      ),
    ).toEqual([]);
  });

  it("draws every recorded path's final segment from the seam's declared host-key surface", () => {
    // The union bound. INV-28's test enumerates the literal host keys the seam
    // reads; this asserts the runtime record stays inside that surface plus the
    // three keys reached through a non-literal read and the configured network
    // name, which is user data rather than a host key.
    const declaredHostKeys = new Set([
      'log',
      'logger',
      'network_id',
      'networks',
      'privateKey',
      'quiet',
      'resolver',
      'then',
      'trx',
      // reached through a loop over an array literal or a descriptor probe
      'require',
      'contracts',
      'working_directory',
      // the lineage hops and the compared scalars, read by literal field name
      'options',
      'contracts_directory',
      'contracts_build_directory',
      'build_info_directory',
      'network',
      'from',
      'feeLimit',
      'userFeePercentage',
      'originEnergyLimit',
      'callValue',
      'tokenValue',
      'tokenId',
      // the compiler slot's keys, added at revision 5. `evm` and `compilers` are
      // not declared Config props — they exist only when the CLI or the project's
      // `tronbox.js` supplies them — so a chain through them commonly stops at the
      // first hop and the deeper keys never appear in a given run's record.
      'solc',
      'compilers',
      'settings',
      'version',
      'evm',
      'useZeroFourCompiler',
      'useZeroFiveCompiler',
    ]);
    const configuredNetworkNames = new Set(['development']);

    const union = new Set<string>();
    for (const shape of [
      migrateShapedHandles(),
      testShapedHandles(),
      artifactsOnlyHandles(),
      deployerOnlyHandles(),
    ]) {
      try {
        const env = resolveEnvironment(
          shape.handles,
          { require: ALL_SLOTS, optional: [] },
          { buildInfoReader: singleContractReader() },
        );
        for (const read of env.provenance.internalPathsRead) {
          union.add(read);
        }
      } catch (error) {
        // A shape that cannot satisfy every slot still exercised its reads; the
        // union assertion below is about what a *successful* resolution reports,
        // so a throw here is recorded and skipped rather than failing the test.
        expect(error).toBeInstanceOf(Error);
      }
    }
    expect(union.size).toBeGreaterThan(0);

    const unexpected = [...union].filter(read => {
      const segment = read.split('.').pop() ?? '';
      return (
        !declaredHostKeys.has(segment) && !configuredNetworkNames.has(segment)
      );
    });
    expect(unexpected).toEqual([]);
  });

  it('covers only resolveEnvironment, as the type documents', () => {
    // A later `resolve()` / `ambiguities()` call reads through the intercept and
    // the reader, not through a Config, and the snapshot is frozen at return
    // time. Pinned so the field's scope is a tested fact rather than a comment.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: singleContractReader() },
    );
    const before = [...env.provenance.internalPathsRead];
    env.artifacts.resolve('Box');
    env.artifacts.ambiguities();
    expect([...env.provenance.internalPathsRead]).toEqual(before);
    expect(Object.isFrozen(env.provenance.internalPathsRead)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-34
// ---------------------------------------------------------------------------

describe('INV-34: both reduced-verification modes are stated, never inferred', () => {
  it('mode 1: names the available lineage when only the deployer is supplied', () => {
    const env = resolveEnvironment(deployerOnlyHandles().handles, {
      require: ['paths', 'network'],
    });
    expect(env.provenance.configLineages).toEqual({
      viaDeployer: 'materialized-snapshot',
      viaArtifacts: 'absent',
      crossChecked: false,
      crossCheckSkippedBecause: 'only-deployer-lineage-available',
      sameObject: false,
    });
  });

  it('mode 1: names the available lineage when only artifacts is supplied', () => {
    const env = resolveEnvironment(artifactsOnlyHandles().handles, {
      require: ['paths', 'network'],
    });
    expect(env.provenance.configLineages).toEqual({
      viaDeployer: 'absent',
      viaArtifacts: 'live-config',
      crossChecked: false,
      crossCheckSkippedBecause: 'only-artifacts-lineage-available',
      sameObject: false,
    });
  });

  it('mode 1 is not a failure: the reduced resolution still returns a composite', () => {
    const env = resolveEnvironment(deployerOnlyHandles().handles, {
      require: ['paths', 'network', 'scheduling', 'output'],
    });
    expect(env.paths.root).toBe('/proj');
    expect(env.network.name).toBe('development');
    expect(env.provenance.slots.scheduling).toBe('present');
  });

  it('omits crossCheckSkippedBecause entirely when the cross-check ran', () => {
    // Absent, not `undefined` — INV-4's rule applied to this field. A consumer
    // testing `'crossCheckSkippedBecause' in provenance` must get `false`.
    const env = resolveEnvironment(migrateShapedHandles().handles, {
      require: ['paths'],
    });
    expect(env.provenance.configLineages.crossChecked).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(
        env.provenance.configLineages,
        'crossCheckSkippedBecause',
      ),
    ).toBe(false);
    expect(sortedOwnKeys(env.provenance.configLineages)).toEqual([
      'crossChecked',
      'sameObject',
      'viaArtifacts',
      'viaDeployer',
    ]);
  });

  it('never reports crossChecked: false while both lineages were reachable', () => {
    // The invariant's own second test. Driven across every shape rather than one,
    // because the bug it guards against — reporting a skip the resolution did not
    // actually take — would show up on whichever shape nobody wrote a test for.
    const shapes: readonly [string, ReturnType<typeof migrateShapedHandles>][] =
      [
        ['migrate', migrateShapedHandles()],
        ['tronbox test', testShapedHandles()],
        ['artifacts only', artifactsOnlyHandles()],
        ['deployer only', deployerOnlyHandles()],
      ];
    for (const [label, shape] of shapes) {
      const env = resolveEnvironment(shape.handles, { require: ['paths'] });
      const lineages = env.provenance.configLineages;
      const bothReachable =
        lineages.viaDeployer !== 'absent' && lineages.viaArtifacts !== 'absent';
      expect(lineages.crossChecked, label).toBe(bothReachable);
      expect(
        Object.prototype.hasOwnProperty.call(
          lineages,
          'crossCheckSkippedBecause',
        ),
        label,
      ).toBe(!bothReachable);
    }
  });

  it('folds a supplied-but-unreachable lineage into mode 1 rather than inventing a third mode', () => {
    // The third *reachability* state — a lineage supplied whose Config hop does
    // not arrive — has to land somewhere, and the two-mode cap means it lands in
    // mode 1's vocabulary: reported `absent`, cross-check skipped, named.
    //
    // Observed through `chain`, which neither lineage backs. When a
    // lineage-derived slot *is* required the same shape is a diagnosed
    // `incomplete` instead (asserted below) — which is the important half: an
    // unreachable lineage is never silently downgraded to a skip for a slot that
    // needed it.
    const shape = migrateShapedHandles();
    const brokenArtifacts = handles({
      deployer: deployerHandle(shape.config, {}),
      artifacts: interceptFixture({}),
      tronWrap: tronWrapHandle(),
    });

    const env = resolveEnvironment(brokenArtifacts, { require: ['chain'] });
    expect(env.provenance.configLineages.viaArtifacts).toBe('absent');
    expect(env.provenance.configLineages.viaDeployer).toBe('live-config');
    expect(env.provenance.configLineages.crossChecked).toBe(false);
    expect(env.provenance.configLineages.crossCheckSkippedBecause).toBe(
      'only-deployer-lineage-available',
    );

    const error = caught(() =>
      resolveEnvironment(brokenArtifacts, { require: ['paths'] }),
    );
    expect(error).toBeInstanceOf(EnvironmentIncompleteError);
    if (!(error instanceof EnvironmentIncompleteError)) {
      throw new Error('unreachable');
    }
    expect(error.message).toContain(
      'property path "artifacts.resolver.options" is absent',
    );
  });

  it.each([
    [
      'build-info-absent',
      absentReader(),
      {
        kind: 'build-info-absent',
        buildInfoDirectory: DEFAULT_BUILD_INFO_DIR,
        artifactTreeIsExternal: false,
      },
    ],
    [
      'build-info-unreadable',
      unreadableReader(`${DEFAULT_BUILD_INFO_DIR}/aaa.output.json`, 'EACCES'),
      {
        kind: 'build-info-unreadable',
        file: `${DEFAULT_BUILD_INFO_DIR}/aaa.output.json`,
        cause: 'EACCES',
      },
    ],
    [
      'build-info-lacks-contract-map',
      filesReader([{ name: 'aaa.output.json', output: { sources: {} } }]),
      {
        kind: 'build-info-lacks-contract-map',
        file: `${DEFAULT_BUILD_INFO_DIR}/aaa.output.json`,
      },
    ],
  ] as const)(
    'mode 2: reports %s as indeterminate with a reason naming the mechanism',
    (kind, reader, expected) => {
      // Per SC-003 every degraded path has a test, and this is that obligation
      // discharged: all three `IndeterminateReason` mechanisms, each named.
      const shape = migrateShapedHandles();
      const env = resolveEnvironment(
        shape.handles,
        { require: ['artifacts'] },
        { buildInfoReader: reader },
      );
      const report = env.artifacts.ambiguities();
      expect(report.status).toBe('indeterminate');
      expect(indeterminateReason(report)).toEqual(expected);
      expect(indeterminateReason(report).kind).toBe(kind);
    },
  );

  it('mode 2 is not a failure: resolve still returns, carrying the reason forward', () => {
    // `indeterminate` is a routine state. Build-info is never written under
    // `tronbox test` — `WorkflowCompile.writeBuildInfo` returns immediately on
    // `options.quietWrite`, which `build/lib/test.js` sets — and that is the same
    // context forcing `reset: true` on every run. So the ordinary test loop has
    // ambiguity indeterminacy *and* full migration replay simultaneously.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: absentReader() },
    );
    const resolution = env.artifacts.resolve('Box');
    expect(resolution.status).toBe('indeterminate');
    if (resolution.status !== 'indeterminate') {
      throw new Error('unreachable');
    }
    expect(resolution.reason.kind).toBe('build-info-absent');
    expect(resolution.unverifiedContract).toBeDefined();
    expect(resolution.name).toBe('Box');
  });

  it('states artifactTreeIsExternal on the absent reason, since the two facts compose', () => {
    // `build/lib/commands/test.js` points the build tree at a temporary
    // directory, which is the column where build-info is never written AND every
    // migration is replayed from zero on every run. SF-5's collision policy needs
    // to observe that, so the reason carries it rather than leaving it derivable.
    const shape = migrateShapedHandles({
      contractsBuildDirectory: '/tmp/tronbox-test-build/contracts',
    });
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts', 'paths'] },
      { buildInfoReader: absentReader() },
    );
    expect(env.paths.contractsBuildDirectoryIsExternal).toBe(true);
    const reason = indeterminateReason(env.artifacts.ambiguities());
    expect(reason).toEqual({
      kind: 'build-info-absent',
      buildInfoDirectory: '/proj/build/build-info',
      artifactTreeIsExternal: true,
    });
  });

  it('keeps IndeterminateReason a closed union of exactly three mechanisms', () => {
    const kinds = new Set<string>();
    for (const reader of [
      absentReader(),
      unreadableReader(`${DEFAULT_BUILD_INFO_DIR}/a.output.json`, 'EACCES'),
      filesReader([{ name: 'a.output.json', output: 42 }]),
      throwingReader(new TypeError('reader exploded')),
      escapingUnreadableReader(),
    ]) {
      kinds.add(
        indeterminateReason(
          buildArtifactAmbiguityIndex(projectPathsFixture(), reader).report,
        ).kind,
      );
    }
    expect([...kinds].sort()).toEqual([
      'build-info-absent',
      'build-info-lacks-contract-map',
      'build-info-unreadable',
    ]);
  });
});

// ---------------------------------------------------------------------------
// INV-35
// ---------------------------------------------------------------------------

describe('INV-35: the injected logger guaranteed surface is exactly log', () => {
  it('makes logger.warn a compile error, and a TypeError if it were written anyway', () => {
    // The type-level half is the `@ts-expect-error` directive: if `warn` were on
    // `TronBoxLogger` this file would fail `tsc -p tsconfig.test.json` with an
    // unused-directive error, so the assertion cannot pass vacuously. The runtime
    // half shows what the type is protecting against — every logger TronBox
    // injects except the un-quieted CLI's is a single-method object.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['output'] });
    expect(
      () =>
        // @ts-expect-error INV-35: `warn` is not declared on TronBoxLogger.
        env.output.logger.warn('an unsilenceable warning'),
    ).toThrow(TypeError);
  });

  it.each([
    ['Deployer default / migrate.js --quiet / test.js / Config default', { log(): void {} }],
    [
      'Migration wrapper, which also silently indents by two spaces',
      { log: (message: unknown): void => void String(`  ${String(message)}`) },
    ],
  ])('accepts the single-method logger from the %s path', (_label, logger) => {
    const shape = migrateShapedHandles({ logger });
    const env = resolveEnvironment(
      handles({ deployer: deployerHandle(shape.config, { logger }) }),
      { require: ['output'] },
    );
    expect(env.output.logger).toBe(logger);
    expect(typeof env.output.logger.log).toBe('function');
    expect(env.output.origin).toBe('deployer');
  });

  it('accepts the un-quieted CLI console without re-exporting its richer surface', () => {
    // `build/index.js` passes `logger: console`, the one injection path that
    // carries `warn`/`error`. The handle is passed through by identity, so the
    // extra methods still exist at runtime — and remain unreachable through the
    // type, which is exactly the discipline INV-35 asks for: probe at the call
    // site, never assume from the type.
    const consoleLike = {
      log: (): void => undefined,
      warn: (): void => undefined,
      error: (): void => undefined,
    };
    const shape = migrateShapedHandles({ logger: consoleLike });
    const env = resolveEnvironment(
      handles({ deployer: deployerHandle(shape.config, { logger: consoleLike }) }),
      { require: ['output'] },
    );
    expect(env.output.logger).toBe(consoleLike);
    expect(sortedOwnKeys(env.output)).toEqual([
      'hostQuietRequested',
      'logger',
      'origin',
    ]);
    // A capability probe is how SF-10 may reach `warn`. Typed as `unknown` first,
    // because that is the only honest shape for a member the seam does not declare.
    const probed: unknown = (env.output.logger as unknown as Record<
      string,
      unknown
    >).warn;
    expect(typeof probed).toBe('function');
  });

  it('refuses a logger carrying warn but no log', () => {
    // The inverse of the hazard, and reachable: a consumer-built harness that
    // supplies `{ warn }` gets a named diagnosis rather than a slot whose one
    // guaranteed method is missing.
    const shape = migrateShapedHandles({ logger: { warn: (): void => undefined } });
    const error = caught(() =>
      resolveEnvironment(
        handles({
          deployer: deployerHandle(shape.config, {
            logger: { warn: (): void => undefined },
          }),
        }),
        { require: ['output'] },
      ),
    );
    expect(error).toBeInstanceOf(EnvironmentIncompleteError);
    if (!(error instanceof EnvironmentIncompleteError)) {
      throw new Error('unreachable');
    }
    expect(error.message).toContain(
      'property path "deployer.logger.log" is absent',
    );
  });

  it('probes log with `in`, so a prototype-borne log is accepted', () => {
    // `console`'s methods and a closure-built wrapper's differ in ownership, so
    // an own-property check here would reject the un-quieted CLI's logger.
    class PrototypeLogger {
      log(): void {
        // never called by the seam (INV-32)
      }
    }
    const logger = new PrototypeLogger();
    const shape = migrateShapedHandles({ logger });
    const env = resolveEnvironment(
      handles({ deployer: deployerHandle(shape.config, { logger }) }),
      { require: ['output'] },
    );
    expect(env.output.logger).toBe(logger);
  });

  it('declares log and nothing else on TronBoxLogger', () => {
    // Source-level corroboration of the type-level test above, so the property
    // is checkable without reading the compiler's mind.
    const typesSource = environmentSources().find(
      source => source.relative === 'types.ts',
    );
    expect(typesSource).toBeDefined();
    const declaration = /export interface TronBoxLogger \{([^}]*)\}/.exec(
      typesSource?.text ?? '',
    );
    expect(declaration).not.toBeNull();
    const members = interfaceMembers(declaration?.[1] ?? '');
    expect(members).toEqual(['log(...args: unknown[]): void;']);
  });

  it('states which lineage supplied the channel, including when it is a noop', () => {
    // `origin: 'config-lineage'` may be TronBox's own `{ log(){} }` default — a
    // channel that discards everything written to it. The specification's own note says the
    // `output` slot is absent under `tronbox test` mocha files, and the slot table
    // agrees (`absentIn` lists that context). The implementation nonetheless
    // resolves the slot there through the artifacts lineage.
    //
    // **Routed and closed elsewhere, not SF-0's.** Invariants revision 2 sent this
    // to SF-10 Design, which resolved it *and corrected the premise this comment
    // used to carry*: `origin` is not a usable visibility signal in either value,
    // because `build/lib/commands/migrate.js:command.run` replaces the logger before
    // `Config.detect` and `build/lib/test.js` passes `{ log(){} }` — so a discarding
    // channel is the normal case in two of five contexts rather than an exception.
    // SF-10 accommodates it by construction: degraded-mode statements ride the
    // returned result as `DegradedNote` values, and the log is advisory only. What
    // this test asserts is therefore SF-0's side alone — the slot resolves, and it
    // states which lineage it came from. It deliberately makes no claim about
    // visibility, which is SF-10's contract and is tested there.
    const shape = artifactsOnlyHandles();
    const env = resolveEnvironment(shape.handles, { require: ['output'] });
    expect(env.output.origin).toBe('config-lineage');
    expect(env.output.hostQuietRequested).toBe(false);
    expect(slotNames).toContain('output');

    const discarding = { log(): void {} };
    const viaLineage = artifactsOnlyHandles({ logger: discarding });
    const lineageEnv = resolveEnvironment(viaLineage.handles, {
      require: ['output'],
    });
    expect(lineageEnv.output.logger).toBe(discarding);
    expect(lineageEnv.output.origin).toBe('config-lineage');
  });

  it('reads hostQuietRequested from the lineage that supplied the channel', () => {
    // Never mixed across lineages. Under `tronbox test` the deployer's snapshot
    // carries `quiet: true` while the live Config the resolver holds carries no
    // `quiet` key at all, so a mixed read would report the wrong lineage's answer.
    const shape = testShapedHandles({}, { quiet: true });
    const env = resolveEnvironment(shape.handles, { require: ['output'] });
    expect(env.output.origin).toBe('deployer');
    expect(env.output.hostQuietRequested).toBe(true);

    const artifactsSide = resolveEnvironment(
      handles({ artifacts: shape.intercept }),
      { require: ['output'] },
    );
    expect(artifactsSide.output.origin).toBe('config-lineage');
    expect(artifactsSide.output.hostQuietRequested).toBe(false);
  });

  it('redacts the logger on serialization while leaving it spreadable', () => {
    // `toJSON` rather than a non-enumerable property, so `{ ...env.output }` does
    // not silently drop `logger` — the behaviour that has to break is
    // serialization, and only serialization.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['output'] });
    expect({ ...env.output }.logger).toBe(env.output.logger);
    expect(serializedTree(env.output)).toMatchObject({
      origin: 'deployer',
      hostQuietRequested: false,
    });
  });
});

// ---------------------------------------------------------------------------
// INV-36
// ---------------------------------------------------------------------------

describe('INV-36: a partial index is never reported as indexed', () => {
  it.each([0, 1, 2] as const)(
    'aborts into indeterminate when file %i of three lacks a contract map',
    position => {
      // Every position, because "abort on the first unusable entry" and "skip
      // unusable entries" agree on the last-position case. Only a middle or first
      // failure separates them.
      const specs = [0, 1, 2].map(index => ({
        name: `${'abc'[index]}.output.json`,
        ...(index === position
          ? { output: { sources: {} } }
          : {
              contracts: [
                {
                  sourcePath: `contracts/C${index}.sol`,
                  contractNames: [`C${index}`],
                },
              ],
            }),
      }));
      const report = buildArtifactAmbiguityIndex(
        projectPathsFixture(),
        filesReader(specs),
      ).report;
      expect(report.status).toBe('indeterminate');
      expect(indeterminateReason(report)).toEqual({
        kind: 'build-info-lacks-contract-map',
        file: `${DEFAULT_BUILD_INFO_DIR}/${'abc'[position]}.output.json`,
      });
    },
  );

  it('reports no candidates at all from a partial read, rather than the readable subset', () => {
    const index = buildArtifactAmbiguityIndex(
      projectPathsFixture(),
      filesReader([
        {
          name: 'aaa.output.json',
          contracts: [
            { sourcePath: 'contracts/Box.sol', contractNames: ['Box'] },
          ],
        },
        { name: 'bbb.output.json', output: { sources: {} } },
      ]),
    );
    expect(index.report.status).toBe('indeterminate');
    expect(index.candidates('Box')).toEqual([]);
  });

  it('never reports a colliding name as unique because the other file was unreadable', () => {
    // The false negative this invariant exists to prevent. `Box` collides across
    // the two files; if the unreadable one were skipped, `Box` would come back
    // `unique` and SF-5 would proceed against the wrong contract with no signal.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      {
        buildInfoReader: filesReader([
          {
            name: 'aaa.output.json',
            contracts: [
              { sourcePath: 'contracts/Box.sol', contractNames: ['Box'] },
            ],
          },
          {
            name: 'bbb.output.json',
            output: 'not an object at all',
          },
        ]),
      },
    );
    const resolution = env.artifacts.resolve('Box');
    expect(resolution.status).toBe('indeterminate');
    expect(resolution.status).not.toBe('unique');
  });

  it('rejects a file whose per-source entry is not a contract map', () => {
    // The nested shape, not only the top level: `contracts` present but one
    // source path mapping to a non-object still cannot be unioned.
    const report = buildArtifactAmbiguityIndex(
      projectPathsFixture(),
      filesReader([
        {
          name: 'aaa.output.json',
          output: { contracts: { 'contracts/Box.sol': 'Box' } },
        },
      ]),
    ).report;
    expect(indeterminateReason(report)).toEqual({
      kind: 'build-info-lacks-contract-map',
      file: `${DEFAULT_BUILD_INFO_DIR}/aaa.output.json`,
    });
  });

  it('lists every contributing file in indexedFrom when the status is indexed', () => {
    // "Every file was read and contributed" is what `indexed` asserts, so the
    // report has to name them. `indexedFrom` is that claim, checkable.
    const report = indexedReport(
      buildArtifactAmbiguityIndex(
        projectPathsFixture(),
        collidingReader(),
      ).report,
    );
    expect([...report.indexedFrom].sort()).toEqual([
      `${DEFAULT_BUILD_INFO_DIR}/aaa.output.json`,
      `${DEFAULT_BUILD_INFO_DIR}/bbb.output.json`,
    ]);
    expect(report.collisions).toEqual([
      {
        name: 'Box',
        candidates: [
          {
            sourcePath: 'contracts/Box.sol',
            contractName: 'Box',
            buildInfoFile: `${DEFAULT_BUILD_INFO_DIR}/aaa.output.json`,
          },
          {
            sourcePath: 'contracts/vendor/Box.sol',
            contractName: 'Box',
            buildInfoFile: `${DEFAULT_BUILD_INFO_DIR}/bbb.output.json`,
          },
        ],
      },
    ]);
  });

  it('admits no third status and no exclusions field on the union', () => {
    const statuses = new Set<string>();
    for (const reader of [
      singleContractReader(),
      collidingReader(),
      absentReader(),
      unreadableReader(`${DEFAULT_BUILD_INFO_DIR}/a.output.json`, 'EACCES'),
      filesReader([{ name: 'a.output.json', output: {} }]),
      filesReader([]),
    ]) {
      const report = buildArtifactAmbiguityIndex(
        projectPathsFixture(),
        reader,
      ).report;
      statuses.add(report.status);
      expect(sortedOwnKeys(report)).toEqual(
        report.status === 'indexed'
          ? ['collisions', 'indexedFrom', 'status']
          : ['reason', 'status'],
      );
    }
    expect([...statuses].sort()).toEqual(['indeterminate', 'indexed']);
  });

  it('treats an empty build-info directory as absent, not as an empty index', () => {
    // A directory that exists and holds no output file is the same observable
    // state as no directory: nothing was indexed, so nothing can be asserted
    // unique. Reporting `indexed` with zero collisions would be the false
    // negative in its most inviting form.
    const report = buildArtifactAmbiguityIndex(
      projectPathsFixture(),
      filesReader([]),
    ).report;
    expect(indeterminateReason(report).kind).toBe('build-info-absent');
  });

  it('holds through the default reader against a real directory of three files', () => {
    // The same property through `fileSystemBuildInfoReader`, since the fixtures
    // above bypass the one implementation that can encounter a genuinely
    // unreadable file.
    const dir = makeTempDir('partial-index');
    fs.writeFileSync(
      path.join(dir, 'aaa.output.json'),
      JSON.stringify({
        contracts: { 'contracts/Box.sol': { Box: {} } },
      }),
    );
    fs.writeFileSync(path.join(dir, 'bbb.output.json'), '{ not json');
    fs.writeFileSync(
      path.join(dir, 'ccc.output.json'),
      JSON.stringify({
        contracts: { 'contracts/vendor/Box.sol': { Box: {} } },
      }),
    );

    const index = buildArtifactAmbiguityIndex(
      projectPathsFixture({ root: dir, buildInfoDirectory: dir }),
      fileSystemBuildInfoReader,
    );
    expect(indeterminateReason(index.report)).toEqual({
      kind: 'build-info-unreadable',
      file: path.join(dir, 'bbb.output.json'),
      cause: 'the file is not valid JSON',
    });
    expect(index.candidates('Box')).toEqual([]);
  });
});
