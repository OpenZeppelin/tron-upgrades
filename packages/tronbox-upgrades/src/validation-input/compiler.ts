import { createRequire } from 'node:module';

import {
  soljsonPathFor,
  type AbsolutePath,
  type CompilerConfiguration,
} from '../environment';

import type { Cause } from './causes';
import { CompilerRetiredError, ValidationInputInvariantError } from './errors';
import type { SolcStandardInput, SolcStandardOutput } from './solc-input';

/**
 * The TVM compiler's whole lifecycle — locate, gate, load, wrap, and **retire** —
 * plus the one declaration of the supported range.
 *
 * **Why the lifecycle is one module.** A caught
 * `WebAssembly.RuntimeError` invalidates the module, because emscripten's abort
 * poisons it. A handle that can be poisoned must not have its loading in one
 * module and its disposal in another, or a caught ceiling on contract A silently
 * becomes a spurious ceiling on contracts B..Z. The evidence that this is real
 * rather than theoretical is `evidence/probe-wasm-memory-ceiling.js`'s own design:
 * one fresh child process per trial.
 *
 * **The host is reproduced, never called** (SF-0's INV-49, INV-25). TronBox's own
 * `getWrapper` has three `process.exit(1)` sites — an invalid version string, a
 * version above its ceiling, and a download failure (clone
 * `src/components/TronSolc.js:84`, `:92`, `:118` at `v4.9.0`) — so routing
 * compiler resolution through it would kill the user's process mid-validation
 * with no diagnosis, no cause and no remedy. There is no `catch` for
 * `process.exit`. The compiler itself lives in the user's home directory rather
 * than inside `tronbox`, which is what makes the compliant route available at all.
 */

/**
 * The declared range, declared **once** (INV-16). Both the gate and the message
 * read it, so the range cannot drift out of sync with the check.
 *
 * **The floor is a plugin claim, not a compiler capability.** `0.5.13` is the
 * version where the TVM registry's builds begin emitting `storageLayout`, as
 * measured against the registry, and that is still the mechanical boundary — but it is
 * the boundary of the *compiler's* capability, and declaring it as the *plugin's*
 * would publish a support claim nothing measured: no probe ran upgrades-core
 * against sub-0.8 compiler output, `@openzeppelin/contracts-upgradeable` has
 * required `^0.8.0` since v4.0, and 12 of the registry's 35 builds are in this
 * range. `0.8.0` also subsumes the mechanical boundary, so F-5's silent-omission
 * hazard — a sub-0.5.13 compiler accepting a `storageLayout` request with zero
 * diagnostics and simply omitting the key — is unreachable from inside the
 * declared range.
 *
 * **The ceiling is the host's**: clone `src/components/TronSolc.js:9` is
 * `const maxVersion = '0.8.26'` and `:87-93` exits above it, verified at `v4.9.0`
 * and `v4.8.0`. It is *not* a formality under `--evm`, because `:87` reads
 * `compareVersions(compilerVersion, maxVersion) > 0 && !options.evm`, so
 * `0.8.27`–`0.8.29` become reachable there. Those are refused with the same
 * message, because they are equally untested.
 */
export const SUPPORTED_SOLC = { min: '0.8.0', max: '0.8.26' } as const;

/** Which compiler this validation ran, and how it was reached. */
export interface CompilerIdentity {
  /** F-7. Carried for the remedy, not for the comparison (C3). */
  readonly family: 'tvm' | 'evm';
  /** The triple the config resolved to. Used to *locate*, never to compare. */
  readonly requestedVersion: string;
  /** What `version()` returned. INV-5: this is what cause 3 compares. */
  readonly longVersion: string;
  readonly soljsonPath: string;
}

/**
 * A loaded compiler, single-use-after-failure (INV-24).
 *
 * `compile` is synchronous, and that is structural rather than incidental:
 * `solidity_compile` is a synchronous `cwrap` that blocks the event loop for its
 * whole duration, so `Promise.race` and `AbortSignal` cannot bound it. A
 * `Promise`-returning signature here would imply a wall-clock bound that v1 does
 * not have and cannot have without a worker thread or child process (INV-36).
 *
 * There is no import-callback parameter, which is where INV-27's *"every source
 * is supplied up front"* lives: the host passes none either
 * (clone `src/components/TronSolc.js:55` is `compile(input, null, null)`), so an
 * unresolved import has to be decided before this is called or it surfaces as a
 * `ParserError` about the plugin's own input assembly.
 */
export interface CompilerHandle {
  readonly longVersion: string;
  /** Throws {@link CompilerRetiredError} if called after a previous throw. */
  compile(input: SolcStandardInput): SolcStandardOutput;
}

/** What the gate produces. The handle is unobtainable without passing it. */
export type CompilerOpenResult =
  | {
      readonly ok: true;
      readonly handle: CompilerHandle;
      readonly identity: CompilerIdentity;
    }
  | { readonly ok: false; readonly cause: Cause };

/**
 * The host's own version comparison, reproduced.
 *
 * Clone `src/components/TronSolc.js:11-25`: split on `.`, compare numerically,
 * treat missing parts as `0`. Reproduced rather than replaced by a semver library
 * because the question this answers is *"would TronBox consider this version above
 * its ceiling"*, and answering it differently than the host does is how a plugin
 * requests a different compiler than the one the artifacts were built with.
 */
function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const l = leftParts[index] ?? 0;
    const r = rightParts[index] ?? 0;
    if (l > r) {
      return 1;
    }
    if (l < r) {
      return -1;
    }
  }
  return 0;
}

/** Clone `src/components/TronSolc.js:27-29`. */
function isVersionTriple(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

/**
 * The gate (INV-15). A version, never a probe.
 *
 * A version that is not a triple is out of range too — it is not a version the
 * host would accept either, and the remedy is the same one: name a version inside
 * the range. The host's answer to it is `process.exit(1)`, which is exactly what
 * this plugin must not do.
 */
export function isSupportedSolcVersion(version: string): boolean {
  return (
    isVersionTriple(version) &&
    compareVersions(version, SUPPORTED_SOLC.min) >= 0 &&
    compareVersions(version, SUPPORTED_SOLC.max) <= 0
  );
}

/**
 * **Where the compiler lives is not decided here.**
 *
 * The `~/.tronbox/{solc,evm-solc}/soljson_v<version>.js` convention is
 * host-internal, so the seam owns it — `src/environment/soljson-path.ts`, reached
 * through {@link soljsonPathFor}, which returns an `AbsolutePath`. This module
 * composes no path and reads no home directory; it receives one already resolved and
 * loads it.
 *
 * **That split is what makes the load auditable.** {@link loadCompiler} constructs a
 * resolver with `createRequire`, which is invisible to the specifier scan INV-49
 * rests on — so *"where can that resolver point"* has to be answerable mechanically
 * rather than by review. Two halves answer it, and only together: the parameter's
 * `AbsolutePath` brand, which INV-2 makes mintable only inside
 * `src/environment/**`, so a literal specifier, a computed string or a bare package
 * name is a type error **at every call site**; and the type-checked assertion over
 * this module's own body, which is what rules out the resolver being handed something
 * unbranded *inside* it. See {@link loadCompiler} for the assertions by name.
 */

/** The subset of an emscripten soljson module this wrapper drives. */
interface SoljsonModule {
  cwrap(
    name: string,
    returnType: string | null,
    argumentTypes: readonly string[],
  ): (...args: unknown[]) => unknown;
  readonly _solidity_version?: unknown;
  readonly _solidity_reset?: unknown;
  readonly _solidity_compile?: unknown;
}

function isSoljsonModule(value: unknown): value is SoljsonModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { cwrap?: unknown }).cwrap === 'function'
  );
}

/**
 * TronBox's `wrapSoljson`, reproduced for the declared range only.
 *
 * Clone `src/components/TronSolc.js:34-62`. Two details are load-bearing and both
 * are the host's:
 *
 * - **`reset()` after every compile** (`:38`, `:58`). `cwrap`'s `compile` copies
 *   the returned pointer into a JS string and there is no `free()` for it; `reset`
 *   clears the allocations. This is also why reusing one handle across partitions
 *   is *reproduction* rather than optimism.
 * - **the three-argument `solidity_compile`** (`:41`), which is the shape for
 *   0.6.0 and newer. Everything in `SUPPORTED_SOLC` is newer, so the pre-0.6
 *   branches the host still carries are unreachable here; a module that does not
 *   expose `_solidity_compile` is a broken assumption about a file the *gate* has
 *   already vouched for, so it raises rather than refusing.
 */
function wrapSoljson(soljson: SoljsonModule, soljsonPath: string): CompilerHandle {
  const version = soljson._solidity_version
    ? soljson.cwrap('solidity_version', 'string', [])
    : soljson.cwrap('version', 'string', []);
  const reset = soljson._solidity_reset
    ? soljson.cwrap('solidity_reset', null, [])
    : undefined;

  if (!soljson._solidity_compile) {
    throw new ValidationInputInvariantError(
      `the compiler at ${soljsonPath} exposes no "solidity_compile" entry ` +
        `point, so it is not a Solidity standard-JSON compiler.`,
    );
  }
  const compile = soljson.cwrap('solidity_compile', 'string', [
    'string',
    'number',
    'number',
  ]);

  const longVersion = String(version());

  /**
   * INV-24: set in the `catch` *before* re-raising, so no later call can reach
   * the wasm. Loud on reuse, because silence is the failure.
   */
  let retiredBy: string | undefined;

  return {
    longVersion,
    compile(input: SolcStandardInput): SolcStandardOutput {
      if (retiredBy !== undefined) {
        throw new CompilerRetiredError(retiredBy);
      }
      let raw: unknown;
      try {
        raw = compile(JSON.stringify(input), null, null);
      } catch (thrown) {
        retiredBy =
          thrown instanceof Error ? thrown.constructor.name : 'a non-Error throw';
        throw thrown;
      }
      if (reset) {
        reset();
      }
      return parseSolcOutput(raw, soljsonPath);
    },
  };
}

/**
 * solc answers with a JSON string. Malformed JSON from a compiler the gate
 * vouched for is a broken assumption rather than a user condition, so it raises;
 * a *well-formed* output that reports compile errors is cause 11 and is decided by
 * the caller, not here.
 */
function parseSolcOutput(raw: unknown, soljsonPath: string): SolcStandardOutput {
  if (typeof raw !== 'string') {
    throw new ValidationInputInvariantError(
      `the compiler at ${soljsonPath} returned ${typeof raw} rather than a ` +
        `standard-JSON string.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationInputInvariantError(
      `the compiler at ${soljsonPath} returned output that is not valid JSON.`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ValidationInputInvariantError(
      `the compiler at ${soljsonPath} returned a JSON ${typeof parsed} rather ` +
        `than a standard-JSON object.`,
    );
  }
  return parsed as SolcStandardOutput;
}

/**
 * The production loader. `createRequire` against a seam-resolved absolute path, with
 * zero host imports — the route `evidence/probe-recompile-fidelity.js` demonstrates.
 *
 * **This is the only `createRequire` in `src/`, and the only file INV-49's ban on the
 * primitive exempts.** The exemption is paid for rather than granted — but what pays
 * for it is not this signature. `AbsolutePath` constrains every **caller**: a package
 * name, a relative path or a bare `string` is a compile error at the call site. It
 * constrains this *body* not at all, because `runtimeRequire` is a general CommonJS
 * resolver in scope here, and a second line invoking it with anything at all would
 * type-check. So the bound is asserted rather than assumed, in
 * `test/inv-49-host-import-boundary.test.ts`:
 *
 * - "bounds where the one permitted constructed require can point"
 *   pins the `createRequire` argument, the invoked binding, the host-naming string
 *   literals and the path-shaped ones.
 * - "bounds the type of what the one permitted constructed require is invoked with"
 *   is the clause that covers this body: the type-checker's verdict that the sole call
 *   through a `createRequire` product anywhere under `src/` passes an identifier typed
 *   `AbsolutePath`, branded by the seam's own `environment/types.ts`. A binding
 *   shadowing this parameter at type `string` fails there and nowhere else.
 *
 * Both cited by title rather than by line, and each title kept **on one line** so a
 * line-based `grep -F` finds it. A line number in another file drifts on its next
 * edit; a title broken across a comment wrap is unfindable even when it is correct;
 * and the citation replaced here was neither — it named a block that did not exist,
 * and the wrap is why no grep caught that.
 *
 * Constructed inside the call rather than at module scope (INV-44), so the whole
 * pipeline is drivable against fakes with no `~/.tronbox` populated: nine of the
 * eleven causes have nothing to do with the compiler, and the two that do — the
 * ceiling and the failed recompile — still need it *injected* rather than real.
 */
export function loadCompiler(soljsonPath: AbsolutePath): CompilerHandle {
  const runtimeRequire = createRequire(__filename);
  const loaded: unknown = runtimeRequire(soljsonPath);
  if (!isSoljsonModule(loaded)) {
    throw new ValidationInputInvariantError(
      `the file at ${soljsonPath} is not an emscripten soljson module: it ` +
        `exposes no "cwrap".`,
    );
  }
  return wrapSoljson(loaded, soljsonPath);
}

export interface CompilerOpenRequest {
  readonly compiler: CompilerConfiguration;
  /** `ArtifactRecord.longCompilerVersion` — the build that made the artifact. */
  readonly artifactLongVersion: string;
  readonly exists: (candidate: string) => boolean;
  readonly load: (soljsonPath: AbsolutePath) => CompilerHandle;
  /**
   * The machine's home directory, read by the caller.
   *
   * A thunk rather than a string so it is read only on the path that needs it —
   * which is *after* the range gate, so an out-of-range project touches no machine
   * state at all. The seam cannot read it (INV-43 / INV-44 / INV-47), and this module
   * must not either, so it arrives on the dependency surface beside `exists` and
   * `load`; `pipeline.ts` defaults it to `os.homedir`.
   */
  readonly homeDirectory: () => string;
}

/**
 * Causes 1, 2 and 3, in the order their detectability allows.
 *
 * The **range gate runs before anything is loaded** (INV-15), and the order is
 * not cosmetic: an out-of-range project must refuse with the range named rather
 * than with whatever the load says, and it must refuse even when no compiler is
 * on disk at all — telling a user on `0.7.6` that a compiler is missing would
 * point them at a download that would not help. There is no code path on which an
 * out-of-range compiler yields a validation input of any fidelity.
 */
export function openCompiler(request: CompilerOpenRequest): CompilerOpenResult {
  const { compiler } = request;

  if (!isSupportedSolcVersion(compiler.resolvedVersion)) {
    return {
      ok: false,
      cause: {
        kind: 'compiler-unsupported',
        resolvedVersion: compiler.resolvedVersion,
        // `exactOptionalPropertyTypes`: the field is spread in only when the
        // seam reported a flag, so it is absent rather than `undefined` and a
        // message branch cannot render "via undefined".
        ...(compiler.viaLegacyFlag === undefined
          ? {}
          : { viaLegacyFlag: compiler.viaLegacyFlag }),
      },
    };
  }

  // Sequenced after the gate on purpose: `resolvedVersion` is interpolated into the
  // cache file name, and only past this point is it known to be a `\d+.\d+.\d+`
  // triple rather than an arbitrary string off the user's config. Resolving earlier
  // would build a path out of an unvalidated version, and the value's consumer is a
  // module loader.
  const resolution = soljsonPathFor(request.homeDirectory(), compiler);
  if (resolution.status === 'home-not-absolute') {
    // Not a twelfth cause. The eleven are user conditions with remedies; a machine
    // whose home directory is not an absolute path is a broken assumption about the
    // environment, which is what this class is for — and it is the one class the load
    // path below deliberately re-raises instead of folding into cause 1, so the two
    // sites agree on what it means.
    //
    // The value itself is not rendered: the caller supplied it, and a machine path in
    // a message buys nothing a caller does not already hold.
    throw new ValidationInputInvariantError(
      'the home directory is not an absolute path, so the TronBox compiler ' +
        'cache under it cannot be located. The plugin refuses to resolve it ' +
        'against a working directory, because TronBox moves the working ' +
        'directory during a migration.',
    );
  }
  const soljsonPath = resolution.soljsonPath;
  const absent: Cause = {
    kind: 'compiler-absent',
    requestedVersion: compiler.resolvedVersion,
    soljsonPath,
    family: compiler.family,
  };

  if (!request.exists(soljsonPath)) {
    return { ok: false, cause: absent };
  }

  let handle: CompilerHandle;
  try {
    handle = request.load(soljsonPath);
  } catch (thrown) {
    // A file that exists but does not yield a usable compiler — a truncated
    // download is the realistic case — has the same remedy as one that is not
    // there: fetch it again. Cause 1's message is worded to be true of both,
    // which is why this is a wording choice inside cause 1 rather
    // than a twelfth member. An invariant error from our own wrapper is a plugin
    // bug and is deliberately not swallowed here.
    if (thrown instanceof ValidationInputInvariantError) {
      throw thrown;
    }
    return { ok: false, cause: absent };
  }

  /**
   * INV-5, narrowed on purpose. The assertion is on the value *we* produced —
   * a loaded compiler that answers without `+commit.` means this wrapper called
   * the wrong entry point, which is a plugin bug. It is deliberately **not**
   * applied to `artifactLongVersion`: that value comes off the user's artifact,
   * and a short form there is a host or project condition, so asserting on it
   * would report a user's old artifact as a plugin bug. A short artifact version
   * simply fails the comparison below and refuses with both strings shown, which
   * is the actionable outcome.
   */
  if (!handle.longVersion.includes('+commit.')) {
    throw new ValidationInputInvariantError(
      `the compiler at ${soljsonPath} reported the short version ` +
        `"${handle.longVersion}"; cause 3 compares long versions, because two ` +
        `compiler families answer to the same version number.`,
    );
  }

  if (handle.longVersion !== request.artifactLongVersion) {
    return {
      ok: false,
      cause: {
        kind: 'compiler-mismatched',
        loadedLongVersion: handle.longVersion,
        artifactLongVersion: request.artifactLongVersion,
        family: compiler.family,
      },
    };
  }

  return {
    ok: true,
    handle,
    identity: {
      family: compiler.family,
      requestedVersion: compiler.resolvedVersion,
      longVersion: handle.longVersion,
      soljsonPath,
    },
  };
}
