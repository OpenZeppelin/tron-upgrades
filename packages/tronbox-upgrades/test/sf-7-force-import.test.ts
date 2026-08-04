import { describe, expect, it } from 'vitest';

import { runForceImport } from '../src/adopt';
import {
  AdoptionKindMismatchError,
  AdoptionVerificationFailedError,
  NothingToAdoptError,
} from '../src/adopt/errors';
import type {
  OperationContext,
  OperationToolkit,
  ResolvedForProxyOps,
} from '../src/proxy/toolkit';
import { canonicalizeAddress } from '../src/record';
import { toTronHex } from '../src/record/address';
import { zeroChainAddress } from '../src/chain';
import type { ContractAbstraction } from '../src/environment';

/*
 * SF-7 — adoption over a recording fake. The failure mode here is a SILENT
 * false negative (a wrong recorded baseline validates every later upgrade), so the
 * heart of this file is INV-1's two arms: the mismatch refusal AND the
 * vacuity refusal — an artifact with no deployedBytecode must refuse, never
 * match everything.
 */

const ADDR = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const IMPL = '0xabCDEF1234567890ABcDEF1234567890aBCDeF12';
const CODE = '0x6080604052001122';

interface Spec {
  readonly hasCode?: boolean;
  readonly implementationSlot?: string;
  readonly adminSlot?: string;
  readonly beaconSlot?: string;
  readonly answersBeaconImplementation?: boolean;
  readonly onChainCode?: string;
  readonly existingProxyKind?: 'transparent' | 'uups';
  readonly kind?: 'transparent' | 'uups' | 'beacon';
}

function abstraction(deployedBytecode: string | undefined): ContractAbstraction {
  return {
    contractName: 'Box',
    abi: [],
    bytecode: '0x60806040',
    deployedBytecode,
  } as unknown as ContractAbstraction;
}

function buildFake(spec: Spec = {}) {
  const log: string[] = [];
  const writes: string[] = [];

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
    session: {
      getProxyRecord: async () => {
        log.push('getProxyRecord');
        return spec.existingProxyKind !== undefined
          ? ({ kind: spec.existingProxyKind } as never)
          : undefined;
      },
      addImplRecord: async (record: { versionKey: string }) => {
        writes.push(`impl:${record.versionKey}`);
      },
    } as never,
    chain: {
      provider: {
        send: async (method: string) => {
          log.push(method);
          return spec.onChainCode ?? CODE;
        },
      },
      read: {
        hasCode: async () => {
          log.push('hasCode');
          return spec.hasCode ?? true;
        },
        readImplementationAddress: async () => {
          log.push('readImplementationAddress');
          return (spec.implementationSlot ?? zeroChainAddress) as never;
        },
        readAdminAddress: async () => {
          log.push('readAdminAddress');
          return (spec.adminSlot ?? zeroChainAddress) as never;
        },
        readBeaconAddress: async () => {
          log.push('readBeaconAddress');
          return (spec.beaconSlot ?? zeroChainAddress) as never;
        },
        readBeaconImplementation: async () => {
          log.push('readBeaconImplementation');
          return spec.answersBeaconImplementation
            ? ({ kind: 'implementation', address: toTronHex(canonicalizeAddress(IMPL)) } as never)
            : ({ kind: 'not-a-beacon' } as never);
        },
      },
    } as never,
    contractAt: async (_a: never, address: string) => ({ address }) as never,
    async validateImplementation(name: string) {
      log.push(`validate:${name}`);
      return {
        name,
        input: {} as never,
        validations: {},
        version: { linkedWithoutMetadata: 'vkey' },
        layout: { of: name },
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
    resolveSender: () => ({ kind: 'unconfigured' as const }),
    signerOf: async () => null,
    proxyArtifact: () => ({}) as never,
    looksLikeProxyAdmin: async () => false,
    hashWithoutMetadata: (bytecode: string) => `H(${bytecode})`,
    callThroughFacade: async (request: { at: string }) => {
      log.push('callThroughFacade');
      return { address: request.at, transactionHash: 'ee'.repeat(32) };
    },
    ownerOf: async () => null,
    inferKind: async () => 'uups' as const,
    fetchOrDeployImplementation: async () => {
      log.push('fetchOrDeployImplementation');
      return IMPL;
    },
    hostDeploy: async () => {
      log.push('hostDeploy');
      return { address: IMPL, transactionHash: 'aa'.repeat(32) };
    },
    confirm: async () => {
      log.push('confirm');
      return { kind: 'confirmed-successful' as const, transactionHash: '', receipt: {} };
    },
    processProxyKind: async () => 'transparent' as const,
    storedLayoutFor: async () => ({}),
    assertStorageCompatible: async () => undefined,
    sendUpgradeCall: async () => {
      log.push('sendUpgradeCall');
      return { address: '', transactionHash: '' };
    },
    recordProxy: async (address: string, kind: string) => {
      writes.push(`proxy:${kind}:${address.slice(0, 6)}`);
    },
  } as unknown as OperationToolkit;

  const resolved: ResolvedForProxyOps = {
    kind: spec.kind,
    initializer: undefined,
    constructorArgs: [],
    redeployImplementation: 'onchange',
    unsafeAllowLinkedLibraries: false,
    unsafeSkipProxyAdminCheck: false,
    initialOwner: undefined,
    call: undefined,
    engineOptions: {},
  };

  return { context: { toolkit, resolved } as OperationContext, log, writes };
}

const TRANSPARENT: Spec = {
  implementationSlot: toTronHex(canonicalizeAddress(IMPL)),
  adminSlot: toTronHex(canonicalizeAddress(ADDR)),
};

describe('INV-3: the code check comes first, and no-code refuses by name', () => {
  it('refuses before any slot read', async () => {
    const fake = buildFake({ hasCode: false });
    await expect(
      runForceImport(fake.context, ADDR, abstraction(CODE)),
    ).rejects.toBeInstanceOf(NothingToAdoptError);
    expect(fake.log).toEqual(['hasCode']);
  });
});

describe('classification and the kind gate (INV-2)', () => {
  it('adopts a transparent proxy: proxy record + impl record, kind reported', async () => {
    const fake = buildFake(TRANSPARENT);
    const outcome = await runForceImport(fake.context, ADDR, abstraction(CODE));
    expect((outcome as { kind?: string }).kind).toBe('transparent');
    expect(fake.writes).toEqual([
      `proxy:transparent:${canonicalizeAddress(ADDR).slice(0, 6)}`,
      'impl:vkey',
    ]);
  });

  it('adopts a UUPS proxy when the admin slot is empty', async () => {
    const fake = buildFake({
      implementationSlot: toTronHex(canonicalizeAddress(IMPL)),
    });
    const outcome = await runForceImport(fake.context, ADDR, abstraction(CODE));
    expect((outcome as { kind?: string }).kind).toBe('uups');
  });

  it('adopts a bare beacon under the beacon kind — never as a proxy (scenario 5)', async () => {
    const fake = buildFake({ answersBeaconImplementation: true });
    const outcome = await runForceImport(fake.context, ADDR, abstraction(CODE));
    expect((outcome as { kind?: string }).kind).toBe('beacon');
    // No proxy record for a bare beacon; the impl record carries the baseline.
    expect(fake.writes).toEqual(['impl:vkey']);
  });

  it('adopts a bare implementation and reports that kind (scenario 4)', async () => {
    const fake = buildFake({});
    const outcome = await runForceImport(fake.context, ADDR, abstraction(CODE));
    expect((outcome as { kind?: string }).kind).toBe('implementation');
    expect(fake.writes).toEqual(['impl:vkey']);
  });

  it('refuses a caller kind that contradicts the chain, naming both (scenario 6)', async () => {
    const fake = buildFake({ ...TRANSPARENT, kind: 'uups' });
    let caught: AdoptionKindMismatchError | undefined;
    try {
      await runForceImport(fake.context, ADDR, abstraction(CODE));
    } catch (error) {
      caught = error as AdoptionKindMismatchError;
    }
    expect(caught).toBeInstanceOf(AdoptionKindMismatchError);
    expect(caught?.foundKind).toBe('transparent');
    expect(caught?.expectedKind).toBe('uups');
    expect(fake.writes).toEqual([]);
  });
});

describe('INV-1: nothing records without the on-chain comparison passing', () => {
  it('refuses when the code at the implementation address is not the named contract (scenario 3)', async () => {
    const fake = buildFake({ ...TRANSPARENT, onChainCode: '0xdeadbeef' });
    await expect(
      runForceImport(fake.context, ADDR, abstraction(CODE)),
    ).rejects.toBeInstanceOf(AdoptionVerificationFailedError);
    expect(fake.writes).toEqual([]);
  });

  it('vacuity: an artifact with no deployedBytecode refuses rather than matching everything', async () => {
    for (const empty of [undefined, '', '0x']) {
      const fake = buildFake(TRANSPARENT);
      await expect(
        runForceImport(fake.context, ADDR, abstraction(empty)),
      ).rejects.toBeInstanceOf(AdoptionVerificationFailedError);
      expect(fake.writes).toEqual([]);
    }
  });
});

describe('INV-4 / INV-5: replay preserves the baseline, and adoption sends nothing', () => {
  it('an identical replay writes no second proxy record (scenario 7)', async () => {
    const fake = buildFake({ ...TRANSPARENT, existingProxyKind: 'transparent' });
    await runForceImport(fake.context, ADDR, abstraction(CODE));
    // The impl write remains — its merge semantics keep the baseline — but no
    // proxy record is appended.
    expect(fake.writes).toEqual(['impl:vkey']);
  });

  it('a record under a DIFFERENT kind refuses instead of overwriting', async () => {
    const fake = buildFake({ ...TRANSPARENT, existingProxyKind: 'uups' });
    await expect(
      runForceImport(fake.context, ADDR, abstraction(CODE)),
    ).rejects.toBeInstanceOf(AdoptionKindMismatchError);
    expect(fake.writes).toEqual([]);
  });

  it('no path queues, deploys, or sends', async () => {
    for (const spec of [
      {},
      TRANSPARENT,
      { answersBeaconImplementation: true },
    ] as Spec[]) {
      const fake = buildFake(spec);
      await runForceImport(fake.context, ADDR, abstraction(CODE));
      for (const banned of ['queue', 'hostDeploy', 'sendUpgradeCall', 'confirm', 'requireDeployer', 'fetchOrDeployImplementation']) {
        expect(fake.log).not.toContain(banned);
      }
    }
  });
});
