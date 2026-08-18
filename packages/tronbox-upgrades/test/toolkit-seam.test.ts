// Imported FIRST, ahead of every other project import — see its own doc
// comment. This file's new "real seam" suite below is the first in
// `toolkit-seam.test.ts` to open a real record session (every earlier suite
// here runs in `validate-only` mode, which opens none), so it is the first
// suite in this file for which the ordering matters.
import { RECORD_DIR, restoreRecordDir } from './helpers/prime-record-dir';

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getStorageUpgradeReport, InvalidDeployment } from '@openzeppelin/upgrades-core';

import { assertNoOptionsInArgsPosition, createOperationToolkit } from '../src/proxy/toolkit';
import { DEPLOY_PROXY_ACCEPTED_OPTIONS } from '../src/proxy/deploy-proxy';
import {
  DEPLOY_IMPLEMENTATION_ACCEPTED_OPTIONS,
  runPrepareUpgrade,
} from '../src/standalone';
import { UPGRADE_PROXY_ACCEPTED_OPTIONS } from '../src/proxy/upgrade-proxy';
import {
  DEPLOY_BEACON_ACCEPTED_OPTIONS,
  DEPLOY_BEACON_PROXY_ACCEPTED_OPTIONS,
  UPGRADE_BEACON_ACCEPTED_OPTIONS,
  deployBeacon,
  deployBeaconProxy,
  upgradeBeacon,
} from '../src/beacon';
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
  it.each([
    [
      'hostDeploy',
      (context: Awaited<ReturnType<typeof createOperationToolkit>>) =>
        context.toolkit.hostDeploy({ contractName: 'Box' } as never, []),
    ],
    [
      'callThroughFacade',
      (context: Awaited<ReturnType<typeof createOperationToolkit>>) =>
        context.toolkit.callThroughFacade({
          facadeName: 'ProxyAdmin',
          at: 'T...',
          method: 'upgradeAndCall',
          args: [],
        }),
    ],
  ] as const)('%s is an explicit validate-only stub', async (member, invoke) => {
    const shape = migrateShapedHandles();
    const context = await createOperationToolkit({
      handles: shape.handles,
      rawOptions: {},
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });

    await expect(Promise.resolve().then(() => invoke(context))).rejects.toThrow(
      `internal error: ${member} was reached from a validate-only operation`,
    );
  });

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

  it.each([
    ['deployBeacon', DEPLOY_BEACON_ACCEPTED_OPTIONS],
    ['upgradeBeacon', UPGRADE_BEACON_ACCEPTED_OPTIONS],
    ['deployBeaconProxy', DEPLOY_BEACON_PROXY_ACCEPTED_OPTIONS],
  ] as const)('%s refuses `kind` at runtime — its own list, not a shared one', async (_name, acceptedOptions) => {
    // Executed, not read from the type: a JS caller who bypasses the (now
    // fixed) DeployBeaconOptions/UpgradeBeaconOptions/DeployBeaconProxyOptions
    // type-level refusal and hands `kind` to the real resolver still gets
    // refused. Each beacon operation now passes its OWN accepted-options
    // constant (`beacon/index.ts`) rather than one list shared across all
    // three — this pin covers each one individually so a future re-merge back
    // into a shared list would fail here first.
    const shape = migrateShapedHandles();
    await expect(
      createOperationToolkit({
        handles: shape.handles,
        rawOptions: { kind: 'beacon' },
        acceptedOptions,
        processEnv: {},
        mode: 'validate-only',
      }),
    ).rejects.toBeInstanceOf(UnknownOptionError);
  });

  /*
   * The split's whole point, pinned at the runtime boundary: each beacon
   * operation's own accepted-options list now contains exactly what it
   * consumes, so an option genuinely dead for THAT operation is refused by
   * name — never silently accepted and ignored (the exact defect class
   * `README.md`'s "an option an operation does not accept is refused by
   * name" sentence promises, and which the old shared `BEACON_ACCEPTED_OPTIONS`
   * broke for nine members on `deployBeaconProxy` alone). One representative
   * inert option per operation, chosen to differ from the other two so the
   * three pins together cover three distinct reasons an option can be dead:
   * no proxy to initialize (`deployBeacon`), no owner to (re)set
   * (`upgradeBeacon`), and no implementation to validate or deploy
   * (`deployBeaconProxy`).
   */
  it('deployBeacon refuses `initializer` — inert there: no proxy is ever deployed, so nothing calls encodeInitializer', async () => {
    const shape = migrateShapedHandles();
    await expect(
      createOperationToolkit({
        handles: shape.handles,
        rawOptions: { initializer: 'setUp' },
        acceptedOptions: DEPLOY_BEACON_ACCEPTED_OPTIONS,
        processEnv: {},
        mode: 'validate-only',
      }),
    ).rejects.toBeInstanceOf(UnknownOptionError);
  });

  it('upgradeBeacon refuses `initialOwner` — inert there: the beacon\'s owner is set once, at deployBeacon, and an upgrade never touches it', async () => {
    const shape = migrateShapedHandles();
    await expect(
      createOperationToolkit({
        handles: shape.handles,
        rawOptions: { initialOwner: 'TJmmqjb1DK9TTZbQXzRQ2AuA94z4gKAPFh' },
        acceptedOptions: UPGRADE_BEACON_ACCEPTED_OPTIONS,
        processEnv: {},
        mode: 'validate-only',
      }),
    ).rejects.toBeInstanceOf(UnknownOptionError);
  });

  it('deployBeaconProxy refuses `redeployImplementation` — inert there: it deploys the BeaconProxy only, never an implementation', async () => {
    const shape = migrateShapedHandles();
    await expect(
      createOperationToolkit({
        handles: shape.handles,
        rawOptions: { redeployImplementation: 'always' },
        acceptedOptions: DEPLOY_BEACON_PROXY_ACCEPTED_OPTIONS,
        processEnv: {},
        mode: 'validate-only',
      }),
    ).rejects.toBeInstanceOf(UnknownOptionError);
  });

  it('deployBeacon still resolves every option it actually consumes', async () => {
    const shape = migrateShapedHandles();
    const context = await createOperationToolkit({
      handles: shape.handles,
      rawOptions: {
        constructorArgs: [1],
        initialOwner: 'TJmmqjb1DK9TTZbQXzRQ2AuA94z4gKAPFh',
        unsafeAllow: ['constructor'],
        redeployImplementation: 'always',
      },
      acceptedOptions: DEPLOY_BEACON_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });
    expect(context.resolved.constructorArgs).toEqual([1]);
    expect(context.resolved.initialOwner).toBe('TJmmqjb1DK9TTZbQXzRQ2AuA94z4gKAPFh');
    expect(context.resolved.redeployImplementation).toBe('always');
    expect(context.resolved.engineOptions['unsafeAllow']).toEqual(['constructor']);
  });

  /*
   * Fix round 1 (owner's scoping correction): `deployBeacon` ACCEPTS
   * `unsafeAllowRenames`/`unsafeSkipStorageCheck` — an earlier pass at this
   * list refused them, on the theory that OUR code never reads them for a
   * fresh deploy. That theory is right about our code and wrong about the
   * rule: the engine ignoring an option for one operation is not the same
   * as that operation refusing it, and refusing it here would diverge from
   * `deployProxy`/`deployImplementation`/`validateImplementation`/
   * `forceImport`, which all accept the identical pair for the identical
   * reason. This pins ACCEPTANCE (no throw, threaded into `engineOptions`
   * exactly like `upgradeBeacon`'s) — the inertness itself is proven by
   * execution in the "genuinely inert for a fresh deploy" suite below.
   */
  it('deployBeacon accepts unsafeAllowRenames/unsafeSkipStorageCheck — the engine ignores them for a fresh deploy, but that is not this operation refusing them', async () => {
    const shape = migrateShapedHandles();
    const context = await createOperationToolkit({
      handles: shape.handles,
      rawOptions: { unsafeAllowRenames: true, unsafeSkipStorageCheck: true },
      acceptedOptions: DEPLOY_BEACON_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });
    expect(context.resolved.engineOptions['unsafeAllowRenames']).toBe(true);
    expect(context.resolved.engineOptions['unsafeSkipStorageCheck']).toBe(true);
  });

  it('upgradeBeacon still resolves every option it actually consumes, including the storage-check pair — genuinely load-bearing here, merely accepted-and-forwarded on deployBeacon', async () => {
    const shape = migrateShapedHandles();
    const context = await createOperationToolkit({
      handles: shape.handles,
      rawOptions: {
        constructorArgs: [1],
        unsafeAllowRenames: true,
        unsafeSkipStorageCheck: true,
        redeployImplementation: 'onchange',
      },
      acceptedOptions: UPGRADE_BEACON_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });
    expect(context.resolved.constructorArgs).toEqual([1]);
    expect(context.resolved.redeployImplementation).toBe('onchange');
    expect(context.resolved.engineOptions['unsafeAllowRenames']).toBe(true);
    expect(context.resolved.engineOptions['unsafeSkipStorageCheck']).toBe(true);
  });

  it('deployBeaconProxy still resolves the one option it actually consumes', async () => {
    const shape = migrateShapedHandles();
    const context = await createOperationToolkit({
      handles: shape.handles,
      rawOptions: { initializer: 'setUp' },
      acceptedOptions: DEPLOY_BEACON_PROXY_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });
    expect(context.resolved.initializer).toBe('setUp');
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
 * The REAL toolkit is built here through `createOperationToolkit`, never a
 * fake `hostDeploy`, because a fake toolkit's `hostDeploy` is exactly the
 * thing under test and would make this tautological.
 */
describe('hostDeploy verifies linking before it deploys (review §3 M4)', () => {
  it('refuses bytecode with an unresolved placeholder even under the linking opt-out, before any deploy attempt', async () => {
    const shape = migrateShapedHandles();
    const context = await createOperationToolkit({
      handles: { ...shape.handles, ...realSeamChainHandle() },
      rawOptions: { unsafeAllow: ['external-library-linking'] },
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: process.env,
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
      handles: { ...shape.handles, ...realSeamChainHandle() },
      rawOptions: {},
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: process.env,
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
 * Fix round 1's central execution proof: `unsafeAllowRenames` and
 * `unsafeSkipStorageCheck` are read at exactly one site anywhere in the
 * installed engine — `getStorageUpgradeReport`
 * (`upgrades-core/dist/storage/index.js:54` for the skip-check short-circuit,
 * `:64` for the comparator's rename tolerance) — which our own
 * `assertStorageCompatible` (`proxy/toolkit.ts`) calls unmodified. This drives
 * that REAL, installed function directly, with two minimal hand-built
 * `StorageLayout` objects (the public shape `storage/layout.d.ts` declares;
 * no corpus compile needed, since a bare rename or type change needs no
 * Solidity source to demonstrate), proving both flags genuinely flip a real
 * verdict — which is the fact that makes them worth accepting on every
 * validating operation rather than dropping them.
 */
describe('unsafeAllowRenames/unsafeSkipStorageCheck flip a REAL storage-comparison verdict — the pair\'s one actual read site', () => {
  const numberType = { label: 'uint256', numberOfBytes: '32' };

  it('unsafeAllowRenames: a bare label change is flagged without it, cleared with it', () => {
    const original = {
      storage: [
        { contract: 'V1', label: 'x', type: 't_uint256', src: 'file.sol:1', offset: 0, slot: '0' },
      ],
      types: { t_uint256: numberType },
    };
    const updated = {
      storage: [
        { contract: 'V2', label: 'renamed', type: 't_uint256', src: 'file.sol:1', offset: 0, slot: '0' },
      ],
      types: { t_uint256: numberType },
    };
    const baseOpts = {
      kind: 'transparent' as const,
      unsafeAllow: [],
      unsafeAllowCustomTypes: false,
      unsafeAllowLinkedLibraries: false,
      unsafeAllowRenames: false,
      unsafeSkipStorageCheck: false,
    };

    const withoutFlag = getStorageUpgradeReport(original, updated, baseOpts);
    expect(withoutFlag.ok).toBe(false);

    const withFlag = getStorageUpgradeReport(original, updated, {
      ...baseOpts,
      unsafeAllowRenames: true,
    });
    expect(withFlag.ok).toBe(true);
  });

  it('unsafeSkipStorageCheck: a genuine type change is flagged without it, bypassed entirely with it', () => {
    const original = {
      storage: [
        { contract: 'V1', label: 'x', type: 't_uint256', src: 'file.sol:1', offset: 0, slot: '0' },
      ],
      types: { t_uint256: numberType },
    };
    const updated = {
      storage: [
        { contract: 'V2', label: 'x', type: 't_string_storage', src: 'file.sol:1', offset: 0, slot: '0' },
      ],
      types: { t_string_storage: { label: 'string', numberOfBytes: '32' } },
    };
    const baseOpts = {
      kind: 'transparent' as const,
      unsafeAllow: [],
      unsafeAllowCustomTypes: false,
      unsafeAllowLinkedLibraries: false,
      unsafeAllowRenames: false,
      unsafeSkipStorageCheck: false,
    };

    const withoutFlag = getStorageUpgradeReport(original, updated, baseOpts);
    expect(withoutFlag.ok).toBe(false);

    const withFlag = getStorageUpgradeReport(original, updated, {
      ...baseOpts,
      unsafeSkipStorageCheck: true,
    });
    expect(withFlag.ok).toBe(true);
  });
});

/*
 * The other half of the same proof: the identical pair, accepted by
 * `deployBeacon` (post-round-1) and driven through the REAL toolkit's
 * `validateImplementation` over a real compiled corpus contract, produces NO
 * verdict change whatsoever — confirming by execution, not merely by reading
 * `processExceptions`'s source, that the engine call `deployBeacon` actually
 * makes (`getErrors`, never `getStorageUpgradeReport`) is genuinely blind to
 * both flags.
 */
describe('the same pair is genuinely inert for deployBeacon\'s own validation path — accepted, forwarded, no verdict change', () => {
  it('validateImplementation over a clean standalone contract resolves identically with the flags on or off', async () => {
    const project = realToolkitProject({ standaloneId: 'stateless' });

    const without = await createOperationToolkit({
      handles: project.shape.handles,
      rawOptions: {},
      acceptedOptions: DEPLOY_BEACON_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });
    const withFlags = await createOperationToolkit({
      handles: project.shape.handles,
      rawOptions: { unsafeAllowRenames: true, unsafeSkipStorageCheck: true },
      acceptedOptions: DEPLOY_BEACON_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });
    // The wiring this test's behaviour rests on: the flags really did reach
    // `engineOptions` differently, so an identical outcome below is not an
    // accident of both calls carrying the same value.
    expect(without.resolved.engineOptions['unsafeAllowRenames']).toBe(false);
    expect(withFlags.resolved.engineOptions['unsafeAllowRenames']).toBe(true);
    expect(without.resolved.engineOptions['unsafeSkipStorageCheck']).toBe(false);
    expect(withFlags.resolved.engineOptions['unsafeSkipStorageCheck']).toBe(true);

    const validatedWithout = await without.toolkit.validateImplementation(
      project.contractName,
      without.resolved,
    );
    const validatedWithFlags = await withFlags.toolkit.validateImplementation(
      project.contractName,
      withFlags.resolved,
    );
    // Both calls succeed (neither flag causes — or prevents — a refusal),
    // and the derived layout/version data the operation goes on to use is
    // identical either way: the flags reached `getErrors` as extra keys it
    // never reads, exactly as traced against the installed engine source.
    expect(validatedWithFlags.name).toBe(validatedWithout.name);
    expect(validatedWithFlags.layout).toEqual(validatedWithout.layout);
    expect(validatedWithFlags.encodedArgs).toBe(validatedWithout.encodedArgs);
  });
});

/*
 * The clobber regression pin (Eric's review, r3787161941): the round-1 fix
 * removed `validateImplementation`'s `kind: 'transparent'` overwrite of the
 * engine options, and nothing tested the case that fix exists for. The engine
 * filters its uups-only `missing-public-upgradeto` judgement for transparent
 * and beacon (`upgrades-core/dist/validate/overrides.js:86-88`), so under the
 * old clobber `getErrors` answered EMPTY for a UUPS implementation that had
 * dropped its upgrade mechanism — the deploy proceeded, and the eventual
 * upgrade would have removed the proxy's upgradeability. The e2e migrations
 * use UUPS-safe contracts, so only this pair dies if the clobber returns:
 * REAL toolkit, REAL engine, a corpus contract with no upgradeTo/
 * upgradeToAndCall, judged under each kind.
 */
describe('kind:uups over an implementation with no upgrade mechanism — the clobber regression pin (review r3787161941)', () => {
  it('refuses naming the missing upgrade entry point with kind:uups, and accepts the same contract as transparent', async () => {
    // `flat` is a plain storage-layout fixture with no UUPSUpgradeable parent,
    // so it has no upgrade entry point — unsafe as uups, fine as transparent.
    const project = realToolkitProject({ standaloneId: 'flat' });

    const uups = await createOperationToolkit({
      handles: project.shape.handles,
      rawOptions: { kind: 'uups' },
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });
    // The wiring the refusal below rests on: the caller's kind genuinely
    // reached the engine options — under the old clobber this read
    // 'transparent' whatever the caller passed.
    expect(uups.resolved.engineOptions['kind']).toBe('uups');

    let caught: unknown;
    try {
      await uups.toolkit.validateImplementation(project.contractName, uups.resolved);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('is not upgrade-safe');
    // The engine's own diagnosis for THIS judgement — never a generic refusal
    // this fixture happens to trigger some other way.
    expect((caught as Error).message).toMatch(/upgradeTo/);

    const transparent = await createOperationToolkit({
      handles: project.shape.handles,
      rawOptions: { kind: 'transparent' },
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });
    const validated = await transparent.toolkit.validateImplementation(
      project.contractName,
      transparent.resolved,
    );
    expect(validated.name).toBe(project.contractName);
  });

  it('prepareUpgrade with no caller kind derives uups from the proxy slots and the real engine refuses the entry-point-less candidate (F4)', async () => {
    // The composition the deep review's finding 4 demands: nothing in the
    // options names a kind, the referenced proxy's slots do (empty admin
    // slot = uups), and that derived kind must reach the REAL `getErrors` —
    // under the pre-fix code both validation calls judged with an omitted
    // kind, the candidate self-inferred transparent, and this exact refusal
    // was filtered.
    const project = realToolkitProject({ standaloneId: 'flat' });
    const context = await createOperationToolkit({
      handles: project.shape.handles,
      rawOptions: {},
      acceptedOptions: DEPLOY_IMPLEMENTATION_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });
    // Validation throws before any deployer/queue/record member is touched,
    // so the only chain member this path consults is the slot read.
    const bound = {
      ...context,
      toolkit: {
        ...context.toolkit,
        proxySlots: async () => ({
          kind: 'code' as const,
          implementation: '0x' + 'ab'.repeat(20),
          admin: null,
          beacon: null,
        }),
      },
    };
    let caught: unknown;
    try {
      await runPrepareUpgrade(
        bound,
        '0x' + 'cd'.repeat(20),
        { contractName: project.contractName } as never,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('is not upgrade-safe');
    expect((caught as Error).message).toMatch(/upgradeTo/);
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
describe('the degraded-output channel is truthful: every capturable engine call and the single indeterminate-resolution emit site disclose', () => {
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

/**
 * The engine's own manifest file for `realSeamChainHandle`'s and
 * `realSeamRetryChainHandle`'s shared `MAINNET_CHAIN_ID` — `unknown-<decimal
 * chain id>.json`, per `Manifest`'s own naming (`dist/manifest.js`) and
 * `src/chain/instance.ts`'s doc comment, which names the identical decimal
 * for mainnet. Every real-seam suite below that seeds a stored implementation
 * writes into this one file, directly, bypassing the engine's own lock —
 * safe because Vitest runs this file's tests sequentially and each seed runs
 * before the toolkit call that reads it.
 */
const REAL_SEAM_MANIFEST_FILE = path.join(
  RECORD_DIR,
  `unknown-${String(parseInt(MAINNET_CHAIN_ID.slice(2), 16))}.json`,
);

interface SeededManifestData {
  manifestVersion: string;
  impls: Record<string, { address: string }>;
  proxies: unknown[];
}

/**
 * Seeds (read-merge, never overwrite) an implementation entry for
 * `versionKey` at `address`, with no `txHash` — the shape that drives the
 * engine's `validateStoredDeployment` down its "no code" branch rather than
 * its "look up the transaction" one. Read-merge because every real-seam
 * suite below shares this one manifest file for the run.
 */
function seedManifestImplementation(versionKey: string, address: string): void {
  const existing: SeededManifestData = fs.existsSync(REAL_SEAM_MANIFEST_FILE)
    ? (JSON.parse(fs.readFileSync(REAL_SEAM_MANIFEST_FILE, 'utf8')) as SeededManifestData)
    // Mirrors the installed engine's `currentManifestVersion`; revisit this
    // literal with an engine upgrade so the seed stays on its supported version.
    : { manifestVersion: '3.2', impls: {}, proxies: [] };
  existing.impls[versionKey] = { address };
  fs.mkdirSync(path.dirname(REAL_SEAM_MANIFEST_FILE), { recursive: true });
  fs.writeFileSync(REAL_SEAM_MANIFEST_FILE, JSON.stringify(existing, null, 2));
}

/**
 * A wider real-seam chain handle for the removed-retry suites below —
 * `realSeamChainHandle` above answers only what an EMPTY record needs, and
 * says so; a stored (and here, invalid) entry needs more, traced by running
 * the suites below against progressively answered fixtures until nothing
 * else threw:
 *
 * - `web3_clientVersion`: `isDevelopmentNetwork`'s second read
 *   (`dist/provider.js:104`), reached once `validateStoredDeployment`'s
 *   no-code check has already thrown `InvalidDeployment` for the stored
 *   entry, and again from `checkForAddressClash` after a successful retry
 *   deploy (`dist/impl-store.js:156`). Answered with a client string naming
 *   neither Hardhat, Anvil nor TestRPC, so the network reads as non-dev on
 *   both call sites — the real-world case this plugin runs against, and the
 *   one where an invalid entry is a hard refusal rather than a silent
 *   redeploy.
 * - `eth_getCode`, per address: the no-code check itself
 *   (`dist/deployment.js:107-110`) for a stored address, and later
 *   `hasCode`'s post-deploy confirmation (`dist/deployment.js:174-184`) for a
 *   freshly deployed one. Unlisted addresses answer `'0x'` — absence IS "no
 *   code", so a stale stored address needs no entry of its own.
 * - `eth_getTransactionReceipt`: the same post-deploy confirmation's
 *   transaction-mined poll (`dist/deployment.js:146-159`), reached only after
 *   a retry's deploy thunk actually ran. Unlisted transaction hashes throw
 *   rather than hang the poll loop, on the same "answer minimally, name what
 *   was not expected" principle as the fallthrough below.
 */
function realSeamRetryChainHandle(options: {
  readonly codeByAddress?: Readonly<Record<string, string>>;
  /**
   * `null` means *configured, and never mined* — the fixture answers the poll
   * with no receipt for as long as it is asked, which is what the engine's own
   * timeout bound is measured against. Distinct from an absent key, which stays
   * a loud "this test reached a transaction nobody declared".
   */
  readonly receiptStatusByTxHash?: Readonly<Record<string, string | null>>;
}): { tronWrap: unknown } {
  const codeByAddress = options.codeByAddress ?? {};
  const receiptStatusByTxHash = options.receiptStatusByTxHash ?? {};
  return {
    tronWrap: {
      trx: {},
      fullNode: {
        host: 'http://real-seam-retry-gate.invalid:8090',
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
          // `anvil_metadata` / `hardhat_metadata` — `Manifest.forNetwork`'s
          // own dev-instance probe — are refused LOCALLY by the chain
          // layer's policy table, before any request is built, so this
          // fixture is never asked for either one.
          if (envelope.method === 'web3_clientVersion') {
            return respond('TronNode/v1.0');
          }
          if (envelope.method === 'eth_getCode') {
            const address = String(envelope.params?.[0] ?? '').toLowerCase();
            return respond(codeByAddress[address] ?? '0x');
          }
          if (envelope.method === 'eth_getTransactionReceipt') {
            const txHash = String(envelope.params?.[0] ?? '');
            if (!(txHash in receiptStatusByTxHash)) {
              throw new Error(
                `real-seam retry fixture has no receipt configured for ${txHash}`,
              );
            }
            const status = receiptStatusByTxHash[txHash];
            return status === null ? respond(null) : respond({ status });
          }
          throw new Error(
            `real-seam retry fixture has no answer for ${envelope.method} — ` +
              'name it here if a traced test genuinely needs it',
          );
        },
      },
    },
  };
}

// Shared by every real-seam suite below; runs once for the whole file.
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
 * The removed-retry branch itself (`proxy/toolkit.ts`'s `fetchOrDeployImplementation`,
 * the catch consulting `(error as {removed?: boolean}).removed`) — driven
 * through the same REAL seam as the 'never' gate suite above, never a fake
 * that throws `{removed: true}` or reimplements the gate as a second piece of
 * logic. A stale, no-code stored entry is what makes the engine itself throw
 * `InvalidDeployment` and set `removed = true` on it (`dist/impl-store.js`'s
 * `fetchOrDeployGeneric` catch), which is the only way this branch is
 * genuinely exercised rather than assumed.
 */
describe("fetchOrDeployImplementation's removed-retry branch — the REAL production seam", () => {
  it('retries exactly once after the engine removes an invalid stored entry, and the real deploy thunk runs on that retry alone', async () => {
    const versionKey = 'real-seam-retry-gate';
    const staleAddress = '0x1111111111111111111111111111111111111111';
    const newAddress = '0x2222222222222222222222222222222222222222';
    const newTxHash = 'bb'.repeat(32);
    // No `txHash` on the seeded entry: `validateStoredDeployment` takes the
    // "no code" branch (`dist/deployment.js:106-111`), not the
    // "look up the transaction" one.
    seedManifestImplementation(versionKey, staleAddress);

    const shape = migrateShapedHandles();
    const context = await createOperationToolkit({
      handles: {
        ...shape.handles,
        ...realSeamRetryChainHandle({
          codeByAddress: { [newAddress.toLowerCase()]: '0x6080604052' },
          receiptStatusByTxHash: { [newTxHash]: '0x1' },
        }),
      },
      rawOptions: {},
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: process.env,
    });
    // The retry is only reachable when the policy is not `'never'` — see the
    // no-retry suite below for that arm. The default is `'onchange'`.
    expect(context.resolved.redeployImplementation).toBe('onchange');

    const validated = {
      name: 'RealSeamRetryGateBox',
      input: {} as never,
      validations: {},
      version: { linkedWithoutMetadata: versionKey },
      layout: {},
      encodedArgs: '0x',
    };

    let deployCalls = 0;
    const address = await context.toolkit.fetchOrDeployImplementation(
      validated as never,
      context.resolved,
      async () => {
        deployCalls += 1;
        return { address: newAddress, transactionHash: newTxHash };
      },
    );

    expect(address).toBe(newAddress);
    // Traced before pinning, not assumed: the FIRST `fetch()` fails entirely
    // inside the engine — `validateStoredDeployment` throws over the stale,
    // no-code entry before the engine ever reaches ITS OWN `deploy` argument
    // (this plugin's `'never'`-gate closure, `proxy/toolkit.ts`), which is
    // the only thing that can call the REAL thunk passed in above. So the
    // thunk runs on the retry alone — once, never twice.
    expect(deployCalls).toBe(1);
  });
});

/*
 * The two arms `fetchOrDeployImplementation`'s catch refuses to retry —
 * "refuse" here meaning the ORIGINAL error propagates unchanged, through the
 * same real seam. The second arm doubles as the field-shape canary: it asserts
 * directly against the installed engine's
 * `InvalidDeployment` that `removed` really does read `true` after the
 * engine's own removal path, which is the exact predicate the wrapper's catch
 * reads — so an upstream rename of that field fails this suite loudly rather
 * than silently disabling the retry above. Reproducing that assertion a
 * second time, standalone, would delete-and-retry the SAME stored entry the
 * suite above pins the wrapper's retry over, which would undermine that
 * pin rather than duplicate it safely — so it lives here instead, on the arm
 * that already needs it.
 */
describe("fetchOrDeployImplementation's no-retry arms — the REAL production seam", () => {
  it('an error without removed:true propagates immediately — the real deploy thunk runs exactly once, no retry', async () => {
    const versionKey = 'real-seam-plain-error-gate';
    // No stored entry for this key: the engine calls the real thunk directly
    // on the FIRST `fetch()`, never through `InvalidDeployment` at all.
    const shape = migrateShapedHandles();
    const context = await createOperationToolkit({
      handles: { ...shape.handles, ...realSeamChainHandle() },
      rawOptions: {},
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: process.env,
    });
    expect(context.resolved.redeployImplementation).toBe('onchange');

    const validated = {
      name: 'RealSeamPlainErrorGateBox',
      input: {} as never,
      validations: {},
      version: { linkedWithoutMetadata: versionKey },
      layout: {},
      encodedArgs: '0x',
    };

    const thrown = new Error('the real deploy thunk failed for reasons of its own');
    let deployCalls = 0;
    let caught: unknown;
    try {
      await context.toolkit.fetchOrDeployImplementation(
        validated as never,
        context.resolved,
        async () => {
          deployCalls += 1;
          throw thrown;
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(thrown);
    expect((caught as { removed?: boolean }).removed).not.toBe(true);
    expect(deployCalls).toBe(1);
  });

  it("redeployImplementation: 'never' over an already-invalid stored entry: the engine's own InvalidDeployment escapes as-is, never retried and never the plugin's named refusal", async () => {
    const versionKey = 'real-seam-never-removed-gate';
    const staleAddress = '0x3333333333333333333333333333333333333333';
    seedManifestImplementation(versionKey, staleAddress);

    const shape = migrateShapedHandles();
    const context = await createOperationToolkit({
      handles: { ...shape.handles, ...realSeamRetryChainHandle({}) },
      rawOptions: { redeployImplementation: 'never' },
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: process.env,
    });
    expect(context.resolved.redeployImplementation).toBe('never');

    const validated = {
      name: 'RealSeamNeverRemovedGateBox',
      input: {} as never,
      validations: {},
      version: { linkedWithoutMetadata: versionKey },
      layout: {},
      encodedArgs: '0x',
    };

    let deployCalls = 0;
    let caught: unknown;
    try {
      await context.toolkit.fetchOrDeployImplementation(
        validated as never,
        context.resolved,
        async () => {
          deployCalls += 1;
          return {
            address: '0x4444444444444444444444444444444444444444',
            transactionHash: 'cc'.repeat(32),
          };
        },
      );
    } catch (error) {
      caught = error;
    }
    // The field-shape canary: the engine's removal path really does set
    // `removed` to `true`, non-enumerably, on its own `InvalidDeployment`
    // instance (`dist/impl-store.js`'s `fetchOrDeployGeneric` catch) —
    // asserted directly against the installed engine, not a
    // reimplementation of its predicate.
    expect(caught).toBeInstanceOf(InvalidDeployment);
    expect((caught as { removed?: boolean }).removed).toBe(true);
    expect((caught as Error).message).toContain('No contract at address');
    expect((caught as Error).message).toContain('(Removed from manifest)');
    // Never the plugin's own named refusal: that class fires only over an
    // EMPTY record (the 'never' gate suite above). Here the engine's own
    // cache lookup already rejects a recorded-but-invalid entry before the
    // plugin's closure — the only thing that can throw that named class — is
    // ever invoked, which is the nuance `proxy/toolkit.ts`'s own comment
    // names and this assertion now executes.
    expect(caught).not.toBeInstanceOf(ImplementationNotPreviouslyDeployedError);
    expect(deployCalls).toBe(0);
  });
});

/*
 * `timeout` and `pollingInterval` reaching the engine — the half of that pair's
 * story that used to be missing. The seam passed `{}` as the engine's own
 * `DeployOpts`, which was wrong twice: the resolved values never arrived (the
 * engine fell back to 60s/5s), and upstream reads the argument as `!!opts`, so
 * `{}` still rendered `configurableTimeout: true` — advising the caller to
 * adjust the two options that same call had made inert.
 *
 * Asserted through behavior rather than by inspecting the call: a transaction
 * that is never mined leaves the engine's `waitAndValidateDeployment` polling
 * until ITS bound expires, and the bound is the value under test. With the
 * resolved pair threaded, a 40 ms timeout throws in ~40 ms; with `{}` restored
 * here, the same test sits on upstream's 60-second default and fails on
 * Vitest's own timeout. So the elapsed-time assertion is the pin — and the
 * message assertion is the second half, since the advice upstream prints is
 * now true.
 */
describe("fetchOrDeployImplementation's engine DeployOpts — the REAL production seam", () => {
  it("threads the resolved timeout/pollingInterval into the engine's mined-transaction wait, so a tiny bound expires like one", async () => {
    const versionKey = 'real-seam-deploy-opts-gate';
    const newAddress = '0x5555555555555555555555555555555555555555';
    const neverMinedTxHash = 'dd'.repeat(32);

    const shape = migrateShapedHandles();
    const context = await createOperationToolkit({
      handles: {
        ...shape.handles,
        ...realSeamRetryChainHandle({
          // Deployed, and never mined: no code at the address and no receipt
          // for the transaction, for as long as the engine keeps asking.
          receiptStatusByTxHash: { [neverMinedTxHash]: null },
        }),
      },
      rawOptions: { timeout: 40, pollingInterval: 10 },
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: process.env,
    });
    // The resolver's half, first: these are the values the seam must hand on.
    expect(context.resolved.timeout).toBe(40);
    expect(context.resolved.pollingInterval).toBe(10);

    const validated = {
      name: 'RealSeamDeployOptsGateBox',
      input: {} as never,
      validations: {},
      version: { linkedWithoutMetadata: versionKey },
      layout: {},
      encodedArgs: '0x',
    };

    const startedAt = process.hrtime.bigint();
    let caught: unknown;
    try {
      await context.toolkit.fetchOrDeployImplementation(
        validated as never,
        context.resolved,
        async () => ({ address: newAddress, transactionHash: neverMinedTxHash }),
      );
    } catch (error) {
      caught = error;
    }
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    expect((caught as Error).message).toContain('Timed out waiting for');
    expect((caught as Error).message).toContain(neverMinedTxHash);
    // Upstream appends its own details onto `message` (`dist/error.js`), and
    // this is the advice `{}` used to print over two inert options. It is
    // honest now, which is the point of threading them.
    expect((caught as Error).message).toContain(
      'adjust the polling parameters with the timeout and pollingInterval options',
    );
    // The bound that expired was OURS. Generous by 50× against a 40 ms
    // timeout and still two orders of magnitude under upstream's 60-second
    // default, so this fails on a lost value and not on a slow machine.
    expect(elapsedMs).toBeLessThan(2_000);
    // Measured both ways before this was left standing: threaded, the test
    // runs in ~110 ms; with `{}` put back in the seam, it sits on upstream's
    // 60-second default until the runner kills it. The 5 s per-test timeout
    // below is what turns that regression into a fast failure rather than a
    // minute of silence — the suite's own default is 60 s, which is exactly
    // the value under test.
  }, 5_000);
});

/*
 * The 'never' gate is inert for adoption on two independent grounds (see
 * `ImplementationNotPreviouslyDeployedError`'s own doc comment): neither
 * `redeployImplementation` nor `useDeployedImplementation` is in
 * `FORCE_IMPORT_ACCEPTED_OPTIONS`, and `runForceImport` overrides the field
 * unconditionally on the one engine call it does make (merge on, always —
 * review r3787536670). This suite pins the FIRST
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

/*
 * The pins above and earlier in this file exercise the beacon operations'
 * accepted-options constants
 * DIRECTLY (`createOperationToolkit({ acceptedOptions: DEPLOY_BEACON_ACCEPTED_OPTIONS,
 * ... })`), which proves the LIST refuses the right keys but not that each
 * exported operation is actually WIRED to its own constant — a cross-wiring
 * (e.g. `deployBeacon` accidentally passing `UPGRADE_BEACON_ACCEPTED_OPTIONS`)
 * would leave every one of those pins green. This suite closes that gap: one
 * call per operation through its PUBLIC entry point (`../src/beacon`, not
 * `runDeployBeacon`/`runUpgradeBeacon`/`runDeployBeaconProxy`), each with one
 * option that is genuinely refused —
 * `initializer` for `deployBeacon`, `initialOwner` for `upgradeBeacon`,
 * `redeployImplementation` for `deployBeaconProxy` — so a cross-wiring that
 * pointed any of the three at a DIFFERENT beacon operation's list (all three
 * of which happen to still refuse a nearby option) would need to coincide on
 * every one of the three choices to stay green. The keys maximize cross-wiring
 * detection: with one refused key per operation, four of the six possible
 * wrong constant assignments are the achievable ceiling.
 *
 * Driven through the real seam (`realSeamChainHandle()`, same fixture as the
 * `forceImport` suite above) for the identical reason: none of these three
 * public entries take a `mode` option, so `createOperationToolkit` always
 * opens a real chain connection and a real record session — both of which
 * must succeed BEFORE the option resolver's unknown-key check ever runs.
 */
describe('the beacon operations are wired to their OWN accepted-options constant — proven through the public entry, not the constant directly', () => {
  it('deployBeacon (public entry) refuses `initializer` before validating anything', async () => {
    const shape = migrateShapedHandles();
    await expect(
      deployBeacon(
        { contractName: 'Box', abi: [] } as never,
        { ...shape.handles, ...realSeamChainHandle(), initializer: 'setUp' } as never,
      ),
    ).rejects.toBeInstanceOf(UnknownOptionError);
  });

  it('upgradeBeacon (public entry) refuses `initialOwner` before validating anything', async () => {
    const shape = migrateShapedHandles();
    await expect(
      upgradeBeacon(
        'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        { contractName: 'BoxV2', abi: [] } as never,
        {
          ...shape.handles,
          ...realSeamChainHandle(),
          initialOwner: 'TJmmqjb1DK9TTZbQXzRQ2AuA94z4gKAPFh',
        } as never,
      ),
    ).rejects.toBeInstanceOf(UnknownOptionError);
  });

  it('deployBeaconProxy (public entry) refuses `redeployImplementation` before validating anything', async () => {
    const shape = migrateShapedHandles();
    await expect(
      deployBeaconProxy(
        'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        { contractName: 'Box', abi: [] } as never,
        [],
        { ...shape.handles, ...realSeamChainHandle(), redeployImplementation: 'always' } as never,
      ),
    ).rejects.toBeInstanceOf(UnknownOptionError);
  });
});
