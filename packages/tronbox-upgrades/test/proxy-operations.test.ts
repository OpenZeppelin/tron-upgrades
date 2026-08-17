// Imported FIRST, ahead of every other project import: it primes
// `MANIFEST_DEFAULT_DIR` before `'../src/options'` below can pull in the
// real engine and freeze the default in force. See its own doc comment.
import { RECORD_DIR, restoreRecordDir } from './helpers/prime-record-dir';

import fs from 'node:fs';
import { Interface } from 'ethers';
import { afterAll, describe, expect, it } from 'vitest';

import { deployProxy, runDeployProxy } from '../src/proxy/deploy-proxy';
import { runUpgradeProxy } from '../src/proxy/upgrade-proxy';
import type {
  OperationContext,
  OperationToolkit,
  ResolvedForProxyOps,
} from '../src/proxy/toolkit';
import {
  BeaconProxyRefusedError,
  EmptyInitializerRefusedError,
  ImplementationNotPreviouslyDeployedError,
  InitialOwnerUnsupportedKindError,
  NotTransparentProxyError,
  OptionsInArgsPositionError,
  ProxyAdminAsOwnerError,
  StaleProxyRecordError,
  TransparentInitialOwnerRequiredError,
  UpgradeVerificationFailedError,
} from '../src/proxy/errors';
import { PROXY_CONTRACT_NAMES } from '../src/proxy/artifacts';
import { OptionValueError } from '../src/options';
import {
  assertNoCheatcodeCollision,
  CheatcodeSlotCollisionError,
  ConfirmationIndeterminateError,
  DeployerAbsentError,
  TransactionRevertedError,
} from '../src/deploy';
import type { ConfirmationVerdict } from '../src/deploy';
import { canonicalizeAddress, openRecord, toBase58 } from '../src/record';
import type { RecordSession } from '../src/record';
import { toTronHex } from '../src/record/address';
import type { ChainAccess, ChainInstanceIdentity } from '../src/chain';
import { zeroChainAddress } from '../src/chain';
import type { AbsolutePath, ContractAbstraction } from '../src/environment';
import { ResultCapabilityUnavailableError } from '../src/results';
import { pluginOptionDefaults } from '../src/options/defaults';

/*
 * The proxy operations — the ordering invariants, pinned on a recording fake
 * whose call log IS the assertion. Outcome-only tests cannot see order, and
 * order is where the proxy operations' silent failures live: validation
 * before spend, authority before the implementation deploys, verification
 * after the upgrade call, the beacon check before kind processing, one
 * queued step, and refusals that never leave a half-queued operation behind.
 */

const IMPL_OWNER = '0xabCDEF1234567890ABcDEF1234567890aBCDeF12';
const PROXY_ADDR = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const NEW_IMPL = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
// A different implementation than `NEW_IMPL`, standing in for "what the proxy
// currently runs" in the upgrade tests that need the two distinguished.
const OTHER_IMPL = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
// A real, distinct base58 address for `initialOwner` — already used in that
// exact role in `test/surface-request-response-contract.test.ts`.
const OWNER_BASE58 = 'TJmmqjb1DK9TTZbQXzRQ2AuA94z4gKAPFh';
const TX_HASH = 'aa'.repeat(32);

// ── The REAL record directory, primed before the engine could load ───────────
//
// `RECORD_DIR` and its `MANIFEST_DEFAULT_DIR` assignment come from
// `./helpers/prime-record-dir`, imported first in this file for exactly that
// reason. One directory for the whole file rather than one per test: the
// assignment is a no-op after the engine's first load, so a second temp
// directory created mid-file would be silently ignored by the engine while
// this plugin's OWN bookkeeping pointed at it — the two byte-compare tests
// below use distinct chain ids instead, which is what the engine keys its
// manifest FILE name on.
afterAll(() => {
  restoreRecordDir();
});

interface FakeSpec {
  readonly priorAddress?: string | null;
  readonly verdictStatus?: 'authoritative' | 'no-code-at-address' | 'unrecorded';
  readonly noDeployer?: boolean;
  readonly wildcard?: boolean;
  readonly beacon?: string;
  readonly admin?: string;
  readonly interfaceVersion?: string | undefined;
  readonly currentImplementation?: string;
  readonly observedAfterUpgrade?: string;
  readonly existingProxyRecord?: boolean;
  /**
   * Whether `session.getImplRecord` vouches for the prior address as a
   * recorded implementation. Defaults to `false` (undefined) — every other
   * test in this file gets the real `getImplRecord`'s "nothing recorded"
   * answer; the "recorded implementation, not a stale proxy" test is the one
   * that sets it `true`.
   */
  readonly implRecordKnown?: boolean;
  readonly constructorArgs?: readonly unknown[];
  /**
   * Whether `fetchOrDeployImplementation`'s own record reuse fetches the
   * cached implementation instead of invoking `deploy()`. Lets a test pin
   * "the implementation deploy is skipped" independently of the
   * (now-removed) proxy-level reuse `runDeployProxy` used to short-circuit
   * on. Defaults to `false` — every other test in this file keeps exercising
   * the deploy path unchanged.
   *
   * Read together with `resolved.redeployImplementation`: `'never'` with
   * this `false` (the default) is the empty-record case the fake refuses by
   * name, exactly as the real gate does; `'never'` with this `true` is the
   * already-recorded case, where the real gate never runs at all because the
   * engine's own cache lookup returns before the wrapped `deploy` closure is
   * reached.
   */
  readonly implementationReused?: boolean;
  /**
   * What the fake's `inferKind` answers — the engine-side inference over a
   * validated implementation. Defaults to `'transparent'`, the answer the
   * engine gives for a contract with no public upgrade entry point.
   */
  readonly inferredKind?: 'transparent' | 'uups' | 'beacon';
  /** Overrides the abstraction's ABI (the initializer-rule tests need one). */
  readonly abi?: readonly unknown[];
  /**
   * Makes the fake's `validateImplementation` throw instead of returning a
   * validation result — the refusal both operations' step 1 can take, and
   * the one this suite uses to pin that the refusal blocks every side
   * effect after it, not merely the ones the runner happens to reach first.
   */
  readonly validateThrows?: Error;
  /**
   * What the fake's `looksLikeProxyAdmin` answers. Defaults to `false` —
   * every ordering test in this file keeps sailing past the check; the
   * ProxyAdmin-as-owner suite is the one that sets it `true`.
   */
  readonly looksLikeAdmin?: boolean;
  /**
   * The verdict the fake's `confirm` resolves with. Defaults to
   * `'confirmed-successful'`. `'reverted'`/`'indeterminate'` drive the two
   * on-chain-settled non-success verdicts through the SAME shape
   * `confirmTransaction` produces, so the pipeline's own `verdict.kind`
   * branches are what is under test, not a fake's approximation of them.
   * Ignored when `confirmThrows` is set.
   */
  readonly confirmOutcome?: ConfirmationVerdict['kind'];
  /**
   * Makes the fake's `confirm` reject outright, standing in for an
   * interrupted run — the process dies mid-confirm, never reaching a
   * verdict at all (unlike `'indeterminate'`, which IS a verdict the gate
   * settled on).
   */
  readonly confirmThrows?: Error;
  /**
   * A real, disk-backed `RecordSession` in place of the fake one below.
   * `recordProxy` still logs, but delegates to this session's own
   * `addProxyRecord` — so a refusal that mistakenly reached `recordProxy`
   * would leave a REAL byte trail on the fixture files a byte-compare can
   * catch, not merely a call the fake's own log recorded.
   */
  readonly realSession?: RecordSession;
  /** `resolveSender` answers `'unconfigured'` instead of a resolved address. */
  readonly unconfiguredSender?: boolean;
  /**
   * Overrides merged over the `ResolvedForProxyOps` defaults below. The
   * defaults fix every field to its "caller said nothing" value, which is
   * exactly wrong for the kind/initializer/initialOwner/call semantics this
   * override exists to exercise.
   */
  readonly resolved?: Partial<ResolvedForProxyOps>;
}

interface Fake {
  readonly context: OperationContext;
  readonly log: readonly string[];
  readonly notes: readonly string[];
  readonly warns: readonly string[];
  /**
   * The proxy's OWN constructor args — captured from the second `hostDeploy`
   * call (the proxy's; the first is the implementation's), never confused
   * with `resolved.constructorArgs`, which belongs to the implementation.
   * `undefined` until a proxy deploy actually runs.
   */
  readonly proxyConstructorArgs?: readonly unknown[] | undefined;
  /**
   * The dispatched upgrade call's data, captured from `sendUpgradeCall`'s
   * request. `undefined` until an upgrade actually dispatches a call.
   */
  readonly upgradeCallData?: string | undefined;
  /**
   * `contractAt`'s own call, captured verbatim: the abstraction BY
   * REFERENCE (never re-derived), and the address it was attached at.
   * `undefined` until `contractAt` actually runs.
   */
  readonly contractAtCall?: { readonly abstraction: unknown; readonly address: string } | undefined;
}

const RESULT_ABI = [
  {
    type: 'function',
    name: 'initialize',
    inputs: [{ name: 'value', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'migrate',
    inputs: [{ name: 'value', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
];

function fakeAbstraction(spec: FakeSpec): ContractAbstraction {
  return {
    contractName: 'Box',
    abi: spec.abi ?? RESULT_ABI,
    bytecode: '0x60806040',
    isDeployed: () => spec.priorAddress != null,
    address: spec.priorAddress ?? undefined,
    transactionHash: spec.priorAddress != null ? 'bb'.repeat(32) : undefined,
    at: async (target: string) => ({ address: target }),
  } as unknown as ContractAbstraction;
}

function buildFake(spec: FakeSpec = {}): Fake {
  const log: string[] = [];
  const notes: string[] = [];
  const warns: string[] = [];
  // Set by `hostDeploy`/`sendUpgradeCall` below; read back through the
  // getters on the returned `Fake` so callers see the latest value without
  // this function reassigning a field the `Fake` interface declares readonly.
  let proxyConstructorArgs: readonly unknown[] | undefined;
  let upgradeCallData: string | undefined;
  let contractAtCall: { readonly abstraction: unknown; readonly address: string } | undefined;

  const writeBack = { address: toTronHex(canonicalizeAddress(PROXY_ADDR)), transactionHash: TX_HASH };
  const currentImpl =
    spec.currentImplementation ?? toTronHex(canonicalizeAddress(IMPL_OWNER));

  const verdicts =
    spec.priorAddress != null
      ? [
          spec.verdictStatus === 'unrecorded'
            ? // Mirrors production: an `unrecorded` verdict has no stored
              // record to have supplied a kind from, so the engine has none
              // to report yet — `kindProvenance: 'inferred-by-engine'`, no
              // `kind` field (`src/record/types.ts:175-183`).
              ({
                address: canonicalizeAddress(spec.priorAddress),
                status: 'unrecorded',
                kindProvenance: 'inferred-by-engine',
              } as never)
            : ({
                address: canonicalizeAddress(spec.priorAddress),
                status: spec.verdictStatus ?? 'authoritative',
                kindProvenance: 'recorded',
                kind: 'transparent',
              } as never),
        ]
      : [];

  const toolkit: OperationToolkit = {
    network: {
      name: 'development',
      artifactNetworkId: '9',
      configuredId: {
        value: spec.wildcard ? '*' : '9',
        syntax: spec.wildcard ? 'wildcard' : 'exact',
      },
      txDefaults: {} as never,
      sender: { kind: 'configured-not-authoritative', address: IMPL_OWNER },
      signingKeyConfigured: true,
    },
    artifacts: {} as never,
    channel: {
      warn: (title: string) => {
        warns.push(title);
      },
      note: (title: string) => {
        notes.push(title);
      },
      degraded: (note: never) => note,
      recorded: [],
      origin: 'deployer',
      describe: () => 'fake channel',
    } as never,
    session: {
      identity: { chainId: '3448148188' } as never,
      report: { proxies: verdicts } as never,
      getProxyRecord: async () => {
        log.push('getProxyRecord');
        return spec.existingProxyRecord ? ({ kind: 'transparent' } as never) : undefined;
      },
      getImplRecord: async (address: string) =>
        spec.implRecordKnown === true
          ? ({ address: canonicalizeAddress(address), layout: { of: 'Box' } } as never)
          : undefined,
      addProxyRecord: async () => undefined,
      recordCount: async () => 0,
      manifestFile: '/proj/.openzeppelin/m.json',
      fingerprintFile: '/proj/.openzeppelin/m.instance.json',
    } as never,
    chain: {
      read: {
        readImplementationAddress: async () => {
          // The post-upgrade verification read.
          log.push('readImplementationAddress');
          return (spec.observedAfterUpgrade ??
            toTronHex(canonicalizeAddress(NEW_IMPL))) as never;
        },
        readUpgradeInterfaceVersion: async () => {
          log.push('readUpgradeInterfaceVersion');
          return spec.interfaceVersion === undefined && !('interfaceVersion' in spec)
            ? '5.0.0'
            : spec.interfaceVersion;
        },
      } as never,
    } as never,

    proxySlots: async () => {
      log.push('proxySlots');
      return {
        kind: 'code' as const,
        implementation: currentImpl,
        admin:
          'admin' in spec
            ? (spec.admin === zeroChainAddress ? null : (spec.admin ?? null))
            : toTronHex(canonicalizeAddress(IMPL_OWNER)),
        beacon: spec.beacon ?? null,
      };
    },

    contractAt: async (abstraction, address) => {
      log.push('contractAt');
      contractAtCall = { abstraction, address };
      return { address, events: {} } as never;
    },

    async validateImplementation(name) {
      log.push('validate');
      if (spec.validateThrows) {
        throw spec.validateThrows;
      }
      return {
        name,
        input: {} as never,
        validations: {},
        version: {},
        layout: {},
        encodedArgs: '0x',
      };
    },

    requireDeployer() {
      log.push('requireDeployer');
      if (spec.noDeployer) {
        throw new DeployerAbsentError('deployer');
      }
      return {} as never;
    },

    queue: (host, step) => {
      log.push('queue');
      return Promise.resolve(step());
    },

    priorDeployedAddress: () => spec.priorAddress ?? null,
    replayVerdicts: () => verdicts,

    resolveSender: () => {
      log.push('resolveSender');
      return spec.unconfiguredSender
        ? { kind: 'unconfigured' as const }
        : { kind: 'resolved' as const, address: canonicalizeAddress(IMPL_OWNER) };
    },
    signerOf: async () => {
      log.push('signerOf');
      return null;
    },

    proxyArtifact: name => {
      log.push(`proxyArtifact:${name}`);
      return { contractName: name } as never;
    },
    looksLikeProxyAdmin: async () => {
      log.push('looksLikeProxyAdmin');
      return spec.looksLikeAdmin ?? false;
    },

    async fetchOrDeployImplementation(validated, resolvedOptions, deploy) {
      log.push('fetchOrDeployImplementation');
      // Mirrors `proxy/toolkit.ts`'s real gate: `'always'` deploys
      // unconditionally (upstream's `merge` argument forces a fresh deploy
      // regardless of any cached entry), `'never'` never deploys and — when
      // there is nothing recorded to reuse instead — refuses by name before
      // `deploy()` (and therefore `hostDeploy`) is ever reached. `'onchange'`
      // (the default) keeps this fake's original behavior: reuse when the
      // spec says so, deploy otherwise.
      if (resolvedOptions.redeployImplementation === 'always') {
        await deploy();
        return toTronHex(canonicalizeAddress(NEW_IMPL));
      }
      if (!spec.implementationReused) {
        if (resolvedOptions.redeployImplementation === 'never') {
          throw new ImplementationNotPreviouslyDeployedError(validated.name);
        }
        await deploy();
      }
      return toTronHex(canonicalizeAddress(NEW_IMPL));
    },

    async hostDeploy(abstraction, args) {
      // The real choke-point guard, not a fake stand-in: this fixture must
      // refuse exactly what the production `hostDeploy` refuses, so the
      // ordering tests below pin the choke point itself rather than a
      // fake's approximation of it.
      assertNoCheatcodeCollision(args);
      const contractName = String(
        (abstraction as { contractName?: unknown }).contractName,
      );
      log.push(`hostDeploy:${contractName}`);
      // The proxy's own deploy — never the implementation's, which shares
      // this same seam but under the contract's own name (e.g. `Box`).
      if (
        contractName === PROXY_CONTRACT_NAMES.transparent ||
        contractName === PROXY_CONTRACT_NAMES.trc1967
      ) {
        proxyConstructorArgs = args;
      }
      return writeBack;
    },

    async confirm(transactionHash) {
      log.push('confirm');
      if (spec.confirmThrows) {
        throw spec.confirmThrows;
      }
      const outcome = spec.confirmOutcome ?? 'confirmed-successful';
      if (outcome === 'reverted') {
        return {
          kind: 'reverted',
          transactionHash,
          vmResult: 'REVERT',
          vmMessage: 'REVERT opcode executed',
          receipt: {},
        };
      }
      if (outcome === 'indeterminate') {
        return {
          kind: 'indeterminate',
          transactionHash,
          because: 'receipt-field-absent',
          waitedMs: null,
        };
      }
      return {
        kind: 'confirmed-successful',
        transactionHash,
        receipt: {},
      };
    },

    hashWithoutMetadata: (bytecode: string) => bytecode.slice(0, 16),

    callThroughFacade: async (request: { at: string }) => {
      log.push('callThroughFacade');
      return { address: request.at, transactionHash: 'ee'.repeat(32) };
    },
    ownerOf: async () => null,

    async inferKind() {
      log.push('inferKind');
      return spec.inferredKind ?? 'transparent';
    },

    async processProxyKind() {
      log.push('processProxyKind');
      return 'transparent';
    },

    async storedLayoutFor(address) {
      log.push(`storedLayoutFor:${address.slice(0, 6)}`);
      return {};
    },

    async assertStorageCompatible() {
      log.push('assertStorageCompatible');
    },

    async sendUpgradeCall(request) {
      log.push(`sendUpgradeCall:${request.route}:${request.call}`);
      upgradeCallData = request.data;
      return writeBack;
    },

    recordProxy: async (address, kind) => {
      log.push('recordProxy');
      if (spec.realSession) {
        await spec.realSession.addProxyRecord({ address, kind });
      }
    },
  };

  const resolved: ResolvedForProxyOps = {
    kind: undefined,
    initializer: undefined,
    constructorArgs: spec.constructorArgs ?? [],
    redeployImplementation: 'onchange',
    unsafeAllowLinkedLibraries: false,
    unsafeSkipProxyAdminCheck: false,
    initialOwner: undefined,
    // Inert in these fakes (nothing here reaches the engine's own
    // `DeployOpts`), but resolution always produces both, so the fixture
    // carries the resolved defaults rather than a shape production never
    // hands an operation.
    timeout: pluginOptionDefaults.timeout,
    pollingInterval: pluginOptionDefaults.pollingInterval,
    call: undefined,
    engineOptions: {},
    ...spec.resolved,
  };

  return {
    context: { toolkit, resolved },
    log,
    notes,
    warns,
    get proxyConstructorArgs() {
      return proxyConstructorArgs;
    },
    get upgradeCallData() {
      return upgradeCallData;
    },
    get contractAtCall() {
      return contractAtCall;
    },
  };
}

// ---------------------------------------------------------------------------
// deployProxy
// ---------------------------------------------------------------------------

describe('deployProxy — the order is the contract', () => {
  it('seals unavailable contract capabilities at the operation return boundary', async () => {
    const fake = buildFake();
    const result = await runDeployProxy(
      fake.context,
      fakeAbstraction({}),
      [42],
    );

    expect(() => result.contract.events).toThrow(
      ResultCapabilityUnavailableError,
    );
  });

  it('runs validation first, queues once, and everything chain-touching happens inside the step', async () => {
    const fake = buildFake();
    const result = await runDeployProxy(
      fake.context,
      fakeAbstraction({}),
      [42],
    );

    expect(fake.log[0]).toBe('validate');
    expect(fake.log.filter(entry => entry === 'queue')).toHaveLength(1);

    const queueAt = fake.log.indexOf('queue');
    for (const inside of ['fetchOrDeployImplementation', 'confirm', 'recordProxy']) {
      expect(fake.log.indexOf(inside), inside).toBeGreaterThan(queueAt);
    }
    // The proxy deploy is the SECOND hostDeploy — the implementation's rides
    // fetchOrDeployImplementation.
    expect(
      fake.log.filter(entry => entry.startsWith('hostDeploy:')),
    ).toEqual(['hostDeploy:Box', 'hostDeploy:TransparentUpgradeableProxy']);

    // The result: address tool-verbatim from the write-back, hash from the
    // write-back, never a queue value.
    expect(result.address).toBe(toTronHex(canonicalizeAddress(PROXY_ADDR)));
    expect(result.transaction.hash).toBe(TX_HASH);
  });

  it('the missing deployer refuses AFTER validation ran', async () => {
    const fake = buildFake({ noDeployer: true });
    await expect(
      runDeployProxy(fake.context, fakeAbstraction({}), [42]),
    ).rejects.toBeInstanceOf(DeployerAbsentError);
    expect(fake.log).toContain('validate');
    expect(fake.log.indexOf('validate')).toBeLessThan(
      fake.log.indexOf('requireDeployer'),
    );
    expect(fake.log).not.toContain('queue');
  });

  it('an authoritative prior record no longer short-circuits — deployProxy always hostDeploys a NEW proxy (Hardhat parity)', async () => {
    // The reuse branch is gone. An authoritative prior record only stops
    // the corrupt-record refusal below from firing — it no longer returns
    // the recorded proxy. `OWNER_BASE58` stands in for the FIRST
    // proxy's recorded address, deliberately distinct from `PROXY_ADDR` (the
    // fake's hostDeploy write-back), so a passing test cannot be explained
    // by the two addresses coinciding.
    const fake = buildFake({
      priorAddress: OWNER_BASE58,
      implementationReused: true,
    });
    const result = await runDeployProxy(
      fake.context,
      fakeAbstraction({ priorAddress: OWNER_BASE58 }),
      [42],
    );
    expect(fake.log.filter(entry => entry === 'queue')).toHaveLength(1);
    // The proxy hostDeploys; the implementation's own hostDeploy never
    // runs — fetch-reused, exactly as `fetchOrDeployImplementation` (a
    // separate, untouched reuse mechanism) decided.
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([
      'hostDeploy:TransparentUpgradeableProxy',
    ]);
    expect(fake.log).toContain('recordProxy');
    // The refutation the removal must survive: a second `deployProxy(Box)`
    // can never answer the first proxy's recorded address.
    expect(result.address).not.toBe(OWNER_BASE58);
    expect(result.address).toBe(toTronHex(canonicalizeAddress(PROXY_ADDR)));
  });

  it('a stale prior refuses by name, before the queue', async () => {
    const fake = buildFake({
      priorAddress: PROXY_ADDR,
      verdictStatus: 'no-code-at-address',
    });
    await expect(
      runDeployProxy(
        fake.context,
        fakeAbstraction({ priorAddress: PROXY_ADDR }),
        [42],
      ),
    ).rejects.toBeInstanceOf(StaleProxyRecordError);
    expect(fake.log).not.toContain('queue');
  });

  it('a prior address the record knows as an IMPLEMENTATION proceeds as a fresh deploy (review r3787284026)', async () => {
    // migration 2: deployImplementation(Box) leaves the impl address in the
    // artifact slot; migration 3: deployProxy(Box) must not read it as a
    // stale proxy. The record vouches for it as an implementation, so the
    // deploy proceeds and fetchOrDeployImplementation reuses it by version —
    // only the proxy hostDeploys.
    const fake = buildFake({
      priorAddress: OWNER_BASE58,
      verdictStatus: 'unrecorded',
      implRecordKnown: true,
      implementationReused: true,
    });
    const result = await runDeployProxy(
      fake.context,
      fakeAbstraction({ priorAddress: OWNER_BASE58 }),
      [42],
    );
    expect(fake.log).toContain('queue');
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([
      'hostDeploy:TransparentUpgradeableProxy',
    ]);
    expect(result.address).toBe(toTronHex(canonicalizeAddress(PROXY_ADDR)));
  });

  it('a prior address that is neither a recorded proxy nor a recorded implementation still refuses', async () => {
    const fake = buildFake({
      priorAddress: PROXY_ADDR,
      verdictStatus: 'unrecorded',
      implRecordKnown: false,
    });
    await expect(
      runDeployProxy(fake.context, fakeAbstraction({ priorAddress: PROXY_ADDR }), [42]),
    ).rejects.toBeInstanceOf(StaleProxyRecordError);
    expect(fake.log).not.toContain('queue');
  });

  it('the cheatcode-slot shape refuses before anything queues', async () => {
    const fake = buildFake({ constructorArgs: [1, { overwrite: false }] });
    await expect(
      runDeployProxy(fake.context, fakeAbstraction({}), [42]),
    ).rejects.toBeInstanceOf(CheatcodeSlotCollisionError);
    expect(fake.log).not.toContain('queue');
  });

  it('the wildcard statement is emitted, naming the real chain id', async () => {
    const fake = buildFake({ wildcard: true });
    await runDeployProxy(fake.context, fakeAbstraction({}), [42]);
    expect(fake.notes).toContain('wildcard network id');

    const exact = buildFake();
    await runDeployProxy(exact.context, fakeAbstraction({}), [42]);
    expect(exact.notes).toEqual([]);
  });

  it('says so through the channel when the node omits the sender', async () => {
    const fake = buildFake();
    await runDeployProxy(fake.context, fakeAbstraction({}), [42]);
    expect(fake.warns).toContain('sender comparison skipped');
  });

  it('kind:uups selects the TRC1967 artifact, not transparent', async () => {
    const fake = buildFake({ resolved: { kind: 'uups', initializer: 'initialize' } });
    await runDeployProxy(fake.context, fakeAbstraction({}), [42]);
    expect(fake.log).toContain('proxyArtifact:TRC1967Proxy');
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([
      'hostDeploy:Box',
      'hostDeploy:TRC1967Proxy',
    ]);
  });

  it('an omitted kind is INFERRED from the validated implementation — a UUPS shape selects the TRC1967 artifact', async () => {
    // The parity break this pins: upstream resolves an omitted kind through
    // `inferProxyKind` BEFORE anything selects an artifact
    // (`upgrades-core@1.46 dist/proxy-kind.js:34-41`), so a UUPS-shaped
    // implementation deployed with no `kind` gets a TRC1967 proxy — never a
    // silently-transparent one whose admin the caller does not expect.
    const fake = buildFake({ inferredKind: 'uups' });
    await runDeployProxy(fake.context, fakeAbstraction({}), [42]);
    expect(fake.log).toContain('inferKind');
    // Inference reads the VALIDATED implementation, so it cannot run first.
    expect(fake.log.indexOf('validate')).toBeLessThan(
      fake.log.indexOf('inferKind'),
    );
    expect(fake.log).toContain('proxyArtifact:TRC1967Proxy');
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([
      'hostDeploy:Box',
      'hostDeploy:TRC1967Proxy',
    ]);
  });

  it('an explicit kind consults no inference at all', async () => {
    const fake = buildFake({
      inferredKind: 'uups',
      resolved: { kind: 'transparent' },
    });
    await runDeployProxy(fake.context, fakeAbstraction({}), [42]);
    expect(fake.log).not.toContain('inferKind');
    expect(fake.log).toContain('proxyArtifact:TransparentUpgradeableProxy');
  });

  it('kind:beacon is refused by name, never silently downgraded to transparent', async () => {
    const fake = buildFake({ resolved: { kind: 'beacon' } });
    await expect(
      runDeployProxy(fake.context, fakeAbstraction({}), [42]),
    ).rejects.toThrow(OptionValueError);
  });

  it('initialOwner with an explicit kind:uups is refused by name — nothing deploys', async () => {
    // The parity target's own refusal (`upgrades-core@1.46
    // dist/usage-error.js:72 InitialOwnerUnsupportedKindError`): a UUPS
    // proxy has no admin for the option to configure, so accepting it would
    // silently drop the one thing the caller asked for.
    const fake = buildFake({
      resolved: { kind: 'uups', initialOwner: OWNER_BASE58 },
    });
    await expect(
      runDeployProxy(fake.context, fakeAbstraction({}), [42]),
    ).rejects.toBeInstanceOf(InitialOwnerUnsupportedKindError);
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([]);
    expect(fake.log).not.toContain('queue');
  });

  it('initialOwner with an INFERRED uups kind takes the same refusal', async () => {
    const fake = buildFake({
      inferredKind: 'uups',
      resolved: { initialOwner: OWNER_BASE58 },
    });
    await expect(
      runDeployProxy(fake.context, fakeAbstraction({}), [42]),
    ).rejects.toBeInstanceOf(InitialOwnerUnsupportedKindError);
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([]);
    expect(fake.log).not.toContain('queue');
  });

  it('initializer:false is refused by name — the ported proxy rejects empty init data', async () => {
    // The sole class for this refusal, across every operation: the
    // formerly-separate `InitializerDataRequiredError` was absorbed into
    // `EmptyInitializerRefusedError` (Nahim's consolidation decision) —
    // same input, same class, whether the refusal is thrown here (the
    // explicit `initializer: false` pre-flight) or from `encodeInitializer`
    // (the ABI-has-no-default-initializer arm).
    const fake = buildFake({ resolved: { initializer: false } });
    await expect(
      runDeployProxy(fake.context, fakeAbstraction({}), [42]),
    ).rejects.toBeInstanceOf(EmptyInitializerRefusedError);
    // Pre-spend: step 6 refuses before the queue is ever entered, so no
    // implementation and no proxy reach the host.
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([]);
    expect(fake.log).not.toContain('queue');
  });

  it('an omitted initializer with zero args TRIES initialize() — the ABI decides, not the arg count', async () => {
    // The parity target's TRY-FIRST rule (`getInitializerData`, ported
    // verbatim in the sibling's `hardhat-tron-upgrades/dist/utils/
    // initializer-data.js`): omitted means try `'initialize'`; only an ABI
    // with no such fragment has nothing to encode.
    const zeroInitAbi = [
      {
        type: 'function',
        name: 'initialize',
        inputs: [],
        outputs: [],
        stateMutability: 'nonpayable',
      },
    ];
    const fake = buildFake();
    await runDeployProxy(
      fake.context,
      fakeAbstraction({ abi: zeroInitAbi }),
      [],
    );
    // The transparent proxy's constructor args are [implementation,
    // initialOwner, initData] — the encoded zero-arg initialize() call is
    // the third, and it is NON-empty: the ported proxies reject '0x'.
    expect(fake.proxyConstructorArgs?.[2]).toBe(
      new Interface(zeroInitAbi as never).encodeFunctionData('initialize', []),
    );
    expect(fake.proxyConstructorArgs?.[2]).not.toBe('0x');
  });

  it('an omitted initializer refuses by name when the ABI has NO initialize() — nothing deploys', async () => {
    // Upstream would deploy UNINITIALIZED here (`allowNoInitialization` →
    // '0x'); the ported proxies reject empty init data, so absence of the
    // default initializer is where the empty-data refusal belongs.
    const noInitAbi = [
      {
        type: 'function',
        name: 'store',
        inputs: [{ name: 'v', type: 'uint256' }],
        outputs: [],
        stateMutability: 'nonpayable',
      },
    ];
    const fake = buildFake();
    await expect(
      runDeployProxy(fake.context, fakeAbstraction({ abi: noInitAbi }), []),
    ).rejects.toBeInstanceOf(EmptyInitializerRefusedError);
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([]);
    expect(fake.log).not.toContain('queue');
  });

  it('initialOwner reaches the transparent proxy constructor args', async () => {
    const fake = buildFake({ resolved: { initialOwner: OWNER_BASE58 } });
    await runDeployProxy(fake.context, fakeAbstraction({}), [42]);
    // buildFake's hostDeploy log/capture records proxy constructor args.
    expect(fake.proxyConstructorArgs?.[1]).toBe(canonicalizeAddress(OWNER_BASE58));
  });

  it('a validation refusal sends nothing and writes no record', async () => {
    const fake = buildFake({ validateThrows: new Error('not upgrade-safe') });
    await expect(
      runDeployProxy(fake.context, fakeAbstraction({}), [42]),
    ).rejects.toThrow('not upgrade-safe');
    // The full absence set, not merely the deploy: nothing queued, no
    // implementation or proxy host-deployed, and no record written —
    // exactly what a refusal at step 1 must leave untouched.
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([]);
    expect(fake.log).not.toContain('queue');
    expect(fake.log).not.toContain('recordProxy');
  });
});

/*
 * A REAL, disk-backed `RecordSession` for the byte-compare tests below — the
 * record layer's own preflight, run for real under `RECORD_DIR`, following
 * `test/record-non-vacuity.test.ts`'s own byte-compare pattern. `recordProxy`
 * in `buildFake` above delegates to this session's own `addProxyRecord` when
 * one is supplied, so a refusal that mistakenly reached it would leave a
 * genuine mutation on disk — not merely a call a fake's log recorded.
 *
 * `chainIdHex` is what the engine keys the manifest FILE name on, so each
 * caller in this suite names a distinct chain id — one shared `RECORD_DIR`,
 * unable to move once the engine has loaded, holds every session's own file
 * with no cross-test interference.
 */
async function realRecordSession(chainIdHex: string): Promise<RecordSession> {
  const identity: ChainInstanceIdentity = {
    chainId: chainIdHex,
    genesisHash: `0x${'ab'.repeat(32)}`,
    firstBlockHash: `0x${'cd'.repeat(32)}`,
    observedThrough: 'http://fixture.invalid/',
  };
  const chain: ChainAccess = {
    get provider(): ChainAccess['provider'] {
      throw new Error('no provider expected on this path');
    },
    endpoint: Object.freeze({
      describe: identity.observedThrough,
      origin: 'derived' as const,
    }),
    identity: () => Promise.resolve(identity),
    // A throwing stub, never a value: `addresses: []` below means
    // `reconcileProxies` never dereferences it, and a getter is what makes
    // "never" measurable rather than merely unasserted.
    read: {
      hasCode: () =>
        Promise.reject(
          new Error('no address was named, so no code-presence read may happen'),
        ),
    } as unknown as ChainAccess['read'],
  };
  return openRecord({
    root: RECORD_DIR as AbsolutePath,
    // The real view, deliberately: the engine reads the SAME variable
    // straight off `process.env`, primed above at module scope, so this
    // plugin's own bookkeeping has to read the identical view or the two
    // could disagree about which file is in force.
    env: process.env,
    chain,
    addresses: [],
  });
}

/** Both fixture files' current bytes, or `null` for one that does not exist. */
function recordFixtureBytes(session: RecordSession): {
  readonly manifest: string | null;
  readonly fingerprint: string | null;
} {
  return {
    manifest: fs.existsSync(session.manifestFile)
      ? fs.readFileSync(session.manifestFile, 'utf8')
      : null,
    fingerprint: fs.existsSync(session.fingerprintFile)
      ? fs.readFileSync(session.fingerprintFile, 'utf8')
      : null,
  };
}

describe('deployProxy — a refused deploy leaves the on-disk record byte-unchanged', () => {
  it('a validation refusal never reaches recordProxy, and the manifest/fingerprint fixtures prove it', async () => {
    const session = await realRecordSession('0x2a');
    const before = recordFixtureBytes(session);

    const fake = buildFake({
      validateThrows: new Error('not upgrade-safe'),
      realSession: session,
    });
    await expect(
      runDeployProxy(fake.context, fakeAbstraction({}), [42]),
    ).rejects.toThrow('not upgrade-safe');
    expect(fake.log).not.toContain('recordProxy');

    const after = recordFixtureBytes(session);
    expect(after.manifest).toBe(before.manifest);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it('non-vacuity: the identical wiring DOES rewrite the manifest once recordProxy is actually reached', async () => {
    // What makes the assertion above measure something rather than a fixture
    // nobody could move: the same real session mechanism, with nothing
    // changed but the trigger and the chain id, provably rewrites the
    // manifest on a successful deploy.
    const session = await realRecordSession('0x3');
    const before = recordFixtureBytes(session);
    const fake = buildFake({ realSession: session });
    await runDeployProxy(fake.context, fakeAbstraction({}), [42]);
    expect(fake.log).toContain('recordProxy');

    const after = recordFixtureBytes(session);
    expect(after.manifest).not.toBeNull();
    expect(after.manifest).not.toBe(before.manifest);
    expect(after.fingerprint).not.toBeNull();
  });
});

describe('deployProxy — a reverted or indeterminate confirmation is never recorded', () => {
  it('a reverted confirmation refuses by name after BOTH deploys reached the host, and never records', async () => {
    // The revert is discovered only at `confirm`, which runs after the
    // implementation's hostDeploy (via `fetchOrDeployImplementation`) AND the
    // proxy's own — so both ran, and the refusal is what stops the sender
    // comparison and the record write that would otherwise follow.
    const fake = buildFake({ confirmOutcome: 'reverted' });
    await expect(
      runDeployProxy(fake.context, fakeAbstraction({}), [42]),
    ).rejects.toBeInstanceOf(TransactionRevertedError);
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([
      'hostDeploy:Box',
      'hostDeploy:TransparentUpgradeableProxy',
    ]);
    expect(fake.log).not.toContain('recordProxy');
  });

  it('an indeterminate confirmation is likewise refused and never recorded', async () => {
    const fake = buildFake({ confirmOutcome: 'indeterminate' });
    await expect(
      runDeployProxy(fake.context, fakeAbstraction({}), [42]),
    ).rejects.toBeInstanceOf(ConfirmationIndeterminateError);
    expect(fake.log).not.toContain('recordProxy');
  });
});

describe('deployProxy — an interrupted confirmation, and what a re-run does about it', () => {
  // Deliberately a two-scene model: the first run establishes the landed-but-
  // unrecorded state, and the second models the separate process that retries it.
  it('the interrupted run throws mid-confirm after both deploys landed, with nothing recorded', async () => {
    // Distinct from `'indeterminate'` above: the gate never SETTLED on a
    // verdict at all here — `confirm` itself rejects, standing in for the
    // process dying mid-confirm.
    const error = new Error('ECONNRESET');
    const interrupted = buildFake({ confirmThrows: error });
    await expect(
      runDeployProxy(interrupted.context, fakeAbstraction({}), [42]),
    ).rejects.toBe(error);
    expect(interrupted.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([
      'hostDeploy:Box',
      'hostDeploy:TransparentUpgradeableProxy',
    ]);
    expect(interrupted.log).not.toContain('recordProxy');
  });

  it('a re-run resumes the already-deployed implementation but ALWAYS redeploys a fresh proxy — Hardhat parity, no proxy replay', async () => {
    // `implementationReused: true` stands in for what the engine's own
    // replay memory (`fetchOrDeployGetDeployment`) decides on a genuine
    // re-run: the interrupted attempt's implementation deploy already landed
    // on-chain, so the retry FETCHES it instead of deploying again — the
    // "resume" half of the contract. The proxy carries no such memory:
    // `deployProxy` always hostDeploys a NEW one (the reuse branch is gone,
    // Hardhat parity), so it deploys again regardless — the "clean" half.
    const retry = buildFake({ implementationReused: true });
    const result = await runDeployProxy(retry.context, fakeAbstraction({}), [42]);
    expect(retry.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([
      'hostDeploy:TransparentUpgradeableProxy',
    ]);
    expect(retry.log).toContain('recordProxy');
    expect(result.address).toBe(toTronHex(canonicalizeAddress(PROXY_ADDR)));
  });
});

describe("deployProxy — redeployImplementation: 'never'", () => {
  it('refuses by name before any host spend when the implementation was not previously deployed — the proxy is never reached', async () => {
    const fake = buildFake({ resolved: { redeployImplementation: 'never' } });
    await expect(
      runDeployProxy(fake.context, fakeAbstraction({}), [42]),
    ).rejects.toBeInstanceOf(ImplementationNotPreviouslyDeployedError);
    // The implementation half is refused before the proxy half is ever
    // attempted — zero hostDeploy entries, not merely "the implementation's
    // is missing".
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([]);
    expect(fake.log).not.toContain('recordProxy');
  });

  it('proceeds using the recorded implementation address when one already exists, with no fresh implementation deploy', async () => {
    const fake = buildFake({
      implementationReused: true,
      resolved: { redeployImplementation: 'never' },
    });
    const result = await runDeployProxy(fake.context, fakeAbstraction({}), [42]);
    // Only the proxy hostDeploys — the implementation's own is skipped,
    // exactly as the already-recorded case for every other policy behaves.
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([
      'hostDeploy:TransparentUpgradeableProxy',
    ]);
    expect(fake.log).toContain('recordProxy');
    expect(result.address).toBe(toTronHex(canonicalizeAddress(PROXY_ADDR)));
  });
});

describe('deployProxy — the ProxyAdmin-as-owner refusal and its escape', () => {
  it('refuses by name when the resolved initialOwner looks like a ProxyAdmin contract', async () => {
    const fake = buildFake({
      looksLikeAdmin: true,
      resolved: { initialOwner: OWNER_BASE58 },
    });
    await expect(
      runDeployProxy(fake.context, fakeAbstraction({}), [42]),
    ).rejects.toBeInstanceOf(ProxyAdminAsOwnerError);
    expect(fake.log).toContain('looksLikeProxyAdmin');
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([]);
    expect(fake.log).not.toContain('queue');
  });

  it('unsafeSkipProxyAdminCheck skips the check outright, and the deploy proceeds', async () => {
    const fake = buildFake({
      looksLikeAdmin: true,
      resolved: { initialOwner: OWNER_BASE58, unsafeSkipProxyAdminCheck: true },
    });
    const result = await runDeployProxy(fake.context, fakeAbstraction({}), [42]);
    // Skipped outright — never merely overridden after running: the check
    // never fires at all under the escape hatch.
    expect(fake.log).not.toContain('looksLikeProxyAdmin');
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([
      'hostDeploy:Box',
      'hostDeploy:TransparentUpgradeableProxy',
    ]);
    expect(result.address).toBe(toTronHex(canonicalizeAddress(PROXY_ADDR)));
  });
});

describe('deployProxy — the transparent initialOwner refusal and its escape', () => {
  it('transparent with no initialOwner and an unconfigured sender refuses by name, before the queue (review r3787162127)', async () => {
    // The null owner used to sail into the queued step, deploy the
    // implementation, and die in the host's ABI encoder — a wrong message
    // after an irreversible spend. Same rule as deployBeacon's.
    const fake = buildFake({ unconfiguredSender: true });
    await expect(
      runDeployProxy(fake.context, fakeAbstraction({}), [42]),
    ).rejects.toBeInstanceOf(TransparentInitialOwnerRequiredError);
    expect(fake.log).not.toContain('queue');
    expect(fake.log.some(e => e.startsWith('hostDeploy:'))).toBe(false);
  });

  it('an unconfigured sender WITH an explicit initialOwner deploys normally', async () => {
    const fake = buildFake({
      unconfiguredSender: true,
      resolved: { initialOwner: OWNER_BASE58 },
    });
    const result = await runDeployProxy(fake.context, fakeAbstraction({}), [42]);
    expect(fake.log).toContain('hostDeploy:TransparentUpgradeableProxy');
    expect(result.address).toBe(toTronHex(canonicalizeAddress(PROXY_ADDR)));
  });
});

// ---------------------------------------------------------------------------
// upgradeProxy
// ---------------------------------------------------------------------------

describe('upgradeProxy — the measured orderings, pinned on the log', () => {
  const newImpl = () => fakeAbstraction({});

  it('the beacon check runs before kind processing, and a beacon refuses', async () => {
    const beacon = toTronHex(canonicalizeAddress(NEW_IMPL));
    const fake = buildFake({ beacon });
    await expect(
      runUpgradeProxy(fake.context, PROXY_ADDR, newImpl()),
    ).rejects.toBeInstanceOf(BeaconProxyRefusedError);
    expect(fake.log).toContain('proxySlots');
    expect(fake.log).not.toContain('processProxyKind');
    expect(fake.log).not.toContain('queue');
  });

  it('authority and dispatch are planned BEFORE the implementation deploys', async () => {
    const fake = buildFake();
    await runUpgradeProxy(fake.context, PROXY_ADDR, newImpl());

    const authority = fake.log.indexOf('proxySlots');
    const probe = fake.log.indexOf('readUpgradeInterfaceVersion');
    const implementationDeploy = fake.log.indexOf('fetchOrDeployImplementation');
    expect(authority).toBeGreaterThanOrEqual(0);
    expect(probe).toBeGreaterThan(authority);
    expect(implementationDeploy).toBeGreaterThan(probe);
  });

  it('the slot is re-read after the upgrade call, and a mismatch refuses', async () => {
    const good = buildFake();
    await runUpgradeProxy(good.context, PROXY_ADDR, newImpl());
    const send = good.log.findIndex(entry => entry.startsWith('sendUpgradeCall:'));
    const verify = good.log.lastIndexOf('readImplementationAddress');
    expect(send).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(send);

    const bad = buildFake({
      observedAfterUpgrade: toTronHex(canonicalizeAddress(IMPL_OWNER)),
    });
    await expect(
      runUpgradeProxy(bad.context, PROXY_ADDR, newImpl()),
    ).rejects.toBeInstanceOf(UpgradeVerificationFailedError);
  });

  it('verification compares identity, not spelling — a base58 observation of the same address passes', async () => {
    const fake = buildFake({
      observedAfterUpgrade: toBase58(canonicalizeAddress(NEW_IMPL)),
    });
    await expect(
      runUpgradeProxy(fake.context, PROXY_ADDR, newImpl()),
    ).resolves.toBeDefined();
  });

  it('already-current still dispatches the upgrade and its encoded call', async () => {
    const fake = buildFake({
      priorAddress: NEW_IMPL,
      currentImplementation: toTronHex(canonicalizeAddress(NEW_IMPL)),
      implementationReused: true,
      existingProxyRecord: true,
      resolved: { call: { fn: 'migrate', args: [7] } },
    });
    await runUpgradeProxy(
      fake.context,
      PROXY_ADDR,
      fakeAbstraction({ priorAddress: NEW_IMPL }),
    );
    expect(fake.log).toContain('queue');
    expect(fake.log.filter(entry => entry.startsWith('hostDeploy:'))).toEqual([]);
    expect(fake.log).toContain('sendUpgradeCall:admin-v5:upgradeAndCall');
    expect(fake.upgradeCallData).toBe(
      new Interface(RESULT_ABI as never).encodeFunctionData('migrate', [7]),
    );
    expect(fake.log).not.toContain('recordProxy');
  });

  it('already-current still dispatches the upgrade without a call', async () => {
    // The v5 admin route is always `upgradeAndCall`, so it carries the
    // possibly-empty data argument even when the caller supplied no call.
    const fake = buildFake({
      priorAddress: NEW_IMPL,
      currentImplementation: toTronHex(canonicalizeAddress(NEW_IMPL)),
      implementationReused: true,
      existingProxyRecord: true,
    });
    await runUpgradeProxy(
      fake.context,
      PROXY_ADDR,
      fakeAbstraction({ priorAddress: NEW_IMPL }),
    );
    expect(fake.log).toContain('queue');
    expect(fake.log.filter(entry => entry.startsWith('hostDeploy:'))).toEqual([]);
    expect(fake.log).toContain('sendUpgradeCall:admin-v5:upgradeAndCall');
    expect(fake.upgradeCallData).toBe('0x');
    expect(fake.log).not.toContain('recordProxy');
  });

  it('the result preserves the PROXY address, and attaches the NEW abstraction there — not the old implementation', async () => {
    const fake = buildFake();
    const newImplementation = newImpl();
    const result = await runUpgradeProxy(fake.context, PROXY_ADDR, newImplementation);

    const canonicalProxy = canonicalizeAddress(PROXY_ADDR);
    expect(result.address).toBe(canonicalProxy);
    // `contractAt` is called with the PROXY's own address — never the new
    // implementation's — and the caller's NEW abstraction (by reference),
    // which is what lets the returned handle's ABI be the upgraded one.
    expect(fake.contractAtCall?.address).toBe(canonicalProxy);
    expect(fake.contractAtCall?.abstraction).toBe(newImplementation);
    // The envelope's `implementation` field: the address the queue actually
    // deployed/fetched, not merely "defined".
    expect(result.implementation).toBe(toTronHex(canonicalizeAddress(NEW_IMPL)));
  });

  it('a reverted confirmation refuses after the dispatched call, before the verification read and any record', async () => {
    const fake = buildFake({ confirmOutcome: 'reverted' });
    await expect(
      runUpgradeProxy(fake.context, PROXY_ADDR, newImpl()),
    ).rejects.toBeInstanceOf(TransactionRevertedError);
    expect(fake.log.some(e => e.startsWith('sendUpgradeCall:'))).toBe(true);
    // The trust-but-verify read comes AFTER the confirm check in the
    // pipeline, so a reverted confirmation never reaches it.
    expect(fake.log).not.toContain('readImplementationAddress');
    expect(fake.log).not.toContain('recordProxy');
  });

  it('records only when no record existed', async () => {
    const fresh = buildFake();
    await runUpgradeProxy(fresh.context, PROXY_ADDR, newImpl());
    expect(fresh.log).toContain('recordProxy');

    const recorded = buildFake({ existingProxyRecord: true });
    await runUpgradeProxy(recorded.context, PROXY_ADDR, newImpl());
    expect(recorded.log).not.toContain('recordProxy');
  });

  it('a zero admin on the transparent path refuses by name', async () => {
    const fake = buildFake({ admin: zeroChainAddress });
    await expect(
      runUpgradeProxy(fake.context, PROXY_ADDR, newImpl()),
    ).rejects.toBeInstanceOf(NotTransparentProxyError);
    expect(fake.log).not.toContain('queue');
  });

  it('dispatches through the planned route: a v5 admin sends upgradeAndCall', async () => {
    const fake = buildFake({ interfaceVersion: '5.0.0' });
    await runUpgradeProxy(fake.context, PROXY_ADDR, newImpl());
    expect(fake.log).toContain('sendUpgradeCall:admin-v5:upgradeAndCall');
  });

  it('dispatches a v4 admin plain upgrade when there is no call data', async () => {
    const fake = buildFake({ interfaceVersion: undefined });
    await runUpgradeProxy(fake.context, PROXY_ADDR, newImpl());
    expect(fake.log).toContain('sendUpgradeCall:admin-v4:upgrade');
  });

  it('a supplied call is encoded and dispatched on upgrade', async () => {
    const fake = buildFake({
      resolved: { call: { fn: 'migrate', args: [7] } },
      currentImplementation: OTHER_IMPL,
    });
    await runUpgradeProxy(fake.context, PROXY_ADDR, newImpl());
    // The EXACT encoding, computed the same way `upgrade-proxy.ts:encodeCall`
    // does over the same ABI — not merely "is defined". `plan.carriesData ?
    // callData : '0x'` is a defined string on every dispatch, so a weaker
    // assertion (`not.toBeUndefined()`) would pass identically even if
    // `resolved.call` were dropped and `'0x'` sent instead.
    expect(fake.upgradeCallData).toBe(
      new Interface(RESULT_ABI as never).encodeFunctionData('migrate', [7]),
    );
    expect(fake.upgradeCallData).not.toBe('0x');
  });

  // The README's hex-`call` divergence row, executed rather than described:
  // `encodeCall` (upgrade-proxy.ts) resolves a plain-string or a `{ fn }`
  // name through `Interface.encodeFunctionData`/`getFunction`, and — verified
  // directly against the installed `ethers` before writing this suite —
  // neither ever consults argument count to disambiguate an overloaded bare
  // name. `encodeFunctionData(fragment, values)` calls `this.getFunction(fragment)`
  // with NO `values` argument at all when `fragment` is a string
  // (`node_modules/ethers/lib.commonjs/abi/interface.js:743-751`), so there is
  // no arity-based selection on this path for any argument count, unlike the
  // (also imperfect) `getFunction(name, values)` path `encodeInitializer` uses.
  const overloadedAbi = [
    {
      type: 'function',
      name: 'reinitialize',
      inputs: [],
      outputs: [],
      stateMutability: 'nonpayable',
    },
    {
      type: 'function',
      name: 'reinitialize',
      inputs: [{ name: 'v', type: 'uint8' }],
      outputs: [],
      stateMutability: 'nonpayable',
    },
  ];

  it('a bare overloaded call name raises ethers\' own ambiguity error, not a named refusal — before the queue', async () => {
    const fake = buildFake({ resolved: { call: 'reinitialize' } });
    let caught: unknown;
    try {
      await runUpgradeProxy(
        fake.context,
        PROXY_ADDR,
        fakeAbstraction({ abi: overloadedAbi }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    // Raw ethers, not this plugin's own refusal family: no `code` this
    // plugin defines, and `ethers`' own diagnostic name and text.
    expect((caught as { code?: unknown }).code).toBe('INVALID_ARGUMENT');
    expect((caught as Error).message).toContain('ambiguous function description');
    expect(fake.log).not.toContain('queue');
  });

  it('args do not disambiguate an overloaded call name either, even inside the { fn, args } form', async () => {
    const fake = buildFake({
      resolved: { call: { fn: 'reinitialize', args: [5] } },
    });
    await expect(
      runUpgradeProxy(fake.context, PROXY_ADDR, fakeAbstraction({ abi: overloadedAbi })),
    ).rejects.toThrow('ambiguous function description');
  });

  it('the full signature in { fn, args } disambiguates and encodes the arguments', async () => {
    const fake = buildFake({
      resolved: { call: { fn: 'reinitialize(uint8)', args: [5] } },
    });
    await runUpgradeProxy(fake.context, PROXY_ADDR, fakeAbstraction({ abi: overloadedAbi }));
    expect(fake.upgradeCallData).toBe(
      new Interface(overloadedAbi as never).encodeFunctionData('reinitialize(uint8)', [5]),
    );
  });

  it('the plain-string call form always encodes zero arguments, even when the string names a full signature', async () => {
    // `encodeCall`'s string branch is `iface.encodeFunctionData(call, [])` —
    // unconditionally `[]` — so a full signature string with a non-empty
    // parameter list is resolved (unambiguous by itself) but then encoded
    // with no arguments, which `ethers` refuses as a missing argument.
    const fake = buildFake({ resolved: { call: 'reinitialize(uint8)' } });
    await expect(
      runUpgradeProxy(fake.context, PROXY_ADDR, fakeAbstraction({ abi: overloadedAbi })),
    ).rejects.toThrow(/missing argument/i);
  });

  it('a validation refusal dispatches nothing and writes no record', async () => {
    const fake = buildFake({ validateThrows: new Error('not upgrade-safe') });
    await expect(
      runUpgradeProxy(fake.context, PROXY_ADDR, newImpl()),
    ).rejects.toThrow('not upgrade-safe');
    // The full absence set: no implementation deploy, no queue, no
    // dispatched upgrade call, and no record — a refusal at step 1 leaves
    // no half-queued operation behind.
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([]);
    expect(fake.log).not.toContain('queue');
    expect(fake.log.some(e => e.startsWith('sendUpgradeCall:'))).toBe(false);
    expect(fake.log).not.toContain('recordProxy');
  });

  it('the cheatcode-slot shape refuses through hostDeploy — no deploy reaches the host', async () => {
    // Unlike deployProxy, upgradeProxy has no pre-queue guard of its own: the
    // implementation's constructor args reach the host only from inside the
    // queued step, through `fetchOrDeployImplementation`'s deploy callback.
    // The choke-point guard in `hostDeploy` is the only thing that can catch
    // this shape here, so the refusal happens after `queue` is entered but
    // before any hostDeploy call completes and before anything downstream
    // of it runs.
    const fake = buildFake({ constructorArgs: [1, { overwrite: false }] });
    await expect(
      runUpgradeProxy(fake.context, PROXY_ADDR, newImpl()),
    ).rejects.toBeInstanceOf(CheatcodeSlotCollisionError);
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([]);
    expect(fake.log).not.toContain('confirm');
    expect(fake.log.some(e => e.startsWith('sendUpgradeCall:'))).toBe(false);
    expect(fake.log).not.toContain('recordProxy');
  });

  it("redeployImplementation: 'never' refuses by name before any host spend when the implementation was not previously deployed", async () => {
    const fake = buildFake({ resolved: { redeployImplementation: 'never' } });
    await expect(
      runUpgradeProxy(fake.context, PROXY_ADDR, newImpl()),
    ).rejects.toBeInstanceOf(ImplementationNotPreviouslyDeployedError);
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([]);
    expect(fake.log.some(e => e.startsWith('sendUpgradeCall:'))).toBe(false);
    expect(fake.log).not.toContain('confirm');
    expect(fake.log).not.toContain('recordProxy');
  });

  it("redeployImplementation: 'never' proceeds using the recorded implementation address when one already exists, with no fresh deploy", async () => {
    const fake = buildFake({
      implementationReused: true,
      resolved: { redeployImplementation: 'never' },
    });
    await runUpgradeProxy(fake.context, PROXY_ADDR, newImpl());
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([]);
    expect(fake.log.some(e => e.startsWith('sendUpgradeCall:'))).toBe(true);
  });

  it("redeployImplementation: 'always' deploys a fresh implementation even when one is already recorded", async () => {
    // Distinct from 'never'/'onchange': upstream's `merge` argument to
    // `fetchOrDeployGetDeployment` forces a fresh deploy unconditionally, so
    // `implementationReused` — every other policy's short-circuit — does not
    // apply here.
    const fake = buildFake({
      implementationReused: true,
      resolved: { redeployImplementation: 'always' },
    });
    await runUpgradeProxy(fake.context, PROXY_ADDR, newImpl());
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([
      'hostDeploy:Box',
    ]);
  });
});

/*
 * `deployProxy` (the production entry, not `runDeployProxy`) refuses the
 * dropped positional-overloads shape before it ever builds a toolkit — so
 * this needs no environment or chain fixture: a garbage `args` never reaches
 * `createOperationToolkit`, `resolveEnvironment`, or the record session.
 */
describe('deployProxy — the positional-overloads refusal, ahead of the toolkit', () => {
  it('refuses an options object passed where args belongs, before any environment resolution', async () => {
    await expect(
      deployProxy(
        fakeAbstraction({}),
        { initializer: false } as unknown as readonly unknown[],
      ),
    ).rejects.toBeInstanceOf(OptionsInArgsPositionError);
  });

  it('a real array of constructor args is never mistaken for options', async () => {
    // Past the positional check, `deployProxy` reaches `createOperationToolkit`,
    // which throws its own (unrelated) absent-environment error outside a
    // TronBox context — proving the array was accepted rather than refused
    // by this guard.
    await expect(
      deployProxy(fakeAbstraction({}), [42]),
    ).rejects.not.toBeInstanceOf(OptionsInArgsPositionError);
  });

  it('an array whose single element is a struct carrying option-shaped keys is still an args array, never mistaken for options', async () => {
    // `Array.isArray` short-circuits `assertNoOptionsInArgsPosition` before
    // it ever inspects an element's own keys — so a constructor argument
    // that happens to be an object with a key like `initializer` (a
    // perfectly legitimate struct-shaped constructor argument) is not
    // confused with an options object landing in the wrong position, which
    // only happens when `args` ITSELF is not an array.
    await expect(
      deployProxy(fakeAbstraction({}), [{ initializer: false }]),
    ).rejects.not.toBeInstanceOf(OptionsInArgsPositionError);
  });
});
