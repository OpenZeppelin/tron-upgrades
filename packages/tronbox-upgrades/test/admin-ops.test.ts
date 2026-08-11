import { describe, expect, it } from 'vitest';

import { runTransferProxyAdminOwnership } from '../src/admin';
import {
  AuthorityAlreadyTransferredError,
  AuthorityVerificationFailedError,
} from '../src/admin/errors';
import { NotTransparentProxyError } from '../src/proxy/errors';
import type {
  OperationContext,
  OperationToolkit,
  ResolvedForProxyOps,
} from '../src/proxy/toolkit';
import { canonicalizeAddress, toBase58 } from '../src/record';
import { toTronHex } from '../src/record/address';
import { zeroChainAddress } from '../src/chain';

/*
 * the admin operation — the authority transfer over a recording fake.
 * Irreversibility is the whole risk, so the file's center is the pre-read's
 * negative space (nothing sends when the pre-read already answers) and the
 * post-transfer verify (success is the chain's answer, never the receipt's).
 */

const PROXY = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const ADMIN = '0xabCDEF1234567890ABcDEF1234567890aBCDeF12';
const NEW_OWNER = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const SENDER = '0x2222222222222222222222222222222222222222';

interface Spec {
  readonly adminSlot?: string;
  /** owner() answers, in call order; reused last value when exhausted. */
  readonly owners?: ReadonlyArray<string | null>;
  readonly senderAddress?: string | null;
}

function buildFake(spec: Spec = {}) {
  const log: string[] = [];
  let ownerReads = 0;

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
    chain: { read: {} } as never,
    proxySlots: async () => {
      log.push('proxySlots');
      const admin =
        spec.adminSlot === zeroChainAddress
          ? null
          : (spec.adminSlot ?? toTronHex(canonicalizeAddress(ADMIN)));
      return { kind: 'code' as const, implementation: null, admin, beacon: null };
    },
    contractAt: async () => ({}) as never,
    validateImplementation: async () => {
      throw new Error('not used here');
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
    resolveSender: () => {
      log.push('resolveSender');
      return spec.senderAddress === null
        ? { kind: 'unconfigured' as const }
        : {
            kind: 'resolved' as const,
            address: canonicalizeAddress(spec.senderAddress ?? SENDER),
          };
    },
    signerOf: async () => null,
    proxyArtifact: () => ({}) as never,
    looksLikeProxyAdmin: async () => false,
    hashWithoutMetadata: (b: string) => b,
    callThroughFacade: async (request: { at: string; method: string }) => {
      log.push(`callThroughFacade:${request.method}`);
      return { address: request.at, transactionHash: 'ee'.repeat(32) };
    },
    ownerOf: async () => {
      log.push('ownerOf');
      const owners = spec.owners ?? [null];
      const value = owners[Math.min(ownerReads, owners.length - 1)];
      ownerReads += 1;
      return value === null || value === undefined
        ? null
        : canonicalizeAddress(value);
    },
    inferKind: async () => 'uups' as const,
    fetchOrDeployImplementation: async () => '',
    hostDeploy: async () => ({ address: '', transactionHash: '' }),
    confirm: async (transactionHash: string) => {
      log.push('confirm');
      return { kind: 'confirmed-successful' as const, transactionHash, receipt: {} };
    },
    processProxyKind: async () => 'transparent' as const,
    storedLayoutFor: async () => ({}),
    assertStorageCompatible: async () => undefined,
    sendUpgradeCall: async () => ({ address: '', transactionHash: '' }),
    recordProxy: async () => undefined,
  } as unknown as OperationToolkit;

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

  return { context: { toolkit, resolved } as OperationContext, log };
}

describe('a zero admin slot refuses before any send', () => {
  it('refuses by name with nothing sent', async () => {
    const fake = buildFake({ adminSlot: zeroChainAddress });
    await expect(
      runTransferProxyAdminOwnership(fake.context, PROXY, NEW_OWNER),
    ).rejects.toBeInstanceOf(NotTransparentProxyError);
    expect(fake.log).toEqual(['proxySlots']);
  });
});

describe('the pre-read answers, nothing sends', () => {
  it('already the target: a declared no-op naming the holder — across encodings', async () => {
    const fake = buildFake({ owners: [toBase58(canonicalizeAddress(NEW_OWNER))] });
    const result = await runTransferProxyAdminOwnership(
      fake.context,
      PROXY,
      toTronHex(canonicalizeAddress(NEW_OWNER)),
    );
    expect((result as { alreadyHeld?: boolean }).alreadyHeld).toBe(true);
    expect(fake.log).not.toContain('queue');
    expect(fake.log.some(e => e.startsWith('callThroughFacade'))).toBe(false);
  });

  it('a foreign holder: refusal naming it, never an opaque revert', async () => {
    const other = '0x1111111111111111111111111111111111111111';
    const fake = buildFake({ owners: [other], senderAddress: SENDER });
    let caught: AuthorityAlreadyTransferredError | undefined;
    try {
      await runTransferProxyAdminOwnership(fake.context, PROXY, ADMIN);
    } catch (error) {
      caught = error as AuthorityAlreadyTransferredError;
    }
    expect(caught).toBeInstanceOf(AuthorityAlreadyTransferredError);
    expect(caught?.currentHolder).toBe(canonicalizeAddress(other));
    expect(fake.log).not.toContain('queue');
  });
});

/*
 * The foreign-holder refusal (`src/admin/index.ts` ~:69-79) fires only when
 * `currentOwner !== null` AND `sender.kind === 'resolved'`. Both conditions
 * disarm it independently, and today's disposition for either disarmed state
 * is the same: nothing refuses pre-spend, the doomed `transferOwnership` IS
 * sent, and the failure surfaces post-hoc — here, through the verify re-read,
 * because this fake's `confirm` always answers `'confirmed-successful'` and
 * its `ownerOf` never reports the sender as having become the holder. Pinned
 * as today's behaviour, not endorsed: a pre-spend refusal in either disarmed
 * state is a stricter alternative and a deliberate future decision, not
 * implemented here.
 */
describe('the foreign-holder refusal disarms when the sender is unconfigured or owner() never answers', () => {
  it('unconfigured sender + a foreign holder: the spend is sent anyway and fails post-hoc', async () => {
    const other = '0x1111111111111111111111111111111111111111';
    const fake = buildFake({ owners: [other], senderAddress: null });
    let caught: AuthorityVerificationFailedError | undefined;
    try {
      await runTransferProxyAdminOwnership(fake.context, PROXY, NEW_OWNER);
    } catch (error) {
      caught = error as AuthorityVerificationFailedError;
    }
    expect(fake.log).toContain('queue');
    expect(fake.log).toContain('callThroughFacade:transferOwnership');
    expect(caught).toBeInstanceOf(AuthorityVerificationFailedError);
    expect(caught?.observed).toBe(canonicalizeAddress(other));
  });

  it('owner() never answers (currentOwner null): the spend is sent anyway, regardless of the sender, and fails post-hoc the same way', async () => {
    const fake = buildFake({ owners: [null], senderAddress: SENDER });
    let caught: AuthorityVerificationFailedError | undefined;
    try {
      await runTransferProxyAdminOwnership(fake.context, PROXY, NEW_OWNER);
    } catch (error) {
      caught = error as AuthorityVerificationFailedError;
    }
    expect(fake.log).toContain('queue');
    expect(fake.log).toContain('callThroughFacade:transferOwnership');
    expect(caught).toBeInstanceOf(AuthorityVerificationFailedError);
    expect(caught?.observed).toBe('nothing that answers owner()');
  });
});

describe('the transfer path: one queued step, confirm, verify', () => {
  it('sends transferOwnership through the ProxyAdmin facade and verifies the new owner', async () => {
    const fake = buildFake({
      owners: [SENDER, NEW_OWNER],
      senderAddress: SENDER,
    });
    const result = await runTransferProxyAdminOwnership(fake.context, PROXY, NEW_OWNER);
    expect(fake.log.filter(e => e === 'queue')).toHaveLength(1);
    expect(fake.log).toContain('callThroughFacade:transferOwnership');
    // Confirm precedes the verify read: success is gated twice.
    expect(fake.log.indexOf('confirm')).toBeLessThan(fake.log.lastIndexOf('ownerOf'));
    expect((result as { alreadyHeld?: boolean }).alreadyHeld).toBe(false);
    expect((result as { previousOwner?: string }).previousOwner).toBe(
      canonicalizeAddress(SENDER),
    );
  });

  it('a verify read that does not answer the target refuses naming both', async () => {
    const other = '0x1111111111111111111111111111111111111111';
    const fake = buildFake({
      owners: [SENDER, other],
      senderAddress: SENDER,
    });
    let caught: AuthorityVerificationFailedError | undefined;
    try {
      await runTransferProxyAdminOwnership(fake.context, PROXY, NEW_OWNER);
    } catch (error) {
      caught = error as AuthorityVerificationFailedError;
    }
    expect(caught).toBeInstanceOf(AuthorityVerificationFailedError);
    expect(caught?.expected).toBe(canonicalizeAddress(NEW_OWNER));
    expect(caught?.observed).toBe(canonicalizeAddress(other));
  });
});
