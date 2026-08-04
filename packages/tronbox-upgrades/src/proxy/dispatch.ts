/**
 * The upgrade-dispatch matrix (INV-5): a pure function from probed facts to a
 * plan, with a closed row set and a named refusal for anything outside it.
 *
 * The generations, measured from the sibling adaptation and upstream:
 *
 * | route     | probe result on…    | entry point                                    |
 * |-----------|---------------------|------------------------------------------------|
 * | admin-v5  | admin → `"5.0.0"`   | `ProxyAdmin.upgradeAndCall(proxy, impl, data)` — always, `0x` data included |
 * | admin-v4  | admin → absent      | `upgrade(proxy, impl)` plain; `upgradeAndCall` only WITH data, because v4's `upgradeAndCall` force-calls the implementation |
 * | uups-v5   | proxy → `"5.0.0"`   | `upgradeToAndCall(impl, data)` — always        |
 * | uups-pre5 | proxy → absent      | `upgradeTo(impl)` plain; `upgradeToAndCall` WITH data |
 *
 * "Absent" means the `UPGRADE_INTERFACE_VERSION` getter reverted — a
 * legitimate state, not an error. The probe classification (revert versus
 * transport failure, INV-6) is SF-1's: `readUpgradeInterfaceVersion` answers
 * `undefined` for the optional-call revert and raises for everything else, so
 * by the time this function runs, "absent" already means what it says.
 *
 * The entry point is NEVER taken from the new implementation's ABI: the
 * upgrade call runs against the CURRENT generation's contract (the admin, or
 * the current implementation reached through the proxy).
 */

import { UnknownProxyGenerationError } from './errors';

export interface DispatchProbe {
  readonly kind: 'transparent' | 'uups';
  /** `readUpgradeInterfaceVersion` on the admin (transparent) or proxy (uups). */
  readonly interfaceVersion: string | undefined;
  /** Whether the caller supplied call data (an `opts.call`). */
  readonly hasCallData: boolean;
}

export type UpgradeCallName =
  | 'upgradeAndCall'
  | 'upgrade'
  | 'upgradeToAndCall'
  | 'upgradeTo';

export interface UpgradePlan {
  readonly route: 'admin-v5' | 'admin-v4' | 'uups-v5' | 'uups-pre5';
  readonly call: UpgradeCallName;
  /** Whether the call carries the (possibly empty) data argument. */
  readonly carriesData: boolean;
}

const KNOWN_VERSION = '5.0.0';

/** The whole matrix, one refusal, no default arm that guesses. */
export function planUpgradeDispatch(probe: DispatchProbe): UpgradePlan {
  const { kind, interfaceVersion, hasCallData } = probe;

  if (interfaceVersion !== undefined && interfaceVersion !== KNOWN_VERSION) {
    throw new UnknownProxyGenerationError(
      kind === 'transparent' ? 'admin' : 'proxy',
      interfaceVersion,
    );
  }

  if (kind === 'transparent') {
    if (interfaceVersion === KNOWN_VERSION) {
      return { route: 'admin-v5', call: 'upgradeAndCall', carriesData: true };
    }
    return hasCallData
      ? { route: 'admin-v4', call: 'upgradeAndCall', carriesData: true }
      : { route: 'admin-v4', call: 'upgrade', carriesData: false };
  }

  if (interfaceVersion === KNOWN_VERSION) {
    return { route: 'uups-v5', call: 'upgradeToAndCall', carriesData: true };
  }
  return hasCallData
    ? { route: 'uups-pre5', call: 'upgradeToAndCall', carriesData: true }
    : { route: 'uups-pre5', call: 'upgradeTo', carriesData: false };
}
