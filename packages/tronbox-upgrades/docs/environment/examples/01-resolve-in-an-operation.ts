/**
 * Pattern 1 — resolve inside the operation, asking for the minimum.
 *
 * The shape every sub-feature consuming the seam should follow: handles arrive as
 * an argument, resolution happens inside the call, and the slot list is the
 * smallest one that does the job.
 */
import {
  EnvironmentAbsentError,
  EnvironmentIncompleteError,
  EnvironmentInconsistentError,
  resolveEnvironment,
  TronBoxEnvironmentError,
  type RawMigrationHandles,
} from '../../../src/environment';

export interface ValidateOptions {
  readonly handles: RawMigrationHandles;
  readonly contractName: string;
}

/** Resolves a contract's source path, tolerating both degraded artifact modes. */
export function validateContract(options: ValidateOptions): string {
  const env = resolveEnvironment(options.handles, {
    require: ['paths', 'artifacts'],
    optional: ['output'],
  });

  // `paths` and `artifacts` were required, so they are non-optional here — no
  // null check, which is INV-1's whole purpose.
  const resolution = env.artifacts.resolve(options.contractName);

  // `output` was optional, so it is `OutputChannelSlot | undefined`.
  env.output?.logger.log(`resolving under ${env.paths.root}`);

  switch (resolution.status) {
    case 'unique':
      return resolution.sourcePath;
    case 'ambiguous':
      // Detection only — the refusal-or-pick policy belongs to SF-5. Note the
      // field is `unverifiedContract`, not `contract`.
      return resolution.candidates[0]?.sourcePath ?? options.contractName;
    case 'indeterminate':
      // Routine, not exceptional: build info is never written under
      // `tronbox test`, which is the same context that replays every migration.
      return options.contractName;
  }
}

/**
 * Turn a seam failure into a message about the operation the user attempted.
 *
 * Narrow with `instanceof`, not by switching on `code`: `code` is a discriminant
 * on the *base* class, so switching on it does not narrow to the subclass and the
 * structured payload (`unsatisfied`, `inconsistencies`) stays unreachable.
 */
export function describeEnvironmentFailure(
  handles: RawMigrationHandles,
): string | undefined {
  try {
    resolveEnvironment(handles, { require: ['paths', 'network'] });
    return undefined;
  } catch (error) {
    if (!(error instanceof TronBoxEnvironmentError)) {
      throw error; // Not ours. Do not swallow it.
    }
    if (error instanceof EnvironmentAbsentError) {
      return (
        `Run this through \`tronbox migrate\`; no handle bearing on ` +
        `[${error.requested.join(', ')}] was supplied.`
      );
    }
    if (error instanceof EnvironmentIncompleteError) {
      // Read the structured payload rather than parsing the message.
      return error.unsatisfied
        .map(item => {
          const where = `available in ${item.providedIn.join(', ')}`;
          switch (item.cause.kind) {
            case 'handle-missing':
              return `${item.slot}: no "${item.cause.handle}" handle (${where})`;
            case 'handle-malformed':
              return (
                `${item.slot}: "${item.cause.handle}" is malformed — ` +
                `${item.cause.expectedPath} ` +
                `${item.cause.because === 'threw' ? 'threw' : 'is absent'} ` +
                `(${where})`
              );
            case 'invariant-violated':
              return `${item.slot}: ${item.cause.detail}`;
          }
        })
        .join('\n');
    }
    if (error instanceof EnvironmentInconsistentError) {
      return error.inconsistencies
        .map(item =>
          item.kind === 'config-lineage-field'
            ? `"${item.field}" disagrees between the two Config lineages`
            : item.kind,
        )
        .join('\n');
    }
    return error.message;
  }
}

/**
 * Memoize per migration — keyed on a handle, never on the `Config`.
 *
 * `deployer` and `artifacts` are fresh per migration while the `Config` is shared
 * across them, so a `Config`-keyed memo serves migration N's composite to N+1
 * (INV-22). Keying on one handle is safe because `resolveEnvironment`'s own
 * resolver-pairing check covers the other.
 */
type Resolved = ReturnType<typeof resolveFor>;

function resolveFor(handles: RawMigrationHandles): ReturnType<
  typeof resolveEnvironment<readonly ['paths', 'network', 'artifacts']>
> {
  return resolveEnvironment(handles, {
    require: ['paths', 'network', 'artifacts'],
  });
}

const perMigration = new WeakMap<object, Resolved>();

export function cachedEnvironment(handles: RawMigrationHandles): Resolved {
  const key = handles.artifacts;
  if (typeof key !== 'object' || key === null) {
    return resolveFor(handles); // Nothing stable to key on.
  }
  const existing = perMigration.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const env = resolveFor(handles);
  perMigration.set(key, env);
  return env;
}
