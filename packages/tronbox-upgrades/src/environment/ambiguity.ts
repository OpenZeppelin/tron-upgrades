import fs from 'node:fs';
import path from 'node:path';
import { assertAbsolutePath, isContainedIn } from './paths';
import type {
  AbsolutePath,
  ArtifactAmbiguityReport,
  ArtifactCandidate,
  ArtifactNameCollision,
  ProjectPaths,
} from './types';

export interface BuildInfoFile {
  readonly file: AbsolutePath;
  /** Parsed solc standard-JSON output. Never retained beyond index construction. */
  readonly output: unknown;
  /**
   * The paired `<hash>.json` compiler *input* TronBox writes next to
   * `<hash>.output.json` (derived by stripping the `.output` suffix —
   * `abc.output.json`'s pair is `abc.json`). `undefined` when the pair does
   * not exist *or* exists and fails to parse; those two causes collapse to
   * the same value here on purpose; see {@link input}'s doc comment for how a
   * caller tells them apart.
   *
   * Absence or corruption of the pair is never an error at this layer — only
   * a `*.output.json` failure produces `status: 'unreadable'`. The ambiguity
   * index has no use for the pair and does not propagate it; it exists on
   * this type for the Foundry-model validation pipeline's fresh-compile path,
   * which turns a missing or corrupt pair into its own refusal reason rather
   * than this reader throwing on its behalf.
   */
  readonly inputFile: AbsolutePath | undefined;
  /**
   * The parsed pair, or `undefined`. Reading `input` alone cannot distinguish
   * "the pair does not exist" from "the pair exists and is not valid JSON" —
   * both are `undefined` — but {@link inputFile} can: it is `undefined` only
   * in the first case, so a caller checks it, not `input`, to name the file
   * in a "could not parse" message.
   */
  readonly input: unknown | undefined;
}

export type BuildInfoReadResult =
  | { readonly status: 'absent' }
  | {
      readonly status: 'unreadable';
      readonly file: AbsolutePath;
      readonly cause: string;
    }
  | { readonly status: 'files'; readonly files: readonly BuildInfoFile[] };

/**
 * The seam's one injected dependency. Two methods, each a
 * separately confined capability — `read` returns file *content* and is asked
 * only for paths under `buildInfoDirectory`; `exists` returns a `boolean` and is
 * asked only for the packaged-artifact path `artifacts.ts:resolvePackaged`
 * computes. The count fixed here is dependencies, not methods: nothing new is
 * constructed, defaulted, threaded through the entry point, or mocked
 * separately, and the method admitted is strictly *weaker* than the one already
 * present.
 *
 * The seam injects this so its routine degraded paths are unit-testable: the
 * three `IndeterminateReason` branches without constructing a
 * deliberately corrupt build tree, and the missing-vs-malformed split
 * without arranging for a file to be absent on a real disk.
 */
export interface BuildInfoReader {
  read(buildInfoDirectory: AbsolutePath): BuildInfoReadResult;
  /** One of the missing-vs-malformed causes: existence, never content. */
  exists(file: AbsolutePath): boolean;
}

export interface ArtifactAmbiguityIndex {
  readonly report: ArtifactAmbiguityReport;
  candidates(name: string): readonly ArtifactCandidate[];
}

/**
 * A cause string that cannot carry file content.
 *
 * `error.message` is unusable here. Node's `JSON.parse` embeds a snippet of the
 * offending source in its message (`Unexpected token 'o', "not json" is not
 * valid JSON`), so forwarding it would put contract source — in a monorepo,
 * source paths disclosing unreleased product names — into an
 * `IndeterminateReason` and from there into CI logs. The file path is what the
 * user needs to recompile, and the path is carried separately.
 */
function safeCause(error: unknown, fallback: string): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  if (error instanceof Error && error.name !== 'Error') {
    return error.name;
  }
  return fallback;
}

function isObjectRecord(
  value: unknown,
): value is Record<PropertyKey, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

/**
 * Exactly one directory listing. For each `*.output.json` entry directly
 * within it: one read-and-parse of the output, plus one existence probe and,
 * when the probe finds the pair, one read-and-parse of its paired
 * `<hash>.json` compiler *input* — see {@link BuildInfoFile.inputFile}.
 *
 * The pair was never read before this addition, and the ambiguity index
 * built from this function's result still has no use for it:
 * `<hash>.output.json` is raw solc standard-JSON output and already retains
 * `contracts[sourcePath][contractName]`, and `ArtifactCandidate` carries only
 * `buildInfoFile`, never `inputFile`. It is read anyway because this is
 * already the one place that walks `buildInfoDirectory` and already holds
 * each `<hash>` stem, and the Foundry-model validation pipeline — which
 * builds its solc request from the recorded compiler *input* instead of
 * re-invoking `solc` — needs exactly this pairing. That consumer decides what
 * a missing or corrupt pair means; this function only surfaces it, and does
 * not throw or return `status: 'unreadable'` for either case.
 *
 * Parsed eagerly, matching the output loop, even though the input file is
 * typically the *larger* of the pair: a lazy-loading wrapper is not what
 * {@link BuildInfoFile}'s two new fields ask for, and one eager-parse policy
 * shared by both loops is worth more than the memory a second, lazier one
 * would save. Revisit if a real build tree makes this loop's memory footprint
 * a problem — YAGNI until then.
 *
 * `isFile()` still excludes a symlinked `*.output.json` entry from the
 * directory listing, so there is still no traversal out of the directory via
 * the *output* side of the pair. The input side is opened at a path this
 * function derives, not at an entry the listing produced, so that exclusion
 * does not reach it — but it sits inside the same trust boundary as the
 * output file next to it: whoever can plant a symlinked `<hash>.json` in
 * `buildInfoDirectory` can already plant a forged `<hash>.output.json` there.
 */
function defaultRead(buildInfoDirectory: AbsolutePath): BuildInfoReadResult {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(buildInfoDirectory, { withFileTypes: true });
  } catch (error) {
    if (safeCause(error, '') === 'ENOENT') {
      return Object.freeze({ status: 'absent' });
    }
    return Object.freeze({
      status: 'unreadable',
      file: buildInfoDirectory,
      cause: safeCause(error, 'the directory could not be listed'),
    });
  }

  const outputEntries = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.output.json'))
    .sort((left, right) => left.name.localeCompare(right.name));

  const files: BuildInfoFile[] = [];
  for (const entry of outputEntries) {
    const file = assertAbsolutePath(
      path.join(buildInfoDirectory, entry.name),
      `build-info entry ${entry.name}`,
    );

    let contents: string;
    try {
      contents = fs.readFileSync(file, 'utf8');
    } catch (error) {
      return Object.freeze({
        status: 'unreadable',
        file,
        cause: safeCause(error, 'the file could not be read'),
      });
    }

    let output: unknown;
    try {
      output = JSON.parse(contents) as unknown;
    } catch {
      // Deliberately not `safeCause(error, …)`: a SyntaxError's message is the
      // one host message that quotes file bytes.
      return Object.freeze({
        status: 'unreadable',
        file,
        cause: 'the file is not valid JSON',
      });
    }

    // The paired compiler-*input* file, `<hash>.json` for this entry's
    // `<hash>.output.json`. Absent or unparseable is not this function's
    // error to raise — see `BuildInfoFile.inputFile`'s doc comment — so
    // failure here can only narrow `input` to `undefined`, never abort the
    // loop the way an output failure does above.
    const inputName = `${entry.name.slice(0, -'.output.json'.length)}.json`;
    const candidateInputPath = path.join(buildInfoDirectory, inputName);
    let inputFile: AbsolutePath | undefined;
    let input: unknown;
    if (fs.existsSync(candidateInputPath)) {
      inputFile = assertAbsolutePath(
        candidateInputPath,
        `build-info input pair for ${entry.name}`,
      );
      try {
        input = JSON.parse(fs.readFileSync(inputFile, 'utf8')) as unknown;
      } catch {
        input = undefined;
      }
    } else {
      inputFile = undefined;
      input = undefined;
    }

    files.push(Object.freeze({ file, output, inputFile, input }));
  }

  return Object.freeze({ status: 'files', files: Object.freeze(files) });
}

/**
 * Stat-class, and deliberately so. The obvious shortcut —
 * `try { fs.readFileSync(file); return true } catch { return false }` —
 * satisfies this signature and silently converts the weaker capability back into
 * the stronger one: it puts the packaged artifact's bytes inside the seam, one
 * careless interpolation away from a file-content leak, and it makes a large
 * corrupt file cost a full read to answer a boolean.
 *
 * `fs.existsSync` is the stat-class probe that additionally cannot throw, so an
 * unreadable parent directory answers "not there" rather than escaping as an
 * untranslated host failure. The cost is that such a path is diagnosed
 * missing rather than malformed, which is the same direction TronBox's own
 * resolver collapses it in.
 */
function defaultExists(file: AbsolutePath): boolean {
  return fs.existsSync(file);
}

export const fileSystemBuildInfoReader: BuildInfoReader = Object.freeze({
  read: defaultRead,
  exists: defaultExists,
});

/**
 * Reproduces `build/components/Resolver/intercept.js:ResolverIntercept
 * .prototype.require`'s own normalization exactly —
 * `import_path.replace(/^\.\//,"").replace(/\.sol$/i,"")`, in that order, with
 * no separator rewriting, no case folding of the name, and no trimming. One
 * function, used by both the resolve path and the index, so the two key spaces
 * cannot drift apart.
 */
export function normalizeArtifactName(name: string): string {
  return name.replace(/^\.\//, '').replace(/\.sol$/i, '');
}

function indeterminateIndex(
  reason: Extract<
    ArtifactAmbiguityReport,
    { status: 'indeterminate' }
  >['reason'],
): ArtifactAmbiguityIndex {
  return Object.freeze({
    report: Object.freeze({
      status: 'indeterminate' as const,
      reason: Object.freeze(reason),
    }),
    candidates: () => Object.freeze([]),
  });
}

function absentIndex(paths: ProjectPaths): ArtifactAmbiguityIndex {
  return indeterminateIndex({
    kind: 'build-info-absent',
    buildInfoDirectory: paths.buildInfoDirectory,
    // Mirrors `ProjectPaths`. When true, this resolution is in the column where
    // build-info is never written AND every migration is replayed from zero on
    // every run; the two facts were established separately and they compose.
    artifactTreeIsExternal: paths.contractsBuildDirectoryIsExternal,
  });
}

function candidateOrder(
  left: ArtifactCandidate,
  right: ArtifactCandidate,
): number {
  return (
    left.sourcePath.localeCompare(right.sourcePath) ||
    left.contractName.localeCompare(right.contractName) ||
    left.buildInfoFile.localeCompare(right.buildInfoFile)
  );
}

/**
 * Unions every build-info output file into a bare-name index, and never ranks
 * candidates.
 *
 * `status: 'indexed'` asserts that *every* output file under
 * `buildInfoDirectory` was read and contributed. The first unusable entry aborts
 * into `indeterminate` naming that file — there is no partially-indexed report
 * and no per-file skip, because a partial union under an `indexed` label is a
 * false negative in the collision check, and false negatives are the failure
 * this index exists to prevent. False positives are the accepted direction:
 * they are visible, since each candidate names its source path and originating
 * build-info file.
 *
 * Ordering is fully determined, so two calls over the same inputs
 * produce deep-equal reports.
 */
export function buildArtifactAmbiguityIndex(
  paths: ProjectPaths,
  reader: BuildInfoReader = fileSystemBuildInfoReader,
): ArtifactAmbiguityIndex {
  let readResult: BuildInfoReadResult;
  try {
    readResult = reader.read(paths.buildInfoDirectory);
  } catch (error) {
    return indeterminateIndex({
      kind: 'build-info-unreadable',
      file: paths.buildInfoDirectory,
      cause: safeCause(error, 'the build-info reader failed'),
    });
  }

  if (readResult.status === 'absent') {
    return absentIndex(paths);
  }
  if (readResult.status === 'unreadable') {
    // A path from the injected reader is trusted only after it is shown
    // to be absolute and contained in `buildInfoDirectory`.
    return indeterminateIndex(
      path.isAbsolute(readResult.file) &&
        isContainedIn(paths.buildInfoDirectory, readResult.file)
        ? {
            kind: 'build-info-unreadable',
            file: readResult.file,
            cause: readResult.cause,
          }
        : {
            kind: 'build-info-unreadable',
            file: paths.buildInfoDirectory,
            cause:
              'the build-info reader named a file outside buildInfoDirectory',
          },
    );
  }
  if (readResult.files.length === 0) {
    return absentIndex(paths);
  }

  const candidatesByName = new Map<string, ArtifactCandidate[]>();
  const indexedFrom: AbsolutePath[] = [];

  for (const entry of readResult.files) {
    if (
      !path.isAbsolute(entry.file) ||
      !isContainedIn(paths.buildInfoDirectory, entry.file)
    ) {
      return indeterminateIndex({
        kind: 'build-info-unreadable',
        file: paths.buildInfoDirectory,
        cause: 'the build-info reader named a file outside buildInfoDirectory',
      });
    }

    if (
      !isObjectRecord(entry.output) ||
      !isObjectRecord(entry.output.contracts)
    ) {
      return indeterminateIndex({
        kind: 'build-info-lacks-contract-map',
        file: entry.file,
      });
    }
    indexedFrom.push(entry.file);

    for (const [sourcePath, contracts] of Object.entries(
      entry.output.contracts,
    )) {
      if (!isObjectRecord(contracts)) {
        return indeterminateIndex({
          kind: 'build-info-lacks-contract-map',
          file: entry.file,
        });
      }

      for (const contractName of Object.keys(contracts)) {
        // The candidate carries identifiers and a path. Never the
        // compiled output the name maps to.
        const candidate = Object.freeze({
          sourcePath,
          contractName,
          buildInfoFile: entry.file,
        });
        const existing = candidatesByName.get(
          normalizeArtifactName(contractName),
        );
        if (existing === undefined) {
          candidatesByName.set(normalizeArtifactName(contractName), [
            candidate,
          ]);
        } else {
          existing.push(candidate);
        }
      }
    }
  }

  const byName = new Map<string, readonly ArtifactCandidate[]>();
  for (const [name, candidates] of candidatesByName) {
    byName.set(name, Object.freeze([...candidates].sort(candidateOrder)));
  }

  const collisions: ArtifactNameCollision[] = [];
  for (const [name, candidates] of byName) {
    if (candidates.length > 1) {
      collisions.push(Object.freeze({ name, candidates }));
    }
  }
  collisions.sort((left, right) => left.name.localeCompare(right.name));

  return Object.freeze({
    report: Object.freeze({
      status: 'indexed' as const,
      collisions: Object.freeze(collisions),
      indexedFrom: Object.freeze([...indexedFrom]),
    }),
    candidates(name: string): readonly ArtifactCandidate[] {
      return byName.get(normalizeArtifactName(name)) ?? Object.freeze([]);
    },
  });
}
