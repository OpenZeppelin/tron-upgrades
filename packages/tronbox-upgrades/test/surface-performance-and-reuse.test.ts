import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as optionsSurface from '../src/options';
import {
  UnknownOptionError,
  engineValidationOptions,
  pluginOptionDefaults,
  requireProxyKind,
  resolveInitializer,
  resolveUpgradeOptions,
} from '../src/options';
import * as outputSurface from '../src/output';
import {
  captureEngineWarnings,
  createOutputChannel,
  degradedCodes,
  silenceWarnings,
  type HostChannelFacts,
  type LogSink,
  type OutputChannel,
} from '../src/output';
import { resetSilenceForTests } from '../src/output/silence';
import * as resultsSurface from '../src/results';
import {
  hostSharingGuard,
  installGuarded,
  operationNotes,
  sealUnavailable,
  transactionIdentity,
  type DeployedProxy,
} from '../src/results';
import { srcDir } from './helpers/locate';
import {
  hostImportViolations,
  type ScannedSource,
} from './helpers/source-scan';
import {
  DEPLOY_PROXY_OPTION_KEYS,
  UPGRADE_OPTION_KEYS,
  channelFacts,
  recordingSink,
  reExportedNames,
  resolveAsJavaScriptCaller,
  sf10Sources,
  sourceNamed,
} from './helpers/surface-fixtures';

/**
 * The option/result surface's Performance, Scalability & Re-usability —
 * covering the import graph's shape, injected host dependencies, the single
 * mutable binding, the surface's refusal of deployment-shaped or
 * address-canonicalizing options, and additive-only compatibility across
 * minors.
 *
 * The dependency-canary check is this category's remaining member, so it
 * lives with the other three in `surface-engine-canaries.test.ts`: when
 * `@openzeppelin/upgrades-core` moves, one file fails and its name says why.
 * That is the same placement the environment seam chose for
 * `real-tronbox.test.ts`.
 *
 * Technique 8, both sub-techniques, in the shape a dependency-root library has:
 *
 * - **Load** has no throughput budget here — the option/result surface serves
 *   no callers over a network and does no I/O on any path. The scaling
 *   property that matters is the *import graph*: three directories that
 *   reach nothing are what make the option/result surface a dependency root
 *   in the code and not only in the plan, and what let its implementation
 *   run in parallel with the environment seam's. That is asserted
 *   structurally, by the import-graph, host-dependency and
 *   single-mutable-binding checks below. The quantitative bounds are in
 *   `surface-resource-limits`.
 * - **Portability** gets the strongest form the technique names: the whole
 *   surface **embedded in a second host** that is not TronBox, with a
 *   different logger shape, a different contract-abstraction shape and a
 *   `Map`-backed cache instead of an object one — driven end to end with no
 *   source change. See § A second host.
 */

// ---------------------------------------------------------------------------
// The import graph
// ---------------------------------------------------------------------------

/** Non-relative specifiers in one module — the ones that name a package. */
function packageSpecifiers(source: ScannedSource): readonly string[] {
  return source.moduleSpecifiers
    .map(entry => entry.specifier)
    .filter(specifier => !specifier.startsWith('.'));
}

function sourcesIn(directory: string): readonly ScannedSource[] {
  return sf10Sources().filter(source =>
    source.relative.startsWith(`${directory}${path.sep}`),
  );
}

describe('the three directories import nothing from the package', () => {
  it('has `src/output/**` importing no package at all', () => {
    const offending = sourcesIn('output').flatMap(source =>
      packageSpecifiers(source).map(
        specifier => `${source.relative} imports '${specifier}'`,
      ),
    );
    expect(offending).toEqual([]);
  });

  it('has `src/options/**` importing only `@openzeppelin/upgrades-core`', () => {
    const specifiers = sourcesIn('options').flatMap(source =>
      packageSpecifiers(source).map(
        specifier => `${source.relative} -> ${specifier}`,
      ),
    );
    // Pinned as an exact list, not as a set membership: a second package appearing
    // here is a new dependency for a declared root, which is the decision this
    // assertion exists to force into the open.
    expect(specifiers.sort()).toEqual([
      'options/resolve.ts -> @openzeppelin/upgrades-core',
      'options/types.ts -> @openzeppelin/upgrades-core',
    ]);
  });

  it('has `src/results/**` importing only `../output` (a type) and the shared leaf', () => {
    expect(
      sourcesIn('results').flatMap(source => packageSpecifiers(source)),
    ).toEqual([]);

    const crossDirectory = sourcesIn('results').flatMap(source =>
      source.moduleSpecifiers
        .filter(entry => entry.specifier.startsWith('..'))
        .map(entry => `${source.relative} -> ${entry.specifier}`),
    );
    // `../host-sharing` is the collapse of the twice-declared host-sharing
    // refusal onto one shared leaf; the leaf imports nothing, so this edge
    // acquires no directory and the layer stays a dependency root.
    expect(crossDirectory.sort()).toEqual([
      'results/augmentation.ts -> ../host-sharing',
      'results/types.ts -> ../output',
    ]);
    // And it is a type-only import, so the edge does not exist at runtime either.
    expect(sourceNamed('results/types.ts').text).toContain(
      "import type { DegradedNote } from '../output';",
    );
  });

  it('imports `src/environment/**` from nowhere in the three directories', () => {
    const offending = sf10Sources().flatMap(source =>
      source.moduleSpecifiers
        .filter(entry => /(^|\/)environment(\/|$)/.test(entry.specifier))
        .map(entry => `${source.relative}:${entry.line} -> ${entry.specifier}`),
    );
    expect(offending).toEqual([]);
  });

  it('writes every specifier as a literal, so the scan above is a proof', () => {
    // The completeness clause. A computed specifier is invisible to any static
    // scan, so zero package imports is only a proof alongside zero of these.
    const computed = sf10Sources().flatMap(source =>
      source.dynamicSpecifierSites.map(
        site => `${source.relative}:${site.line} ${site.kind}(${site.expression})`,
      ),
    );
    expect(computed).toEqual([]);
  });

  it('finds the relative imports that are there, so an empty result is not a blind scan', () => {
    const relative = sf10Sources()
      .flatMap(source =>
        source.moduleSpecifiers.map(
          entry => `${source.relative} -> ${entry.specifier}`,
        ),
      )
      .filter(entry => entry.includes('-> .'))
      .sort();
    // Non-vacuity: the instrument is reading real import statements, and it reads
    // `export … from` as well as `import` — the three `index.ts` files are
    // re-exports, so a scanner that only handled `import` would report nothing for
    // them and every assertion above would pass vacuously.
    expect(relative.length).toBeGreaterThan(15);
    expect(relative).toContain('output/channel.ts -> ./silence');
    expect(relative).toContain('output/index.ts -> ./engine');
    expect(relative).toContain('options/index.ts -> ./defaults');
    expect(relative).toContain('results/index.ts -> ./limitations');
  });
});

// ---------------------------------------------------------------------------
// Injected host dependencies
// ---------------------------------------------------------------------------

/**
 * § A second host.
 *
 * A host that is deliberately **not** TronBox: its logger has no `log` method at
 * all, its contract abstraction has a different key set, and its cache is a `Map`
 * instead of an object. Everything the plugin needs is handed in as data, so
 * adapting is a shim in the *host* — which is the property under test. If embedding
 * required editing `src/`, that would be a re-usability violation rather than a
 * packaging detail.
 */
interface SecondHost {
  readonly written: string[];
  readonly cache: Map<string, object>;
  emit(line: string): void;
  abstraction(name: string): Record<string, unknown>;
  channelFacts(): HostChannelFacts;
  guardEvidence(): string;
}

function secondHost(): SecondHost {
  const written: string[] = [];
  const cache = new Map<string, object>();
  const host: SecondHost = {
    written,
    cache,
    // Note the name: not `log`. The three-line adapter below is the whole cost of
    // the second host, and it lives here rather than in `src/`.
    emit(line: string): void {
      written.push(`[second-host] ${line}`);
    },
    abstraction(name: string): Record<string, unknown> {
      const target: Record<string, unknown> = {
        moduleName: name,
        deployedAt: 'T2ndHostAddressXXXXXXXXXXXXXXXXXXXX',
        manifest: { abi: [] },
      };
      // The same hazard shape TronBox has, from a different host: a
      // non-configurable accessor returning an unconditional empty array.
      Object.defineProperty(target, 'events', {
        enumerable: false,
        configurable: false,
        get: () => [],
      });
      cache.set(name, target);
      return target;
    },
    channelFacts(): HostChannelFacts {
      const adapter: LogSink = {
        log: (...args: unknown[]): void => {
          host.emit(args.map(arg => String(arg)).join(' '));
        },
      };
      // `origin` is provenance only, so a second host picks whichever
      // lineage label describes where its sink came from.
      return { logger: adapter, origin: 'config-lineage', hostQuietRequested: false };
    },
    guardEvidence(): string {
      return 'the second host enumerates its own Map-backed module cache';
    },
  };
  return host;
}

/** The whole option/result surface, driven once, against whatever host it is handed. */
function driveOperation(
  facts: HostChannelFacts,
  cachedObjects: readonly object[],
  evidence: string,
  freshHandle: Record<string, unknown>,
  suppliedOptions: object,
): { readonly result: DeployedProxy; readonly channel: OutputChannel } {
  const channel = createOutputChannel(facts);
  const resolved = resolveAsJavaScriptCaller(
    suppliedOptions,
    DEPLOY_PROXY_OPTION_KEYS,
  );
  requireProxyKind(resolved.validation.kind, ['uups', 'transparent'], 'deployProxy');
  const initializer = resolveInitializer(undefined, resolved.constructorArgs.length);

  const engineOptions = engineValidationOptions(resolved);
  captureEngineWarnings(channel, 'getErrors', () => {
    console.error('Warning: the engine noticed something about this contract');
    return engineOptions;
  });

  const guard = hostSharingGuard(evidence, cachedObjects);
  installGuarded(
    freshHandle,
    'pluginInitializer',
    { value: initializer },
    guard,
  );

  const result: DeployedProxy = {
    contract: sealUnavailable(freshHandle),
    address: 'TResultAddressXXXXXXXXXXXXXXXXXXXXX',
    transaction: transactionIdentity('0xfeedface', 'deployProxy'),
    notes: operationNotes(channel.recorded),
  };
  return { result, channel };
}

describe('every host dependency is injected; nothing is reached for', () => {
  it('names no host package by any loading syntax', () => {
    // Reuses the environment seam's own host-import-boundary instrument
    // rather than a second one: it covers `import`, `export … from`,
    // `import x = require()`, `require`,
    // `require.resolve` and `import()`.
    expect(hostImportViolations(sf10Sources())).toEqual([]);
  });

  it('makes no value reference to the ambient world', () => {
    const forbidden: readonly string[] = Object.freeze([
      'process',
      'require',
      'fetch',
      'setTimeout',
      'setInterval',
      'setImmediate',
      'globalThis',
      '__dirname',
      '__filename',
      'Date',
      'performance',
      'Buffer',
    ]);
    const offending = sf10Sources().flatMap(source =>
      source.identifiers
        .filter(
          use =>
            !use.isPropertyName &&
            !use.inTypePosition &&
            forbidden.includes(use.name),
        )
        .map(use => `${source.relative} references ${use.name}`),
    );
    expect(offending).toEqual([]);

    // Non-vacuity: the same instrument does see the identifiers that are there, so
    // an empty list is an absence rather than a broken filter.
    const present = sf10Sources().flatMap(source =>
      source.identifiers
        .filter(use => !use.isPropertyName && use.name === 'Object')
        .map(() => source.relative),
    );
    expect(present.length).toBeGreaterThan(10);
  });

  it('declares every seam as a required parameter', () => {
    // `Function.length` counts parameters before the first default, so these are
    // the ones a call site *cannot* omit. The guard being counted here is the
    // point: an optional guard defaulting to "no check" would make the common call
    // site the unguarded one.
    expect(createOutputChannel).toHaveLength(1);
    expect(captureEngineWarnings).toHaveLength(3);
    expect(resolveUpgradeOptions).toHaveLength(2);
    expect(requireProxyKind).toHaveLength(3);
    expect(resolveInitializer).toHaveLength(2);
    expect(hostSharingGuard).toHaveLength(2);
    expect(installGuarded).toHaveLength(4);
    // `registry` defaults to the v1 registry, so only `target` is required —
    // and there is no guard parameter, because `src/results/**` has no mutation site
    // for one to guard.
    expect(sealUnavailable).toHaveLength(1);
    expect(transactionIdentity).toHaveLength(2);
    expect(operationNotes).toHaveLength(1);
    expect(silenceWarnings).toHaveLength(0);
  });

  it('runs the whole surface inside a second host with no source change', () => {
    const host = secondHost();
    const cached = host.abstraction('LegacyBox');
    const fresh = host.abstraction('Box');

    const { result, channel } = driveOperation(
      host.channelFacts(),
      [cached],
      host.guardEvidence(),
      fresh,
      { kind: 'uups', constructorArgs: [42], timeout: 1_000 },
    );

    // The result contract holds, built entirely from the second host's objects.
    expect(result.address).toBe('TResultAddressXXXXXXXXXXXXXXXXXXXXX');
    expect(result.transaction.hash).toBe('0xfeedface');
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]?.code).toBe('engine-warning');
    expect(result.notes[0]?.summary).toBe(
      'the engine noticed something about this contract',
    );
    // The plugin's advisory write reached the second host's own transport, through
    // its own adapter.
    expect(host.written).toHaveLength(1);
    expect(host.written[0]).toContain('[second-host] Warning:');
    // The guard was satisfied by a `Map`-backed cache, and the augmentation landed
    // non-enumerably on the fresh handle.
    expect(Object.keys(fresh)).toEqual([
      'moduleName',
      'deployedAt',
      'manifest',
    ]);
    expect(Reflect.get(fresh, 'pluginInitializer')).toEqual({
      kind: 'call',
      fn: 'initialize',
    });
    // The second host's own `events` hazard is sealed by the same registry.
    expect(() => void (result.contract as unknown as { events: unknown }).events)
      .toThrow(/not available on a contract handle this plugin returns/);
    expect(channel.origin).toBe('config-lineage');
  });

  it('refuses the second host\'s cached instance for the same reason it refuses TronBox\'s', () => {
    const host = secondHost();
    const cached = host.abstraction('LegacyBox');

    // Non-vacuity of the portability claim: the second host is not merely *running*
    // the code, it is running the guard — a fixture whose cache never collided
    // would demonstrate the plumbing and not the policy.
    expect(() =>
      driveOperation(
        host.channelFacts(),
        [...host.cache.values()],
        host.guardEvidence(),
        cached,
        { kind: 'uups' },
      ),
    ).toThrow(/Refusing to install "pluginInitializer" on an object/);
  });

  it('behaves identically for a second host whose sink discards', () => {
    // Two of five TronBox invocation contexts supply a discarding sink with no flag
    // involved, and a second host may too. The record must be identical.
    const host = secondHost();
    const fresh = host.abstraction('Box');
    const discarding: HostChannelFacts = {
      logger: { log(): void {} },
      origin: 'deployer',
      hostQuietRequested: true,
    };

    const { result } = driveOperation(
      discarding,
      [],
      host.guardEvidence(),
      fresh,
      { kind: 'transparent' },
    );
    expect(host.written).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]?.code).toBe('engine-warning');
  });

  it('takes the same fixtures from a plain object with no host at all', () => {
    // Every fixture in this suite is a plain object or a plain function — no TronBox
    // process, no node seam, no `src/environment/**`. Restated as an assertion so
    // the claim is executable: the minimum viable host is an object literal.
    const sink = recordingSink();
    const channel = createOutputChannel(channelFacts(sink));
    expect(channel.describe()).toContain('deployer');
    expect(
      resolveUpgradeOptions(undefined, UPGRADE_OPTION_KEYS).timeout,
    ).toBe(pluginOptionDefaults.timeout);
  });
});

// ---------------------------------------------------------------------------
// The one mutable binding
// ---------------------------------------------------------------------------

describe('exactly one module-scope mutable binding exists, and it is the silence flag', () => {
  it('holds exactly two across the three directories — the flag and the re-entrancy guard', () => {
    const bindings = sf10Sources()
      .flatMap(source =>
        source.topLevelMutableBindings.map(
          name => `${source.relative}:${name}`,
        ),
      )
      .sort();
    // `activeCall` is the one permitted addition, and this rule enumerates it
    // rather than leaving it to be discovered. Two of them and the audit is
    // no longer a list, which is why this is an exact equality.
    expect(bindings).toEqual([
      `output${path.sep}engine.ts:activeCall`,
      `output${path.sep}silence.ts:silenced`,
    ]);
  });

  it('holds none in `src/options/**` or `src/results/**`', () => {
    for (const directory of ['options', 'results']) {
      expect(
        sourcesIn(directory).flatMap(source => source.topLevelMutableBindings),
        `${directory} gained a module-scope mutable binding`,
      ).toEqual([]);
    }
  });

  it('keeps the test-only reset off both export surfaces', () => {
    /*
     * Deliberately absent from the directory's face *and* from the package entry
     * point, so it is reachable only by deep import from `src/output/silence` — the
     * same shape as the Hardhat sibling's `setNamespacedWarningSink`.
     *
     * Asserted against the **export clause**, not against the file text: the module
     * documents both omissions by name, and that documentation is the record of the
     * decision. A text search would fail on correct code, which is the same
     * instrument mistake the console-reference scan records.
     */
    const clause = reExportedNames(sourceNamed('output/index.ts'));
    expect(clause.map(entry => entry.name)).not.toContain('resetSilenceForTests');
    expect(clause.map(entry => entry.name)).not.toContain('isSilenced');
    // The whole point of the deep import: `silence.ts` is re-exported, but only for
    // `silenceWarnings`.
    expect(
      clause.filter(entry => entry.from === './silence').map(entry => entry.name),
    ).toEqual(['silenceWarnings']);
    expect(Object.keys(outputSurface)).not.toContain('resetSilenceForTests');
    expect(Object.keys(outputSurface)).not.toContain('isSilenced');
    // And it *is* reachable by deep import — this file's own sibling suites import
    // it that way, so the omission is a surface decision rather than a deletion.
    expect(typeof resetSilenceForTests).toBe('function');
  });

  it('reads the flag at exactly one place, which is what makes the reset safe to omit', () => {
    const readers = sf10Sources()
      .filter(source =>
        source.identifiers.some(
          use => !use.isPropertyName && use.name === 'isSilenced',
        ),
      )
      .map(source => source.relative)
      .sort();
    expect(readers).toEqual([
      `output${path.sep}channel.ts`,
      `output${path.sep}silence.ts`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// No deployment-shaped options, no address canonicalization
// ---------------------------------------------------------------------------

describe('no deployment-shaped option and no address canonicalization enters this surface', () => {
  const deploymentShaped: readonly { readonly key: string; readonly value: unknown }[] =
    Object.freeze([
      { key: 'deployer', value: {} },
      { key: 'txOverrides', value: {} },
      { key: 'from', value: 'TJmmqjb1DK9TTZbQXzRQ2AuA94z4gKAPFh' },
      { key: 'privateKey', value: '00'.repeat(32) },
      { key: 'network', value: 'shasta' },
      { key: 'feeLimit', value: 1_000_000 },
      { key: 'callValue', value: 0 },
      { key: 'userFeePercentage', value: 30 },
      { key: 'originEnergyLimit', value: 10_000_000 },
      { key: 'tokenId', value: 1 },
      { key: 'tokenValue', value: 0 },
      { key: 'shouldPollResponse', value: true },
      { key: 'gasPrice', value: 1 },
      { key: 'gasLimit', value: 1 },
      { key: 'nonce', value: 0 },
    ]);

  it.each(deploymentShaped)(
    'refuses `$key` as an unknown option rather than ignoring it',
    ({ key, value }) => {
      let thrown: unknown;
      try {
        resolveAsJavaScriptCaller({ [key]: value }, DEPLOY_PROXY_OPTION_KEYS);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UnknownOptionError);
      const error = thrown as UnknownOptionError;
      expect(error.unknownKeys).toEqual([key]);
      // The refusal names the accepted set, so a caller who reached for the
      // deploy seam's surface early learns what this surface *is* rather than
      // that it "failed".
      expect(error.message).toContain(key);
      expect(error.accepted).toEqual(DEPLOY_PROXY_OPTION_KEYS);
    },
  );

  it('drives every enumerated deployment-shaped key, so the list is not a token sample', () => {
    expect(deploymentShaped.length).toBeGreaterThanOrEqual(15);
    // And none of them is accidentally accepted by the surface it was tested
    // against.
    for (const { key } of deploymentShaped) {
      expect(DEPLOY_PROXY_OPTION_KEYS).not.toContain(key);
      expect(UPGRADE_OPTION_KEYS).not.toContain(key);
    }
  });

  it('references no address-canonicalization helper anywhere in the three directories', () => {
    const canonicalizationShaped =
      /^(toHex|fromHex|toBase58|fromBase58|hexToBase58|base58ToHex|toChecksumAddress|isAddress|canonicalize|canonicalAddress|address41|toTronAddress|toEthAddress)$/;
    const offending = sf10Sources().flatMap(source =>
      source.identifiers
        .filter(use => canonicalizationShaped.test(use.name))
        .map(use => `${source.relative} references ${use.name}`),
    );
    expect(offending).toEqual([]);
    // Nor by an access chain — the record layer owns the canonical form, so
    // not even a `tronWeb.address.toHex` read belongs here.
    expect(
      sf10Sources().flatMap(source =>
        source.accessChains.filter(chain => /address\.(toHex|fromHex)/.test(chain)),
      ),
    ).toEqual([]);
  });

  it('declares result `address` fields as plain `string`, with no branded type', () => {
    // Tool-verbatim by declaration. A branded canonical type here would commit
    // every operation to the record layer's decision before the record layer
    // has made it.
    const proxy: DeployedProxy = {
      contract: sealUnavailable({
        address: 'T1',
        events: [],
      }),
      address: 'TdeliberatelyNotCanonicalized',
      transaction: transactionIdentity('0xabc', 'deployProxy'),
      notes: [],
    };
    const plain: string = proxy.address;
    expect(plain).toBe('TdeliberatelyNotCanonicalized');
    expect(sourceNamed('results/types.ts').text).toContain(
      'readonly address: string;',
    );
  });

  it('does not mirror `DeployProxyAdminOptions`, because the operation is not shipped', () => {
    const offending = sf10Sources().filter(source =>
      source.text.includes('DeployProxyAdminOptions'),
    );
    expect(offending.map(source => source.relative)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Additive-only compatibility across minors
// ---------------------------------------------------------------------------

describe('the public surface is additive across minors', () => {
  /**
   * The runtime surface of each directory's face, pinned exactly.
   *
   * Removing or renaming a member is a **major** change and fails here, which is the
   * property under test. *Adding* one also fails here — deliberately: an
   * addition is defined as a minor change, and moving this pin is the
   * one-line edit that records the decision. An assertion that only checked
   * for a superset would let a removal through whenever an addition arrived
   * in the same commit.
   */
  it('pins `src/options`\'s value exports', () => {
    expect(Object.keys(optionsSurface).sort()).toEqual([
      'DEFAULT_INITIALIZER',
      'MILLISECOND_OPTION_MINIMUM',
      'OptionConflictError',
      'OptionUnsupportedOnTronError',
      'OptionValueError',
      'UnknownOptionError',
      'UpgradesOptionError',
      'defaultConstructorArgs',
      'engineValidationOptions',
      'optionsUnsupportedOnTron',
      'pluginOptionDefaults',
      'proxyKinds',
      'recordedUpstreamValidationDefaults',
      'redeployModes',
      'renderReceived',
      'requireProxyKind',
      'resolveInitializer',
      'resolveUpgradeOptions',
      'unsafeAllowKinds',
    ]);
  });

  it('pins `src/output`\'s value exports', () => {
    expect(Object.keys(outputSurface).sort()).toEqual([
      'DegradedNoteInvalidError',
      'EngineCallNotSynchronousError',
      'EngineCaptureReentrantError',
      'RECORDED_NOTE_CAP',
      'capturableEngineExports',
      'captureEngineWarnings',
      'createOutputChannel',
      'degradedCodes',
      'engineWarningCapableExports',
      'silenceWarnings',
      'uncapturableEngineExports',
      'uncapturedEngineWarnings',
    ]);
  });

  it('pins `src/results`\'s value exports', () => {
    expect(Object.keys(resultsSurface).sort()).toEqual([
      'HostInstanceSharedError',
      'ResultCapabilityUnavailableError',
      'TransactionHashUnavailableError',
      'UnavailableMemberAbsentError',
      'hostSharingGuard',
      'installGuarded',
      'operationNotes',
      'sealUnavailable',
      'transactionIdentity',
      'unavailableContractMembers',
    ]);
  });

  it('pins the type-only surface, which `Object.keys` cannot see', () => {
    /*
     * Most of what packaging re-exports is types — the ten per-operation option
     * aliases, the eight result types, `DegradedCode`. A runtime key check cannot
     * see any of them, so a removed or renamed type alias would break every
     * consumer's build while every assertion above still passed.
     */
    const typesOf = (relative: string): readonly string[] =>
      reExportedNames(sourceNamed(relative))
        .filter(entry => entry.isTypeOnly)
        .map(entry => entry.name)
        .sort();

    expect(typesOf('options/index.ts')).toEqual([
      'CallOption',
      'DeployBeaconOptions',
      'DeployBeaconProxyOptions',
      'DeployImplementationOptions',
      'DeployProxyOptions',
      'ForceImportOptions',
      'InitializerOption',
      'InitializerResolution',
      'PrepareUpgradeOptions',
      'ProxyKind',
      'RedeployMode',
      'ResolvedUpgradeOptions',
      'StandaloneOptions',
      'TronOptionRefusal',
      'UnsafeAllowKind',
      'UpgradeBeaconOptions',
      'UpgradeOptions',
      'UpgradeProxyOptions',
      'ValidateImplementationOptions',
      'ValidateUpgradeOptions',
    ]);
    expect(typesOf('output/index.ts')).toEqual([
      'DegradedCode',
      'DegradedNote',
      'EngineWarningCapableExport',
      'HostChannelFacts',
      'LogSink',
      'OutputChannel',
      'UncapturedEngineWarning',
    ]);
    expect(typesOf('results/index.ts')).toEqual([
      'AdoptionOutcome',
      'AuthorityTransfer',
      'ContractHandle',
      'DeployedBeacon',
      'DeployedProxy',
      'HostSharingGuard',
      'ImplementationDeployment',
      'Limitation',
      'LimitationRegistry',
      'OperationResult',
      'TransactionIdentity',
      'UpgradedProxy',
      'ValidationOutcome',
    ]);

    // The value half of each clause agrees with the runtime surface, so the two
    // instruments corroborate rather than diverge.
    for (const [relative, surface] of [
      ['options/index.ts', optionsSurface],
      ['output/index.ts', outputSurface],
      ['results/index.ts', resultsSurface],
    ] as const) {
      expect(
        reExportedNames(sourceNamed(relative))
          .filter(entry => !entry.isTypeOnly)
          .map(entry => entry.name)
          .sort(),
      ).toEqual(Object.keys(surface).sort());
    }
  });

  it('pins every error `code`, because a caller branches on it', () => {
    // The codes *are* the compatibility surface for error handling — the
    // enumerated-error-class rule exists so nothing requires parsing a
    // message, which makes renaming a code a breaking
    // change for every `switch` in the wild.
    const codes = [
      new optionsSurface.OptionValueError('kind', 1, ['uups']).code,
      new optionsSurface.UnknownOptionError([], []).code,
      new optionsSurface.OptionConflictError([], 'b', 'i').code,
      new optionsSurface.OptionUnsupportedOnTronError('o', 'b', 'i').code,
      new outputSurface.DegradedNoteInvalidError('summary', 'c').code,
      new outputSurface.EngineCallNotSynchronousError('c').code,
      new outputSurface.EngineCaptureReentrantError('c', 'a').code,
      new resultsSurface.TransactionHashUnavailableError('o').code,
      new resultsSurface.UnavailableMemberAbsentError('m').code,
      new resultsSurface.HostInstanceSharedError('m', 'e').code,
      new resultsSurface.ResultCapabilityUnavailableError('events', {
        because: 'b',
        instead: 'i',
      }).code,
    ];
    expect(codes.sort()).toEqual([
      'DEGRADED_NOTE_INVALID',
      'ENGINE_CAPTURE_REENTRANT',
      'ENGINE_CALL_NOT_SYNCHRONOUS',
      'HOST_INSTANCE_SHARED',
      'OPTION_CONFLICT',
      'OPTION_UNKNOWN',
      'OPTION_UNSUPPORTED_ON_TRON',
      'OPTION_VALUE_INVALID',
      'RESULT_CAPABILITY_UNAVAILABLE',
      'TRANSACTION_HASH_UNAVAILABLE',
      'UNAVAILABLE_MEMBER_ABSENT',
    ].sort());
    // Every code is distinct, so a caller's `switch` is total.
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('pins the `DegradedCode` enumeration, whose removal breaks every consumer switching on it', () => {
    expect([...degradedCodes]).toEqual([
      'namespaced-ast-only',
      'storage-layout-unavailable',
      'artifact-name-indeterminate',
      'engine-warning',
      'engine-note',
      'notes-truncated',
    ]);
  });

  it('records the entry point surface, so a widening is deliberate', () => {
    // Re-pinned when the operations landed: the entry now carries VALUE
    // exports — deployProxy, upgradeProxy, and the two refusal families —
    // which is the deliberate widening the earlier pin existed to make
    // deliberate. What still cannot appear, asserted on specifier positions
    // rather than prose: a re-export of `./output` (its channel factory and
    // engine capture are reached per operation, never at import time) and a
    // static edge to `./options/resolve` (the package's engine value-import),
    // and the one-mutable-binding rule (the test-only reset stays off the
    // surface) travels with it.
    const entry = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
    expect(entry).toContain('export type {');
    expect(entry).toContain("export { deployProxy, upgradeProxy } from './proxy';");
    expect(/from '\.\/output/.test(entry)).toBe(false);
    expect(/from '\.\/options\/resolve/.test(entry)).toBe(false);
    expect(entry).not.toContain('resetSilenceForTests');
  });
});
