/**
 * All three seams of `ValidationInputDependencies`, and why both gate outcomes
 * and every refusal cause are drivable without a real build tree.
 *
 * Every member is optional and every production default is resolved **inside** the
 * call rather than captured at module scope
 * (`src/validation-input/pipeline.ts`). That is what makes both paths and the
 * seven causes reachable from a fixture: substituting a dependency is not a
 * back door into behaviour, it is the same code reading a different disk.
 *
 * | member | production default | what substituting it buys |
 * |---|---|---|
 * | `exists` | `fs.existsSync` | causes 2 and 3 without a broken checkout |
 * | `readSource` | `fs.readFileSync` | the other half of causes 2 and 3 — a file that is present and unreadable |
 * | `readBuildInfo` | the seam's own reader | the `fresh` / `stale` / `absent` gate — and with it causes 5 and 6 — without arranging a corrupt build tree |
 *
 * There is no compiler member, because the pipeline never compiles: a compile is
 * not injectable for the same reason it is not performable. There is no `policy`
 * member and there must not be: an injectable disposition table would restore
 * per-call-site variation through the back door, and the one policy call site is
 * the reason a leniency change touches one table instead of seven call sites.
 * There is no writer either — this module persists nothing, so the injected
 * surface has no write capability to misuse.
 */
import type {
  AbsolutePath,
  BuildInfoFile,
  BuildInfoReadResult,
  BuildInfoReader,
} from '../../../src/environment';
import {
  deriveValidationInput,
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
 * These two are called on **every** derivation: the source closure is resolved
 * before the gate, so the source-resolution causes stay ahead of the record
 * causes. That is the honest order — a project with an unreadable import has
 * that problem whether or not it also lacks a build record, and
 * `tronbox compile --all` cannot fix a reference the compiler itself would
 * refuse.
 *
 * `readSource` raising is not the same condition as `exists` returning `false`,
 * and cause 2 keeps them apart: `because: 'missing'` is restored by putting the
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
        // what `fs.readFileSync` does and the pipeline's cause-2 branch is
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
 * read-and-parse per `*.output.json` entry, plus an existence probe for the
 * paired compiler-*input* file and, when the pair is present, one read-and-parse
 * of it. A pair that is missing, corrupt, or could not be read is never an
 * error at the reader; the gate
 * turns it into a per-candidate rejection (`input-pair-absent` /
 * `input-pair-unparseable`).
 *
 * Its three-way result is what the gate is built from:
 *
 * | reader result | gate | outcome |
 * |---|---|---|
 * | `{ status: 'absent' }` | `absent`, `because: 'directory-absent'` | refusal, `build-record-absent` |
 * | `{ status: 'unreadable' }`, or a reader that throws | `absent`, `because: 'directory-unreadable'` | refusal, `build-record-absent` |
 * | `{ status: 'files' }` with nothing for this pair | `absent`, `because: 'no-record-for-target'` | refusal, `build-record-absent` |
 * | `{ status: 'files' }`, every candidate rejected | `stale`, with one reason per candidate | refusal, `build-record-stale` |
 * | `{ status: 'files' }`, one candidate verifies with a usable pair | `fresh` | a produced input |
 *
 * A reader that raises is treated as a directory that cannot be read, rather than
 * propagating: no record can be consulted either way, so the pipeline refuses —
 * it has nothing to validate from, and never compiles instead.
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
// 3. All three together
// ---------------------------------------------------------------------------

/**
 * One assembled dependency set, and the call that uses it.
 *
 * Assembled with `exactOptionalPropertyTypes` in force, so an omitted member is
 * **absent** rather than set to `undefined` — the two are different values to this
 * surface, and only the first takes the production default.
 *
 * Nothing here counts compiles, because there is nothing to count: the pipeline
 * either produces an input from a record in `buildRecords` whose bytecode
 * matches the artifact the environment reports, or it refuses with the gate's
 * own evidence. The `BuildInfoFile` entries carry the record (`output`), the
 * paired compiler input (`inputFile` / `input`), and the file names a refusal
 * would render.
 */
export async function deriveFromFixtures(request: {
  readonly contract: string;
  readonly env: ValidationInputEnvironment;
  readonly tree: Readonly<Record<string, string>>;
  readonly buildRecords: readonly BuildInfoFile[];
}): Promise<ValidationInputOutcome> {
  const files = inMemoryFiles(request.tree);

  const deps: ValidationInputDependencies = {
    exists: files.exists,
    readSource: files.readSource,
    readBuildInfo: readerOver(request.buildRecords),
  };

  return deriveValidationInput({
    contract: request.contract,
    env: request.env,
    deps,
  });
}

/*
 * The one thing this file does not do: construct a `ValidationInputEnvironment`.
 *
 * `env.paths` holds `AbsolutePath` values, and the brand is mintable only inside
 * the environment seam, which refuses a non-absolute input rather than resolving
 * it. So every example here takes the environment as a parameter, exactly as a
 * consuming operation receives it from `resolveEnvironment`. The fixture builders
 * that assemble one live in `test/helpers/`.
 */
