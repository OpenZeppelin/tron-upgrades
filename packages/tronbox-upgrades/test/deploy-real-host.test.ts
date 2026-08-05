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
 * minors, and verifies the fixture the unit suite uses (`deploy-seam.test.ts`)
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
