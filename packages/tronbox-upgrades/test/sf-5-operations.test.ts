import { describe, expect, it } from 'vitest';

import { runDeployProxy } from '../src/proxy/deploy-proxy';
import { runUpgradeProxy } from '../src/proxy/upgrade-proxy';
import type {
  OperationContext,
  OperationToolkit,
  ResolvedForProxyOps,
} from '../src/proxy/toolkit';
import {
  BeaconProxyRefusedError,
  NotTransparentProxyError,
  StaleProxyRecordError,
  UpgradeVerificationFailedError,
} from '../src/proxy/errors';
import { CheatcodeSlotCollisionError, DeployerAbsentError } from '../src/deploy';
import { canonicalizeAddress, toBase58 } from '../src/record';
import { toTronHex } from '../src/record/address';
import { zeroChainAddress } from '../src/chain';
import type { ContractAbstraction } from '../src/environment';

/*
 * SF-5 — the ordering invariants, pinned on a recording fake whose call log IS
 * the assertion. Outcome-only tests cannot see order, and order is where this
 * sub-feature's silent failures live: validation before spend (INV-1), authority before
 * the implementation deploys (INV-2), verification after the upgrade call
 * (INV-3), the beacon check before kind processing (INV-4), one queued step
 * (INV-13), and refusals that never leave a half-queued operation behind
 * (INV-16, INV-18).
 */

const IMPL_OWNER = '0xabCDEF1234567890ABcDEF1234567890aBCDeF12';
const PROXY_ADDR = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const NEW_IMPL = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const TX_HASH = 'aa'.repeat(32);

interface FakeSpec {
  readonly priorAddress?: string | null;
  readonly verdictStatus?: 'authoritative' | 'no-code-at-address';
  readonly noDeployer?: boolean;
  readonly wildcard?: boolean;
  readonly beacon?: string;
  readonly admin?: string;
  readonly interfaceVersion?: string | undefined;
  readonly currentImplementation?: string;
  readonly observedAfterUpgrade?: string;
  readonly existingProxyRecord?: boolean;
  readonly constructorArgs?: readonly unknown[];
}

interface Fake {
  readonly context: OperationContext;
  readonly log: readonly string[];
  readonly notes: readonly string[];
  readonly warns: readonly string[];
}

const RESULT_ABI = [
  {
    type: 'function',
    name: 'initialize',
    inputs: [{ name: 'value', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
];

function fakeAbstraction(spec: FakeSpec): ContractAbstraction {
  return {
    contractName: 'Box',
    abi: RESULT_ABI,
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

  const writeBack = { address: toTronHex(canonicalizeAddress(PROXY_ADDR)), transactionHash: TX_HASH };
  const currentImpl =
    spec.currentImplementation ?? toTronHex(canonicalizeAddress(IMPL_OWNER));

  const verdicts =
    spec.priorAddress != null
      ? [
          {
            address: canonicalizeAddress(spec.priorAddress),
            status: spec.verdictStatus ?? 'authoritative',
            kindProvenance: 'recorded',
            kind: 'transparent',
          } as never,
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
      getImplRecord: async () => undefined,
      addProxyRecord: async () => undefined,
      recordCount: async () => 0,
      manifestFile: '/proj/.openzeppelin/m.json',
      fingerprintFile: '/proj/.openzeppelin/m.instance.json',
    } as never,
    chain: {
      read: {
        readImplementationAddress: async () => {
          // The post-upgrade verification read (INV-3).
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

    contractAt: async (_abstraction, address) => {
      log.push('contractAt');
      return { address } as never;
    },

    async validateImplementation(name) {
      log.push('validate');
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
        throw new DeployerAbsentError('tronbox test');
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
      return { kind: 'resolved', address: canonicalizeAddress(IMPL_OWNER) };
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
      return false;
    },

    async fetchOrDeployImplementation(_validated, _resolved, deploy) {
      log.push('fetchOrDeployImplementation');
      await deploy();
      return toTronHex(canonicalizeAddress(NEW_IMPL));
    },

    async hostDeploy(abstraction) {
      log.push(
        `hostDeploy:${String((abstraction as { contractName?: unknown }).contractName)}`,
      );
      return writeBack;
    },

    async confirm(transactionHash) {
      log.push('confirm');
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
      return 'transparent';
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
      return writeBack;
    },

    recordProxy: async () => {
      log.push('recordProxy');
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
    call: undefined,
    engineOptions: {},
  };

  return { context: { toolkit, resolved }, log, notes, warns };
}

// ---------------------------------------------------------------------------
// deployProxy
// ---------------------------------------------------------------------------

describe('deployProxy — the order is the contract', () => {
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

  it('INV-18: the missing deployer refuses AFTER validation ran', async () => {
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

  it('INV-9: an authoritative prior reuses — zero queue, zero deploys, zero appends', async () => {
    const fake = buildFake({ priorAddress: PROXY_ADDR });
    const result = await runDeployProxy(
      fake.context,
      fakeAbstraction({ priorAddress: PROXY_ADDR }),
      [42],
    );
    expect(result.address).toBe(canonicalizeAddress(PROXY_ADDR));
    expect(fake.log).not.toContain('queue');
    expect(fake.log.some(entry => entry.startsWith('hostDeploy:'))).toBe(false);
    expect(fake.log).not.toContain('recordProxy');
  });

  it('INV-9: a stale prior refuses by name, before the queue', async () => {
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

  it('INV-16: the cheatcode-slot shape refuses before anything queues', async () => {
    const fake = buildFake({ constructorArgs: [1, { overwrite: false }] });
    await expect(
      runDeployProxy(fake.context, fakeAbstraction({}), [42]),
    ).rejects.toBeInstanceOf(CheatcodeSlotCollisionError);
    expect(fake.log).not.toContain('queue');
  });

  it('INV-17: the wildcard statement is emitted, naming the real chain id', async () => {
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
});

// ---------------------------------------------------------------------------
// upgradeProxy
// ---------------------------------------------------------------------------

describe('upgradeProxy — the measured orderings, pinned on the log', () => {
  const newImpl = () => fakeAbstraction({});

  it('INV-4: the beacon check runs before kind processing, and a beacon refuses', async () => {
    const beacon = toTronHex(canonicalizeAddress(NEW_IMPL));
    const fake = buildFake({ beacon });
    await expect(
      runUpgradeProxy(fake.context, PROXY_ADDR, newImpl()),
    ).rejects.toBeInstanceOf(BeaconProxyRefusedError);
    expect(fake.log).toContain('proxySlots');
    expect(fake.log).not.toContain('processProxyKind');
    expect(fake.log).not.toContain('queue');
  });

  it('INV-2: authority and dispatch are planned BEFORE the implementation deploys', async () => {
    const fake = buildFake();
    await runUpgradeProxy(fake.context, PROXY_ADDR, newImpl());

    const authority = fake.log.indexOf('proxySlots');
    const probe = fake.log.indexOf('readUpgradeInterfaceVersion');
    const implementationDeploy = fake.log.indexOf('fetchOrDeployImplementation');
    expect(authority).toBeGreaterThanOrEqual(0);
    expect(probe).toBeGreaterThan(authority);
    expect(implementationDeploy).toBeGreaterThan(probe);
  });

  it('INV-3: the slot is re-read after the upgrade call, and a mismatch refuses', async () => {
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

  it('INV-3: verification compares identity, not spelling — a base58 observation of the same address passes', async () => {
    const fake = buildFake({
      observedAfterUpgrade: toBase58(canonicalizeAddress(NEW_IMPL)),
    });
    await expect(
      runUpgradeProxy(fake.context, PROXY_ADDR, newImpl()),
    ).resolves.toBeDefined();
  });

  it('INV-10: already-current is a no-op — no queue, no send, and the result names the implementation', async () => {
    const fake = buildFake({
      priorAddress: NEW_IMPL,
      currentImplementation: toTronHex(canonicalizeAddress(NEW_IMPL)),
    });
    const result = await runUpgradeProxy(
      fake.context,
      PROXY_ADDR,
      fakeAbstraction({ priorAddress: NEW_IMPL }),
    );
    expect(fake.log).not.toContain('queue');
    expect(fake.log.some(entry => entry.startsWith('sendUpgradeCall:'))).toBe(false);
    expect(canonicalizeAddress(result.implementation)).toBe(
      canonicalizeAddress(NEW_IMPL),
    );
  });

  it('INV-15: records only when no record existed', async () => {
    const fresh = buildFake();
    await runUpgradeProxy(fresh.context, PROXY_ADDR, newImpl());
    expect(fresh.log).toContain('recordProxy');

    const recorded = buildFake({ existingProxyRecord: true });
    await runUpgradeProxy(recorded.context, PROXY_ADDR, newImpl());
    expect(recorded.log).not.toContain('recordProxy');
  });

  it('INV-5: a zero admin on the transparent path refuses by name', async () => {
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
});
