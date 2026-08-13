/**
 * The published option surface must describe the runtime, exactly.
 *
 * Every operation refuses an unaccepted key at runtime by name
 * (`UnknownOptionError`), and every operation also ships a TypeScript type
 * saying which keys it takes. Those two statements used to be written
 * independently, and they drifted: `ForceImportOptions` advertised one member
 * against the seven `forceImport` accepts, `validateImplementation`'s alias
 * was three short, and `transferProxyAdminOwnership` had no alias at all.
 * Worse, none of the aliases could catch a wrong key even where they were
 * right, because every operation declared its parameter as an
 * index-signature bag — `deployProxy(Box, [42], { totallyMadeUpKey: 1 })`
 * type-checked and then failed at runtime.
 *
 * This file makes the correspondence a **compile-time obligation**, in both
 * directions, per operation:
 *
 * - a key in the runtime list that the type does not declare, and
 * - a key the type declares that the runtime list does not accept
 *
 * are each a build failure naming the offending key. The assertions below are
 * checked by `npm run test:types` (`tsc -p tsconfig.test.json`); the runtime
 * `it` blocks cover the two properties a type cannot state — that no list
 * repeats a key, and that every list carries the five migration handles.
 *
 * Two assertions per operation, deliberately:
 *
 * 1. the exported alias against the list — the published name stays honest
 *    even for an alias no signature happens to use;
 * 2. the entry point's own last parameter against the list — which is what
 *    catches a cross-wiring, an operation typed with a sibling's alias.
 */

import { describe, expect, it } from 'vitest';

import {
  DEPLOY_PROXY_ACCEPTED_OPTIONS,
  UPGRADE_PROXY_ACCEPTED_OPTIONS,
  deployProxy,
  upgradeProxy,
} from '../src/proxy';
import { HANDLE_OPTION_KEYS, type MigrationHandles } from '../src/proxy/toolkit';
import {
  DEPLOY_BEACON_ACCEPTED_OPTIONS,
  DEPLOY_BEACON_PROXY_ACCEPTED_OPTIONS,
  UPGRADE_BEACON_ACCEPTED_OPTIONS,
  deployBeacon,
  deployBeaconProxy,
  upgradeBeacon,
} from '../src/beacon';
import { FORCE_IMPORT_ACCEPTED_OPTIONS, forceImport } from '../src/adopt';
import {
  TRANSFER_OWNERSHIP_ACCEPTED_OPTIONS,
  transferProxyAdminOwnership,
} from '../src/admin';
import {
  DEPLOY_IMPLEMENTATION_ACCEPTED_OPTIONS,
  VALIDATE_ACCEPTED_OPTIONS,
  deployImplementation,
  prepareUpgrade,
  validateImplementation,
  validateUpgrade,
} from '../src/standalone';
import type {
  DeployBeaconOptions,
  DeployBeaconProxyOptions,
  DeployImplementationOptions,
  DeployProxyOptions,
  ForceImportOptions,
  PrepareUpgradeOptions,
  TransferProxyAdminOwnershipOptions,
  UpgradeBeaconOptions,
  UpgradeProxyOptions,
  ValidateImplementationOptions,
  ValidateUpgradeOptions,
} from '../src/options/types';

/**
 * `true` when `T`'s keys are exactly `Keys`. Otherwise a tuple whose second
 * member is the offending key — so the compile error names it instead of
 * saying only that two types differ.
 */
type KeysMatch<T, Keys extends string> = [Exclude<keyof T, Keys>] extends [never]
  ? [Exclude<Keys, keyof T>] extends [never]
    ? true
    : ['accepted at runtime but absent from the type:', Exclude<Keys, keyof T>]
  : ['declared by the type but refused at runtime:', Exclude<keyof T, Keys>];

/**
 * The options parameter is last on every operation and has a default, so the
 * tuple carries it as optional: `NonNullable` recovers the declared type.
 */
type OptionsParameter<F> = F extends (...args: [...infer _Rest, infer Last]) => unknown
  ? NonNullable<Last>
  : never;

type Accepted<L extends readonly string[]> = L[number];

/* deployProxy */
const _deployProxyAlias: KeysMatch<
  DeployProxyOptions & MigrationHandles,
  Accepted<typeof DEPLOY_PROXY_ACCEPTED_OPTIONS>
> = true;
const _deployProxySignature: KeysMatch<
  OptionsParameter<typeof deployProxy>,
  Accepted<typeof DEPLOY_PROXY_ACCEPTED_OPTIONS>
> = true;

/* upgradeProxy */
const _upgradeProxyAlias: KeysMatch<
  UpgradeProxyOptions & MigrationHandles,
  Accepted<typeof UPGRADE_PROXY_ACCEPTED_OPTIONS>
> = true;
const _upgradeProxySignature: KeysMatch<
  OptionsParameter<typeof upgradeProxy>,
  Accepted<typeof UPGRADE_PROXY_ACCEPTED_OPTIONS>
> = true;

/* deployBeacon */
const _deployBeaconAlias: KeysMatch<
  DeployBeaconOptions & MigrationHandles,
  Accepted<typeof DEPLOY_BEACON_ACCEPTED_OPTIONS>
> = true;
const _deployBeaconSignature: KeysMatch<
  OptionsParameter<typeof deployBeacon>,
  Accepted<typeof DEPLOY_BEACON_ACCEPTED_OPTIONS>
> = true;

/* upgradeBeacon */
const _upgradeBeaconAlias: KeysMatch<
  UpgradeBeaconOptions & MigrationHandles,
  Accepted<typeof UPGRADE_BEACON_ACCEPTED_OPTIONS>
> = true;
const _upgradeBeaconSignature: KeysMatch<
  OptionsParameter<typeof upgradeBeacon>,
  Accepted<typeof UPGRADE_BEACON_ACCEPTED_OPTIONS>
> = true;

/* deployBeaconProxy */
const _deployBeaconProxyAlias: KeysMatch<
  DeployBeaconProxyOptions & MigrationHandles,
  Accepted<typeof DEPLOY_BEACON_PROXY_ACCEPTED_OPTIONS>
> = true;
const _deployBeaconProxySignature: KeysMatch<
  OptionsParameter<typeof deployBeaconProxy>,
  Accepted<typeof DEPLOY_BEACON_PROXY_ACCEPTED_OPTIONS>
> = true;

/* forceImport */
const _forceImportAlias: KeysMatch<
  ForceImportOptions & MigrationHandles,
  Accepted<typeof FORCE_IMPORT_ACCEPTED_OPTIONS>
> = true;
const _forceImportSignature: KeysMatch<
  OptionsParameter<typeof forceImport>,
  Accepted<typeof FORCE_IMPORT_ACCEPTED_OPTIONS>
> = true;

/* transferProxyAdminOwnership */
const _transferAlias: KeysMatch<
  TransferProxyAdminOwnershipOptions & MigrationHandles,
  Accepted<typeof TRANSFER_OWNERSHIP_ACCEPTED_OPTIONS>
> = true;
const _transferSignature: KeysMatch<
  OptionsParameter<typeof transferProxyAdminOwnership>,
  Accepted<typeof TRANSFER_OWNERSHIP_ACCEPTED_OPTIONS>
> = true;

/* validateImplementation and validateUpgrade share one runtime list */
const _validateImplementationAlias: KeysMatch<
  ValidateImplementationOptions & MigrationHandles,
  Accepted<typeof VALIDATE_ACCEPTED_OPTIONS>
> = true;
const _validateImplementationSignature: KeysMatch<
  OptionsParameter<typeof validateImplementation>,
  Accepted<typeof VALIDATE_ACCEPTED_OPTIONS>
> = true;
const _validateUpgradeAlias: KeysMatch<
  ValidateUpgradeOptions & MigrationHandles,
  Accepted<typeof VALIDATE_ACCEPTED_OPTIONS>
> = true;
const _validateUpgradeSignature: KeysMatch<
  OptionsParameter<typeof validateUpgrade>,
  Accepted<typeof VALIDATE_ACCEPTED_OPTIONS>
> = true;

/* deployImplementation and prepareUpgrade share the other */
const _deployImplementationAlias: KeysMatch<
  DeployImplementationOptions & MigrationHandles,
  Accepted<typeof DEPLOY_IMPLEMENTATION_ACCEPTED_OPTIONS>
> = true;
const _deployImplementationSignature: KeysMatch<
  OptionsParameter<typeof deployImplementation>,
  Accepted<typeof DEPLOY_IMPLEMENTATION_ACCEPTED_OPTIONS>
> = true;
const _prepareUpgradeAlias: KeysMatch<
  PrepareUpgradeOptions & MigrationHandles,
  Accepted<typeof DEPLOY_IMPLEMENTATION_ACCEPTED_OPTIONS>
> = true;
const _prepareUpgradeSignature: KeysMatch<
  OptionsParameter<typeof prepareUpgrade>,
  Accepted<typeof DEPLOY_IMPLEMENTATION_ACCEPTED_OPTIONS>
> = true;

/*
 * The regression pin for the index signature itself, stated the only way a
 * type test can state it: `@ts-expect-error` inverts the assertion, so each
 * of these lines fails to compile the day the call below starts type-checking
 * again — which is exactly what an index signature creeping back onto an
 * option type would do. Never called; it exists to be compiled.
 *
 * Both halves of the old bug are pinned: a key no operation accepts, and a
 * key a DIFFERENT operation accepts (the more likely mistake, and the one a
 * bag type cannot catch even in principle).
 */
function _unknownKeysMustNotTypeCheck(contract: never, handles: MigrationHandles): void {
  void deployProxy(contract, [42], {
    ...handles,
    // @ts-expect-error refused at runtime by name (`UnknownOptionError`).
    totallyMadeUpKey: 1,
  });
  void upgradeProxy('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', contract, {
    ...handles,
    // @ts-expect-error `initializer` is `deployProxy`'s; an upgrade sends no init call.
    initializer: 'setUp',
  });
  void transferProxyAdminOwnership(
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    {
      ...handles,
      // @ts-expect-error the operation validates nothing; `kind` reaches nothing.
      kind: 'transparent',
    },
  );
}

/**
 * Every accepted-options list in the package, by the operation that owns it.
 * A list absent here is a list this file does not pin, so the roster is
 * asserted against the count the package ships rather than left implicit.
 */
const acceptedOptionLists = {
  deployProxy: DEPLOY_PROXY_ACCEPTED_OPTIONS,
  upgradeProxy: UPGRADE_PROXY_ACCEPTED_OPTIONS,
  deployBeacon: DEPLOY_BEACON_ACCEPTED_OPTIONS,
  upgradeBeacon: UPGRADE_BEACON_ACCEPTED_OPTIONS,
  deployBeaconProxy: DEPLOY_BEACON_PROXY_ACCEPTED_OPTIONS,
  forceImport: FORCE_IMPORT_ACCEPTED_OPTIONS,
  transferProxyAdminOwnership: TRANSFER_OWNERSHIP_ACCEPTED_OPTIONS,
  'validateImplementation + validateUpgrade': VALIDATE_ACCEPTED_OPTIONS,
  'deployImplementation + prepareUpgrade': DEPLOY_IMPLEMENTATION_ACCEPTED_OPTIONS,
} as const satisfies Readonly<Record<string, readonly string[]>>;

describe('the published option surface — what a type cannot state', () => {
  it.each(Object.entries(acceptedOptionLists))(
    '%s: the accepted list repeats no key',
    (_operation, list) => {
      expect([...new Set(list)]).toEqual([...list]);
    },
  );

  it.each(Object.entries(acceptedOptionLists))(
    '%s: the accepted list carries every migration handle',
    (_operation, list) => {
      // The handles are how a migration hands the operation its sandbox; a
      // list that dropped one would refuse a well-formed call by name, and
      // the type assertions above would still pass — both sides would agree
      // on the same wrong set.
      expect([...list]).toEqual(expect.arrayContaining([...HANDLE_OPTION_KEYS]));
    },
  );

  it('pins the nine lists the eleven operations share between them', () => {
    expect(Object.keys(acceptedOptionLists)).toHaveLength(9);
  });
});
