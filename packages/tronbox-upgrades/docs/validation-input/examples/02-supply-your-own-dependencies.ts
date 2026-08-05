/**
 * All five seams of `ValidationInputDependencies`, and why the whole ladder is
 * drivable without a populated `~/.tronbox` or a real build tree.
 *
 * Every member is optional and every production default is resolved **inside** the
 * call rather than captured at module scope
 * (`src/validation-input/pipeline.ts:1272`). That is what makes the four paths and
 * the eleven causes reachable from a fixture: substituting a dependency is not a
 * back door into behaviour, it is the same code reading a different disk.
 *
 * | member | production default | what substituting it buys |
 * |---|---|---|
 * | `exists` | `fs.existsSync` | cause 1 without deleting a cached compiler |
 * | `readSource` | `fs.readFileSync` | causes 4 and 5 without a broken checkout |
 * | `readBuildInfo` | the seam's own reader | the `fresh` / `stale` / `absent` gate without arranging a corrupt build tree |
 * | `loadCompiler` | the emscripten loader | a compile count, and cause 8 without exhausting real memory |
 * | `homeDirectory` | `os.homedir` | the cache location, without writing under the user's own home |
 *
 * There is no `policy` member and there must not be: an injectable disposition
 * table would restore per-call-site variation through the back door, and the one
 * policy call site is the reason a leniency change touches one table instead of
 * eleven call sites. There is no writer either — this module persists nothing, so
 * the injected surface has no write capability to misuse.
 */
import type {
  AbsolutePath,
  BuildInfoFile,
  BuildInfoReadResult,
  BuildInfoReader,
} from '../../../src/environment';
import {
  deriveValidationInput,
  type CompilerHandle,
  type SolcStandardInput,
  type SolcStandardOutput,
  type ValidationInputDependencies,
  type ValidationInputEnvironment,
  type ValidationInputOutcome,
} from '../../../src/validation-input';

// ---------------------------------------------------------------------------
// 1. The filesystem pair: `exists` and `readSource`
// ---------------------------------------------------------------------------

/**
 * An in-memory source tree, keyed by the absolute path the resolver computes.
 *
 * These two are called on **every** path, including the fresh one: the source
 * closure is resolved before the gate, so the source-resolution causes stay ahead
 * of every compiler cause. That is the honest order once the compiler is optional
 * — a project with an unreadable import has that problem whether or not it also
 * lacks a cached compiler.
 *
 * `readSource` raising is not the same condition as `exists` returning `false`,
 * and cause 4 keeps them apart: `because: 'missing'` is restored by putting the
 * file back, `because: 'unreadable'` is a permission or encoding problem. Neither
 * carries a byte of the file — only its key and its path.
 */
export function inMemoryFiles(tree: Readonly<Record<string, string>>): {
  readonly exists: (candidate: string) => boolean;
  readonly readSource: (candidate: string) => string;
} {
  return {
    exists: (candidate: string): boolean => candidate in tree,
    readSource: (candidate: string): string => {
      const content = tree[candidate];
      if (content === undefined) {
        // Modelled as a throw rather than as an empty string, because that is
        // what `fs.readFileSync` does and the pipeline's cause-4 branch is
        // written against the real thing.
        throw new Error(`ENOENT: ${candidate}`);
      }
      return content;
    },
  };
}

// ---------------------------------------------------------------------------
// 2. The build-record reader, which decides the gate
// ---------------------------------------------------------------------------

/**
 * The reader is the seam's own — one directory listing plus at most one
 * read-and-parse per `*.output.json` entry, and the paired compiler-*input* file
 * never read at all.
 *
 * Its three-way result is what the gate's `absent` reason is built from:
 *
 * | reader result | gate |
 * |---|---|
 * | `{ status: 'absent' }` | `absent`, `because: 'directory-absent'` |
 * | `{ status: 'unreadable' }`, or a reader that throws | `absent`, `because: 'directory-unreadable'` |
 * | `{ status: 'files' }` with nothing for this pair | `absent`, `because: 'no-record-for-target'` |
 * | `{ status: 'files' }`, every candidate rejected | `stale`, with one reason per candidate |
 * | `{ status: 'files' }`, one candidate verifies | `fresh` |
 *
 * A reader that raises is treated as a directory that cannot be read, rather than
 * propagating: no record can be consulted either way, so the ladder compiles.
 */
export function readerOver(
  files: readonly BuildInfoFile[],
): BuildInfoReader['read'] {
  return (): BuildInfoReadResult => ({ status: 'files', files });
}

/** The no-build-info project, which is the `directory-absent` gate. */
export function noBuildRecords(): BuildInfoReader['read'] {
  return (): BuildInfoReadResult => ({ status: 'absent' });
}

/**
 * A reader that reports the directory unreadable.
 *
 * `file` and `cause` are both `AbsolutePath`-and-`string` facts the caller already
 * holds, so this takes them rather than minting them: the `AbsolutePath` brand has
 * no constructor on the seam's public face, which is deliberate — the one place
 * that mints it refuses a non-absolute input rather than resolving it against a
 * working directory TronBox moves during a migration.
 */
export function unreadableBuildRecords(
  file: AbsolutePath,
  cause: string,
): BuildInfoReader['read'] {
  return (): BuildInfoReadResult => ({ status: 'unreadable', file, cause });
}

// ---------------------------------------------------------------------------
// 3. The compiler seam, and the compile count
// ---------------------------------------------------------------------------

/**
 * A loader that counts, and delegates the actual output to the caller.
 *
 * The output is the caller's because a `SolcStandardOutput` is `upgrades-core`'s
 * own `SolcOutput` — one `SourceUnit` AST per source — and a fixture that produces
 * one has either recorded a real compile or built the ASTs it needs. Neither is
 * this seam's business; the count is.
 *
 * The count is the executable form of the ladder's cost table: `fresh` is 0, and
 * `stale`, `absent` and `escalated` are 1 each. An operation that finds itself at
 * 2 for one contract has re-derived rather than escalated.
 *
 * `compile` is synchronous, and that is structural rather than incidental: the
 * emscripten entry point blocks the event loop for its whole duration, so a
 * `Promise`-returning signature here would imply a wall-clock bound that no
 * `Promise.race` or `AbortSignal` can actually impose.
 */
export function countingLoader(
  produce: (input: SolcStandardInput) => SolcStandardOutput,
  longVersion: string,
): {
  readonly loadCompiler: (soljsonPath: string) => CompilerHandle;
  compiles(): number;
} {
  let compiles = 0;
  return {
    loadCompiler: (): CompilerHandle => ({
      longVersion,
      compile: (input: SolcStandardInput): SolcStandardOutput => {
        compiles += 1;
        return produce(input);
      },
    }),
    compiles: (): number => compiles,
  };
}

/**
 * A loader whose compile reports the wasm's own memory ceiling.
 *
 * This drives cause 8 (`compiler-resource-exhausted`) with no real memory
 * pressure. The classification is by `name` and message rather than by
 * `instanceof WebAssembly.RuntimeError`, so this plain `Error` is recognised
 * exactly as the compiler's own abort is — and the deliberate reason for that is
 * that the `WebAssembly` global's typing depends on which `lib` the consuming
 * project compiles with, and a validation failing to recognise a compiler's
 * ceiling because of a `lib` setting would be absurd.
 *
 * Anything that is **not** a wasm abort is re-raised rather than folded into cause
 * 8: a timeout is a different event from an out-of-memory and would be a new
 * cause, never a widening of this one.
 *
 * A stub is welcome to model the poisoning too — the production wrapper retires a
 * handle whose `compile` threw and raises `CompilerRetiredError` on reuse, because
 * an emscripten abort leaves the module in a state where later compiles fail for
 * reasons unrelated to what they were asked to compile.
 */
export function ceilingLoader(): (soljsonPath: string) => CompilerHandle {
  return (): CompilerHandle => ({
    longVersion: '0.8.26+commit.733b4d28.Emscripten.clang',
    compile: (): SolcStandardOutput => {
      const abort = new Error('memory access out of bounds');
      abort.name = 'RuntimeError';
      throw abort;
    },
  });
}

// ---------------------------------------------------------------------------
// 4. `homeDirectory`, and why it is a thunk
// ---------------------------------------------------------------------------

/**
 * Where the compiler cache is looked for, as `~/.tronbox/{solc,evm-solc}/`.
 *
 * A thunk rather than a string so it is read only on the path that needs it. The
 * read happens **after** the supported-range gate, so an out-of-range project
 * touches no machine state at all — and on the fresh path it is not read once. It
 * is on this surface rather than inside the compiler module because the seam that
 * owns the `~/.tronbox` convention is a function of its arguments alone, and the
 * module that builds the loader path must not also be the module that decides
 * where it points.
 */
export function homeAt(directory: string): () => string {
  return (): string => directory;
}

// ---------------------------------------------------------------------------
// 5. All five together
// ---------------------------------------------------------------------------

/**
 * One assembled dependency set, and the call that uses it.
 *
 * Assembled with `exactOptionalPropertyTypes` in force, so an omitted member is
 * **absent** rather than set to `undefined` — the two are different values to this
 * surface, and only the first takes the production default.
 */
export async function deriveFromFixtures(request: {
  readonly contract: string;
  readonly env: ValidationInputEnvironment;
  readonly tree: Readonly<Record<string, string>>;
  readonly buildRecords: readonly BuildInfoFile[];
  readonly produceOutput: (input: SolcStandardInput) => SolcStandardOutput;
  readonly longVersion: string;
  readonly home: string;
}): Promise<{
  readonly outcome: ValidationInputOutcome;
  readonly compiles: number;
}> {
  const files = inMemoryFiles(request.tree);
  const loader = countingLoader(request.produceOutput, request.longVersion);

  const deps: ValidationInputDependencies = {
    exists: files.exists,
    readSource: files.readSource,
    readBuildInfo: readerOver(request.buildRecords),
    loadCompiler: loader.loadCompiler,
    homeDirectory: homeAt(request.home),
  };

  const outcome = await deriveValidationInput({
    contract: request.contract,
    env: request.env,
    deps,
  });

  return { outcome, compiles: loader.compiles() };
}

/*
 * The one thing this file does not do: construct a `ValidationInputEnvironment`.
 *
 * `env.paths` holds `AbsolutePath` values, and the brand is mintable only inside
 * the environment seam, which refuses a non-absolute input rather than resolving
 * it. So every example here takes the environment as a parameter, exactly as a
 * consuming operation receives it from `resolveEnvironment`. The fixture builders
 * that assemble one live in `test/helpers/sf-2-ladder.ts`.
 */
