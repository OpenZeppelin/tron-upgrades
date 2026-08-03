import {
  ConfigReadFailureError,
  failInvariant,
  failMalformed,
  nullableNumber,
  nullableString,
  readLineageProperty,
  requireNonEmptyString,
  requireString,
  type ConfigLineage,
  type ConfigReadFailure,
  type NetworkScalarField,
} from './config-lineage';
import {
  isObjectLike,
  readOwnProperty,
  type InternalPathRecorder,
} from './handles';
import type { NetworkEnvironment } from './types';

export interface NetworkScalarValues {
  readonly network: string;
  readonly network_id: string;
  readonly 'networks[network].network_id': string;
  readonly from: string | null;
  readonly feeLimit: number | null;
  readonly userFeePercentage: number | null;
  readonly originEnergyLimit: number | null;
  readonly callValue: number | null;
  readonly tokenValue: number | null;
  readonly tokenId: number | null;
  readonly signingKeyConfigured: boolean;
}

/**
 * `resolveGroup` treats a both-lineages comparison that finds every field equal
 * as proof that the two value records are equal, so it may return either as the
 * agreed set. That argument holds only while this record's keys are *exactly*
 * the compared field group — no key outside it (which would go uncompared) and
 * no field without a key (which would compare `undefined` to `undefined`). This
 * makes the correspondence a compile error rather than a comment.
 */
type AssertTrue<T extends true> = T;
export type NetworkScalarValuesCoverage = AssertTrue<
  [keyof NetworkScalarValues] extends [NetworkScalarField]
    ? [NetworkScalarField] extends [keyof NetworkScalarValues]
      ? true
      : false
    : false
>;

/**
 * INV-16: the selected network is validated against the `networks` map itself,
 * before any derived getter is read.
 *
 * This is the trap the check closes, verified on 4.9.0 and 4.8.0. In
 * `build/components/Config.js:Config`, the `network_config` getter throws
 * "Network not set. Cannot determine network to use." only when the selected
 * network is *falsy*; a name simply absent from `networks` yields
 * `_.extend({}, default_tx_values, self.networks[network] || {})` — pure
 * defaults, with no error at all. Every consumer getter then swallows or never
 * sees a throw, so for a misspelled network the getters report
 * `feeLimit: 1000000000`, `userFeePercentage: 100`, `originEnergyLimit: 10000000`
 * from `build/components/TronWrap/constants.js:deployParameters` — a complete,
 * plausible, entirely fictional network configuration. `Config`'s own `_values`
 * defaults are `network: "development"` with `networks: {}`, so an empty config
 * reaches that state with no user error at all.
 *
 * Reading the getters cannot distinguish that from a real configuration.
 * Checking `networks` can, and the map is reachable through both lineages:
 * `Config.prototype.normalize` copies `networks` onto the materialized snapshot
 * by reference, with the per-network entries intact (verified — same object
 * identity as the live Config's).
 */
function assertSelectedNetworkIsConfigured(
  lineage: ConfigLineage,
  name: string,
  recorder: InternalPathRecorder,
): Record<PropertyKey, unknown> {
  const networksPath = `${lineage.prefix}.networks`;
  const networks = readOwnProperty(
    lineage.config,
    'networks',
    networksPath,
    recorder,
  );
  if (!networks.ok) {
    return failMalformed(lineage, networksPath, networks.reason);
  }
  if (!isObjectLike(networks.value)) {
    return failInvariant(
      `Config field "networks" must be an object mapping network names to ` +
        'their configuration.',
    );
  }

  const entryPath = `${networksPath}.${name}`;
  const entry = readOwnProperty(networks.value, name, entryPath, recorder);
  if (!entry.ok || !isObjectLike(entry.value)) {
    const configured = Object.keys(networks.value);
    return failInvariant(
      `the selected network "${name}" has no entry in "networks". ` +
        `Configured networks: ` +
        `${configured.length === 0 ? 'none' : configured.join(', ')}. ` +
        "TronBox's own getters would report a complete but fictional " +
        'configuration for this network rather than failing.',
    );
  }

  return entry.value;
}

/**
 * The host's own diagnosis for a network whose `network_id` TronBox will refuse.
 *
 * One function, two callers: the key being absent, and the key holding a falsy
 * numeric. Those are the same state to the host —
 * `build/lib/environment.js:Environment.detect` gates on truthiness, `if
 * (!network_id) return callback(new TronBoxError("You must specify a network_id
 * in your '" + config.network + "' configuration…"))`, verified on 4.9.0 and
 * 4.8.0 — so the seam reports what the host reports rather than inventing a
 * second wording for a configuration the host also refuses.
 */
function failMissingNetworkId(name: string): never {
  return failInvariant(
    `the selected network "${name}" is configured without a ` +
      '"network_id". TronBox requires one — its own `Test.run` gate ' +
      'rejects a missing `network_id` — and the value keys the `networks` ' +
      'map of every saved artifact.',
  );
}

/**
 * INV-48: the seam's only value normalization, and this function *is* the closed
 * list — two call sites, both `network_id`, both in
 * {@link projectNetworkValues}. Adding an entry means showing that the host
 * treats both forms as the same value, which is a citation rather than an
 * opinion. Four conditions bound every entry, and all four are what this
 * function encodes:
 *
 * 1. **The host's own canonical form is the string coercion.**
 *    `build/components/Contract/contract.js:setNetwork` does
 *    `this.network_id = network_id + ""`, and `:hasNetwork` keys the saved
 *    artifact's `networks` map with `network_id + ""` (verified on 4.9.0 and
 *    4.8.0). `String(value)` on a `number` is that expression, not a
 *    re-invention of it: `1` and `'1'` reach the host as one string either way,
 *    so refusing the numeric form buys no safety and spends the plugin's
 *    credibility refusing a config `Environment.detect` accepted one step
 *    earlier — on all three entry paths, `migrate`, `test` and `console`.
 * 2. **Only `number`, and only after the host's falsy gate is reproduced.** The
 *    host accepts `'0'` and refuses `0`; reproducing that asymmetry is what makes
 *    the seam's acceptance set *equal* to the host's rather than a superset.
 *    Coercing `0` to `'0'` would have the seam bless a configuration TronBox
 *    then refuses.
 * 3. **No other type is coercible** — not `bigint`, not `boolean`, not a
 *    `toString` carrier. Each keeps `requireString`'s named refusal.
 * 4. **`'*'` is neither consumed nor produced.** The branch runs only on
 *    `number` and no number is `'*'`, so INV-6's strict-equality wildcard
 *    derivation is structurally out of reach.
 */
function normalizeNetworkId(
  value: unknown,
  field: string,
  name: string,
): string {
  if (typeof value === 'number') {
    // `Environment.detect`'s gate verbatim: `if (!network_id)`. So `0`, `-0` and
    // `NaN` are refused with the host's own diagnosis, never normalized.
    return value ? String(value) : failMissingNetworkId(name);
  }
  return requireString(value, field);
}

/**
 * Reads and validates every network scalar off one lineage. Returns the
 * compared value set, never a slot — {@link buildNetworkEnvironment} builds the
 * slot from the agreed values so no lineage's object is preferred (INV-12).
 */
export function projectNetworkValues(
  lineage: ConfigLineage,
  recorder: InternalPathRecorder,
): NetworkScalarValues | ConfigReadFailure {
  try {
    // INV-16, first condition: a non-empty selected network name.
    //
    // The nullish case gets its own diagnosis because the seam cannot see what
    // the user wrote. `Config.prototype.addProp`'s getter is
    // `if (this._values[key]) return this._values[key]; … return obj()`, and
    // `network`'s `obj` is a bare no-op — so a `network` configured as `''`
    // reads back as `undefined`, not as `''`. Reporting "must be a string"
    // there would send someone hunting for a type error they do not have.
    const rawName = readLineageProperty(lineage, 'network', recorder);
    if (rawName === undefined || rawName === null) {
      return failInvariant(
        'no network is selected. TronBox reports the selected network through ' +
          'a truthiness-guarded getter, so a `network` configured as an empty ' +
          'string reads back as absent — check the `network` key in your ' +
          'TronBox config and the `--network` argument.',
      );
    }
    const name = requireNonEmptyString(rawName, 'network');

    // INV-16, second condition — before any derived getter is read.
    const entry = assertSelectedNetworkIsConfigured(lineage, name, recorder);

    const entryPath = `${lineage.prefix}.networks.${name}`;
    const configuredIdPath = `${entryPath}.network_id`;
    const configuredIdRead = readOwnProperty(
      entry,
      'network_id',
      configuredIdPath,
      recorder,
    );
    if (!configuredIdRead.ok) {
      return failMissingNetworkId(name);
    }
    // INV-48, site 1 of 2. Both sites go through the one helper: this one runs
    // first and throws, so normalizing only here would relocate the refusal to
    // `artifactNetworkId` rather than resolve it. And a permanent divergence
    // would be worse than either, because both fields are INV-13 cross-check
    // members — one coerced and one raw compares a number against a string
    // across lineages and reports a fictional `inconsistent`.
    const configuredNetworkId = normalizeNetworkId(
      configuredIdRead.value,
      `networks.${name}.network_id`,
      name,
    );

    // INV-40: presence only. The value is tested in place and never bound to a
    // variable that outlives the check. `Config`'s own top-level `privateKey`
    // getter is hardcoded to return `null`, so it is useless as a presence
    // check — the real key lives on the network entry.
    const privateKeyPath = `${entryPath}.privateKey`;
    const privateKeyRead = readOwnProperty(
      entry,
      'privateKey',
      privateKeyPath,
      recorder,
    );
    if (!privateKeyRead.ok && privateKeyRead.reason === 'threw') {
      return failMalformed(lineage, privateKeyPath, 'threw');
    }
    const signingKeyConfigured =
      privateKeyRead.ok &&
      typeof privateKeyRead.value === 'string' &&
      privateKeyRead.value.length > 0;

    // Only now the derived getters. These are what the tool *resolved*, so they
    // come from the getters rather than from the raw entry — `feeLimit` reads
    // `network_config.feeLimit || network_config.fee_limit`, and that resolution
    // is the fact SF-4 needs. Note the getters' `||` chains treat a configured
    // `0` as absent: with `callValue: 0` merged in from `deployParameters`,
    // `config.callValue` reads `undefined`, hence `null` here.
    // INV-48, site 2 of 2 — the same helper, so the two sites cannot drift.
    const artifactNetworkId = normalizeNetworkId(
      readLineageProperty(lineage, 'network_id', recorder),
      'network_id',
      name,
    );

    const values: NetworkScalarValues = Object.freeze({
      network: name,
      network_id: artifactNetworkId,
      'networks[network].network_id': configuredNetworkId,
      from: nullableString(
        readLineageProperty(lineage, 'from', recorder),
        'from',
      ),
      feeLimit: nullableNumber(
        readLineageProperty(lineage, 'feeLimit', recorder),
        'feeLimit',
      ),
      userFeePercentage: nullableNumber(
        readLineageProperty(lineage, 'userFeePercentage', recorder),
        'userFeePercentage',
      ),
      originEnergyLimit: nullableNumber(
        readLineageProperty(lineage, 'originEnergyLimit', recorder),
        'originEnergyLimit',
      ),
      callValue: nullableNumber(
        readLineageProperty(lineage, 'callValue', recorder),
        'callValue',
      ),
      tokenValue: nullableNumber(
        readLineageProperty(lineage, 'tokenValue', recorder),
        'tokenValue',
      ),
      tokenId: nullableNumber(
        readLineageProperty(lineage, 'tokenId', recorder),
        'tokenId',
      ),
      signingKeyConfigured,
    });

    return values;
  } catch (error) {
    if (error instanceof ConfigReadFailureError) {
      return error.failure;
    }
    throw error;
  }
}

/**
 * Total function of the validated scalars. INV-6: `syntax` is derived by strict
 * equality against `'*'`, never by a truthiness or regex test, so `'**'` and
 * `'*3'` are `'exact'`.
 */
export function buildNetworkEnvironment(
  values: NetworkScalarValues,
): NetworkEnvironment {
  return Object.freeze({
    name: values.network,
    artifactNetworkId: values.network_id,
    configuredId: Object.freeze({
      value: values['networks[network].network_id'],
      syntax:
        values['networks[network].network_id'] === '*'
          ? ('wildcard' as const)
          : ('exact' as const),
    }),
    txDefaults: Object.freeze({
      feeLimit: values.feeLimit,
      userFeePercentage: values.userFeePercentage,
      originEnergyLimit: values.originEnergyLimit,
      callValue: values.callValue,
      tokenValue: values.tokenValue,
      tokenId: values.tokenId,
    }),
    // INV-7: wrapped, so the caveat cannot be skipped at a call site. The
    // effective sender is chosen at send time — `TronWrap._getAccounts`
    // replaces `_accounts` wholesale on a TRE node while resetting
    // `privateKeyByAccount` — so an authority preflight against this value can
    // pass while the transaction sends from a different account.
    sender: Object.freeze({
      kind: 'configured-not-authoritative' as const,
      address: values.from,
    }),
    signingKeyConfigured: values.signingKeyConfigured,
  });
}

/** Re-exported for the resolver's field-group comparison. */
export type { NetworkScalarField };
