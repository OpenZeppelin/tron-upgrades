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
 * Exactly one directory listing plus at most one read-and-parse per
 * `*.output.json` entry directly within it. The paired `<hash>.json` compiler
 * *input* file is never read — it is typically the larger of the pair and the
 * index does not need it, because `<hash>.output.json` is raw solc
 * standard-JSON output and already retains
 * `contracts[sourcePath][contractName]`. `isFile()` also excludes symlinks, so
 * there is no traversal out of the directory.
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

    files.push(Object.freeze({ file, output }));
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
