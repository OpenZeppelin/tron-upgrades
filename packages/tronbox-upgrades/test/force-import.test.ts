import fs, { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

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
import { pluginOptionDefaults } from '../src/options/defaults';

const RECORD_DIR = mkdtempSync(path.join(os.tmpdir(), 'tron-force-import-'));
const PREVIOUS_MANIFEST_DIR = process.env['MANIFEST_DEFAULT_DIR'];
process.env['MANIFEST_DEFAULT_DIR'] = RECORD_DIR;

afterAll(async () => {
  try {
    if (PREVIOUS_MANIFEST_DIR === undefined) {
      delete process.env['MANIFEST_DEFAULT_DIR'];
    } else {
      process.env['MANIFEST_DEFAULT_DIR'] = PREVIOUS_MANIFEST_DIR;
    }
  } finally {
    await fs.promises.rm(RECORD_DIR, { recursive: true, force: true });
  }
});

/*
 * Adoption (forceImport) over a recording fake. The failure mode here is a
 * SILENT false negative (a wrong recorded baseline validates every later
 * upgrade), so the heart of this file is the on-chain-comparison guard's two
 * arms: the mismatch refusal AND the vacuity refusal — an artifact with no
 * deployedBytecode must refuse, never match everything.
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
  readonly layout?: unknown;
  /** Enables the installed engine and a real manifest behind the recording fake. */
  readonly engineChainId?: string;
  /** Overrides the fake's `validateImplementation` version key (default 'vkey'). */
  readonly versionKey?: string;
}

function abstraction(
  deployedBytecode: string | undefined,
  transactionHash?: string,
): ContractAbstraction {
  return {
    contractName: 'Box',
    abi: [],
    bytecode: '0x60806040',
    deployedBytecode,
    transactionHash,
  } as unknown as ContractAbstraction;
}

function engineProvider(chainId: string, code = CODE) {
  return {
    async send(method: string): Promise<unknown> {
      switch (method) {
        case 'eth_chainId':
          return chainId;
        case 'eth_getCode':
          return code;
        case 'eth_getTransactionByHash':
          return {};
        case 'eth_getTransactionReceipt':
          return { status: '0x1' };
        case 'web3_clientVersion':
          return 'TronBox/Test';
        case 'anvil_metadata':
        case 'hardhat_metadata':
          throw new Error(`${method} is unavailable`);
        default:
          throw new Error(`unexpected engine RPC ${method}`);
      }
    },
  };
}

async function manifestFor(chainId: string) {
  const { Manifest } = await import('@openzeppelin/upgrades-core');
  return new Manifest(Number.parseInt(chainId.slice(2), 16));
}

async function implementationRecord(chainId: string, key = 'vkey') {
  const data = await (await manifestFor(chainId)).read();
  const entry = data.impls[key];
  if (entry === undefined) {
    // Loud, not `undefined`: every caller asserts on a record it expects to
    // exist, and a missing entry failing on property access would report the
    // wrong defect.
    throw new Error(`no implementation entry under version key '${key}'`);
  }
  return entry;
}

async function writeEngineDeployment(
  chainId: string,
  address: string,
  transactionHash: string | undefined,
  layout: unknown,
): Promise<void> {
  const engine = await import('@openzeppelin/upgrades-core');
  await engine.fetchOrDeployGetDeployment(
    { linkedWithoutMetadata: 'vkey' } as never,
    engineProvider(chainId) as never,
    async () =>
      ({
        address,
        txHash: transactionHash,
        layout,
      }) as never,
    {},
    false,
  );
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
    } as never,
    chain: {
      provider: {
        send: async (method: string) => {
          log.push(method);
          return spec.onChainCode ?? CODE;
        },
      },
      read: {
        readBeaconImplementation: async () => {
          log.push('readBeaconImplementation');
          return spec.answersBeaconImplementation
            ? ({ kind: 'implementation', address: toTronHex(canonicalizeAddress(IMPL)) } as never)
            : ({ kind: 'not-a-beacon' } as never);
        },
      },
    } as never,
    proxySlots: async () => {
      log.push('proxySlots');
      if (spec.hasCode === false) {
        return { kind: 'no-code' as const };
      }
      return {
        kind: 'code' as const,
        implementation: spec.implementationSlot ?? null,
        admin: spec.adminSlot ?? null,
        beacon: spec.beaconSlot ?? null,
      };
    },
    contractAt: async (_a: never, address: string) =>
      ({ address, events: {} }) as never,
    async validateImplementation(name: string) {
      log.push(`validate:${name}`);
      return {
        name,
        input: {} as never,
        validations: {},
        version: { linkedWithoutMetadata: spec.versionKey ?? 'vkey' },
        layout: spec.layout ?? { of: name },
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
    fetchOrDeployImplementation: async (
      validated: Parameters<
        OperationToolkit['fetchOrDeployImplementation']
      >[0],
      resolvedOptions: Parameters<
        OperationToolkit['fetchOrDeployImplementation']
      >[1],
      deploy: Parameters<
        OperationToolkit['fetchOrDeployImplementation']
      >[2],
    ) => {
      log.push('fetchOrDeployImplementation');
      if (spec.engineChainId !== undefined) {
        const engine = await import('@openzeppelin/upgrades-core');
        const deployment = await engine.fetchOrDeployGetDeployment(
          validated.version as never,
          engineProvider(spec.engineChainId) as never,
          async () => {
            const writeBack = await deploy();
            return {
              address: writeBack.address,
              txHash: writeBack.transactionHash,
              layout: validated.layout,
            } as never;
          },
          {},
          resolvedOptions.redeployImplementation === 'always',
        );
        return deployment.address;
      }
      const writeBack = await deploy();
      writes.push('impl:vkey');
      return writeBack.address;
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
    // Inert in these fakes (nothing here reaches the engine's own
    // `DeployOpts`), but resolution always produces both, so the fixture
    // carries the resolved defaults rather than a shape production never
    // hands an operation.
    timeout: pluginOptionDefaults.timeout,
    pollingInterval: pluginOptionDefaults.pollingInterval,
    call: undefined,
    engineOptions: {},
  };

  return { context: { toolkit, resolved } as OperationContext, log, writes };
}

const TRANSPARENT: Spec = {
  implementationSlot: toTronHex(canonicalizeAddress(IMPL)),
  adminSlot: toTronHex(canonicalizeAddress(ADDR)),
};

describe('the code check comes first, and no-code refuses by name', () => {
  it('refuses before any slot read', async () => {
    const fake = buildFake({ hasCode: false });
    const failure = await runForceImport(fake.context, ADDR, abstraction(CODE)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(NothingToAdoptError);
    expect((failure as Error).message).toContain('forceImport');
    expect(fake.log).toEqual(['proxySlots']);
  });
});

describe('classification and the kind gate', () => {
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

describe('nothing records without the on-chain comparison passing', () => {
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

describe('replay preserves the baseline, and adoption sends nothing', () => {
  it('an identical replay writes no second proxy record (scenario 7)', async () => {
    const fake = buildFake({ ...TRANSPARENT, existingProxyKind: 'transparent' });
    await runForceImport(fake.context, ADDR, abstraction(CODE));
    // The engine reuses the implementation record without appending a proxy record.
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
      expect(fake.log).toContain('fetchOrDeployImplementation');
      for (const banned of ['queue', 'hostDeploy', 'sendUpgradeCall', 'confirm', 'requireDeployer']) {
        expect(fake.log).not.toContain(banned);
      }
    }
  });
});

describe('adoption delegates implementation records to the engine', () => {
  it('writes the same implementation entry as an engine-routed deployment', async () => {
    const deployedChain = '0x7f1701';
    const adoptedChain = '0x7f1702';
    const address = canonicalizeAddress(ADDR);
    const transactionHash = `0x${'17'.repeat(32)}`;
    const layout = { of: 'Box' };

    await writeEngineDeployment(
      deployedChain,
      address,
      transactionHash,
      layout,
    );
    const adopted = buildFake({ engineChainId: adoptedChain });
    await runForceImport(
      adopted.context,
      address,
      abstraction(CODE, transactionHash),
    );

    expect(JSON.stringify(await implementationRecord(adoptedChain))).toBe(
      JSON.stringify(await implementationRecord(deployedChain)),
    );
  });

  it('replay leaves the record SEMANTICALLY unchanged: same primary address, same layout, no new addresses', async () => {
    // Byte-identity was the old property, and it was a property of merge-off
    // — the mode whose clash check breaks the double-import path (review
    // r3787536670). Merge-on may rewrite the entry (e.g. materialize
    // `allAddresses`); what an exact replay must never do is CHANGE what the
    // record says: the primary address, the layout, and the set of known
    // addresses.
    const chainId = '0x7f1703';
    const fake = buildFake({ engineChainId: chainId });

    await runForceImport(fake.context, ADDR, abstraction(CODE));
    const before = await implementationRecord(chainId);
    await runForceImport(fake.context, ADDR, abstraction(CODE));
    const after = await implementationRecord(chainId);

    expect(after.address).toBe(before.address);
    expect(after.layout).toEqual(before.layout);
    expect(new Set(after.allAddresses ?? [after.address])).toEqual(
      new Set(before.allAddresses ?? [before.address]),
    );
  });

  it('unions a second address for the same version into allAddresses', async () => {
    const chainId = '0x7f1704';
    const fake = buildFake({ engineChainId: chainId });
    const first = canonicalizeAddress(ADDR);
    const second = canonicalizeAddress(IMPL);

    await runForceImport(fake.context, first, abstraction(CODE));
    await runForceImport(fake.context, second, abstraction(CODE));

    expect(await implementationRecord(chainId)).toEqual({
      address: first,
      layout: { of: 'Box' },
      allAddresses: [first, second],
    });
  });

  it('preserves the recorded layout when another address has the same version', async () => {
    const chainId = '0x7f1705';
    const first = canonicalizeAddress(ADDR);
    const second = canonicalizeAddress(IMPL);

    await runForceImport(
      buildFake({ engineChainId: chainId, layout: { of: 'baseline' } }).context,
      first,
      abstraction(CODE),
    );
    await runForceImport(
      buildFake({ engineChainId: chainId, layout: { of: 'challenger' } }).context,
      second,
      abstraction(CODE),
    );

    expect(await implementationRecord(chainId)).toEqual({
      address: first,
      layout: { of: 'baseline' },
      allAddresses: [first, second],
    });
  });

  it('a second import of the same address under a different version key completes — no raw engine clash (review r3787536670)', async () => {
    // First try omits the constructor args (wrong version key), second run
    // corrects them: the user's ordinary error-fixing path. Constructor args
    // feed getVersion's linkedWithoutMetadata, so the corrected run arrives
    // under a SECOND key with the SAME address — exactly the shape merge-off's
    // checkForAddressClash refused with the engine's raw clash error.
    const chainId = '0x7f1706';
    const first = buildFake({ engineChainId: chainId });
    await runForceImport(first.context, ADDR, abstraction(CODE));

    const corrected = buildFake({ engineChainId: chainId, versionKey: 'vkey-corrected' });
    await runForceImport(corrected.context, ADDR, abstraction(CODE));

    // Both entries exist, both name the same address AND the same layout —
    // the harmless state Eric's comment describes (a lookup by either key
    // answers the same thing), now representable instead of refused.
    const first_ = await implementationRecord(chainId);
    const second = await implementationRecord(chainId, 'vkey-corrected');
    expect(first_.address).toBe(canonicalizeAddress(ADDR));
    expect(second.address).toBe(canonicalizeAddress(ADDR));
    expect(second.layout).toEqual(first_.layout);
  });
});
