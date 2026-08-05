import {
  hostSharingGuard,
  isObjectLike,
  readOwnProperty,
  type HostSharingGuard,
  type InternalPathRecorder,
} from './handles';
import type {
  ConfigLineageBinding,
  ConfigLineageProvenance,
  ConfigScalarField,
  Inconsistency,
  RawMigrationHandles,
} from './types';

/**
 * The compared field set as three explicit groups, iterated
 * rather than derived from `Object.keys`. A resolution compares exactly the
 * groups whose slots it exposes, which is what makes the claim "cost is
 * linear in the number of declared slots and the fixed cross-check field
 * list" true.
 */
export const pathConfigLineageFields = Object.freeze([
  'working_directory',
  'contracts_directory',
  'contracts_build_directory',
  'build_info_directory',
] as const satisfies readonly ConfigScalarField[]);

export const networkConfigLineageFields = Object.freeze([
  'network',
  'network_id',
  'networks[network].network_id',
  'from',
  'feeLimit',
  'userFeePercentage',
  'originEnergyLimit',
  'callValue',
  'tokenValue',
  'tokenId',
  'signingKeyConfigured',
] as const satisfies readonly ConfigScalarField[]);

/**
 * The compiler group: the resolved compiler configuration's scalars. `settings`
 * is absent by construction — it is an object, and every member of
 * a compared group is rendered verbatim. `compiler.ts:compareCompilerSettings` cross-checks it
 * by identity instead, so it is not uncompared.
 */
export const compilerConfigLineageFields = Object.freeze([
  'compiler.resolvedVersion',
  'compiler.family',
  'compiler.viaLegacyFlag',
  'compiler.versionIsHostDefault',
  'compiler.settingsSource',
] as const satisfies readonly ConfigScalarField[]);

export const configLineageFields = Object.freeze([
  ...pathConfigLineageFields,
  ...networkConfigLineageFields,
  ...compilerConfigLineageFields,
] as const satisfies readonly ConfigScalarField[]);

export type PathScalarField = (typeof pathConfigLineageFields)[number];
export type NetworkScalarField = (typeof networkConfigLineageFields)[number];
export type CompilerScalarField =
  (typeof compilerConfigLineageFields)[number];

/**
 * The coverage claim, as a compile error rather than prose: the union of
 * the compared groups must equal `ConfigScalarField` exactly. Adding an exposed
 * scalar to the type without adding it to a group — or the reverse — fails to
 * compile. Type-only, so nothing reaches the emitted JavaScript.
 */
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;
type AssertTrue<T extends true> = T;
export type ConfigLineageFieldCoverage = AssertTrue<
  MutuallyAssignable<ConfigScalarField, (typeof configLineageFields)[number]>
>;

/** Only the two Config lineages produce these, hence the narrowed handle. */
export interface LineageReadFailure {
  readonly handle: 'deployer' | 'artifacts';
  readonly expectedPath: string;
  readonly because: 'missing' | 'threw';
}

export type ConfigReadFailure =
  | {
      readonly kind: 'handle-malformed';
      readonly handle: 'deployer' | 'artifacts';
      readonly expectedPath: string;
      readonly because: 'missing' | 'threw';
    }
  | {
      readonly kind: 'invariant-violated';
      readonly detail: string;
    };

/**
 * Internal carrier so a projection can read a dozen fields in straight-line
 * code and still surface the first failure as data. Never escapes the seam
 * — every catch site converts it to a `ConfigReadFailure`.
 */
export class ConfigReadFailureError extends Error {
  constructor(readonly failure: ConfigReadFailure) {
    super(
      failure.kind === 'handle-malformed'
        ? `Malformed handle path: ${failure.expectedPath}`
        : failure.detail,
    );
    this.name = 'ConfigReadFailureError';
  }
}

export interface ConfigLineage {
  readonly handle: 'deployer' | 'artifacts';
  /** The private property path this lineage was reached through. */
  readonly prefix: string;
  readonly config: Record<PropertyKey, unknown>;
  readonly binding: Exclude<ConfigLineageBinding, 'absent'>;
  /** Present only on the artifacts lineage: the resolver the intercept wraps. */
  readonly resolver?: object;
}

export type ConfigLineageAttempt =
  | { readonly status: 'absent' }
  | { readonly status: 'malformed'; readonly failure: LineageReadFailure }
  | { readonly status: 'present'; readonly lineage: ConfigLineage };

export interface ConfigLineages {
  readonly viaDeployer: ConfigLineageAttempt;
  readonly viaArtifacts: ConfigLineageAttempt;
}

function malformed(
  handle: 'deployer' | 'artifacts',
  expectedPath: string,
  because: 'missing' | 'threw',
): ConfigLineageAttempt {
  return Object.freeze({
    status: 'malformed',
    failure: Object.freeze({ handle, expectedPath, because }),
  });
}

/**
 * Live Config or materialized snapshot, decided by whether the lineage computes
 * its values on read.
 *
 * `Config.prototype.addProp` defines every prop with
 * `Object.defineProperty(this, key, { get, set, enumerable: true })`, so on a
 * live `Config` `working_directory` is an own accessor. `Config.prototype.with`
 * is `_.extend({}, this.normalize(this), this.normalize(obj))` and
 * `normalize` is `Object.keys(obj).forEach(key => { try { clone[key] = obj[key] }
 * catch (e) {} })`, so on a snapshot the same key is an own *data* property.
 * Verified on 4.9.0 and 4.8.0.
 */
function classifyBinding(
  config: Record<PropertyKey, unknown>,
): Exclude<ConfigLineageBinding, 'absent'> | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      config,
      'working_directory',
    );
    if (descriptor === undefined) {
      return undefined;
    }
    return typeof descriptor.get === 'function'
      ? 'live-config'
      : 'materialized-snapshot';
  } catch {
    return undefined;
  }
}

function inspectLineage(
  handle: 'deployer' | 'artifacts',
  root: unknown,
  hops: readonly string[],
  recorder: InternalPathRecorder,
): ConfigLineageAttempt {
  if (root === undefined) {
    return Object.freeze({ status: 'absent' });
  }
  if (!isObjectLike(root)) {
    return malformed(handle, handle, 'missing');
  }

  let owner: Record<PropertyKey, unknown> = root;
  let path: string = handle;
  let resolver: object | undefined;

  for (const hop of hops) {
    path = `${path}.${hop}`;
    const next = readOwnProperty(owner, hop, path, recorder);
    if (!next.ok) {
      return malformed(handle, path, next.reason);
    }
    if (!isObjectLike(next.value)) {
      return malformed(handle, path, 'missing');
    }
    // The artifacts lineage passes through the resolver the intercept wraps;
    // the resolver-pairing check compares that object against the deployer Config's own resolver.
    if (handle === 'artifacts' && hop === 'resolver') {
      resolver = next.value;
    }
    owner = next.value;
  }

  const bindingPath = `${path}.working_directory`;
  recorder.record(bindingPath);
  const binding = classifyBinding(owner);
  if (binding === undefined) {
    return malformed(handle, bindingPath, 'missing');
  }

  return Object.freeze({
    status: 'present',
    lineage: Object.freeze({
      handle,
      prefix: path,
      config: owner,
      binding,
      ...(resolver === undefined ? {} : { resolver }),
    }),
  });
}

/**
 * The two — and only two — private property hops in the whole package:
 * `deployer.options.options` and `artifacts.resolver.options`.
 */
export function inspectConfigLineages(
  handles: RawMigrationHandles,
  recorder: InternalPathRecorder,
): ConfigLineages {
  return Object.freeze({
    viaDeployer: inspectLineage(
      'deployer',
      handles.deployer,
      ['options', 'options'],
      recorder,
    ),
    viaArtifacts: inspectLineage(
      'artifacts',
      handles.artifacts,
      ['resolver', 'options'],
      recorder,
    ),
  });
}

/**
 * The augmentation policy's injected predicate for one resolution.
 *
 * Every host object the seam holds arrived as a raw handle or was reached through
 * one, so the set is enumerable rather than assumed — which is what lets the guard
 * be a fact instead of a promise. It is built here because this module owns the
 * two private hops and is therefore the only place that knows what the lineages
 * reached. `resolver` is `undefined` on the deployer lineage and non-objects are
 * dropped by `hostSharingGuard`, so no branch is needed for it.
 */
export function resolutionSharingGuard(
  handles: RawMigrationHandles,
  lineages: ConfigLineages,
): HostSharingGuard {
  const hostObjects: unknown[] = [...Object.values(handles)];
  for (const attempt of [lineages.viaDeployer, lineages.viaArtifacts]) {
    if (attempt.status === 'present') {
      hostObjects.push(attempt.lineage.config, attempt.lineage.resolver);
    }
  }
  return hostSharingGuard(
    'the raw handles this resolution received, plus every Config and Resolver ' +
      'reached through them',
    hostObjects,
  );
}

export function failMalformed(
  lineage: ConfigLineage,
  expectedPath: string,
  because: 'missing' | 'threw',
): never {
  throw new ConfigReadFailureError({
    kind: 'handle-malformed',
    handle: lineage.handle,
    expectedPath,
    because,
  });
}

export function failInvariant(detail: string): never {
  throw new ConfigReadFailureError({
    kind: 'invariant-violated',
    detail,
  });
}

/** Reads one field off a lineage, recording the path and refusing on absence. */
export function readLineageProperty(
  lineage: ConfigLineage,
  key: string,
  recorder: InternalPathRecorder,
): unknown {
  const expectedPath = `${lineage.prefix}.${key}`;
  const result = readOwnProperty(lineage.config, key, expectedPath, recorder);
  if (!result.ok) {
    return failMalformed(lineage, expectedPath, result.reason);
  }
  return result.value;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    return failInvariant(
      `Config field "${field}" must be a string, and is ${describe(value)}.`,
    );
  }
  return value;
}

export function requireNonEmptyString(
  value: unknown,
  field: string,
): string {
  const stringValue = requireString(value, field);
  if (stringValue.length === 0) {
    return failInvariant(`Config field "${field}" must not be empty.`);
  }
  return stringValue;
}

/** An upstream `undefined` becomes `null`, never the other way round. */
export function nullableString(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return failInvariant(
      `Config field "${field}" must be a string or absent, and is ` +
        `${describe(value)}.`,
    );
  }
  return value;
}

/** An upstream `undefined` becomes `null`, never the other way round. */
export function nullableNumber(
  value: unknown,
  field: string,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number') {
    return failInvariant(
      `Config field "${field}" must be a number or absent, and is ` +
        `${describe(value)}.`,
    );
  }
  return value;
}

/**
 * Refuses a field the seam will treat as a record of sub-keys.
 *
 * The host reaches these through `Object.keys(…)` and spread, both of which
 * accept a primitive and yield its *index* keys — `Object.keys('ab')` is
 * `['0','1']`, so a `solc: 'ab'` makes TronBox compile with
 * `settings: { 0: 'a', 1: 'b' }`. That is a configuration the host neither
 * rejects nor honours, so the seam refuses it by name rather than reporting the
 * host's garbage as a fact.
 */
export function requireObjectLike(
  value: unknown,
  field: string,
  expectation: string,
): Record<PropertyKey, unknown> {
  if (!isObjectLike(value)) {
    return failInvariant(
      `Config field "${field}" must be ${expectation}, and is ` +
        `${describe(value)}.`,
    );
  }
  return value;
}

/**
 * Names the *type* of an offending value, never the value. A Config field can
 * hold a credential-adjacent value, and the no-credential-leak guarantee
 * applies to every message the seam renders, not only to the cross-check
 * payload.
 */
function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return `of type ${typeof value}`;
}

/**
 * Returns either an empty list (the lineages agree on every compared
 * field) or the disagreements. There is no third return, so no caller can
 * obtain a value from a disagreeing pair — the type is what forbids the
 * preference path, not a convention.
 *
 * `Object.is` rather than `===` so `NaN` compares equal to itself and `-0` does
 * not compare equal to `0`.
 */
export function compareConfigValues<F extends ConfigScalarField>(
  fields: readonly F[],
  viaDeployer: Readonly<Record<F, unknown>>,
  viaArtifacts: Readonly<Record<F, unknown>>,
): readonly Inconsistency[] {
  return Object.freeze(
    fields.flatMap(field =>
      Object.is(viaDeployer[field], viaArtifacts[field])
        ? []
        : [
            Object.freeze({
              kind: 'config-lineage-field' as const,
              field,
              viaDeployer: viaDeployer[field],
              viaArtifacts: viaArtifacts[field],
            }),
          ],
    ),
  );
}

/**
 * When both handles are supplied, the intercept must wrap the resolver
 * belonging to the deployer's Config. TronBox's own flow never mispairs them —
 * `build/components/Migrate/index.js:Migration` creates both together — but a
 * hand-built harness or a memoization keyed on only one handle can, and the
 * consequence is configuration from one migration's lineage with artifact
 * write-back to another's cache.
 *
 * This is the one place `config.resolver` is read, and it is read *only* for
 * this identity comparison. The rule is that no abstraction is ever
 * obtained through it, which this does not do.
 */
export function checkResolverPairing(
  lineages: ConfigLineages,
  recorder: InternalPathRecorder,
):
  | Extract<
      Inconsistency,
      { readonly kind: 'artifacts-not-wrapping-deployer-resolver' }
    >
  | ConfigReadFailure
  | undefined {
  if (
    lineages.viaDeployer.status !== 'present' ||
    lineages.viaArtifacts.status !== 'present'
  ) {
    return undefined;
  }

  try {
    const deployerResolver = readLineageProperty(
      lineages.viaDeployer.lineage,
      'resolver',
      recorder,
    );
    if (!isObjectLike(deployerResolver)) {
      return failInvariant(
        'The deployer Config carries no resolver object, so the artifacts ' +
          'intercept cannot be verified as wrapping it.',
      );
    }

    return deployerResolver === lineages.viaArtifacts.lineage.resolver
      ? undefined
      : Object.freeze({ kind: 'artifacts-not-wrapping-deployer-resolver' });
  } catch (error) {
    if (error instanceof ConfigReadFailureError) {
      return error.failure;
    }
    throw error;
  }
}

/**
 * One of the indeterminate-report modes: `crossChecked` is `false` exactly
 * when fewer than two lineages were reachable, and
 * `crossCheckSkippedBecause` names which one was available.
 * Neither is inferable from the other fields, which is why both are reported.
 */
export function configLineageProvenance(
  lineages: ConfigLineages,
): ConfigLineageProvenance {
  const viaDeployerPresent = lineages.viaDeployer.status === 'present';
  const viaArtifactsPresent = lineages.viaArtifacts.status === 'present';

  const base = {
    viaDeployer: viaDeployerPresent
      ? lineages.viaDeployer.lineage.binding
      : 'absent',
    viaArtifacts: viaArtifactsPresent
      ? lineages.viaArtifacts.lineage.binding
      : 'absent',
    crossChecked: viaDeployerPresent && viaArtifactsPresent,
    sameObject:
      viaDeployerPresent &&
      viaArtifactsPresent &&
      lineages.viaDeployer.lineage.config ===
        lineages.viaArtifacts.lineage.config,
  } as const;

  if (viaDeployerPresent && !viaArtifactsPresent) {
    return Object.freeze({
      ...base,
      crossCheckSkippedBecause: 'only-deployer-lineage-available',
    });
  }
  if (!viaDeployerPresent && viaArtifactsPresent) {
    return Object.freeze({
      ...base,
      crossCheckSkippedBecause: 'only-artifacts-lineage-available',
    });
  }
  return Object.freeze(base);
}
