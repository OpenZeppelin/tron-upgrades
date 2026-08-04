import { describe, expect, it } from 'vitest';

import {
  assertFreshTransaction,
  assertFullyLinked,
  assertNoCheatcodeCollision,
  assertSignerMatches,
  confirmTransaction,
  linkedLibraryNames,
  refuseUnlessLinkingAllowed,
  resolveEffectiveSender,
  runThroughQueue,
  CheatcodeSlotCollisionError,
  ConfirmationIndeterminateError,
  DeployerAbsentError,
  DeploymentRefusedError,
  DeploySeamInvariantError,
  LinkedImplementationRefusedError,
  LinkVerificationFailedError,
  SenderMismatchError,
  StaleTransactionIdentityError,
  TransactionRevertedError,
  HOST_CONFIRMATION_BOUNDS,
} from '../src/deploy';
import { canonicalizeAddress } from '../src/record';

/*
 * SF-4 — the deployment seam against a faithful queue fixture.
 *
 * The fixture `DeferredChain` below replicates the installed host's semantics
 * exactly — arity-1 `then` returning `this`, the appended catch that fires
 * `_error` and rethrows, `start()` fusing `_done` with no rejection arm — and
 * `sf-4-real-host.test.ts` is what proves the replication: it runs the same
 * behavioural assertions against the real installed class on both minors, and
 * pins the installed source's landmarks. This file owns everything that needs
 * no host: the bridge, the gate, the sender algorithm, linking, and the error
 * family.
 */

/** The host's queue, replicated. Verified against the installed original. */
class FixtureDeferredChain {
  chain: Promise<unknown>;
  await: Promise<unknown>;
  started = false;
  private accept!: () => void;
  private done!: (value: unknown) => void;
  private error!: (reason: unknown) => void;

  constructor() {
    this.chain = new Promise<void>(resolve => {
      this.accept = resolve;
    });
    this.await = new Promise((resolve, reject) => {
      this.done = resolve;
      this.error = reject;
    });
  }

  // Deliberately one parameter, like the original: an `await` of this object
  // supplies an onRejected that this signature silently discards.
  then(fn: (...args: unknown[]) => unknown): this {
    this.chain = this.chain.then((...args: unknown[]) => fn(...args));
    this.chain = this.chain.catch((e: unknown) => {
      this.error(e);
      throw e;
    });
    return this;
  }

  // Also like the original: `catch` takes a real rejection handler, which is
  // the one route through which an upstream failure is observable at all.
  catch(fn: (reason: unknown) => unknown): this {
    this.chain = this.chain.catch(fn);
    return this;
  }

  start(): Promise<unknown> {
    this.started = true;
    this.chain = this.chain.then(this.done);
    this.accept();
    return this.await;
  }
}

class FixtureDeployer {
  readonly chain = new FixtureDeferredChain();
  then(step: (...args: unknown[]) => unknown): unknown {
    if (this.chain.started) {
      return Promise.resolve().then(step);
    }
    return this.chain.then(step);
  }
  start(): Promise<unknown> {
    return this.chain.start();
  }
}

/**
 * True when `value` has not settled by the end of a short timer. `absorb` runs
 * in the same tick as the subscription: subscribing to the chain object goes
 * through its arity-1 `then`, which appends a rethrowing catch and mints a
 * dangling rejected link — absorbing it before the timer's macrotask boundary
 * is what keeps the replicated defect from firing the unhandled-rejection hook
 * mid-wait.
 */
async function stillPending(
  value: unknown,
  absorb?: () => unknown,
): Promise<boolean> {
  const sentinel = Symbol('pending');
  const race = Promise.race([
    Promise.resolve(value).catch(() => 'settled-rejected'),
    new Promise(resolve => setTimeout(() => resolve(sentinel), 20)),
  ]);
  // Two yields first: `Promise.resolve(value)` adopts the thenable in its own
  // microtask job, and the dangling links exist only after that job has called
  // the chain's `then`. An absorb attached before it runs handles yesterday's
  // tail, not the one the subscription just minted.
  await Promise.resolve();
  await Promise.resolve();
  absorb?.();
  return (await race) === sentinel;
}

// ---------------------------------------------------------------------------
// INV-1 / INV-3 — the owned-promise bridge
// ---------------------------------------------------------------------------

describe('INV-1 / INV-3: the bridge settles its own promise where a direct await would hang', () => {
  it('rejects the caller on a pre-start failure that a direct await never learns about', async () => {
    const deployer = new FixtureDeployer();
    const boom = new Error('fee limit too low');

    // The defect being bridged, demonstrated first: a direct await of the
    // host's own return value never settles on failure.
    const direct = deployer.then(() => Promise.reject(boom));

    const bridged = runThroughQueue(deployer, () => {
      throw boom;
    });
    const observed = bridged.catch((e: unknown) => e);

    // The runner's await rejects with the original error — the failure is
    // delivered to the runner, once. That half was never broken.
    await expect(deployer.start()).rejects.toBe(boom);

    expect(await observed).toBe(boom);
    expect(
      await stillPending(direct, () => deployer.chain.chain.catch(() => {})),
    ).toBe(true);
  });

  it('resolves the caller with the step value, and only once start() drives the chain', async () => {
    const deployer = new FixtureDeployer();
    const bridged = runThroughQueue(deployer, () => 'deployed');
    expect(await stillPending(bridged)).toBe(true);

    await deployer.start();
    expect(await bridged).toBe('deployed');
  });

  it('keeps the host chain fulfilled through a failing step, so later steps still run', async () => {
    const deployer = new FixtureDeployer();
    const failed = runThroughQueue(deployer, () => {
      throw new Error('first step fails');
    });
    const observed = failed.catch(() => 'caller saw it');

    let laterStepRan = false;
    deployer.then(() => {
      laterStepRan = true;
    });

    // The host chain never saw the failure, so start() resolves and the
    // later step executed — one error, one delivery, to the caller alone.
    await deployer.start();
    expect(await observed).toBe('caller saw it');
    expect(laterStepRan).toBe(true);
  });

  it('handles a step that throws synchronously the same as one that rejects', async () => {
    const deployer = new FixtureDeployer();
    const boom = new Error('sync');
    const bridged = runThroughQueue(deployer, (): never => {
      throw boom;
    });
    const observed = bridged.catch((e: unknown) => e);
    await deployer.start();
    expect(await observed).toBe(boom);
  });

  it('settles the caller even when an EARLIER step failed and the queued step never ran', async () => {
    // The chain arrives at the bridge's step already rejected, so the step —
    // and the try/catch inside it — never executes. The bridge subscribes to
    // that failure through the chain's real `catch`, so the caller still
    // rejects instead of suspending forever.
    const deployer = new FixtureDeployer();
    const upstream = new Error('an earlier migration step failed');
    deployer.then(() => Promise.reject(upstream));

    const bridged = runThroughQueue(deployer, () => 'never reached');
    const observed = bridged.catch((e: unknown) => e);

    let laterUserStepRan = false;
    deployer.then(() => {
      laterUserStepRan = true;
    });

    await expect(deployer.start()).rejects.toBe(upstream);
    expect(await observed).toBe(upstream);

    // The bridge's rethrow preserved the host's own semantics: a user step
    // queued after the failure is still skipped, exactly as it would be with
    // no bridge in the chain.
    expect(laterUserStepRan).toBe(false);

    await deployer.chain.chain.catch(() => {});
  });

  it('post-start, the bridge behaves identically — one settlement, host untouched', async () => {
    const deployer = new FixtureDeployer();
    await deployer.start();
    const boom = new Error('post-start failure');
    await expect(
      runThroughQueue(deployer, () => Promise.reject(boom)),
    ).rejects.toBe(boom);
    expect(await runThroughQueue(deployer, () => 41)).toBe(41);
  });
});

// ---------------------------------------------------------------------------
// INV-5 / INV-11 — the marshalling and staleness guards
// ---------------------------------------------------------------------------

describe('INV-5: a trailing plain object is refused before the host can mutate it', () => {
  it('refuses exactly the shape the host destructures', () => {
    expect(() => assertNoCheatcodeCollision([1, 'a', { overwrite: false }])).toThrow(
      CheatcodeSlotCollisionError,
    );
    expect(() => assertNoCheatcodeCollision([{ any: 'struct' }])).toThrow(
      CheatcodeSlotCollisionError,
    );
  });

  it('passes every shape the host forwards untouched', () => {
    // Arrays, primitives, null, and a struct that is not final: the host's
    // check is `typeof === 'object' && !== null && !Array.isArray` on the LAST
    // argument only, so these are the measured pass-through shapes.
    expect(() => assertNoCheatcodeCollision([])).not.toThrow();
    expect(() => assertNoCheatcodeCollision([1, 2, 3])).not.toThrow();
    expect(() => assertNoCheatcodeCollision([{ s: 1 }, 'last'])).not.toThrow();
    expect(() => assertNoCheatcodeCollision(['a', [1, 2]])).not.toThrow();
    expect(() => assertNoCheatcodeCollision([null])).not.toThrow();
  });
});

describe('INV-11: a transaction hash inherited from a previous run is refused, not reported', () => {
  it('refuses when the hash did not change across the deploy step', () => {
    expect(() =>
      assertFreshTransaction('aa'.repeat(32), {
        address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
        transactionHash: 'aa'.repeat(32),
      }),
    ).toThrow(StaleTransactionIdentityError);
  });

  it('passes a first deployment and a changed hash', () => {
    const writeBack = {
      address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
      transactionHash: 'bb'.repeat(32),
    };
    expect(() => assertFreshTransaction(null, writeBack)).not.toThrow();
    expect(() => assertFreshTransaction('aa'.repeat(32), writeBack)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// INV-7 / INV-8 / INV-10 — the confirmation gate, driven by the captured shapes
// ---------------------------------------------------------------------------

/*
 * Every fixture below is the measured shape from a real mainnet transaction
 * (block 85064760; the capture is persisted with the development evidence),
 * not an invented one — the difference matters because the invented shape is
 * exactly how the vacuous predicate would have shipped.
 */
const HASH = '2229d262dc2825901d64c68c37b2d06017cb889435a89d433704608a63a9aaf8';

const SUCCESS_INFO = {
  id: HASH,
  fee: 1_000_000,
  blockNumber: 85_064_760,
  receipt: { energy_usage_total: 64_285, net_fee: 345_000, result: 'SUCCESS' },
  contractResult: ['0'.repeat(64)],
};

const REVERT_INFO = {
  id: HASH,
  fee: 345_000,
  blockNumber: 85_064_760,
  result: 'FAILED',
  resMessage: Buffer.from('REVERT opcode executed', 'utf8').toString('hex'),
  receipt: { energy_usage_total: 8_624, net_fee: 345_000, result: 'REVERT' },
  contractResult: [''],
};

/** A plain TRX transfer's receipt: `{ net_fee }` and nothing else. */
const TRANSFER_INFO = {
  id: HASH,
  fee: 267_000,
  blockNumber: 85_064_760,
  receipt: { net_fee: 267_000 },
  contractResult: [''],
};

function waitReturning(info: unknown) {
  let calls = 0;
  const wait = async (): Promise<unknown> => {
    calls += 1;
    return info;
  };
  return { wait, calls: () => calls };
}

describe('INV-7: three disjoint verdicts, each from its measured receipt shape', () => {
  it('confirms success only from receipt.result === "SUCCESS"', async () => {
    const verdict = await confirmTransaction(HASH, waitReturning(SUCCESS_INFO).wait);
    expect(verdict.kind).toBe('confirmed-successful');
  });

  it('classifies REVERT as reverted, with the TVM message decoded verbatim', async () => {
    const verdict = await confirmTransaction(HASH, waitReturning(REVERT_INFO).wait);
    expect(verdict).toMatchObject({
      kind: 'reverted',
      vmResult: 'REVERT',
      vmMessage: 'REVERT opcode executed',
    });
  });

  it('classifies any named non-SUCCESS verdict as a failure, so an unfamiliar name cannot pass', async () => {
    const info = {
      ...REVERT_INFO,
      receipt: { ...REVERT_INFO.receipt, result: 'OUT_OF_ENERGY' },
    };
    const verdict = await confirmTransaction(HASH, waitReturning(info).wait);
    expect(verdict).toMatchObject({ kind: 'reverted', vmResult: 'OUT_OF_ENERGY' });
  });

  it('turns exhaustion into indeterminate carrying the bound, never into success or revert', async () => {
    const wait = async (): Promise<unknown> => {
      throw new Error(`Transaction receipt not found: ${HASH}`);
    };
    const verdict = await confirmTransaction(HASH, wait);
    expect(verdict).toMatchObject({
      kind: 'indeterminate',
      because: 'wait-exhausted',
      waitedMs:
        HOST_CONFIRMATION_BOUNDS.intervalMs * HOST_CONFIRMATION_BOUNDS.maxRetries,
    });
  });
});

describe('INV-8: the vacuity canary — an absent verdict field never classifies as success', () => {
  it('classifies the measured transfer receipt (no receipt.result at all) as indeterminate', async () => {
    const verdict = await confirmTransaction(HASH, waitReturning(TRANSFER_INFO).wait);
    expect(verdict).toMatchObject({
      kind: 'indeterminate',
      because: 'receipt-field-absent',
    });
  });

  it('does the same for an empty object, a missing receipt key, and a non-object', async () => {
    for (const info of [{}, { receipt: {} }, { receipt: null }, 'nonsense', null]) {
      const verdict = await confirmTransaction(HASH, waitReturning(info).wait);
      expect(verdict.kind, JSON.stringify(info)).toBe('indeterminate');
    }
  });

  it('pins the wrong predicate it replaces: info.result !== "FAILED" passes the transfer shape', () => {
    // The measured refutation of the obvious predicate, kept as data: the
    // top-level `result` key is absent on success AND on a plain transfer, so
    // a gate reading it would confirm both — including the transfer, which
    // carries no execution verdict at all.
    const successResult = (SUCCESS_INFO as Record<string, unknown>)['result'];
    const transferResult = (TRANSFER_INFO as Record<string, unknown>)['result'];
    expect(successResult).toBeUndefined();
    expect(transferResult).toBeUndefined();
    expect((REVERT_INFO as Record<string, unknown>)['result']).toBe('FAILED');
  });
});

describe('INV-10: the gate consults the wait exactly once — reads retry inside it, sends never', () => {
  it('calls the injected wait once on every verdict path', async () => {
    for (const info of [SUCCESS_INFO, REVERT_INFO, TRANSFER_INFO]) {
      const probe = waitReturning(info);
      await confirmTransaction(HASH, probe.wait);
      expect(probe.calls()).toBe(1);
    }
    let calls = 0;
    const rejecting = async (): Promise<unknown> => {
      calls += 1;
      throw new Error('not found');
    };
    await confirmTransaction(HASH, rejecting);
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// INV-12 / INV-13 — the effective sender
// ---------------------------------------------------------------------------

const SENDER_BASE58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

describe('INV-12 / INV-13: one resolution, canonical comparison, mismatch refuses', () => {
  it('resolves a configured address to its canonical form and null to a named state', () => {
    expect(resolveEffectiveSender({ address: SENDER_BASE58 })).toEqual({
      kind: 'resolved',
      address: canonicalizeAddress(SENDER_BASE58),
    });
    expect(resolveEffectiveSender({ address: null })).toEqual({
      kind: 'unconfigured',
    });
  });

  it('compares identity, not spelling: the same account in another encoding matches', () => {
    const resolved = resolveEffectiveSender({ address: SENDER_BASE58 });
    // The host reports the signer in TRON hex; the comparison must see one
    // identity, or every mismatch refusal would also fire on every match.
    const canonical = canonicalizeAddress(SENDER_BASE58);
    expect(() => assertSignerMatches(resolved, canonical)).not.toThrow();
    expect(assertSignerMatches(resolved, SENDER_BASE58)).toBe(canonical);
  });

  it('refuses a different signer, naming both identities', () => {
    const resolved = resolveEffectiveSender({ address: SENDER_BASE58 });
    const other = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
    let caught: SenderMismatchError | undefined;
    try {
      assertSignerMatches(resolved, other);
    } catch (error) {
      caught = error as SenderMismatchError;
    }
    expect(caught).toBeInstanceOf(SenderMismatchError);
    expect(caught?.message).toContain(canonicalizeAddress(SENDER_BASE58));
    expect(caught?.message).toContain(canonicalizeAddress(other));
  });

  it('accepts any signer when unconfigured, returning it canonicalized for the result', () => {
    const signer = assertSignerMatches({ kind: 'unconfigured' }, SENDER_BASE58);
    expect(signer).toBe(canonicalizeAddress(SENDER_BASE58));
  });
});

// ---------------------------------------------------------------------------
// INV-20 / INV-21 — linking
// ---------------------------------------------------------------------------

describe('INV-20 / INV-21: linking refuses by default and never trusts silence', () => {
  const LEGACY = '0x6080' + '__MathLib' + '_'.repeat(31) + '6040';
  const HASHED = '0x6080' + '__$0123456789abcdef0123456789abcdef01$__' + '6040';

  it('names the linked libraries from both placeholder forms', () => {
    expect(linkedLibraryNames(LEGACY)).toEqual(['MathLib']);
    expect(linkedLibraryNames(HASHED)).toEqual([
      '0123456789abcdef0123456789abcdef01',
    ]);
    expect(linkedLibraryNames('0x60806040')).toEqual([]);
  });

  it('refuses a linked implementation without the opt-out, naming library and opt-out', () => {
    let caught: LinkedImplementationRefusedError | undefined;
    try {
      refuseUnlessLinkingAllowed(['MathLib'], false);
    } catch (error) {
      caught = error as LinkedImplementationRefusedError;
    }
    expect(caught).toBeInstanceOf(LinkedImplementationRefusedError);
    expect(caught?.message).toContain('MathLib');
    expect(caught?.message).toContain('external-library-linking');
  });

  it('proceeds with the opt-out set, and always for an unlinked implementation', () => {
    expect(() => refuseUnlessLinkingAllowed(['MathLib'], true)).not.toThrow();
    expect(() => refuseUnlessLinkingAllowed([], false)).not.toThrow();
  });

  it('verifies the outcome on the bytecode: a surviving placeholder refuses after a silent link', () => {
    expect(() => assertFullyLinked(LEGACY)).toThrow(LinkVerificationFailedError);
    expect(() => assertFullyLinked('0x60806040')).not.toThrow();
  });

  it('catches a placeholder fragment even when the name extractor cannot parse it', () => {
    // Hex proper cannot contain an underscore, so any occurrence is a
    // placeholder whatever its shape — the belt over the name extraction.
    expect(() => assertFullyLinked('0x6080_6040')).toThrow(
      LinkVerificationFailedError,
    );
  });
});

// ---------------------------------------------------------------------------
// INV-6 — the error family
// ---------------------------------------------------------------------------

describe('INV-6: eight refusals with distinct codes and messages, one internal error outside the family', () => {
  const specimens: readonly DeploymentRefusedError[] = [
    new DeployerAbsentError('tronbox test'),
    new TransactionRevertedError({
      kind: 'reverted',
      transactionHash: HASH,
      vmResult: 'REVERT',
      vmMessage: 'REVERT opcode executed',
      receipt: {},
    }),
    new ConfirmationIndeterminateError({
      kind: 'indeterminate',
      transactionHash: HASH,
      because: 'wait-exhausted',
      waitedMs: 120_000,
    }),
    new SenderMismatchError('TA', 'TB'),
    new LinkedImplementationRefusedError(['MathLib']),
    new LinkVerificationFailedError(['MathLib']),
    new StaleTransactionIdentityError(HASH),
    new CheatcodeSlotCollisionError(),
  ];

  it('every refusal is an Error in the family, with a distinct code and a distinct message', () => {
    for (const specimen of specimens) {
      expect(specimen).toBeInstanceOf(Error);
      expect(specimen).toBeInstanceOf(DeploymentRefusedError);
    }
    expect(new Set(specimens.map(s => s.code)).size).toBe(specimens.length);
    expect(new Set(specimens.map(s => s.message)).size).toBe(specimens.length);
  });

  it('distinguishes the exhausted wait from the absent field inside one class', () => {
    const absent = new ConfirmationIndeterminateError({
      kind: 'indeterminate',
      transactionHash: HASH,
      because: 'receipt-field-absent',
      waitedMs: null,
    });
    const exhausted = specimens[2] as ConfirmationIndeterminateError;
    expect(absent.message).not.toBe(exhausted.message);
  });

  it('keeps the internal invariant error outside the refusal family, so a refusal-scoped catch cannot swallow a bug', () => {
    const internal = new DeploySeamInvariantError('a queued step settled twice');
    expect(internal).toBeInstanceOf(Error);
    expect(internal instanceof DeploymentRefusedError).toBe(false);
  });
});
