// Imported FIRST, ahead of every other project import — see its own doc
// comment. This file's new "real seam" suite below is the first in
// `toolkit-seam.test.ts` to open a real record session (every earlier suite
// here runs in `validate-only` mode, which opens none), so it is the first
// suite in this file for which the ordering matters.
import { restoreRecordDir } from './helpers/prime-record-dir';

import { afterAll, describe, expect, it } from 'vitest';

import { assertNoOptionsInArgsPosition, createOperationToolkit } from '../src/proxy/toolkit';
import { DEPLOY_PROXY_ACCEPTED_OPTIONS } from '../src/proxy/deploy-proxy';
import { UPGRADE_PROXY_ACCEPTED_OPTIONS } from '../src/proxy/upgrade-proxy';
import { BEACON_ACCEPTED_OPTIONS } from '../src/beacon';
import { forceImport } from '../src/adopt';
import { ImplementationNotPreviouslyDeployedError, OptionsInArgsPositionError } from '../src/proxy/errors';
import { UnknownOptionError } from '../src/options';
import { CheatcodeSlotCollisionError, LinkVerificationFailedError } from '../src/deploy';
import { migrateShapedHandles } from './helpers/handles';
import { realToolkitProject } from './helpers/toolkit-project';
import { MAINNET_CHAIN_ID, mainnetFirstBlockHash, mainnetGenesisHash } from './helpers/chain-fixtures';

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
 * `unsafeAllow: ['external-library-linking']` flipping a REAL engine verdict
 * (review §6 gap 3) — post-B1 the flag genuinely reaches
 * `resolved.validation.unsafeAllowLinkedLibraries` (the suite above pins the
 * wiring), and this is the behavioural proof: driven through the REAL
 * toolkit's `validateImplementation`, over `linked-library` — a corpus
 * contract whose bytecode carries a genuine unresolved link reference for a
 * public library function (`test/fixtures/upgrade-pairs.json`'s
 * `standalone.linked-library`; verified in the regenerated corpus to carry
 * `linkReferences: { 'Box.sol': { LinkedMath: [...] } }`), refused by the
 * engine's own `getLinkingErrors` unless the opt-out is granted.
 */
describe('validateImplementation — unsafeAllow flips a REAL engine verdict over a linked-library corpus contract (review §6 gap 3)', () => {
  it('refuses the linked library by name without the opt-out, and accepts it with unsafeAllow', async () => {
    const project = realToolkitProject({ standaloneId: 'linked-library' });

    const refused = await createOperationToolkit({
      handles: project.shape.handles,
      rawOptions: {},
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });
    // The wiring this test's behaviour rests on, asserted rather than assumed.
    expect(refused.resolved.unsafeAllowLinkedLibraries).toBe(false);

    let caught: unknown;
    try {
      await refused.toolkit.validateImplementation(project.contractName, refused.resolved);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('is not upgrade-safe');
    // The engine's own diagnosis text for THIS error kind
    // (`upgrades-core/dist/validate/report.js`'s `external-library-linking`
    // entry) — never a generic "is not upgrade-safe" that could equally be
    // any other refusal this fixture happens not to trigger.
    expect((caught as Error).message).toContain('external libraries');
    expect((caught as Error).message).toContain('LinkedMath');

    const accepted = await createOperationToolkit({
      handles: project.shape.handles,
      rawOptions: { unsafeAllow: ['external-library-linking'] },
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });
    expect(accepted.resolved.unsafeAllowLinkedLibraries).toBe(true);
    const validated = await accepted.toolkit.validateImplementation(
      project.contractName,
      accepted.resolved,
    );
    expect(validated.name).toBe(project.contractName);
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

/*
 * `fetchOrDeployImplementation`'s `redeployImplementation: 'never'` gate —
 * driven through the REAL `createOperationToolkit`, the REAL
 * `@openzeppelin/upgrades-core` engine, and a REAL (in-process, no
 * filesystem-adjacent-to-a-live-node) record session — never the recording
 * fake `test/proxy-operations.test.ts` uses for its own ordering pins.
 *
 * That fake reimplements the gate's intended contract as a second,
 * independent piece of logic (documented on its own `fetchOrDeployImplementation`
 * doc comment); it is a faithful mirror, but it cannot catch a defect in the
 * ONE line of production code the gate actually is
 * (`proxy/toolkit.ts`'s `fetchOrDeployImplementation`) — deleting that line
 * leaves every fake-driven test green. This suite exists to close exactly
 * that gap, with the narrowest reasonable pin: one refusal, through the real
 * seam, over an empty record.
 */
/**
 * A minimal, in-memory chain handle answering exactly the JSON-RPC methods
 * the real-seam suites below need before they ever reach the code under
 * test: `eth_chainId` (both `createChainAccess`'s own construction-time
 * probe and, later, the engine's own `Manifest.forNetwork` inside
 * `fetchOrDeployGetDeployment`) and `eth_getBlockByNumber` at `'0x0'` and
 * `'0x1'` (`openRecord`'s own preflight step 2, the chain-identity read
 * `src/record/session.ts` performs before the manifest is ever touched).
 * The mainnet genesis/first-block hashes are the same fixture
 * `chain-instance-identity.test.ts` uses, chosen because their last four
 * bytes agree with `MAINNET_CHAIN_ID` — the identity read's own
 * genesis/chain-id cross-check would otherwise refuse this pair as two
 * disagreeing chains. No other method is answered, deliberately: neither
 * suite below reaches `eth_getTransactionByHash`, the dev-network probes, or
 * anything else a *positive*-arm or retry-suppression seam test would need.
 * (Those wider arms are a separate, already-scoped test batch — these are
 * one pin apiece.)
 */
function realSeamChainHandle(): { tronWrap: unknown } {
  return {
    tronWrap: {
      trx: {},
      fullNode: {
        host: 'http://real-seam-never-gate.invalid:8090',
        request: async (
          _url: string,
          payload: unknown,
          httpMethod: 'get' | 'post',
        ): Promise<unknown> => {
          if (httpMethod === 'get') {
            return {};
          }
          const envelope = payload as {
            readonly id: unknown;
            readonly method: string;
            readonly params?: readonly unknown[];
          };
          const respond = (result: unknown): unknown => ({
            jsonrpc: '2.0',
            id: envelope.id,
            result,
          });
          if (envelope.method === 'eth_chainId') {
            return respond(MAINNET_CHAIN_ID);
          }
          if (envelope.method === 'eth_getBlockByNumber') {
            const tag = envelope.params?.[0];
            if (tag === '0x0') {
              return respond({ hash: mainnetGenesisHash });
            }
            if (tag === '0x1') {
              return respond({ hash: mainnetFirstBlockHash });
            }
            return respond(null);
          }
          throw new Error(
            `real-seam fixture has no answer for ${envelope.method} — ` +
              'this test is meant to reach nothing else before its own throw',
          );
        },
      },
    },
  };
}

// Shared by both real-seam suites below; runs once for the whole file.
afterAll(() => {
  restoreRecordDir();
});

describe("fetchOrDeployImplementation's 'never' gate — the REAL production seam", () => {
  it('refuses by name, through the real seam, before the real deploy thunk ever runs — nothing recorded for this version', async () => {
    const shape = migrateShapedHandles();
    const context = await createOperationToolkit({
      handles: { ...shape.handles, ...realSeamChainHandle() },
      rawOptions: { redeployImplementation: 'never' },
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      // The REAL view, deliberately (unlike every `validate-only` test
      // above, which passes a fresh `{}` because it never opens a record):
      // the engine reads `MANIFEST_DEFAULT_DIR` straight off `process.env`,
      // primed above at module scope, so `configureRecordLocation`'s own
      // bookkeeping has to read the identical view or the two disagree
      // about which directory is in force — `RecordLocationUnusableError`,
      // measured hitting this exact mismatch while writing this test.
      processEnv: process.env,
    });
    expect(context.resolved.redeployImplementation).toBe('never');

    let deployCalled = false;
    const validated = {
      name: 'RealSeamNeverGateBox',
      input: {} as never,
      validations: {},
      // A key this suite's fresh, redirected `MANIFEST_DEFAULT_DIR` cannot
      // already hold a deployment for — the empty-record arm this test pins.
      version: { linkedWithoutMetadata: 'real-seam-never-gate' },
      layout: {},
      encodedArgs: '0x',
    };

    await expect(
      context.toolkit.fetchOrDeployImplementation(
        validated as never,
        context.resolved,
        async () => {
          deployCalled = true;
          return {
            address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
            transactionHash: 'aa'.repeat(32),
          };
        },
      ),
    ).rejects.toBeInstanceOf(ImplementationNotPreviouslyDeployedError);
    // The real deploy thunk — the stand-in for `hostDeploy` — never ran.
    expect(deployCalled).toBe(false);
  });
});

/*
 * The 'never' gate is inert for adoption on two independent grounds (see
 * `ImplementationNotPreviouslyDeployedError`'s own doc comment): neither
 * `redeployImplementation` nor `useDeployedImplementation` is in
 * `FORCE_IMPORT_ACCEPTED_OPTIONS`, and `runForceImport` overrides the field
 * unconditionally on the two calls it does make. This suite pins the FIRST
 * ground's public face — the PUBLIC `forceImport(...)`, not `runForceImport`
 * against an already-built context — because that is the one a caller
 * actually calls, and the one that has to refuse before adoption's own logic
 * (the on-chain code comparison, the replay/conflict checks) ever runs at
 * all. Driven through the real seam for the same reason the suite above is:
 * `forceImport` always builds its toolkit in `state-changing` mode (it takes
 * no `mode` option), so there is no lighter-weight way to reach the option
 * resolver it calls through.
 */
describe('forceImport refuses either redeploy-policy spelling before adoption runs', () => {
  it.each(['redeployImplementation', 'useDeployedImplementation'] as const)(
    '%s is not in FORCE_IMPORT_ACCEPTED_OPTIONS, so the public forceImport refuses it with UnknownOptionError before runForceImport is ever reached',
    async key => {
      const shape = migrateShapedHandles();
      const rawOptions =
        key === 'redeployImplementation'
          ? { redeployImplementation: 'never' }
          : { useDeployedImplementation: true };

      await expect(
        forceImport(
          'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
          // Never inspected: the resolver's unknown-key check is the FIRST
          // check step, and it throws before `runForceImport` reads
          // anything off this abstraction (its own `nameOf` call, the code
          // comparison, all of it).
          { contractName: 'Box', abi: [] } as never,
          { ...shape.handles, ...realSeamChainHandle(), ...rawOptions } as never,
        ),
      ).rejects.toBeInstanceOf(UnknownOptionError);
    },
  );
});
