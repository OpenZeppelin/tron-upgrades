import { afterEach, describe, expect, it } from 'vitest';

import {
  silenceWarnings,
  type DeployBeaconOptions,
  type DeployBeaconProxyOptions,
  type DeployImplementationOptions,
  type ForceImportOptions,
  type PrepareUpgradeOptions,
  type UpgradeBeaconOptions,
  type ValidateImplementationOptions,
  type ValidateUpgradeOptions,
} from '../src';
import { silenceWarnings as silenceWarningsFromLeaf, resetSilenceForTests } from '../src/output/silence';
import { createOutputChannel } from '../src/output';
import { recordingSink, channelFacts } from './helpers/surface-fixtures';

/*
 * The cheap additions this task landed on the package entry, each proven
 * reachable from `'../src'` — the same module a real consumer's
 * `require('@openzeppelin/tronbox-upgrades')` resolves to.
 */

afterEach(() => {
  resetSilenceForTests();
});

describe('silenceWarnings, exported directly from the entry', () => {
  it('is the exact same binding as `./output/silence`\'s — not a wrapper, not a stub', () => {
    expect(silenceWarnings).toBe(silenceWarningsFromLeaf);
  });

  it('suppresses a channel advisory once called through the entry export', () => {
    const sink = recordingSink();
    const channel = createOutputChannel(channelFacts(sink));
    channel.warn('before silencing');
    expect(sink.calls).toHaveLength(1);

    silenceWarnings();
    channel.warn('after silencing');
    expect(sink.calls).toHaveLength(1);
  });
});

describe('the 8 previously-missing per-operation option types, now on the entry', () => {
  it('PrepareUpgradeOptions, DeployImplementationOptions and DeployBeaconOptions type-check from `../src`', () => {
    const prepareUpgrade: PrepareUpgradeOptions = { kind: 'uups' };
    const deployImplementation: DeployImplementationOptions = {
      redeployImplementation: 'onchange',
    };
    const deployBeacon: DeployBeaconOptions = { constructorArgs: [1] };
    expect(prepareUpgrade.kind).toBe('uups');
    expect(deployImplementation.redeployImplementation).toBe('onchange');
    expect(deployBeacon.constructorArgs).toEqual([1]);
  });

  it('UpgradeBeaconOptions, ForceImportOptions, ValidateImplementationOptions and ValidateUpgradeOptions type-check from `../src`', () => {
    const upgradeBeacon: UpgradeBeaconOptions = { unsafeSkipStorageCheck: true };
    const forceImport: ForceImportOptions = { kind: 'transparent' };
    const validateImplementation: ValidateImplementationOptions = {
      unsafeAllow: ['constructor'],
    };
    const validateUpgrade: ValidateUpgradeOptions = { unsafeAllowRenames: false };
    expect(upgradeBeacon.unsafeSkipStorageCheck).toBe(true);
    expect(forceImport.kind).toBe('transparent');
    expect(validateImplementation.unsafeAllow).toEqual(['constructor']);
    expect(validateUpgrade.unsafeAllowRenames).toBe(false);
  });

  it('DeployBeaconProxyOptions type-checks from `../src` and still refuses `kind` — the type/runtime fix', () => {
    const deployBeaconProxy: DeployBeaconProxyOptions = {
      initializer: 'initialize',
      timeout: 0,
    };
    expect(deployBeaconProxy.initializer).toBe('initialize');
    // @ts-expect-error `kind` is not a member of `DeployBeaconProxyOptions`: `deployBeaconProxy` refuses the option entirely rather than narrowing a wrong value.
    const refused: DeployBeaconProxyOptions = { kind: 'beacon' };
    expect(refused).toBeDefined();
  });

  it('DeployBeaconOptions and UpgradeBeaconOptions refuse `kind` too, from `../src` — the same fix applied to all three beacon ops', () => {
    // @ts-expect-error `kind` is not a member of `DeployBeaconOptions`: `deployBeacon` has its own accepted-options list (`DEPLOY_BEACON_ACCEPTED_OPTIONS`) and refuses `kind` the same way `deployBeaconProxy` does.
    const deployBeaconRefused: DeployBeaconOptions = { kind: 'beacon' };
    // @ts-expect-error `kind` is not a member of `UpgradeBeaconOptions`: `upgradeBeacon` has its own accepted-options list (`UPGRADE_BEACON_ACCEPTED_OPTIONS`) too.
    const upgradeBeaconRefused: UpgradeBeaconOptions = { kind: 'beacon' };
    expect(deployBeaconRefused).toBeDefined();
    expect(upgradeBeaconRefused).toBeDefined();
  });

  it('DeployBeaconOptions and UpgradeBeaconOptions refuse the members OUR CODE never reaches for them specifically, from `../src`', () => {
    // Each beacon operation refuses exactly the members OUR OWN code never
    // reads for it (`beacon/index.ts`): `deployBeacon` deploys no proxy, so
    // `initializer` is refused; `upgradeBeacon` sends no proxy init call and
    // never re-sets the beacon's owner, so `initializer`/`initialOwner` are
    // refused. `unsafeAllowRenames`/`unsafeSkipStorageCheck` are deliberately
    // NOT pinned as refused on `DeployBeaconOptions` here — per the owner's
    // scoping correction, `deployBeacon` ACCEPTS that pair at runtime (the
    // engine ignores it for a fresh deploy; that is not this operation
    // refusing it), mirroring `deployProxy`. See `task-25-report.md`'s "Fix
    // round 1" for the corrected census.
    // @ts-expect-error `initializer` is not a member of `DeployBeaconOptions`.
    const deployBeaconRefusesInitializer: DeployBeaconOptions = { initializer: 'setUp' };
    // @ts-expect-error `initializer` is not a member of `UpgradeBeaconOptions`.
    const upgradeBeaconRefusesInitializer: UpgradeBeaconOptions = { initializer: 'setUp' };
    // @ts-expect-error `initialOwner` is not a member of `UpgradeBeaconOptions`: the owner is set once, at `deployBeacon`.
    const upgradeBeaconRefusesInitialOwner: UpgradeBeaconOptions = { initialOwner: 'T...' };
    expect(deployBeaconRefusesInitializer).toBeDefined();
    expect(upgradeBeaconRefusesInitializer).toBeDefined();
    expect(upgradeBeaconRefusesInitialOwner).toBeDefined();
  });
});
