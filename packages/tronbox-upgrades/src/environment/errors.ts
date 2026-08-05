import packageJson from '../../package.json';
import { slotRequirements } from './slots';
import type {
  ArtifactCandidate,
  EnvironmentDiagnosis,
  Inconsistency,
  SlotName,
  UnsatisfiedSlot,
} from './types';

/**
 * The declared range has exactly one home — `peerDependencies.tronbox`
 * in the plugin's own manifest — is read rather than restated, and is never a
 * comparison operand.
 *
 * The reason is **not** that a version string is unreachable, which is what an
 * earlier revision of this comment claimed. Half of that premise is right:
 * bare-name resolution is impossible, because the host's `package.json` declares
 * no `main`, no `exports` and only a `bin`, with no root `index.js`, so
 * `require.resolve('tronbox')` fails with `MODULE_NOT_FOUND` (verified present at
 * `v4.8.0` and `v4.9.0`). But the absence of an `exports` field is exactly what
 * leaves *subpaths* open — an `exports` map is what closes a package's internals —
 * so `require('tronbox/package.json')` resolves wherever the package is
 * physically present. A version string is available, just not portably.
 *
 * The seam still refuses to read one, because **a version comparison is the wrong
 * instrument even where it is available**, and wrong in both directions: a patch
 * release can move a property path, and a major bump can leave every path this
 * seam reads intact. The structural `handle-malformed` diagnosis *is* the version
 * check, and it answers the question that matters — is the property path this seam
 * needs present? — rather than a proxy for it. Reading the host's manifest is
 * additionally forbidden outright: no module in the plugin imports the
 * host, by any path.
 */
const declaredTronBoxRange: string = packageJson.peerDependencies.tronbox;

/** Exhaustiveness check: a union gaining a member becomes a compile error, not a fallthrough. */
function assertNever(value: never, context: string): never {
  throw new Error(
    `${context}: unhandled variant ${JSON.stringify(value)}`,
  );
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}

/**
 * Renders a compared Config value for an `inconsistent` message. Only members
 * of `ConfigScalarField` reach this, so the values are
 * strings, numbers, booleans or `null` — never a host object and never a
 * credential.
 */
function formatValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'number') {
    if (Object.is(value, -0)) {
      return '-0';
    }
    if (!Number.isFinite(value)) {
      return String(value);
    }
  }

  const rendered = JSON.stringify(value);
  return rendered === undefined ? String(value) : rendered;
}

function renderUnsatisfiedSlot(unsatisfied: UnsatisfiedSlot): string {
  const requirement = slotRequirements[unsatisfied.slot];
  const context =
    `provided in ${formatList(unsatisfied.providedIn)}; ` +
    `absent in ${formatList(unsatisfied.absentIn)}`;
  const cause = unsatisfied.cause;

  switch (cause.kind) {
    case 'handle-missing':
      return (
        `slot "${unsatisfied.slot}" needs one of ` +
        `[${formatList(requirement.handles)}]; handle ` +
        `"${cause.handle}" was not supplied (${context})`
      );
    case 'handle-malformed':
      return (
        `slot "${unsatisfied.slot}" received a malformed handle ` +
        `"${cause.handle}": property path "${cause.expectedPath}" ` +
        `${cause.because === 'threw' ? 'threw when read' : 'is absent'} ` +
        `(${context})`
      );
    case 'invariant-violated':
      return (
        `slot "${unsatisfied.slot}" violates an environment invariant: ` +
        `${cause.detail} (${context})`
      );
    default:
      return assertNever(cause, 'UnsatisfiedSlot.cause');
  }
}

function renderInconsistency(inconsistency: Inconsistency): string {
  switch (inconsistency.kind) {
    case 'config-lineage-field':
      return (
        `Config field "${inconsistency.field}" disagrees between the two ` +
        `lineages: via deployer=${formatValue(inconsistency.viaDeployer)}, ` +
        `via artifacts=${formatValue(inconsistency.viaArtifacts)}`
      );
    case 'artifacts-not-wrapping-deployer-resolver':
      return (
        'the supplied "artifacts" intercept does not wrap the resolver owned ' +
        "by the supplied deployer's Config, so configuration and artifact " +
        'write-back would come from different migrations'
      );
    case 'chain-handle-conflict':
      return (
        'the supplied "tronWrap" and "tronWeb" handles are different ' +
        'objects; TronBox injects them as two names for one object'
      );
    case 'compiler-settings-conflict':
      return (
        'the two Config lineages resolved solc settings to different objects, ' +
        'so the compiler settings a validation would reproduce depend on which ' +
        "handle it was reached through. The settings' own values are not shown " +
        'here: only allow-listed scalars are ever rendered, and ' +
        '"compiler.settingsSource" already names the config key they came from'
      );
    default:
      return assertNever(inconsistency, 'Inconsistency');
  }
}

/**
 * Exactly three subclasses, each with a `code` derived from its
 * `diagnosis` by the template-literal type. A fourth failure class cannot be
 * added without deliberately widening `EnvironmentDiagnosis`.
 */
export abstract class TronBoxEnvironmentError extends Error {
  abstract readonly diagnosis: EnvironmentDiagnosis;
  abstract readonly code: `TRONBOX_ENV_${Uppercase<EnvironmentDiagnosis>}`;
}

/** The only diagnosis that says "outside a TronBox migration context". */
export class EnvironmentAbsentError extends TronBoxEnvironmentError {
  readonly diagnosis = 'absent' as const;
  readonly code = 'TRONBOX_ENV_ABSENT' as const;
  readonly requested: readonly SlotName[];

  constructor(requested: readonly SlotName[]) {
    const frozen = Object.freeze([...requested]);
    super(
      'The plugin was invoked outside a TronBox migration context: none of ' +
        `the handles bearing on the requested slots [${formatList(frozen)}] ` +
        'was supplied.',
    );
    this.name = 'EnvironmentAbsentError';
    this.requested = frozen;
  }
}

/** A required capability cannot be constructed. */
export class EnvironmentIncompleteError extends TronBoxEnvironmentError {
  readonly diagnosis = 'incomplete' as const;
  readonly code = 'TRONBOX_ENV_INCOMPLETE' as const;
  readonly unsatisfied: readonly UnsatisfiedSlot[];

  constructor(unsatisfied: readonly UnsatisfiedSlot[]) {
    const frozen = Object.freeze([...unsatisfied]);
    super(
      'The TronBox environment is incomplete:\n' +
        frozen.map(item => `- ${renderUnsatisfiedSlot(item)}`).join('\n') +
        `\nDeclared TronBox peer range: ${declaredTronBoxRange}.`,
    );
    this.name = 'EnvironmentIncompleteError';
    this.unsatisfied = frozen;
  }
}

/** Every required capability was constructed and the sources disagree. */
export class EnvironmentInconsistentError extends TronBoxEnvironmentError {
  readonly diagnosis = 'inconsistent' as const;
  readonly code = 'TRONBOX_ENV_INCONSISTENT' as const;
  readonly inconsistencies: readonly Inconsistency[];

  constructor(inconsistencies: readonly Inconsistency[]) {
    const frozen = Object.freeze([...inconsistencies]);
    super(
      'The TronBox environment is internally inconsistent:\n' +
        frozen.map(item => `- ${renderInconsistency(item)}`).join('\n'),
    );
    this.name = 'EnvironmentInconsistentError';
    this.inconsistencies = frozen;
  }
}

/**
 * Exported for the proxy operations to throw if refusal is the policy it
 * chooses. The environment seam owns the diagnosis text because it holds the
 * candidates; the environment seam never throws this itself. Deliberately not
 * a `TronBoxEnvironmentError` subclass — that family is fixed at three.
 */
export class ArtifactNameAmbiguousError extends Error {
  readonly candidates: readonly ArtifactCandidate[];

  constructor(
    readonly contractName: string,
    candidates: readonly ArtifactCandidate[],
  ) {
    const frozen = Object.freeze([...candidates]);
    super(
      `Artifact name "${contractName}" is ambiguous across ` +
        `${frozen.length} candidates:\n` +
        frozen
          .map(
            candidate =>
              `- ${candidate.sourcePath}:${candidate.contractName} ` +
              `(from build info ${candidate.buildInfoFile})`,
          )
          .join('\n'),
    );
    this.name = 'ArtifactNameAmbiguousError';
    this.candidates = frozen;
  }
}

export function getDeclaredTronBoxRange(): string {
  return declaredTronBoxRange;
}

/**
 * The only constructor for an `UnsatisfiedSlot`. `providedIn` and
 * `absentIn` are read from the slot table, never authored at a throw site, so
 * a table edit cannot leave a hand-written message contradicting it.
 */
export function unsatisfiedSlot(
  slot: SlotName,
  cause: UnsatisfiedSlot['cause'],
): UnsatisfiedSlot {
  const requirement = slotRequirements[slot];
  return Object.freeze({
    slot,
    cause: Object.freeze(cause),
    providedIn: requirement.providedIn,
    absentIn: requirement.absentIn,
  });
}
