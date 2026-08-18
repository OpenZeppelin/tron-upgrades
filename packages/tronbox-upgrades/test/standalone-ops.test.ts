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
import {
  assertNoCheatcodeCollision,
  CheatcodeSlotCollisionError,
  TransactionRevertedError,
} from '../src/deploy';
import {
  writeBackBearingArtifact,
  type WriteBackBearing,
} from './helpers/write-back-bearing';
import { pluginOptionDefaults } from '../src/options/defaults';
import { NothingToAdoptError } from '../src/adopt/errors';
import { BeaconProxyRefusedError } from '../src/proxy/errors';

/*
 * The standalone operations — the CI surface over a recording fake. The
 * load-bearing property is NEGATIVE space: the validate pair must reach no
 * chain, no record and no queue on any path, prepareUpgrade must send
 * nothing to the proxy, and the kind-inference rule must read the
 * REFERENCE, never the candidate.
 */

const IMPL = '0xabCDEF1234567890ABcDEF1234567890aBCDeF12';
const PROXY = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TX = 'cc'.repeat(32);

interface Spec {
  readonly unsafe?: boolean;
  readonly reuseImplementation?: boolean;
  readonly inferredKind?: 'transparent' | 'uups';
  readonly storedLayoutRefusal?: string;
  /** The implementation's constructor args — the cheatcode-guard tests override this. */
  readonly constructorArgs?: readonly unknown[];
  /**
   * The verdict the fake's `confirm` resolves with. Defaults to
   * `'confirmed-successful'`; `'reverted'` drives the write-back-undo test
   * through the same shape `confirmTransaction` produces.
   */
  readonly confirmOutcome?: 'confirmed-successful' | 'reverted';
  /** What the referenced proxy's 1967 slots report. Default: a uups proxy. */
  readonly slots?:
    | { readonly kind: 'no-code' }
    | {
        readonly kind: 'code';
        readonly implementation: string | null;
        readonly admin: string | null;
        readonly beacon: string | null;
      };
  /** A caller-supplied kind option, as resolution would carry it. */
  readonly resolvedKind?: 'transparent' | 'uups' | 'beacon';
  /**
   * The proxy's manifest record. Present-but-undefined means unregistered;
   * omitted defaults to a recorded uups proxy.
   */
  readonly proxyRecord?:
    | { readonly kind: 'transparent' | 'uups' | 'beacon' }
    | undefined;
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
          if (property === 'getProxyRecord') {
            return async () => {
              log.push('getProxyRecord');
              return 'proxyRecord' in spec ? spec.proxyRecord : { kind: 'uups' };
            };
          }
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
      log.push('proxySlots');
      return (
        spec.slots ?? {
          kind: 'code',
          implementation: toTronHex(canonicalizeAddress(IMPL)),
          admin: null,
          beacon: null,
        }
      );
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

    async hostDeploy(target, args) {
      // The real choke-point guard: this fixture must refuse exactly what
      // the production `hostDeploy` refuses, so the tests below pin the
      // choke point itself rather than a fake's approximation of it.
      assertNoCheatcodeCollision(args);
      log.push(
        `hostDeploy:${String((target as { contractName?: unknown }).contractName)}`,
      );
      const writeBack = {
        address: toTronHex(canonicalizeAddress(IMPL)),
        transactionHash: TX,
      };
      // The write-back the production seam performs on the abstraction it was
      // handed — the revert test's whole subject is whether this assignment
      // survives a mined revert, so a fake that skipped it would leave nothing
      // for `restoreWriteBack` to be tested against.
      const bearer = target as { address?: unknown; transactionHash?: unknown };
      bearer.address = writeBack.address;
      bearer.transactionHash = writeBack.transactionHash;
      return writeBack;
    },

    async confirm(transactionHash) {
      log.push('confirm');
      if (spec.confirmOutcome === 'reverted') {
        return {
          kind: 'reverted',
          transactionHash,
          vmResult: 'REVERT',
          vmMessage: 'REVERT opcode executed',
          receipt: {},
        };
      }
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
    kind: spec.resolvedKind,
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
  };

  return { context: { toolkit, resolved } as OperationContext, log, kindsSeen };
}

const CHAIN_OR_STATE = [
  'proxySlots',
  'getProxyRecord',
  'queue',
  'requireDeployer',
  'fetchOrDeployImplementation',
  'confirm',
  'recordProxy',
  'sendUpgradeCall',
];

describe('the validate pair reaches no chain, no record, no queue — pass and refusal alike', () => {
  it('validateImplementation touches nothing transactional on a pass', async () => {
    const fake = buildFake();
    const outcome = await runValidateImplementation(fake.context, abstraction('Box'));
    expect(fake.log).toEqual(['validate:Box']);
    expect(outcome.notes).toEqual([]);
  });

  it('refuses an unsafe implementation with the violations named, and still sends nothing', async () => {
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

describe('an omitted kind is inferred from the REFERENCE, never the candidate', () => {
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

  it('an unchanged implementation is reused — no deploy, no confirm, the recorded identity reported', async () => {
    const fake = buildFake({ reuseImplementation: true });
    const result = await runDeployImplementation(fake.context, abstraction('Box'));
    expect(fake.log.some(entry => entry.startsWith('hostDeploy'))).toBe(false);
    expect(fake.log).not.toContain('confirm');
    expect(result.transaction.hash).toBe('dd'.repeat(32));
  });

  it("deployImplementation: a mined revert restores the user artifact's write-back (review comment on #18)", async () => {
    // Pins the reverted branch's `restoreWriteBack` wiring on the standalone
    // path, against the host's own accessor shape — a plain data-property fake
    // would let the restore silently do nothing.
    const prior = {
      address: toTronHex(canonicalizeAddress(PROXY)),
      transactionHash: 'dd'.repeat(32),
    };
    const contract = writeBackBearingArtifact('Box') as WriteBackBearing &
      Record<string, unknown>;
    contract['abi'] = [];
    contract['bytecode'] = '0x60806040';
    (contract as { address?: unknown }).address = prior.address;
    (contract as { transactionHash?: unknown }).transactionHash =
      prior.transactionHash;

    const fake = buildFake({ confirmOutcome: 'reverted' });
    await expect(
      runDeployImplementation(
        fake.context,
        contract as unknown as ContractAbstraction,
      ),
    ).rejects.toBeInstanceOf(TransactionRevertedError);
    // Non-vacuous: the deploy DID overwrite the entry (the fake's hostDeploy
    // assigns a pair distinct from `prior`), so equality below proves the
    // restore ran.
    expect(fake.log).toContain('hostDeploy:Box');
    expect(contract.network.address).toBe(prior.address);
    expect(contract.network.transactionHash).toBe(prior.transactionHash);
  });

  it('prepareUpgrade never touches the proxy — the send log holds exactly the implementation deploy', async () => {
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

  it('an unregistered reference surfaces the force-import remedy (scenario 3)', async () => {
    const fake = buildFake({
      storedLayoutRefusal:
        'No stored storage layout for the implementation at T… Register the deployment first with forceImport, or upgrade from the plugin that deployed it.',
    });
    await expect(
      runPrepareUpgrade(fake.context, PROXY, abstraction('BoxV2')),
    ).rejects.toThrow('forceImport');
    expect(fake.log).not.toContain('queue');
  });

  it('deployImplementation: the cheatcode-slot shape refuses through hostDeploy, before confirm', async () => {
    const fake = buildFake({ constructorArgs: [1, { overwrite: false }] });
    await expect(
      runDeployImplementation(fake.context, abstraction('Box')),
    ).rejects.toBeInstanceOf(CheatcodeSlotCollisionError);
    expect(fake.log.filter(e => e.startsWith('hostDeploy'))).toEqual([]);
    expect(fake.log).not.toContain('confirm');
  });

  it('prepareUpgrade: the cheatcode-slot shape refuses through hostDeploy, before confirm', async () => {
    const fake = buildFake({ constructorArgs: [1, { overwrite: false }] });
    await expect(
      runPrepareUpgrade(fake.context, PROXY, abstraction('BoxV2')),
    ).rejects.toBeInstanceOf(CheatcodeSlotCollisionError);
    expect(fake.log.filter(e => e.startsWith('hostDeploy'))).toEqual([]);
    expect(fake.log).not.toContain('confirm');
  });
});

describe('prepareUpgrade binds the kind of the referenced proxy (F4)', () => {
  const BEACON = '0x2222222222222222222222222222222222222222';

  it('a proxy recorded as uups judges BOTH candidate validations as uups', async () => {
    // The deep-review probe recorded {"kinds":[null,null]} here — an omitted
    // kind let the candidate self-infer transparent, suppressing exactly the
    // missing-entry-point error that matters.
    const fake = buildFake();
    await runPrepareUpgrade(fake.context, PROXY, abstraction('BoxV2'));
    expect(fake.kindsSeen).toEqual(['uups', 'uups']);
  });

  it('a proxy recorded as transparent judges the candidate as transparent', async () => {
    const fake = buildFake({ proxyRecord: { kind: 'transparent' } });
    await runPrepareUpgrade(fake.context, PROXY, abstraction('BoxV2'));
    expect(fake.kindsSeen).toEqual(['transparent', 'transparent']);
  });

  it('a caller kind matching the record is accepted', async () => {
    const fake = buildFake({ resolvedKind: 'uups' });
    await runPrepareUpgrade(fake.context, PROXY, abstraction('BoxV2'));
    expect(fake.kindsSeen).toEqual(['uups', 'uups']);
  });

  it('a caller kind contradicting the record refuses instead of overriding (review comment on #20)', async () => {
    // The override was the bricking path: transparent against a uups proxy
    // filters the missing-entry-point judgement, and nothing downstream of
    // prepareUpgrade catches it.
    const fake = buildFake({ resolvedKind: 'transparent' });
    await expect(
      runPrepareUpgrade(fake.context, PROXY, abstraction('BoxV2')),
    ).rejects.toThrow('Requested an upgrade of kind transparent but proxy is uups');
    expect(fake.log).not.toContain('validate:BoxV2');
  });

  it('an unregistered proxy refuses toward forceImport before validating', async () => {
    const fake = buildFake({ proxyRecord: undefined });
    await expect(
      runPrepareUpgrade(fake.context, PROXY, abstraction('BoxV2')),
    ).rejects.toThrow('forceImport');
    expect(fake.log).not.toContain('validate:BoxV2');
  });

  it('refuses kind: beacon before touching the chain', async () => {
    // 'beacon' is in the option's closed set, and upstream filters the
    // missing-entry-point error for it exactly as for transparent — honoring
    // it would recreate the hole this binding removes.
    const fake = buildFake({ resolvedKind: 'beacon' });
    await expect(
      runPrepareUpgrade(fake.context, PROXY, abstraction('BoxV2')),
    ).rejects.toThrow(/beacon/);
    expect(fake.log).not.toContain('proxySlots');
    expect(fake.log).not.toContain('validate:BoxV2');
  });

  it('refuses a beacon proxy by name, before validating the candidate', async () => {
    const fake = buildFake({
      slots: { kind: 'code', implementation: null, admin: null, beacon: BEACON },
    });
    await expect(
      runPrepareUpgrade(fake.context, PROXY, abstraction('BoxV2')),
    ).rejects.toBeInstanceOf(BeaconProxyRefusedError);
    expect(fake.log).not.toContain('validate:BoxV2');
  });

  it('refuses an address without code', async () => {
    const fake = buildFake({ slots: { kind: 'no-code' } });
    await expect(
      runPrepareUpgrade(fake.context, PROXY, abstraction('BoxV2')),
    ).rejects.toBeInstanceOf(NothingToAdoptError);
  });

  it('refuses code with an empty implementation slot', async () => {
    const fake = buildFake({
      slots: { kind: 'code', implementation: null, admin: null, beacon: null },
    });
    await expect(
      runPrepareUpgrade(fake.context, PROXY, abstraction('BoxV2')),
    ).rejects.toBeInstanceOf(NothingToAdoptError);
  });

  it('deployImplementation never consults the proxy slots or the proxy record', async () => {
    const fake = buildFake();
    await runDeployImplementation(fake.context, abstraction('Box'));
    expect(fake.log).not.toContain('proxySlots');
    expect(fake.log).not.toContain('getProxyRecord');
  });
});
