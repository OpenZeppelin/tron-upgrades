/**
 * Pattern 2 — inject a `BuildInfoReader` so your own tests need no build tree.
 *
 * `deps.buildInfoReader` is the seam's one injection point (INV-43). It exists so
 * the routine degraded paths are reachable without constructing a deliberately
 * corrupt build directory on a real disk.
 */
import {
  resolveEnvironment,
  type AbsolutePath,
  type BuildInfoReader,
  type BuildInfoReadResult,
  type RawMigrationHandles,
} from '../../../src/environment';

function join(directory: AbsolutePath, name: string): AbsolutePath {
  // The seam does not re-export `assertAbsolutePath`, so a reader composes paths
  // from the absolute directory it was handed. The index re-checks that every
  // path it is given is absolute and contained in `buildInfoDirectory` anyway.
  return `${directory}/${name}` as AbsolutePath;
}

function basename(file: AbsolutePath): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

/**
 * An in-memory reader over a `name -> parsed solc output` map.
 *
 * Both methods are answered from the same store, so the fixture is a real second
 * host rather than one live method and one stub. Both are synchronous, which is
 * not optional — an `async` reader does not type-check (INV-38).
 */
export function inMemoryReader(
  store: ReadonlyMap<string, unknown>,
): BuildInfoReader {
  return {
    read(buildInfoDirectory: AbsolutePath): BuildInfoReadResult {
      const files = [...store.entries()].map(([name, output]) => ({
        file: join(buildInfoDirectory, name),
        output,
      }));
      return files.length === 0
        ? { status: 'absent' }
        : { status: 'files', files };
    },
    // Stat-class by construction: a map lookup, carrying no file content.
    // Never `try { readFileSync(file); return true } catch { return false }` —
    // that satisfies the signature while converting the weaker capability back
    // into the stronger one.
    exists(file: AbsolutePath): boolean {
      return store.has(basename(file));
    },
  };
}

/** One build-info file defining one contract — the `unique` fixture. */
export function singleContractStore(
  contractName = 'Box',
  sourcePath = 'contracts/Box.sol',
): ReadonlyMap<string, unknown> {
  return new Map<string, unknown>([
    [
      'aaa.output.json',
      { contracts: { [sourcePath]: { [contractName]: {} } } },
    ],
  ]);
}

/** Two files both defining `Box` — the collision fixture. */
export function collidingStore(): ReadonlyMap<string, unknown> {
  return new Map<string, unknown>([
    ['aaa.output.json', { contracts: { 'contracts/Box.sol': { Box: {} } } }],
    [
      'bbb.output.json',
      { contracts: { 'contracts/vendor/Box.sol': { Box: {}, Unique: {} } } },
    ],
  ]);
}

export function resolveWithFixture(
  handles: RawMigrationHandles,
  store: ReadonlyMap<string, unknown>,
): ReturnType<typeof resolveEnvironment<readonly ['paths', 'artifacts']>> {
  return resolveEnvironment(
    handles,
    { require: ['paths', 'artifacts'] },
    { buildInfoReader: inMemoryReader(store) },
  );
}

// ---------------------------------------------------------------------------
// Reaching each degraded branch. All three `IndeterminateReason` kinds come from
// a `read` result, so an empty store, an `unreadable` status and a file whose
// `output` carries no `contracts` record cover the closed union (INV-34).
// ---------------------------------------------------------------------------

/** `IndeterminateReason.kind === 'build-info-absent'`. */
export function absentReader(): BuildInfoReader {
  return { read: () => ({ status: 'absent' }), exists: () => false };
}

/** `IndeterminateReason.kind === 'build-info-unreadable'`. */
export function unreadableReader(
  file: AbsolutePath,
  cause: string,
): BuildInfoReader {
  return {
    read: () => ({ status: 'unreadable', file, cause }),
    exists: () => false,
  };
}

/** `IndeterminateReason.kind === 'build-info-lacks-contract-map'`. */
export function shapelessReader(): BuildInfoReader {
  return {
    read: (buildInfoDirectory: AbsolutePath) => ({
      status: 'files',
      files: [
        { file: join(buildInfoDirectory, 'aaa.output.json'), output: {} },
      ],
    }),
    exists: () => false,
  };
}

/**
 * A probe that answers `false`, driving `resolvePackaged`'s "does not exist"
 * message; answer `true` for the "exists but could not be loaded" message. The
 * two have different remedies, which is the whole point of the split (INV-18).
 */
export function existenceProbeReader(answer: boolean): BuildInfoReader {
  return { read: () => ({ status: 'absent' }), exists: () => answer };
}
