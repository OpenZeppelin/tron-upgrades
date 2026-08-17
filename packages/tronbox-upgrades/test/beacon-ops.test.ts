import { describe, expect, it } from 'vitest';

import {
  deployBeaconProxy,
  runDeployBeacon,
  runDeployBeaconProxy,
  runUpgradeBeacon,
} from '../src/beacon';
import { NothingToAdoptError } from '../src/adopt/errors';
import {
  BeaconInitialOwnerRequiredError,
  EmptyInitializerRefusedError,
  OptionsInArgsPositionError,
  UpgradeVerificationFailedError,
} from '../src/proxy/errors';
import {
  assertNoCheatcodeCollision,
  CheatcodeSlotCollisionError,
} from '../src/deploy';
import type {
  OperationContext,
  OperationToolkit,
  ResolvedForProxyOps,
} from '../src/proxy/toolkit';
import { canonicalizeAddress } from '../src/record';
import { toTronHex } from '../src/record/address';
import type { ContractAbstraction } from '../src/environment';
import { pluginOptionDefaults } from '../src/options/defaults';

/*
 * the beacon operations over a recording fake: rejected-before-spend
 * for an incompatible upgrade, the beacon-answers assertion by name, the
 * beacon-kind record, and the post-upgrade verification on the beacon itself.
 */

const BEACON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const IMPL = '0xabCDEF1234567890ABcDEF1234567890aBCDeF12';
const NEW_IMPL = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

interface Spec {
  readonly beaconAnswers?: boolean;
  readonly incompatible?: boolean;
  /** What the beacon answers after the upgrade call. */
  readonly observedAfterUpgrade?: string;
  /** The implementation's constructor args — the cheatcode-guard tests override this. */
  readonly constructorArgs?: readonly unknown[];
  /** `resolveSender` answers `'unconfigured'` instead of a resolved address. */
  readonly unconfiguredSender?: boolean;
  /** Overrides `resolved.initialOwner` (default: unset). */
  readonly initialOwner?: string;
  /** Overrides `resolved.initializer` (default: unset). */
  readonly initializer?: string | false;
}

const ABI = [
  {
    type: 'function',
    name: 'initialize',
    inputs: [{ name: 'value', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
];

function abstraction(name: string): ContractAbstraction {
  return {
    contractName: name,
    abi: ABI,
    bytecode: '0x60806040',
  } as unknown as ContractAbstraction;
}

function buildFake(spec: Spec = {}) {
  const log: string[] = [];
  let beaconReads = 0;

  const toolkit = {
    network: {} as never,
    artifacts: {} as never,
    channel: {
      warn: () => undefined,
      note: () => undefined,
      degraded: (note: never) => note,
      recorded: [],
      origin: 'deployer',
      describe: () => 'fake',
    } as never,
    session: {} as never,
    chain: {
      read: {
        readBeaconImplementation: async () => {
          log.push('readBeaconImplementation');
          beaconReads += 1;
          if (spec.beaconAnswers === false) {
            return { kind: 'not-a-beacon' } as never;
          }
          const answer =
            beaconReads > 1 && spec.observedAfterUpgrade !== undefined
              ? spec.observedAfterUpgrade
              : toTronHex(canonicalizeAddress(beaconReads > 1 ? NEW_IMPL : IMPL));
          return { kind: 'implementation', address: answer } as never;
        },
      },
    } as never,
    contractAt: async (_a: never, address: string) =>
      ({ address, events: {} }) as never,
    validateImplementation: async (name: string, resolvedOptions: { kind?: string }) => {
      log.push(`validate:${name}:${resolvedOptions.kind}`);
      return {
        name,
        input: {} as never,
        validations: {},
        version: {},
        layout: {},
        encodedArgs: '0x',
      };
    },
    requireDeployer: () => {
      log.push('requireDeployer');
      return {} as never;
    },
    queue: (_h: never, step: () => unknown) => {
      log.push('queue');
      return Promise.resolve(step());
    },
    priorDeployedAddress: () => null,
    replayVerdicts: () => [],
    resolveSender: () =>
      spec.unconfiguredSender
        ? { kind: 'unconfigured' as const }
        : { kind: 'resolved' as const, address: canonicalizeAddress(IMPL) },
    signerOf: async () => null,
    proxyArtifact: (name: string) => {
      log.push(`proxyArtifact:${name}`);
      return { contractName: name } as never;
    },
    looksLikeProxyAdmin: async () => false,
    hashWithoutMetadata: (b: string) => b,
    proxySlots: async () => {
      throw new Error('proxySlots is not part of the beacon paths');
    },
    callThroughFacade: async (request: { at: string; method: string }) => {
      log.push(`callThroughFacade:${request.method}`);
      return { address: request.at, transactionHash: 'ff'.repeat(32) };
    },
    ownerOf: async () => null,
    inferKind: async () => 'uups' as const,
    fetchOrDeployImplementation: async (
      _v: never,
      _r: never,
      deploy: () => Promise<unknown>,
    ) => {
      log.push('fetchOrDeployImplementation');
      await deploy();
      return toTronHex(canonicalizeAddress(NEW_IMPL));
    },
    hostDeploy: async (
      target: { contractName?: unknown },
      args: readonly unknown[],
    ) => {
      // The real choke-point guard: this fixture must refuse exactly what
      // the production `hostDeploy` refuses, so the tests below pin the
      // choke point itself rather than a fake's approximation of it.
      assertNoCheatcodeCollision(args);
      log.push(`hostDeploy:${String(target.contractName)}`);
      return {
        address: toTronHex(canonicalizeAddress(BEACON)),
        transactionHash: 'aa'.repeat(32),
      };
    },
    confirm: async (transactionHash: string) => {
      log.push('confirm');
      return { kind: 'confirmed-successful' as const, transactionHash, receipt: {} };
    },
    processProxyKind: async () => 'transparent' as const,
    storedLayoutFor: async (address: string) => {
      log.push(`storedLayoutFor:${address.slice(0, 6)}`);
      return {};
    },
    assertStorageCompatible: async () => {
      log.push('assertStorageCompatible');
      if (spec.incompatible) {
        throw new Error('Storage layout is incompatible: delete of value');
      }
    },
    sendUpgradeCall: async () => ({ address: '', transactionHash: '' }),
    recordProxy: async (address: string, kind: string) => {
      log.push(`recordProxy:${kind}`);
    },
  } as unknown as OperationToolkit;

  const resolved: ResolvedForProxyOps = {
    kind: undefined,
    initializer: spec.initializer,
    constructorArgs: spec.constructorArgs ?? [],
    redeployImplementation: 'onchange',
    unsafeAllowLinkedLibraries: false,
    unsafeSkipProxyAdminCheck: false,
    initialOwner: spec.initialOwner,
    // Inert in these fakes (nothing here reaches the engine's own
    // `DeployOpts`), but resolution always produces both, so the fixture
    // carries the resolved defaults rather than a shape production never
    // hands an operation.
    timeout: pluginOptionDefaults.timeout,
    pollingInterval: pluginOptionDefaults.pollingInterval,
    call: undefined,
    engineOptions: {},
  };

  return { context: { toolkit, resolved } as OperationContext, log };
}

describe('deployBeacon', () => {
  it('validates under the beacon kind and deploys UpgradeableBeacon in one queued step', async () => {
    const fake = buildFake();
    const result = await runDeployBeacon(fake.context, abstraction('Box'));
    expect(fake.log).toContain('validate:Box:beacon');
    expect(fake.log.filter(e => e === 'queue')).toHaveLength(1);
    expect(fake.log).toContain('hostDeploy:UpgradeableBeacon');
    expect((result as { transaction?: { hash: string } }).transaction?.hash).toBe(
      'aa'.repeat(32),
    );
  });

  it('an unconfigured sender with no initialOwner refuses by name, before the queue', async () => {
    // No `initialOwner` and no configured `from`: the plugin cannot derive an
    // owner, and passing `null` through to the host crashes on one installed
    // minor and produces an unusable deploy on the other (verified in
    // src/deploy/errors.ts's BeaconInitialOwnerRequiredError doc comment).
    const fake = buildFake({ unconfiguredSender: true });
    await expect(
      runDeployBeacon(fake.context, abstraction('Box')),
    ).rejects.toBeInstanceOf(BeaconInitialOwnerRequiredError);
    expect(fake.log).not.toContain('queue');
    expect(fake.log.some(e => e.startsWith('hostDeploy:'))).toBe(false);
  });

  it('an unconfigured sender WITH an explicit initialOwner deploys normally', async () => {
    const fake = buildFake({ unconfiguredSender: true, initialOwner: IMPL });
    const result = await runDeployBeacon(fake.context, abstraction('Box'));
    expect(fake.log).toContain('hostDeploy:UpgradeableBeacon');
    expect((result as { transaction?: { hash: string } }).transaction?.hash).toBe(
      'aa'.repeat(32),
    );
  });

  it('the cheatcode-slot shape refuses through hostDeploy — the beacon itself never deploys', async () => {
    const fake = buildFake({ constructorArgs: [1, { overwrite: false }] });
    await expect(
      runDeployBeacon(fake.context, abstraction('Box')),
    ).rejects.toBeInstanceOf(CheatcodeSlotCollisionError);
    // No hostDeploy call completes at all — not the implementation's, and
    // not the beacon's own, which never runs because the implementation
    // deploy callback throws before returning.
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([]);
    expect(fake.log).not.toContain('confirm');
  });
});

describe('deployBeaconProxy', () => {
  it('a target that does not answer implementation() refuses by name, before the queue', async () => {
    const fake = buildFake({ beaconAnswers: false });
    await expect(
      runDeployBeaconProxy(fake.context, BEACON, abstraction('Box'), [42]),
    ).rejects.toBeInstanceOf(NothingToAdoptError);
    expect(fake.log).not.toContain('queue');
  });

  it('records the proxy under the beacon kind', async () => {
    const fake = buildFake();
    await runDeployBeaconProxy(fake.context, BEACON, abstraction('Box'), [42]);
    expect(fake.log).toContain('recordProxy:beacon');
    expect(fake.log).toContain('hostDeploy:BeaconProxy');
  });

  it('initializer:false is refused by name — the same class as deployProxy, not a beacon-proxy exemption', async () => {
    // The same-input-same-class proof for the beacon path: `encodeInitializer`
    // is the one choke point `deployProxy` and `deployBeaconProxy` both
    // encode their initializer through, and it refuses `initializer: false`
    // identically regardless of kind — verified here for `'beacon'` directly,
    // where it was previously untested. `EmptyInitializerRefusedError`'s own
    // message no longer suggests "use a beacon proxy" as an escape from this
    // exact refusal (see the class's doc comment).
    const fake = buildFake({ initializer: false });
    await expect(
      runDeployBeaconProxy(fake.context, BEACON, abstraction('Box'), [42]),
    ).rejects.toBeInstanceOf(EmptyInitializerRefusedError);
    expect(fake.log).not.toContain('queue');
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([]);
  });
});

describe('upgradeBeacon', () => {
  it('an incompatible upgrade is rejected before any transaction (scenario 2)', async () => {
    const fake = buildFake({ incompatible: true });
    await expect(
      runUpgradeBeacon(fake.context, BEACON, abstraction('BoxV2')),
    ).rejects.toThrow('incompatible');
    expect(fake.log).not.toContain('queue');
    expect(fake.log.some(e => e.startsWith('hostDeploy'))).toBe(false);
    // And the baseline came from the beacon's own chain-read implementation.
    expect(
      fake.log.some(e =>
        e.startsWith(
          `storedLayoutFor:${toTronHex(canonicalizeAddress(IMPL)).slice(0, 6)}`,
        ),
      ),
    ).toBe(true);
  });

  it('upgrades through the UpgradeableBeacon facade and verifies the beacon re-read', async () => {
    const fake = buildFake();
    const result = await runUpgradeBeacon(fake.context, BEACON, abstraction('BoxV2'));
    expect(fake.log).toContain('callThroughFacade:upgradeTo');
    // The verify read is the SECOND beacon read, after confirm.
    expect(fake.log.indexOf('confirm')).toBeLessThan(
      fake.log.lastIndexOf('readBeaconImplementation'),
    );
    expect(
      canonicalizeAddress((result as { implementation: string }).implementation),
    ).toBe(canonicalizeAddress(NEW_IMPL));
  });

  it('a beacon still answering the old implementation refuses naming both', async () => {
    const fake = buildFake({
      observedAfterUpgrade: toTronHex(canonicalizeAddress(IMPL)),
    });
    await expect(
      runUpgradeBeacon(fake.context, BEACON, abstraction('BoxV2')),
    ).rejects.toBeInstanceOf(UpgradeVerificationFailedError);
  });

  it('the cheatcode-slot shape refuses through hostDeploy — no upgrade call is sent', async () => {
    const fake = buildFake({ constructorArgs: [1, { overwrite: false }] });
    await expect(
      runUpgradeBeacon(fake.context, BEACON, abstraction('BoxV2')),
    ).rejects.toBeInstanceOf(CheatcodeSlotCollisionError);
    expect(fake.log.filter(e => e.startsWith('hostDeploy:'))).toEqual([]);
    expect(fake.log).not.toContain('confirm');
    expect(fake.log.some(e => e.startsWith('callThroughFacade'))).toBe(false);
  });
});

/*
 * `deployBeaconProxy` (the production entry) refuses the dropped
 * positional-overloads shape before it ever builds a toolkit — same guard,
 * same reasoning as `deployProxy`'s own (`test/proxy-operations.test.ts`).
 */
describe('deployBeaconProxy — the positional-overloads refusal, ahead of the toolkit', () => {
  it('refuses an options object passed where args belongs, before any environment resolution', async () => {
    await expect(
      deployBeaconProxy(
        BEACON,
        abstraction('Box'),
        { initializer: false } as unknown as readonly unknown[],
      ),
    ).rejects.toBeInstanceOf(OptionsInArgsPositionError);
  });
});
