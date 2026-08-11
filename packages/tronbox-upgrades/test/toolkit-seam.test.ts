import { describe, expect, it } from 'vitest';

import { assertNoOptionsInArgsPosition, createOperationToolkit } from '../src/proxy/toolkit';
import { DEPLOY_PROXY_ACCEPTED_OPTIONS } from '../src/proxy/deploy-proxy';
import { UPGRADE_PROXY_ACCEPTED_OPTIONS } from '../src/proxy/upgrade-proxy';
import { BEACON_ACCEPTED_OPTIONS } from '../src/beacon';
import { OptionsInArgsPositionError } from '../src/proxy/errors';
import { UnknownOptionError } from '../src/options';
import { CheatcodeSlotCollisionError, LinkVerificationFailedError } from '../src/deploy';
import { migrateShapedHandles } from './helpers/handles';
import { realToolkitProject } from './helpers/toolkit-project';

/*
 * The toolkit seam, exercised through the REAL `createOperationToolkit` —
 * never a fake — because the defect this suite pins (B1) lived exactly in the
 * production mapping between the resolver's output and
 * `OperationContext.resolved`: the toolkit read the resolver's result through
 * a widening cast at the wrong nesting level, so six option reads were always
 * empty and a caller's `kind` arrived downstream as `undefined`.
 *
 * `validate-only` mode is the vehicle: it resolves exactly the five slots the
 * `migrateShapedHandles` fixture can satisfy without a chain (`paths`,
 * `network`, `artifacts`, `output`, `compiler` — `VALIDATE_ONLY_SLOTS`),
 * opens no record session, and still runs the one code path under test — the
 * rawOptions → resolver → `context.resolved` mapping, which is identical in
 * both modes.
 *
 * `processEnv` is a fresh object per test: `configureRecordLocation` writes
 * the manifest-directory variable into the env it is handed, and this suite
 * must not leak that write into the real `process.env`.
 */
describe('the toolkit reads the resolver output at the right level (B1)', () => {
  it('kind:uups survives from rawOptions to context.resolved and engineOptions', async () => {
    const shape = migrateShapedHandles();
    const context = await createOperationToolkit({
      handles: shape.handles,
      rawOptions: { kind: 'uups' },
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });
    expect(context.resolved.kind).toBe('uups');
    expect(context.resolved.engineOptions['kind']).toBe('uups');
  });

  it('initializer, call, initialOwner and both unsafe flags survive', async () => {
    const shape = migrateShapedHandles();
    // The accepted-options spread is deliberate: `UPGRADE_PROXY_ACCEPTED_OPTIONS`
    // gates unknown keys per operation, and this test is about the seam
    // threading every accepted key, not about any one operation's accepted set.
    const context = await createOperationToolkit({
      handles: shape.handles,
      rawOptions: {
        initializer: 'setUp',
        call: 'migrate',
        initialOwner: 'T...',
        unsafeSkipProxyAdminCheck: true,
        unsafeAllow: ['external-library-linking'],
      },
      acceptedOptions: [
        ...UPGRADE_PROXY_ACCEPTED_OPTIONS,
        'initializer',
        'initialOwner',
        'unsafeSkipProxyAdminCheck',
      ],
      processEnv: {},
      mode: 'validate-only',
    });
    expect(context.resolved.initializer).toBe('setUp');
    expect(context.resolved.call).toBe('migrate');
    expect(context.resolved.initialOwner).toBe('T...');
    expect(context.resolved.unsafeSkipProxyAdminCheck).toBe(true);
    // One level DOWN on the resolver's result: the flag lives at
    // `resolved.validation.unsafeAllowLinkedLibraries`, where upstream's
    // `withValidationDefaults` derives it from the `unsafeAllow` grant.
    expect(context.resolved.unsafeAllowLinkedLibraries).toBe(true);
  });

  it('BEACON_ACCEPTED_OPTIONS refuses `kind` at runtime — the same list deployBeacon, deployBeaconProxy and upgradeBeacon all share', async () => {
    // Executed, not read from the type: a JS caller who bypasses the (now
    // fixed) DeployBeaconOptions/UpgradeBeaconOptions type-level refusal and
    // hands `kind` to the real resolver still gets refused, through the one
    // constant all three beacon operations pass as `acceptedOptions`.
    const shape = migrateShapedHandles();
    await expect(
      createOperationToolkit({
        handles: shape.handles,
        rawOptions: { kind: 'beacon' },
        acceptedOptions: BEACON_ACCEPTED_OPTIONS,
        processEnv: {},
        mode: 'validate-only',
      }),
    ).rejects.toBeInstanceOf(UnknownOptionError);
  });
});

/*
 * `hostDeploy` is the single seam every operation's deploy funnels through
 * (deploy-proxy, upgrade-proxy, beacon, standalone all call
 * `toolkit.hostDeploy` and nothing else `.new()`s an abstraction) — so it is
 * where `assertFullyLinked` belongs, verifying the bytecode about to deploy
 * carries no unresolved library placeholder even when
 * `unsafeAllowLinkedLibraries` opted the deploy in at entry.
 *
 * The REAL toolkit is built here, through `createOperationToolkit` in
 * `validate-only` mode — never a fake `hostDeploy` — because a fake toolkit's
 * `hostDeploy` is exactly the thing under test and would make this
 * tautological. `validate-only` is the vehicle: `hostDeploy` touches no chain
 * before `.new()`, so it is fully reachable without a live network.
 */
describe('hostDeploy verifies linking before it deploys (review §3 M4)', () => {
  it('refuses bytecode with an unresolved placeholder even under the linking opt-out, before any deploy attempt', async () => {
    const shape = migrateShapedHandles();
    const context = await createOperationToolkit({
      handles: shape.handles,
      rawOptions: { unsafeAllow: ['external-library-linking'] },
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });
    // `binary` is the field the host's own `Contract.new()` deploys
    // (`tx_params.data = self.binary`) — the library-linked form computed
    // from `bytecode` and the host's `links` map, not `bytecode` itself.
    const abstraction = {
      contractName: 'Lib',
      binary: '0x60__$deadbeefdeadbeefdeadbeefdeadbeefde$__',
      new: async (): Promise<never> => {
        throw new Error('must not be reached');
      },
    };
    await expect(
      context.toolkit.hostDeploy(abstraction as never, []),
    ).rejects.toThrow(LinkVerificationFailedError);
  });
});

/*
 * `hostDeploy` is also the single choke point for the cheatcode-collision
 * guard (review M1): every operation's deploy funnels through it, so it is
 * the one place a guard can protect `upgradeProxy`, `deployBeacon`,
 * `upgradeBeacon`, `deployImplementation` and `prepareUpgrade` — none of
 * which had a pre-queue guard of their own before this fix. The REAL toolkit
 * is built here, exactly like the linking suite above, so this pins the
 * choke point itself rather than a fake's approximation of it.
 */
describe('hostDeploy refuses a trailing plain-object argument before it deploys (review M1)', () => {
  it('refuses before `.new()` is ever called, even with linking already satisfied', async () => {
    const shape = migrateShapedHandles();
    const context = await createOperationToolkit({
      handles: shape.handles,
      rawOptions: {},
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });
    const abstraction = {
      contractName: 'Box',
      binary: '0x60806040',
      new: async (): Promise<never> => {
        throw new Error('must not be reached');
      },
    };
    await expect(
      context.toolkit.hostDeploy(abstraction as never, [1, { overwrite: false }]),
    ).rejects.toThrow(CheatcodeSlotCollisionError);
  });
});

/*
 * The degraded-output channel, made truthful (Eric's review, r3739084431):
 * `captureEngineWarnings` had zero production callers and the two silent
 * accepts of a non-`'unique'` artifact resolution never told anyone. Both
 * suites below drive the REAL toolkit — the real environment seam's
 * `env.artifacts` (a real ambiguity index over a real `build-info`
 * directory) and the real `@openzeppelin/upgrades-core` engine — because
 * that is the one combination that proves the *wiring*, not merely the
 * capture mechanism `output/engine.ts`'s own suite already covers with
 * synthetic writes.
 *
 * `realToolkitProject` materializes a `ladder-corpus.json` standalone
 * compile onto a real temp directory, matching TronBox's own on-disk shape
 * closely enough for `deriveValidationInput`'s unmocked `fs.existsSync` /
 * `fs.readFileSync` / `fileSystemBuildInfoReader.read` to succeed.
 */
describe('the degraded-output channel is truthful: every capturable engine call and both indeterminate-resolution accepts now disclose (r3739084431)', () => {
  it('validateImplementation records artifact-name-indeterminate when env.artifacts.resolve reports non-unique', async () => {
    const project = realToolkitProject({
      standaloneId: 'stateless',
      withMalformedCompanion: true,
    });
    const context = await createOperationToolkit({
      handles: project.shape.handles,
      rawOptions: { kind: 'transparent' },
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });

    await context.toolkit.validateImplementation(project.contractName, context.resolved);

    const note = context.toolkit.channel.recorded.find(
      entry => entry.code === 'artifact-name-indeterminate',
    );
    expect(note).toBeDefined();
    expect(note?.summary).toBe(
      `${project.contractName}: the build-info index could not be built, so artifact-name collisions could not be checked.`,
    );
    expect(note?.detail).toEqual([
      'The abstraction still came from the host resolver for this exact name.',
    ]);
    expect(note?.remedy).toBe(
      'Run `tronbox compile --all` to rebuild the build-info directory, or rename the colliding contract.',
    );
  });

  it('validateImplementation surfaces a real engine.validate() Note as engine-note on the channel', async () => {
    // The reinitializer-note standalone: a base contract's function carries a
    // modifier literally named `reinitializer`, which upstream's
    // `dist/validate/run/initializer.js:getPossibleInitializers` reports with
    // `logNote` — verified directly against the installed engine (not only
    // asserted here) to fire exactly once for this fixture, unconditional on
    // the derived contract's own (empty) error list.
    const project = realToolkitProject({ standaloneId: 'reinitializer-note' });
    const context = await createOperationToolkit({
      handles: project.shape.handles,
      rawOptions: { kind: 'transparent' },
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });

    // The capture window's own reason for existing: prove the engine's write
    // never reaches the terminal raw. A spy rather than a fixed console.error
    // reference, because `captureEngineWarnings` saves-and-restores whatever
    // is installed when it opens — restoring past the wiring gap this task
    // closes would otherwise go unnoticed by an assertion that only checked
    // `channel.recorded`.
    const rawWrites: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]): void => {
      rawWrites.push(args);
    };
    try {
      await context.toolkit.validateImplementation(project.contractName, context.resolved);
    } finally {
      console.error = originalConsoleError;
    }

    expect(
      rawWrites.some(args =>
        args.some(
          arg => typeof arg === 'string' && arg.includes('Reinitializers are not included'),
        ),
      ),
    ).toBe(false);

    const note = context.toolkit.channel.recorded.find(
      entry => entry.code === 'engine-note',
    );
    expect(note).toBeDefined();
    expect(note?.summary).toBe(
      'Reinitializers are not included in validations by default',
    );
  });
});

/*
 * The positional-overloads refusal: the old Hardhat/Truffle-shaped API also
 * accepted an options object where `args` now lives. `assertNoOptionsInArgsPosition`
 * is the guard every operation with a positional `args` calls first, before
 * anything else — these tests pin the pure function directly, independent of
 * which operation wires it in.
 */
describe('assertNoOptionsInArgsPosition — the dropped positional-overloads shape', () => {
  it('passes an array through untouched, empty or not', () => {
    expect(() =>
      assertNoOptionsInArgsPosition('deployProxy', [], DEPLOY_PROXY_ACCEPTED_OPTIONS),
    ).not.toThrow();
    expect(() =>
      assertNoOptionsInArgsPosition('deployProxy', [42, 'x'], DEPLOY_PROXY_ACCEPTED_OPTIONS),
    ).not.toThrow();
  });

  it('refuses an options-shaped object by name, naming the recognised keys', () => {
    let caught: OptionsInArgsPositionError | undefined;
    try {
      assertNoOptionsInArgsPosition(
        'deployProxy',
        { initializer: false },
        DEPLOY_PROXY_ACCEPTED_OPTIONS,
      );
    } catch (error) {
      caught = error as OptionsInArgsPositionError;
    }
    expect(caught).toBeInstanceOf(OptionsInArgsPositionError);
    expect(caught?.operation).toBe('deployProxy');
    expect(caught?.looksLikeOptions).toBe(true);
    expect(caught?.message).toContain('deployProxy');
    expect(caught?.message).toContain('options object');
  });

  it('still refuses a non-array that carries no recognised option key, with a generic message', () => {
    let caught: OptionsInArgsPositionError | undefined;
    try {
      assertNoOptionsInArgsPosition('deployBeaconProxy', 'oops', UPGRADE_PROXY_ACCEPTED_OPTIONS);
    } catch (error) {
      caught = error as OptionsInArgsPositionError;
    }
    expect(caught).toBeInstanceOf(OptionsInArgsPositionError);
    expect(caught?.looksLikeOptions).toBe(false);
    expect(caught?.receivedType).toBe('string');
  });

  it('refuses null the same way — typeof null is "object" but it carries no keys', () => {
    let caught: OptionsInArgsPositionError | undefined;
    try {
      assertNoOptionsInArgsPosition('deployProxy', null, DEPLOY_PROXY_ACCEPTED_OPTIONS);
    } catch (error) {
      caught = error as OptionsInArgsPositionError;
    }
    expect(caught).toBeInstanceOf(OptionsInArgsPositionError);
    expect(caught?.looksLikeOptions).toBe(false);
  });
});
