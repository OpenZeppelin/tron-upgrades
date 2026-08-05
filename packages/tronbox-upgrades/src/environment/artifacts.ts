import path from 'node:path';
import {
  buildArtifactAmbiguityIndex,
  fileSystemBuildInfoReader,
  normalizeArtifactName,
  type ArtifactAmbiguityIndex,
  type BuildInfoReader,
} from './ambiguity';
import { readArtifactRecord } from './artifact-record';
import type { ConfigReadFailure } from './config-lineage';
import { EnvironmentIncompleteError, unsatisfiedSlot } from './errors';
import { assertAbsolutePath } from './paths';
import {
  hostSharingGuard,
  isObjectLike,
  readOwnProperty,
  readProperty,
  sealSlot,
  type InternalPathRecorder,
} from './handles';
import type {
  ArtifactAccess,
  ArtifactRecordReport,
  ArtifactResolution,
  ContractAbstraction,
  ProjectPaths,
  ResolverInterceptHandle,
} from './types';

export type InterceptAttempt =
  | { readonly ok: true; readonly intercept: ResolverInterceptHandle }
  | { readonly ok: false; readonly failure: ConfigReadFailure };

function malformed(
  expectedPath: string,
  because: 'missing' | 'threw',
): InterceptAttempt {
  return {
    ok: false,
    failure: Object.freeze({
      kind: 'handle-malformed',
      handle: 'artifacts',
      expectedPath,
      because,
    }),
  };
}

/**
 * The `artifacts` handle reaches a slot only after every property path
 * this slot depends on has been shown to exist. `require` and `contracts` are
 * probed with `in` because they live on `ResolverIntercept.prototype`;
 * `resolver` is an own property.
 */
export function interceptFromHandle(
  artifacts: unknown,
  recorder: InternalPathRecorder,
): InterceptAttempt {
  if (!isObjectLike(artifacts)) {
    return malformed('artifacts', 'missing');
  }

  for (const method of ['require', 'contracts'] as const) {
    const read = readProperty(
      artifacts,
      method,
      `artifacts.${method}`,
      recorder,
    );
    if (!read.ok) {
      return malformed(`artifacts.${method}`, read.reason);
    }
    if (typeof read.value !== 'function') {
      return malformed(`artifacts.${method}`, 'missing');
    }
  }

  const resolver = readOwnProperty(
    artifacts,
    'resolver',
    'artifacts.resolver',
    recorder,
  );
  if (!resolver.ok) {
    return malformed('artifacts.resolver', resolver.reason);
  }
  if (!isObjectLike(resolver.value)) {
    return malformed('artifacts.resolver', 'missing');
  }

  return {
    ok: true,
    intercept: artifacts as unknown as ResolverInterceptHandle,
  };
}

/**
 * A host failure becomes one of the environment seam's own typed shapes.
 * Reuses `EnvironmentIncompleteError` with an `invariant-violated` cause
 * rather than introducing a fourth error class, which is forbidden.
 */
function artifactFailure(detail: string): never {
  throw new EnvironmentIncompleteError([
    unsatisfiedSlot('artifacts', { kind: 'invariant-violated', detail }),
  ]);
}

type InterceptOutcome =
  | { readonly ok: true; readonly contract: ContractAbstraction }
  /** `Resolver.prototype.require` threw — every source returned falsy. */
  | { readonly ok: false; readonly channel: 'threw' }
  /** A source returned a nullish or non-object value that reached us. */
  | { readonly ok: false; readonly channel: 'nullish' };

/**
 * Every abstraction the seam returns comes through the injected
 * intercept, never through a fresh resolver and never through `config.resolver`.
 *
 * `build/components/Resolver/intercept.js:ResolverIntercept.prototype.contracts`
 * returns exactly `Object.keys(this.cache).map(key => this.cache[key])`, and
 * that set is what `artifactor.saveAll` writes back at the end of the migration.
 * An abstraction obtained from a fresh resolver is functionally identical and
 * absent from the cache, so it works for the whole operation and its address is
 * silently missing from the artifact afterwards.
 *
 * Both host failure channels are covered: `Resolver.prototype.require` throws
 * a bare `Error("Could not find artifacts for … from any sources")`, while the
 * sources themselves signal failure by returning `null`.
 */
function resolveThroughIntercept(
  intercept: ResolverInterceptHandle,
  input: string,
): InterceptOutcome {
  let resolved: unknown;
  try {
    resolved = intercept.require(input);
  } catch {
    return { ok: false, channel: 'threw' };
  }
  return isObjectLike(resolved)
    ? { ok: true, contract: resolved as ContractAbstraction }
    : { ok: false, channel: 'nullish' };
}

function contractSourcePath(
  contract: ContractAbstraction,
): string | undefined {
  try {
    const sourcePath = contract.sourcePath;
    return typeof sourcePath === 'string' ? sourcePath : undefined;
  } catch {
    return undefined;
  }
}

const PATH_SEPARATORS = /[\\/]/;

function bareNameHint(name: string): string {
  return PATH_SEPARATORS.test(name)
    ? ' The name contains a path separator; TronBox\'s filesystem resolver ' +
        'returns nothing for such a name unless it ends in ".json". Use ' +
        '`resolvePackaged` for a JSON artifact inside an installed package.'
    : '';
}

/**
 * The API contract for a packaged path, checked with pure path arithmetic and
 * zero filesystem access.
 *
 * This is the first of the three ordered checks (containment, existence,
 * malformed), and the only one needing no capability whatever. Of the three
 * causes `build/components/Resolver/fs.js
 * :FS.prototype.requireJson` collapses into one `null` — absent, malformed JSON,
 * and outside the project — the third is decidable here with zero I/O and is
 * refused by name. Deciding it first is what guarantees an escaping path is
 * never probed; the other two are separated after delegation, by the reader's
 * existence probe (the injected reader's second method).
 *
 * The refusals below subsume TronBox's own containment test rather than
 * reproducing it. `requireJson` prefixes any path not starting with `./` with
 * `./node_modules/` and then rejects a resolved path escaping
 * `working_directory`; since an accepted path here is relative, non-`./`, and
 * has no `..` segment surviving normalization, `<root>/node_modules/<path>`
 * cannot escape `<root>`. Reproducing the host's check as well would add a
 * branch nothing can reach.
 */
function validatePackageRelativePath(
  packageRelativePath: unknown,
): string {
  if (typeof packageRelativePath !== 'string') {
    return artifactFailure(
      'a packaged artifact must be addressed by a string path relative to ' +
        `node_modules, and the argument is of type ${typeof packageRelativePath}.`,
    );
  }
  if (packageRelativePath.length === 0) {
    return artifactFailure('a packaged artifact path must not be empty.');
  }
  if (packageRelativePath.includes('\0')) {
    return artifactFailure(
      'a packaged artifact path must not contain a NUL byte.',
    );
  }

  const slashNormalized = packageRelativePath.replace(/\\/g, '/');
  const normalized = path.posix.normalize(slashNormalized);
  if (
    packageRelativePath.startsWith('./') ||
    path.isAbsolute(packageRelativePath) ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    return artifactFailure(
      `packaged artifact path "${packageRelativePath}" must stay within an ` +
        'installed package under node_modules: it must be relative, must not ' +
        'begin with "./", and must not escape upwards.',
    );
  }
  if (!normalized.endsWith('.json')) {
    return artifactFailure(
      `packaged artifact path "${packageRelativePath}" must name a JSON ` +
        'artifact.',
    );
  }

  return packageRelativePath;
}

/**
 * Builds the `artifacts` slot.
 *
 * The ambiguity index is lazy and computed at most once, memoized in
 * this closure — never at module scope, which would carry a stale index across
 * migrations and, under `tronbox test`, index a build tree the run has
 * already replaced.
 */
export function createArtifactAccess(
  intercept: ResolverInterceptHandle,
  paths: ProjectPaths,
  reader: BuildInfoReader = fileSystemBuildInfoReader,
): ArtifactAccess {
  let index: ArtifactAmbiguityIndex | undefined;

  function getIndex(): ArtifactAmbiguityIndex {
    index ??= buildArtifactAmbiguityIndex(paths, reader);
    return index;
  }

  function resolve(name: string): ArtifactResolution {
    if (typeof name !== 'string') {
      return artifactFailure(
        'a contract must be addressed by a string bare name, and the ' +
          `argument is of type ${typeof name}.`,
      );
    }
    const normalizedName = normalizeArtifactName(name);

    // Resolve through the intercept before touching the index: a name that does
    // not resolve at all should fail with its own diagnosis rather than after
    // megabytes of build-info I/O.
    const outcome = resolveThroughIntercept(intercept, normalizedName);
    if (!outcome.ok) {
      return artifactFailure(
        `contract "${normalizedName}" could not be resolved through the ` +
          'injected ResolverIntercept' +
          (outcome.channel === 'threw'
            ? ': every resolver source reported no artifact.'
            : ': a resolver source returned no usable artifact object.') +
          bareNameHint(normalizedName),
      );
    }
    const contract = outcome.contract;

    const report = getIndex().report;
    if (report.status === 'indeterminate') {
      // One of the indeterminate-report modes, and a routine state rather than a rare fallback:
      // build-info is never written under `tronbox test`, which is the same
      // context that forces a full migration replay.
      return Object.freeze({
        status: 'indeterminate',
        name: normalizedName,
        reason: report.reason,
        unverifiedContract: contract,
      });
    }

    const candidates = getIndex().candidates(normalizedName);
    if (candidates.length > 1) {
      // Detection only. Policy for this branch is the proxy operations', and
      // `ArtifactNameAmbiguousError` is exported for the proxy operations to throw.
      return Object.freeze({
        status: 'ambiguous',
        name: normalizedName,
        candidates,
        unverifiedContract: contract,
      });
    }

    // Zero candidates is a complete index that holds no entry for this name —
    // so no bare-name collision exists, which is what `unique` asserts. The
    // index deliberately assesses no freshness (that is the validation ladder's), so the source
    // path falls back to the abstraction's own.
    const sourcePath =
      candidates[0]?.sourcePath ?? contractSourcePath(contract);
    if (sourcePath === undefined) {
      return artifactFailure(
        `contract "${normalizedName}" resolved to an abstraction carrying no ` +
          'source path, and no build-info entry names one either.',
      );
    }

    return Object.freeze({
      status: 'unique',
      name: normalizedName,
      contract,
      sourcePath,
    });
  }

  /**
   * Returns a `ContractAbstraction` or throws. Never nullish.
   *
   * The three causes are decided in the order containment → existence →
   * malformed, each with the least capability that can decide it. Containment is
   * pure path arithmetic, so an escaping path is never probed. "Missing" is the
   * reader's existence probe returning `false`. "Malformed" is concluded only
   * from the *conjunction* of existence and the host's failure, which is what
   * makes it impossible to report for a file that is simply absent — the
   * distinction the proxy operations' acceptance scenario 6 needs, because the two causes have
   * different remedies.
   *
   * The probe runs only after the host has already failed, so the happy path
   * costs no filesystem access at all.
   */
  function resolvePackaged(
    packageRelativePath: string,
  ): ContractAbstraction {
    const validated = validatePackageRelativePath(packageRelativePath);
    const outcome = resolveThroughIntercept(intercept, validated);
    if (outcome.ok) {
      return outcome.contract;
    }

    // The path TronBox resolved, reproduced from `requireJson`'s own arithmetic
    // so the messages name a real location rather than the caller's argument.
    // Absolute by construction — `paths.root` carries the brand and `path.join`
    // preserves it — but minted through the one assertion function all the same,
    // because there is no other way to obtain an `AbsolutePath`.
    const hostPath = path.join(paths.root, 'node_modules', validated);
    let exists: boolean;
    try {
      exists = reader.exists(
        assertAbsolutePath(hostPath, 'packaged artifact host path'),
      );
    } catch {
      // A probe that throws answers neither yes nor no, so it gets its own
      // refusal rather than being folded into "missing" — which would report a
      // file absent on the strength of a question that failed. Unreachable
      // through `fileSystemBuildInfoReader`, whose probe cannot throw; this
      // translates a misbehaving *injected* reader, the same way
      // `buildArtifactAmbiguityIndex` translates one that throws from `read`.
      return artifactFailure(
        `packaged artifact "${validated}" could not be loaded from ` +
          `"${hostPath}", and the injected reader's existence probe for that ` +
          'path failed, so the seam cannot say whether the file is missing or ' +
          'malformed.',
      );
    }

    if (!exists) {
      return artifactFailure(
        `packaged artifact "${validated}" does not exist at "${hostPath}". ` +
          'Nothing is installed at the path TronBox resolves, so install or ' +
          'update the package that provides the artifact.',
      );
    }
    return artifactFailure(
      `packaged artifact "${validated}" exists at "${hostPath}" but TronBox ` +
        'could not load it: the file is unreadable or is not valid JSON. ' +
        'Reinstall the package that provides it, or check its permissions.',
    );
  }

  /**
   * The `_json` hop happens inside the seam, and what leaves is frozen
   * plain data.
   *
   * The host-failure translation happens here rather than in
   * `artifact-record.ts`: that module stays total and reports a raising host
   * accessor as an outcome, and this is where it becomes one of the
   * environment seam's own errors. The refusal names the property path
   * only — never a value read off the artifact, which for `source` would be
   * the user's own file content.
   */
  function record(contract: ContractAbstraction): ArtifactRecordReport {
    const outcome = readArtifactRecord(contract);
    if (outcome.status === 'host-accessor-threw') {
      return artifactFailure(
        `reading "${outcome.path}" off a resolved contract abstraction raised. ` +
          'TronBox stores the compiled artifact there as a plain property, so a ' +
          'raising accessor means the abstraction is not one this TronBox ' +
          'version produces, and the plugin cannot tell which artifact fields ' +
          'are present.',
      );
    }
    return outcome;
  }

  return sealSlot<ArtifactAccess>(
    {
      resolve,
      resolvePackaged,
      ambiguities: () => getIndex().report,
      record,
      intercept,
    },
    ['intercept'],
    // The one host object in scope here is the intercept itself, and the sealed
    // object is the fresh literal above.
    hostSharingGuard(
      'the ResolverIntercept handed to createArtifactAccess is the only host ' +
        'object this function holds',
      [intercept],
    ),
  );
}
