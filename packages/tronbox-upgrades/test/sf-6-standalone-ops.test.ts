import { describe, expect, it } from 'vitest';

import {
  runValidateImplementation,
  runValidateUpgrade,
  runDeployImplementation,
  runPrepareUpgrade,
} from '../src/standalone';
import type {
  OperationContext,
  OperationToolkit,
  ResolvedForProxyOps,
  ValidatedImplementation,
} from '../src/proxy/toolkit';
import { canonicalizeAddress } from '../src/record';
import { toTronHex } from '../src/record/address';
import type { ContractAbstraction } from '../src/environment';

/*
 * SF-6 — the CI surface over a recording fake. The load-bearing property is
 * NEGATIVE space: the validate pair must reach no chain, no record and no
 * queue on any path (INV-1), prepareUpgrade must send nothing to the proxy
 * (INV-4), and the kind-inference rule must read the REFERENCE, never the
 * candidate (INV-3).
 */

const IMPL = '0xabCDEF1234567890ABcDEF1234567890aBCDeF12';
const PROXY = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TX = 'cc'.repeat(32);

interface Spec {
  readonly unsafe?: boolean;
  readonly reuseImplementation?: boolean;
  readonly inferredKind?: 'transparent' | 'uups';
  readonly storedLayoutRefusal?: string;
}

function abstraction(name: string): ContractAbstraction {
  return {
    contractName: name,
    abi: [],
    bytecode: '0x60806040',
    transactionHash: 'dd'.repeat(32),
  } as unknown as ContractAbstraction;
}

function buildFake(spec: Spec = {}) {
  const log: string[] = [];
  const kindsSeen: Array<string | undefined> = [];

  const validated = (name: string): ValidatedImplementation => ({
    name,
    input: {} as never,
    validations: {},
    version: {},
    layout: { of: name },
    encodedArgs: '0x',
  });

  const toolkit: OperationToolkit = {
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
    // The validate pair must never touch these two: proxies that throw ARE the
    // instrument, exactly like the production validate-only stubs.
    session: new Proxy(
      {},
      {
        get: (_t, property) => {
          throw new Error(`session.${String(property)} reached from a validate path`);
        },
      },
    ) as never,
    chain: {
      read: {
        readImplementationAddress: async (address: string) => {
          log.push(`readImplementationAddress:${address.slice(0, 4)}`);
          return toTronHex(canonicalizeAddress(IMPL)) as never;
        },
      },
    } as never,

    contractAt: async (_a, address) => ({ address }) as never,

    async validateImplementation(name, resolvedOptions) {
      log.push(`validate:${name}`);
      kindsSeen.push(resolvedOptions.kind);
      if (spec.unsafe) {
        throw new Error(`${name} is not upgrade-safe:\n- delegatecall`);
      }
      return validated(name);
    },

    requireDeployer() {
      log.push('requireDeployer');
      return {} as never;
    },

    queue: (host, step) => {
      log.push('queue');
      return Promise.resolve(step());
    },

    priorDeployedAddress: () => null,
    replayVerdicts: () => [],
    resolveSender: () => ({ kind: 'unconfigured' }),
    signerOf: async () => null,
    proxyArtifact: () => ({}) as never,
    looksLikeProxyAdmin: async () => false,

    hashWithoutMetadata: (bytecode: string) => bytecode.slice(0, 16),
    proxySlots: async () => {
      throw new Error('proxySlots must not be consulted by this surface');
    },

    callThroughFacade: async (request: { at: string }) => {
      log.push('callThroughFacade');
      return { address: request.at, transactionHash: 'ee'.repeat(32) };
    },
    ownerOf: async () => null,

    async inferKind(reference) {
      log.push(`inferKind:${reference.name}`);
      return spec.inferredKind ?? 'uups';
    },

    async fetchOrDeployImplementation(_validated, _resolved, deploy) {
      log.push('fetchOrDeployImplementation');
      if (!spec.reuseImplementation) {
        await deploy();
      }
      return toTronHex(canonicalizeAddress(IMPL));
    },

    async hostDeploy(target) {
      log.push(
        `hostDeploy:${String((target as { contractName?: unknown }).contractName)}`,
      );
      return { address: toTronHex(canonicalizeAddress(IMPL)), transactionHash: TX };
    },

    async confirm(transactionHash) {
      log.push('confirm');
      return { kind: 'confirmed-successful', transactionHash, receipt: {} };
    },

    async processProxyKind() {
      log.push('processProxyKind');
      return 'transparent';
    },

    async storedLayoutFor(address) {
      log.push('storedLayoutFor');
      if (spec.storedLayoutRefusal !== undefined) {
        throw new Error(spec.storedLayoutRefusal);
      }
      return { of: `stored:${address.slice(0, 6)}` };
    },

    async assertStorageCompatible(currentLayout, candidate) {
      log.push(
        `assertStorageCompatible:${(currentLayout as { of?: string }).of}->${candidate.name}`,
      );
    },

    async sendUpgradeCall() {
      log.push('sendUpgradeCall');
      throw new Error('the proxy must never be touched from this surface');
    },

    recordProxy: async () => {
      log.push('recordProxy');
    },
  };

  const resolved: ResolvedForProxyOps = {
    kind: undefined,
    initializer: undefined,
    constructorArgs: [],
    redeployImplementation: 'onchange',
    unsafeAllowLinkedLibraries: false,
    unsafeSkipProxyAdminCheck: false,
    initialOwner: undefined,
    call: undefined,
    engineOptions: {},
  };

  return { context: { toolkit, resolved } as OperationContext, log, kindsSeen };
}

const CHAIN_OR_STATE = [
  'queue',
  'requireDeployer',
  'fetchOrDeployImplementation',
  'confirm',
  'recordProxy',
  'sendUpgradeCall',
];

describe('INV-1: the validate pair reaches no chain, no record, no queue — pass and refusal alike', () => {
  it('validateImplementation touches nothing transactional on a pass', async () => {
    const fake = buildFake();
    const outcome = await runValidateImplementation(fake.context, abstraction('Box'));
    expect(fake.log).toEqual(['validate:Box']);
    expect(outcome.notes).toEqual([]);
  });

  it('refuses an unsafe implementation with the violations named, and still sends nothing (INV-2)', async () => {
    const fake = buildFake({ unsafe: true });
    await expect(
      runValidateImplementation(fake.context, abstraction('Box')),
    ).rejects.toThrow('not upgrade-safe');
    for (const banned of CHAIN_OR_STATE) {
      expect(fake.log).not.toContain(banned);
    }
  });

  it('validateUpgrade compares the two local layouts and nothing else', async () => {
    const fake = buildFake();
    await runValidateUpgrade(fake.context, abstraction('Box'), abstraction('BoxV2'));
    for (const banned of CHAIN_OR_STATE) {
      expect(fake.log).not.toContain(banned);
    }
    expect(fake.log).toContain('assertStorageCompatible:Box->BoxV2');
  });
});

describe('INV-3: an omitted kind is inferred from the REFERENCE, never the candidate', () => {
  it('validates the candidate under the kind the reference inferred', async () => {
    const fake = buildFake({ inferredKind: 'uups' });
    await runValidateUpgrade(fake.context, abstraction('Box'), abstraction('BoxV2'));
    // The reference validated with the caller's (absent) kind; the candidate
    // validated with the INFERRED one — which is what surfaces a candidate
    // that dropped its upgrade entry point.
    expect(fake.log).toContain('inferKind:Box');
    expect(fake.kindsSeen).toEqual([undefined, 'uups']);
  });

  it('skips inference entirely when the caller supplied a kind', async () => {
    const fake = buildFake();
    const resolved = { ...fake.context.resolved, kind: 'transparent' as const };
    await runValidateUpgrade(
      { ...fake.context, resolved },
      abstraction('Box'),
      abstraction('BoxV2'),
    );
    expect(fake.log.some(entry => entry.startsWith('inferKind'))).toBe(false);
    expect(fake.kindsSeen).toEqual(['transparent', 'transparent']);
  });
});

describe('deployImplementation and prepareUpgrade', () => {
  it('deployImplementation: validate → deployer → one queued step → confirm', async () => {
    const fake = buildFake();
    const result = await runDeployImplementation(fake.context, abstraction('Box'));
    expect(fake.log[0]).toBe('validate:Box');
    expect(fake.log.filter(entry => entry === 'queue')).toHaveLength(1);
    expect(fake.log.indexOf('confirm')).toBeGreaterThan(fake.log.indexOf('queue'));
    expect(result.transaction.hash).toBe(TX);
  });

  it('INV-6: an unchanged implementation is reused — no deploy, no confirm, the recorded identity reported', async () => {
    const fake = buildFake({ reuseImplementation: true });
    const result = await runDeployImplementation(fake.context, abstraction('Box'));
    expect(fake.log.some(entry => entry.startsWith('hostDeploy'))).toBe(false);
    expect(fake.log).not.toContain('confirm');
    expect(result.transaction.hash).toBe('dd'.repeat(32));
  });

  it('INV-4: prepareUpgrade never touches the proxy — the send log holds exactly the implementation deploy', async () => {
    const fake = buildFake();
    await runPrepareUpgrade(fake.context, PROXY, abstraction('BoxV2'));
    expect(fake.log).not.toContain('sendUpgradeCall');
    expect(fake.log).not.toContain('recordProxy');
    expect(
      fake.log.filter(entry => entry.startsWith('hostDeploy')),
    ).toEqual(['hostDeploy:BoxV2']);
    // And the comparison ran against the layout stored FOR the chain-read
    // current implementation, before any spend.
    expect(fake.log.indexOf('storedLayoutFor')).toBeLessThan(
      fake.log.indexOf('queue'),
    );
  });

  it('INV-5: an unregistered reference surfaces the force-import remedy (scenario 3)', async () => {
    const fake = buildFake({
      storedLayoutRefusal:
        'No stored storage layout for the implementation at T… Register the deployment first with forceImport, or upgrade from the plugin that deployed it.',
    });
    await expect(
      runPrepareUpgrade(fake.context, PROXY, abstraction('BoxV2')),
    ).rejects.toThrow('forceImport');
    expect(fake.log).not.toContain('queue');
  });
});
