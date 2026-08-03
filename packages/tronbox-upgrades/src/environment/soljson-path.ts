import path from 'node:path';

import { assertAbsolutePath } from './paths';
import type { AbsolutePath, CompilerConfiguration } from './types';

/**
 * Where TronBox keeps the compiler it would use, resolved to an absolute path.
 *
 * **Why this is in the seam.** The convention below is host-internal: clone
 * `src/components/TronSolc.js:66` and `:96` at `v4.9.0` are
 * `path.join(homedir(), '.tronbox', options.evm ? 'evm-solc' : 'solc')` and
 * `soljson_v${compilerVersion}.js`. Nothing public promises it. The seam already
 * owns every other restated host constant for that reason —
 * `HOST_DEFAULT_SOLC_VERSION` in `./compiler` is the same argument applied to the
 * default version — and `./compiler`'s own `projectCompilerValues` already quotes
 * this path to explain why it reads the `evm` flag (`compiler.ts:254`). Up to now it
 * quoted it in a comment while a consumer rebuilt it in code, so a host that moved
 * its cache would have taken a comment and an implementation out of step in two
 * directories at once.
 *
 * **Why the home directory is a parameter and not a `homedir()` call.** This module
 * cannot read it, and that is enforced rather than chosen. `src/environment/**` is
 * asserted to import no ambient module: `node:os` is named in INV-43's forbidden
 * list (`test/performance-and-reuse.test.ts:129-130`) and falls outside INV-47's
 * permitted set (`:684-687`), and INV-44 makes the seam a function of its arguments
 * and its one injected reader alone (`:441`). So the *convention* moves in and the
 * *machine reading* stays out — the only split that leaves those three invariants
 * untouched. SF-2 supplies the value from its own injectable dependency surface.
 *
 * **What a consumer gets that it could not build itself.** An {@link AbsolutePath}.
 * INV-2 makes the brand mintable only by `assertAbsolutePath`, which lives in this
 * directory and refuses rather than resolves, so a branded path is evidence that the
 * seam composed it. That is load-bearing rather than decorative: the value's only
 * consumer hands it to a `createRequire`-constructed resolver
 * (`src/validation-input/compiler.ts:loadCompiler`), and a *relative* specifier
 * there would resolve against the plugin's own directory instead of the user's
 * compiler cache. `test/inv-49-host-import-boundary.test.ts` reads the brand as the
 * mechanism that keeps that require pointed where the seam put it.
 */

/** The host's cache directory under the user's home. `TronSolc.js:66`, `:96`. */
const HOST_CACHE_DIRECTORY = '.tronbox';

/**
 * Which of the two caches a family reads, keyed exhaustively.
 *
 * A `Record` rather than the host's own `options.evm ? 'evm-solc' : 'solc'`
 * ternary, and that is the point: a ternary maps every *future* family onto
 * `'solc'` silently, so a third family would send validation at a compiler that is
 * not the one the artifacts were built with and nothing would fail. `satisfies`
 * makes a new member of `CompilerConfiguration['family']` a compile error here.
 */
const CACHE_TREE = Object.freeze({
  tvm: 'solc',
  evm: 'evm-solc',
} as const satisfies Record<CompilerConfiguration['family'], string>);

/** Whether a compiler-slot member bears on *where* the compiler lives. */
type LocationRelevance =
  | 'decides-the-cache-tree'
  | 'decides-the-file-name'
  | 'not-a-location';

/**
 * Every member of the compiler slot, classified.
 *
 * `ArtifactAccess.record()`'s coverage idiom (`./artifact-record.ts:136-170`)
 * applied to the other direction: there the table is keyed by the fields being
 * *read* and the assertion is that it covers the record; here it is keyed by the
 * whole slot and the assertion is that every member has been *considered*. Both
 * exist for one failure — a value derived by iterating a hand-kept list, and a
 * field added to the shape without being added to the list.
 *
 * The concrete drift this catches: a future `CompilerConfiguration` member that
 * redirects the cache — a project-level `solcCacheDirectory`, say — would make this
 * resolver quietly wrong, because a resolver that ignores a member it never heard of
 * cannot report that it ignored it. `satisfies` turns that into a compile error at
 * the one place with the standing to classify it.
 */
const LOCATION_RELEVANCE = Object.freeze({
  family: 'decides-the-cache-tree',
  resolvedVersion: 'decides-the-file-name',
  settings: 'not-a-location',
  viaLegacyFlag: 'not-a-location',
  versionIsHostDefault: 'not-a-location',
  settingsSource: 'not-a-location',
} as const satisfies Record<keyof CompilerConfiguration, LocationRelevance>);

type RelevanceTable = typeof LOCATION_RELEVANCE;

/**
 * The half `satisfies` cannot give, stated where someone auditing the invariant
 * will look — exactly `ArtifactRecordFieldCoverage`'s reason for existing.
 */
type AssertTrue<T extends true> = T;
export type CompilerLocationFieldCoverage = AssertTrue<
  [keyof RelevanceTable] extends [keyof CompilerConfiguration]
    ? [keyof CompilerConfiguration] extends [keyof RelevanceTable]
      ? true
      : false
    : false
>;

/**
 * The slot members this resolver reads, **derived from the table** rather than
 * listed a second time. Reclassifying a member as location-relevant widens this
 * automatically, so the input shape and the classification cannot drift apart.
 */
type LocationField = {
  [K in keyof RelevanceTable]: RelevanceTable[K] extends 'not-a-location'
    ? never
    : K;
}[keyof RelevanceTable];

export type SoljsonPathInput = Pick<CompilerConfiguration, LocationField>;

/**
 * A resolution, or the one condition that makes the convention unusable.
 *
 * A report rather than a throw, for the reason the seam reports everywhere else
 * (`BuildInfoReadResult`, `ArtifactRecordReport`, `CompilerSettingsOutcome`):
 * INV-10 fixes the seam's error family at three subclasses, and a machine whose
 * home directory is not an absolute path is none of those three diagnoses. The
 * refusal arm carries no payload because it needs none — the caller supplied the
 * home directory, so it already holds the only value a message would name.
 */
export type SoljsonPathResolution =
  | { readonly status: 'resolved'; readonly soljsonPath: AbsolutePath }
  | { readonly status: 'home-not-absolute' };

/**
 * `homeDirectory` is the machine's home directory — `os.homedir()` at the
 * consumer's own injection point.
 *
 * It is **refused rather than resolved** when it is not absolute (INV-2's rule,
 * applied to a machine fact instead of a Config one): `path.resolve` would anchor it
 * on a cwd `build/components/Require.js:Require.file` moves mid-migration, and the
 * value's consumer is a module loader, so a relative result would load whatever sits
 * beside the plugin. The check is local rather than delegated to
 * `assertAbsolutePath` because that function's refusal reads *"TronBox reported the
 * relative value"*, which would attribute a machine fact to the host.
 *
 * The `assertAbsolutePath` below cannot refuse: `path.join` on an absolute first
 * segment is absolute for every remaining segment, `..` included. It is here for the
 * *type* — INV-2's brand comes from the minter or it is worth nothing, and a cast
 * would make it evidence of itself.
 */
export function soljsonPathFor(
  homeDirectory: string,
  compiler: SoljsonPathInput,
): SoljsonPathResolution {
  if (!path.isAbsolute(homeDirectory)) {
    return Object.freeze({ status: 'home-not-absolute' });
  }
  return Object.freeze({
    status: 'resolved',
    soljsonPath: assertAbsolutePath(
      path.join(
        homeDirectory,
        HOST_CACHE_DIRECTORY,
        CACHE_TREE[compiler.family],
        `soljson_v${compiler.resolvedVersion}.js`,
      ),
      'the TronBox compiler cache path',
    ),
  });
}
