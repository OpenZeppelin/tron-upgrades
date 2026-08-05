import path from 'node:path';
import {
  ConfigReadFailureError,
  failInvariant,
  pathConfigLineageFields,
  readLineageProperty,
  type ConfigLineage,
  type ConfigReadFailure,
  type PathScalarField,
} from './config-lineage';
import type { InternalPathRecorder } from './handles';
import type { AbsolutePath, ProjectPaths } from './types';

/**
 * The only place the `AbsolutePath` brand is minted. Refuses rather than
 * resolves — `path.resolve` against a cwd is unavailable in principle here,
 * because `build/components/Require.js:Require.file` chdirs to the migration's
 * directory for the file's top-level evaluation and restores it before the
 * exported function runs. The cwd therefore differs between plugin-require time
 * and operation-call time: at require time it is the migration's own directory,
 * which is never the project root, and at call time it is whatever the host
 * restores — the process's invocation directory, which equals the project root
 * only when TronBox was invoked from there, since `Config.load` anchors
 * `working_directory` on the `tronbox.js` that `findUp` located rather than on the
 * cwd. Resolving is therefore unsound in both phases, right by coincidence in at
 * most one of them. The restore is a `finally`, and the two `process.chdir` calls
 * it brackets are the only two in the whole host: clone `src/components/Require.js`
 * at `v4.9.0:57` and `:63`, `v4.8.0:58` and `:64`.
 *
 * Nothing is normalized: the value is passed through byte for byte so a
 * cross-lineage comparison sees what the tool holds.
 */
export function assertAbsolutePath(
  value: unknown,
  field: string,
): AbsolutePath {
  if (typeof value !== 'string') {
    return failInvariant(
      `"${field}" must be an absolute path string, and is of type ` +
        `${value === null ? 'null' : typeof value}.`,
    );
  }
  if (!path.isAbsolute(value)) {
    return failInvariant(
      `"${field}" must be absolute; TronBox reported the relative value ` +
        `"${value}". The seam refuses a relative project anchor rather than ` +
        'resolving it against an ambient working directory.',
    );
  }
  return value as AbsolutePath;
}

/** Containment by path arithmetic only — no `fs` call, no symlink resolution. */
export function isContainedIn(
  root: AbsolutePath,
  candidate: AbsolutePath,
): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export type PathScalarValues = Readonly<Record<PathScalarField, AbsolutePath>>;

/**
 * Reads and validates the four path scalars off one lineage.
 *
 * Each key is asserted independently rather than trusting `root`. TronBox's
 * `Config.prototype.addProp` applies a path key's `transform` on **set** but
 * calls its `default()` on **get**, and every path default is a bare
 * `path.join(self.working_directory, …)` that never passes through `transform` —
 * so absoluteness on the default path is inherited from `working_directory`
 * rather than enforced per key. And `working_directory` is itself the one path
 * key declared as a bare no-op in the `props` map, absent from
 * `Config.prototype.merge`'s `strictPathKeys`, so a `tronbox.js` declaring
 * `working_directory: '../shared'` silently replaces the absolute value.
 */
export function projectPathValues(
  lineage: ConfigLineage,
  recorder: InternalPathRecorder,
): PathScalarValues | ConfigReadFailure {
  try {
    const values = Object.freeze(
      Object.fromEntries(
        pathConfigLineageFields.map(field => [
          field,
          assertAbsolutePath(
            readLineageProperty(lineage, field, recorder),
            field,
          ),
        ]),
      ) as Record<PathScalarField, AbsolutePath>,
    );

    // `build_info_directory` cannot legally escape the project, while
    // `contracts_build_directory` can — `resolvePathInWorkingDirectory` returns
    // early for that one key when `_allowExternalContractsBuildDirectory` is
    // set, which is how `build/lib/commands/test.js` points the build tree at a
    // temporary directory. So an escaping build-info directory is a violation,
    // not a supported configuration.
    if (!isContainedIn(values.working_directory, values.build_info_directory)) {
      return failInvariant(
        `"build_info_directory" (${values.build_info_directory}) is outside ` +
          `the project root (${values.working_directory}). TronBox only ` +
          'permits "contracts_build_directory" to escape the project.',
      );
    }

    return values;
  } catch (error) {
    if (error instanceof ConfigReadFailureError) {
      return error.failure;
    }
    throw error;
  }
}

/**
 * Total function of the validated scalars — every failure already happened in
 * {@link projectPathValues}. Constructing the slot from the *compared* values
 * is what makes the no-silent-preference rule structural for this slot: when
 * both lineages are present and agree, there is no lineage object to prefer.
 */
export function buildProjectPaths(values: PathScalarValues): ProjectPaths {
  return Object.freeze({
    root: values.working_directory,
    contractsDirectory: values.contracts_directory,
    contractsBuildDirectory: values.contracts_build_directory,
    buildInfoDirectory: values.build_info_directory,
    // Observed by containment, never inferred from the invoking command.
    contractsBuildDirectoryIsExternal: !isContainedIn(
      values.working_directory,
      values.contracts_build_directory,
    ),
  });
}
