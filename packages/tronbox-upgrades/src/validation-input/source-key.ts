import path from 'node:path';

import type { AbsolutePath } from '../environment';

/**
 * Source addressing: the key solc sees, and the path arithmetic that produces
 * the things keys are derived from. Nothing else — no reading, no graph walking,
 * no input assembly.
 *
 * **Why this is its own module.** F-6 measured that a wrong source key does not
 * degrade anything — it silently invalidates *every* identity the plugin
 * computes, including `hashBytecodeWithoutMetadata`, which is the manifest/impl
 * key. Changing `T.sol` to `sub/T.sol` changed the bytecode, the metadata and
 * both hashes, because `compilationTarget` is inside the metadata blob and the
 * creation code carries the runtime length as an immediate, so a longer key
 * shifts a `PUSH` operand *inside* the body that survives metadata trimming.
 * Nothing anywhere in the stack reports that as a key problem: the plugin would
 * refuse every validation as stale, for a reason no message mentions (G2). It
 * gets its own file so its test is unmissable rather than buried in input
 * assembly.
 *
 * **Why the path arithmetic is here too, and not only the key derivation.**
 * INV-6's second clause is *"no other module in `src/validation-input/**` calls
 * `path.relative`, `path.resolve` or `replace(/\\/g, '/')` on a source path"*,
 * enforced by a scan naming this file as the only one. Import resolution and the
 * artifact's own `sourcePath` both need that arithmetic, so co-locating it is
 * what the instrument requires rather than a widening of scope. The
 * *"nothing else"* constraint is about keeping graph traversal and input assembly
 * out, and they are out.
 *
 * **Everything below reproduces TronBox rather than calling it** (SF-0's INV-49 —
 * no module in this package imports the host by any path, and the host's own
 * compiler resolution has three `process.exit(1)` sites). Citations are into a
 * TronBox **clone** at tag `v4.9.0` — a clone of the host's own repository, not
 * the installed package: the published package ships only `build/`, one physical
 * line per file, so its line numbers are not checkable. The clone path is
 * deliberately not written down; it is per-machine, and a citation that names one
 * developer's checkout is unverifiable for everybody else and ships that
 * developer's home directory to every consumer of this package.
 */

/**
 * A key rejected because the host would reject it too.
 *
 * A discriminated result rather than a throw or a `null`, so the refusal arm
 * cannot be dropped silently — it is cause 4's and cause 5's raw material.
 */
export type SourceKeyResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: 'outside-contracts-directory' };

/**
 * The host's key derivation, reproduced exactly, in both of its shapes.
 *
 * Clone `src/components/Compile/index.js:49-63` at `v4.9.0`, verbatim:
 *
 * ```js
 * let key = source;
 * if (path.isAbsolute(key)) {
 *   key = path.relative(options.contracts_directory, key);
 *   if (key.startsWith('..')) { // hard error: outside the contracts directory
 *   }
 * }
 * key = key.replace(/\\/g, '/');
 * ```
 *
 * So there are two shapes and the difference is load-bearing (F-13):
 *
 * - An **absolute** path — every project source, because
 *   `profiler.js:dependency_graph` keys the graph on `resolved_path` and
 *   `Resolver/fs.js:resolve` returns the absolute `import_path` — is relativized
 *   against `contracts_directory`, and a result escaping it is refused rather
 *   than passed through. The host's own comment says why: leading `..` segments
 *   are normalized away by solc during import lookup, which breaks the
 *   source-key match.
 * - A **non-absolute** specifier — every npm import, because
 *   `Resolver/npm.js:resolve` returns `import_path` itself as the resolved path —
 *   passes through with backslash normalization only, and is **not** absolutized.
 *
 * Three wrong answers this must reject, and each produces a plugin that fails
 * everything: absolute keys, keys relativized against `working_directory`
 * instead of `contracts_directory`, and keys that keep Windows separators.
 */
export function sourceKey(
  source: string,
  contractsDirectory: AbsolutePath,
): SourceKeyResult {
  let key = source;

  if (path.isAbsolute(key)) {
    key = path.relative(contractsDirectory, key);
    if (key.startsWith('..')) {
      return { ok: false, reason: 'outside-contracts-directory' };
    }
  }

  return { ok: true, key: key.replace(/\\/g, '/') };
}

/** Whether a specifier is a filesystem reference rather than an npm one. */
export function isFileSystemSpecifier(specifier: string): boolean {
  // Clone `src/components/Resolver/index.js:45` — the host's own dispatch.
  return path.isAbsolute(specifier) || specifier.startsWith('.');
}

/**
 * Whether an import is explicitly relative, which is what decides whether it is
 * rewritten against its importer at all.
 *
 * Clone `src/components/Compile/profiler.js:257-258`: `import_path.indexOf('.') === 0`.
 * A specifier that is neither explicitly relative nor absolute is a module
 * reference and is left alone.
 */
export function isExplicitlyRelative(specifier: string): boolean {
  return specifier.startsWith('.');
}

/**
 * A relative import inside a **filesystem** source, resolved to an absolute path.
 *
 * Clone `src/components/Resolver/fs.js:73-76`:
 * `path.resolve(path.join(path.dirname(import_path), dependency_path))`.
 */
export function resolveFileSystemImport(
  importerPath: string,
  specifier: string,
): string {
  return path.resolve(path.join(path.dirname(importerPath), specifier));
}

/**
 * A relative import inside a **module** source, resolved to another module path.
 *
 * Clone `src/components/Resolver/npm.js:91-94`:
 * `path.join(path.dirname(import_path), dependency_path).replace(/\\/g, '/')`.
 * It stays a module path on purpose, so the same source is reached by the same
 * key wherever it is imported from — which is exactly the property F-6 says the
 * identity depends on.
 */
export function resolveModuleImport(
  importerSpecifier: string,
  specifier: string,
): string {
  return path
    .join(path.dirname(importerSpecifier), specifier)
    .replace(/\\/g, '/');
}

/**
 * Where a module specifier's bytes live.
 *
 * Clone `src/components/Resolver/npm.js:68`:
 * `path.join(nodeModulesDir, import_path)`, over a `nodeModulesDir` of
 * `path.join(this.working_directory, 'node_modules')`. The seam's
 * `paths.root` is the host's `working_directory` — `Config.load` anchors it on the
 * `tronbox.js` that `findUp` located, never on a cwd.
 */
export function modulePathOnDisk(root: AbsolutePath, specifier: string): string {
  return path.join(root, 'node_modules', specifier);
}

/**
 * Whether a module specifier is one the host would accept.
 *
 * Clone `src/components/Resolver/validate.js:12-19` (`isValidNpmImportPath`) at
 * `v4.9.0`:
 * absolute paths and `..` segments are refused as traversal, an unscoped
 * reference needs at least one `/`, and a scoped one at least two. Reproduced
 * because an import the host refuses is an import this plugin cannot compile the
 * project the same way with — so it is cause 5, decided before solc runs, rather
 * than a `ParserError` the user cannot act on.
 */
export function isValidModuleSpecifier(specifier: string): boolean {
  if (path.isAbsolute(specifier) || /(^|[\\/])\.\.([\\/]|$)/.test(specifier)) {
    return false;
  }
  if (specifier.startsWith('@')) {
    return (specifier.match(/\//g) ?? []).length >= 2;
  }
  return specifier.includes('/');
}

/**
 * The artifact's own record of where it was compiled from, as an absolute path.
 *
 * The seam hands `ArtifactRecord.sourcePath` through tool-verbatim and
 * deliberately unresolved (`src/environment/types.ts:240-245`), because SF-0's
 * INV-2 forbids resolving a path against a cwd TronBox moves. Resolving it
 * against `paths.root` is a different operation and a sound one: `root` is a
 * value the seam asserted absolute, not an ambient directory. TronBox writes an
 * absolute `sourcePath` in practice (F-4), so this is the branch that never
 * fires — kept because a relative value would otherwise be silently treated as
 * relative to wherever the process happens to be.
 */
export function absoluteSourcePath(
  sourcePath: string,
  root: AbsolutePath,
): string {
  return path.isAbsolute(sourcePath)
    ? sourcePath
    : path.resolve(root, sourcePath);
}
