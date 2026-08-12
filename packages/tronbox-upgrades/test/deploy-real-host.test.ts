import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  tronBoxIsInstalled,
  tronBoxRoot,
  tronBoxVersionsUnderTest,
} from './helpers/locate';
import { runThroughQueue } from '../src/deploy';

/*
 * The deploy seam against the real installed host — the queue-arm behavior's
 * whole subject.
 *
 * The queue premise every deploy-seam decision leans on has two arms, and a
 * suite that exercises only the started arm measures the working case. So
 * this file drives the REAL `Deployer` through both arms on both supported
 * minors — including the bridge itself against a STARTED deployer, which is the
 * arm every real migration takes (`src/deploy/queue.ts` documents why), not only
 * the pre-start arm where the host's defect lives — and verifies the fixture the
 * unit suite uses (`deploy-seam.test.ts`)
 * replicates the installed class — by running the same behavioural
 * assertions against the real one and by pinning the installed source's
 * landmarks, including the arity of `then`, which is the whole defect.
 */

const installedVersions = tronBoxVersionsUnderTest.filter(tronBoxIsInstalled);

function hostModule<T>(installName: string, relative: string): T {
  const root = tronBoxRoot(installName);
  return createRequire(path.join(root, 'package.json'))(
    path.join(root, 'build', relative),
  ) as T;
}

interface HostDeployer {
  then(step: (...args: unknown[]) => unknown): unknown;
  start(): Promise<unknown>;
  chain: { started: boolean; chain: Promise<unknown> };
}

interface HostDeployerConstructor {
  new (options: Record<string, unknown>): HostDeployer;
}

function realDeployer(installName: string): HostDeployer {
  const Deployer = hostModule<HostDeployerConstructor>(
    installName,
    'components/Deployer',
  );
  return new Deployer({
    network: 'development',
    network_id: '9',
    logger: { log() {} },
  });
}

/**
 * True when `value` has not settled by the end of a short timer. `absorb` runs
 * in the same tick as the subscription: subscribing to the chain object goes
 * through its arity-1 `then`, which appends a rethrowing catch and mints a
 * dangling rejected link — absorbing it before the timer's macrotask boundary
 * is what keeps the measured defect from firing the unhandled-rejection hook
 * mid-wait.
 */
async function stillPending(
  value: unknown,
  absorb?: () => unknown,
): Promise<boolean> {
  const sentinel = Symbol('pending');
  const race = Promise.race([
    Promise.resolve(value).catch(() => 'settled-rejected'),
    new Promise(resolve => setTimeout(() => resolve(sentinel), 25)),
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

describe.each(installedVersions)('the queue-arm behavior against %s', installName => {
  it('pre-start: the runner learns the failure once, and the individual awaiter never settles', async () => {
    const deployer = realDeployer(installName);
    const boom = new Error('deployment failed on-chain');

    const individual = deployer.then(() => Promise.reject(boom));

    // The corrected framing, executed: `_error` fires, so the runner-side
    // await rejects with the ORIGINAL error. The failure is delivered — the
    // defect is not a lost rejection.
    await expect(deployer.start()).rejects.toBe(boom);

    // The defect is here: the caller who awaited the host's own return value
    // is suspended forever. Their onRejected was discarded by an arity-1
    // `then`, and their onFulfilled will never be called. The absorb hook
    // handles the host's second defect in the same tick — start() fuses
    // `then(this._done)` with no rejection arm, leaving the chain's final
    // link rejected with no handler, the process-fatal half under the tool's
    // Node floor. Handling it is the observation, not a workaround.
    expect(
      await stillPending(individual, () => deployer.chain.chain.catch(() => {})),
    ).toBe(true);
  });

  it('pre-start: even a successful step settles the individual awaiter only when start() drives the chain', async () => {
    const deployer = realDeployer(installName);
    const individual = deployer.then(() => 'ok');
    expect(await stillPending(individual)).toBe(true);

    await deployer.start();
    expect(await stillPending(individual)).toBe(false);
  });

  it('post-start: the same call shape returns a native promise that rejects normally', async () => {
    const deployer = realDeployer(installName);
    await deployer.start();
    expect(deployer.chain.started).toBe(true);

    const boom = new Error('post-start failure');
    const value = deployer.then(() => Promise.reject(boom));
    expect(value).toBeInstanceOf(Promise);
    await expect(value as Promise<unknown>).rejects.toBe(boom);
  });

  it('the bridge settles even when an earlier step failed on the real host, and later steps stay skipped', async () => {
    const deployer = realDeployer(installName);
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
    expect(laterUserStepRan).toBe(false);

    await deployer.chain.chain.catch(() => {});
  });

  it('the bridge closes the gap on the real host: caller rejected, chain fulfilled, later steps run', async () => {
    const deployer = realDeployer(installName);
    const boom = new Error('bridged failure');

    const bridged = runThroughQueue(deployer, () => {
      throw boom;
    });
    const observed = bridged.catch((e: unknown) => e);

    let laterStepRan = false;
    deployer.then(() => {
      laterStepRan = true;
    });

    await deployer.start();
    expect(await observed).toBe(boom);
    expect(laterStepRan).toBe(true);
  });

  /*
   * The post-start arm, through the bridge — the arm every real migration
   * takes. `Migration.prototype.run` calls the migration body and then
   * `finish(null, migrateFn)` on the next statement, whose first act is
   * `deployer.start()`; every operation here awaits network work inside
   * `createOperationToolkit` before reaching `toolkit.queue`, so `chain.started`
   * is already `true` when the step is registered. The two suites above measure
   * the bridge against the pre-start chain, which is where the host's defect
   * lives — but a seam whose shipped guarantees are asserted only on the arm
   * production never reaches is a seam measured in the wrong place. Same two
   * guarantees, same real `Deployer`, started.
   */
  it('post-start — the production arm: the caller is rejected once, the host stays usable, and nothing escapes unhandled', async () => {
    const deployer = realDeployer(installName);
    await deployer.start();
    expect(deployer.chain.started).toBe(true);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const boom = new Error('post-start bridged failure');
      let stepRuns = 0;
      const bridged = runThroughQueue(deployer, () => {
        stepRuns += 1;
        throw boom;
      });

      // Guarantee one: the failure reaches the caller — settled, not suspended
      // the way the pre-start arm leaves a bare host await.
      await expect(bridged).rejects.toBe(boom);
      expect(stepRuns).toBe(1);

      // Guarantee two: it reached the caller and nothing else. The host side
      // stayed usable, so a later migration step still runs...
      let laterStepRan = false;
      await deployer.then(() => {
        laterStepRan = true;
      });
      expect(laterStepRan).toBe(true);

      // ...and a success settles exactly once, with its value, through the same
      // started host.
      await expect(runThroughQueue(deployer, () => 'ok')).resolves.toBe('ok');

      // Give any dangling rejection a macrotask to surface in. A second
      // settlement attempt would throw `DeploySeamInvariantError` out of the
      // seam's own catch subscription, which is exactly what would land here.
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('pins the installed source: arity-1 then, the fired _error, the unused _reject', () => {
    const source = fs.readFileSync(
      path.join(
        tronBoxRoot(installName),
        'build',
        'components',
        'Deployer',
        'src',
        'deferredchain.js',
      ),
      'utf8',
    );

    // Each landmark asserted present before anything is claimed about it —
    // a missing landmark must fail here, not let a slice measure nothing.
    expect(source).toContain('DeferredChain.prototype.then=function(fn)');
    expect(source).toContain('self._error(e);throw e');
    // The real rejection handler the bridge's skipped-step subscription rides.
    expect(source).toContain('DeferredChain.prototype["catch"]=function(fn)');
    // `_reject` appears exactly once: captured in the constructor, called
    // nowhere. The pre-start arm was never built to reject.
    expect(source.match(/_reject/g)).toHaveLength(1);

    // The arity itself, on the loaded class rather than the text.
    interface ChainConstructor {
      new (): { then(fn: unknown): unknown };
      prototype: { then(fn: unknown): unknown };
    }
    const DeferredChain = hostModule<ChainConstructor>(
      installName,
      'components/Deployer/src/deferredchain',
    );
    expect(DeferredChain.prototype.then.length).toBe(1);
  });
});

describe('the premise is version-stable where the deploy seam assumes it is', () => {
  it.skipIf(installedVersions.length < 2)(
    'deferredchain.js is byte-identical across both installed minors',
    () => {
      const [a, b] = installedVersions;
      const read = (name: string): Buffer =>
        fs.readFileSync(
          path.join(
            tronBoxRoot(name),
            'build',
            'components',
            'Deployer',
            'src',
            'deferredchain.js',
          ),
        );
      expect(read(a as string).equals(read(b as string))).toBe(true);
    },
  );

  it.skipIf(installedVersions.length < 2)(
    'linker.js DIFFERS across minors — the fact that scopes linking behavior per minor, pinned so its disappearance is loud',
    () => {
      const [a, b] = installedVersions;
      const read = (name: string): Buffer =>
        fs.readFileSync(
          path.join(
            tronBoxRoot(name),
            'build',
            'components',
            'Deployer',
            'src',
            'linker.js',
          ),
        );
      // If a future pair of minors converges, this fails and the per-minor
      // obligation gets revisited deliberately instead of silently persisting.
      expect(read(a as string).equals(read(b as string))).toBe(false);
    },
  );
});

/**
 * The `_static_methods.new` face `Contract.clone(...)`'s deploy artifacts
 * expose, unbound. `hostDeploy` never sees this directly (it calls through an
 * abstraction `Contract.clone` produced), but the static method is where
 * `filterEnergyParameter` actually runs, and calling it against a minimal
 * `this` isolates that ONE synchronous step from everything after it
 * (linking checks, the network call) — exactly what `assertNoCheatcodeCollision`
 * needs to be refusing ahead of.
 */
interface HostContractNew {
  readonly _static_methods: {
    readonly new: (this: unknown, ...args: unknown[]) => unknown;
  };
}

function realContractNew(installName: string): (this: unknown, ...args: unknown[]) => unknown {
  return hostModule<HostContractNew>(installName, 'components/Contract/contract.js')
    ._static_methods.new;
}

/**
 * A minimal `this` for `Contract._static_methods.new`: enough for
 * `filterEnergyParameter` to run and, on the minor that gets past it, for the
 * arity check and `Utils.merge` right after to run too — no `tronWrap` is
 * initialized, so anything past that point rejects for reasons unrelated to
 * the null under test, and that rejection is swallowed rather than asserted.
 */
function probeContractThis(): Record<string, unknown> {
  return {
    abi: [{ type: 'constructor', inputs: [{ type: 'address' }, { type: 'address' }] }],
    bytecode: '0x60806040',
    binary: '0x60806040',
    contractName: 'CheatcodeProbe',
    class_defaults: {},
  };
}

/*
 * The finding that reopened this guard (Cursor adversarial, fix round 1): a
 * trailing `null` reaches `filterEnergyParameter` down the SAME branch as a
 * plain object (`typeof null === 'object'`), and the two installed minors
 * diverge from there. Both `assertNoCheatcodeCollision`'s doc comment and
 * `CheatcodeSlotCollisionError`'s `'null'` message make this exact claim —
 * this pins it against the real, installed host source rather than trusting
 * the comment to stay honest on its own.
 */
describe.each(installedVersions)(
  'filterEnergyParameter and a trailing null, against %s',
  installName => {
    it('handles a trailing null differently across the installed minors, neither usably', () => {
      const newFn = realContractNew(installName);
      let synchronousResult: unknown;
      let synchronousThrow: unknown;
      try {
        synchronousResult = newFn.call(probeContractThis(), '0xabc', null);
      } catch (error) {
        synchronousThrow = error;
      }
      // Whichever branch ran, absorb any later async rejection: past the
      // synchronous step under test, `_deployContract` is undefined in this
      // fixture (no `tronWrap` was initialized), which is this probe's own
      // gap, not a fact about the null.
      if (
        synchronousResult !== undefined &&
        typeof (synchronousResult as { catch?: unknown }).catch === 'function'
      ) {
        (synchronousResult as Promise<unknown>).catch(() => undefined);
      }

      if (installName === 'tronbox-4.8.0') {
        // No null guard in filterEnergyParameter: `args.pop()` removes the
        // null, then `Object.keys(null)` throws — synchronously, before any
        // deploy is attempted.
        expect(synchronousThrow).toBeInstanceOf(TypeError);
      } else {
        // 4.9.0 added the null guard: filterEnergyParameter returns early and
        // the null is retained, unexamined, in the argument list — no
        // synchronous throw here. (What happens when THAT null reaches ABI
        // encoding is `errors.ts`'s and `queue.ts`'s concern, not this one's.)
        expect(synchronousThrow).toBeUndefined();
      }
    });
  },
);
