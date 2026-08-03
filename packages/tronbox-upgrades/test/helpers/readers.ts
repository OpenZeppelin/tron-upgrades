import path from 'node:path';
import type {
  BuildInfoReader,
  BuildInfoReadResult,
} from '../../src/environment';
import { assertAbsolutePath } from '../../src/environment/paths';
import type { AbsolutePath } from '../../src/environment/types';
import { SENTINEL_FILE_CONTENT } from './config-fixtures';

/**
 * `BuildInfoReader` fixtures — the seam's one injected dependency (INV-43).
 *
 * They exist so the three `IndeterminateReason` branches, which INV-34
 * establishes are *routine* states rather than rare fallbacks, are testable
 * without building a deliberately corrupt build tree. A `fs`-coupled module
 * would make each of those tests construct and tear down broken directories —
 * the kind of test that gets skipped once it turns flaky, which is how a routine
 * degraded path ends up uncovered in violation of SC-003.
 *
 * **Revision 2 — the interface has two methods.** INV-31 fixes it at exactly
 * `read` and `exists`, and `exists` is *required* rather than optional
 * deliberately: an optional probe would force `resolvePackaged` to keep a
 * fallback path for readers that decline it, which is precisely where INV-18's
 * missing-vs-malformed split would quietly regress back to one combined message.
 * So every fixture here declares one.
 */

export const DEFAULT_BUILD_INFO_DIR = '/proj/build/build-info';

export function absolute(value: string): AbsolutePath {
  return assertAbsolutePath(value, 'test fixture path');
}

/**
 * The `exists` answer for the fixtures that exist to drive `read`.
 *
 * `false` rather than `true`, and the choice is not arbitrary. These fixtures are
 * never the subject of an INV-18 assertion, so the value is unobservable through
 * them today — but if a future edit did route a probe here, `false` yields the
 * "does not exist at <path>" refusal, which is a visible and actionable message,
 * where `true` yields the malformed refusal, which asserts the file *is* present.
 * A wrong-but-loud diagnosis beats a wrong-and-confident one.
 *
 * Deliberately not a throw: `resolvePackaged` catches a throwing probe and
 * translates it (by design — see `artifacts.ts:resolvePackaged`), so a trap here
 * would be absorbed into a refusal rather than surfacing as a test failure. The
 * guard against a stray probe is structural instead — see the `exists` call-site
 * scan in `error-semantics.test.ts` (INV-31).
 */
const DECLINES_EXISTENCE = (): boolean => false;

export interface CountingReader extends BuildInfoReader {
  /** Every directory this reader was asked to list, in order. */
  readonly directories: readonly AbsolutePath[];
  readonly callCount: number;
  /**
   * Every path `exists` was asked about, in order. INV-31 confines the probe to
   * the one host-arithmetic path, and INV-18's order makes "never probed" the
   * assertion for an escaping path — both need the calls recorded, not just
   * counted.
   */
  readonly probedPaths: readonly AbsolutePath[];
  readonly probeCount: number;
}

/** Wraps any reader and records every call to either method. */
export function countingReader(
  inner: BuildInfoReader | (() => BuildInfoReadResult),
): CountingReader {
  const directories: AbsolutePath[] = [];
  const probedPaths: AbsolutePath[] = [];
  return {
    get directories(): readonly AbsolutePath[] {
      return [...directories];
    },
    get callCount(): number {
      return directories.length;
    },
    get probedPaths(): readonly AbsolutePath[] {
      return [...probedPaths];
    },
    get probeCount(): number {
      return probedPaths.length;
    },
    read(buildInfoDirectory: AbsolutePath): BuildInfoReadResult {
      directories.push(buildInfoDirectory);
      return typeof inner === 'function'
        ? inner()
        : inner.read(buildInfoDirectory);
    },
    exists(file: AbsolutePath): boolean {
      probedPaths.push(file);
      return typeof inner === 'function' ? false : inner.exists(file);
    },
  };
}

/**
 * INV-18's existence-probe fixture: answers from `answer`, records every path,
 * and reads as `absent` because `resolvePackaged` never consults `read`.
 *
 * This is what makes all three of INV-18's messages reachable from a unit test
 * with no broken file on a real disk — the reason the amendment put the probe on
 * the injected dependency rather than calling `fs` from `artifacts.ts`.
 */
export function existenceProbeReader(
  answer: boolean | ((file: AbsolutePath) => boolean),
  inner: BuildInfoReader = absentReader(),
): CountingReader {
  return countingReader({
    read: (buildInfoDirectory: AbsolutePath) => inner.read(buildInfoDirectory),
    exists: (file: AbsolutePath) =>
      typeof answer === 'function' ? answer(file) : answer,
  });
}

/**
 * A probe that answers neither yes nor no. Unreachable through
 * `fileSystemBuildInfoReader`, whose `fs.existsSync` cannot throw — this is the
 * misbehaving *injected* reader, and it gets its own refusal rather than being
 * folded into "missing".
 */
export function throwingProbeReader(error: unknown): CountingReader {
  return countingReader({
    read: () => ({ status: 'absent' }),
    exists: (): never => {
      throw error;
    },
  });
}

export function absentReader(): BuildInfoReader {
  return { read: () => ({ status: 'absent' }), exists: DECLINES_EXISTENCE };
}

export function unreadableReader(
  file: string,
  cause: string,
): BuildInfoReader {
  return {
    read: () => ({ status: 'unreadable', file: absolute(file), cause }),
    exists: DECLINES_EXISTENCE,
  };
}

/** A reader that names a file outside `buildInfoDirectory` (INV-31). */
export function escapingUnreadableReader(): BuildInfoReader {
  return unreadableReader('/etc/passwd', 'EACCES');
}

export function throwingReader(error: unknown): BuildInfoReader {
  return {
    read: () => {
      throw error;
    },
    exists: DECLINES_EXISTENCE,
  };
}

export interface ContractEntry {
  readonly sourcePath: string;
  readonly contractNames: readonly string[];
}

export interface BuildInfoFileSpec {
  /** File name within `buildInfoDirectory`; `.output.json` by convention. */
  readonly name: string;
  readonly contracts?: readonly ContractEntry[];
  /** Replaces the whole parsed output — for malformed-shape fixtures. */
  readonly output?: unknown;
  /** Place the file somewhere else entirely, for INV-31's containment test. */
  readonly absolutePath?: string;
}

/**
 * A solc standard-JSON output object carrying ABI and bytecode, so INV-42's
 * "identifiers and paths, never content" assertion has content to *not* find.
 */
function contractsOutput(
  entries: readonly ContractEntry[],
): Record<string, unknown> {
  const contracts: Record<string, Record<string, unknown>> = {};
  for (const entry of entries) {
    const byName: Record<string, unknown> = {};
    for (const name of entry.contractNames) {
      byName[name] = {
        abi: [{ type: 'function', name: `${SENTINEL_FILE_CONTENT}_abi` }],
        evm: {
          bytecode: { object: `0x${SENTINEL_FILE_CONTENT}` },
          deployedBytecode: { object: `0x${SENTINEL_FILE_CONTENT}` },
        },
        metadata: SENTINEL_FILE_CONTENT,
      };
    }
    contracts[entry.sourcePath] = byName;
  }
  return { contracts, sources: { [SENTINEL_FILE_CONTENT]: {} } };
}

export function filesReader(
  specs: readonly BuildInfoFileSpec[],
  buildInfoDirectory: string = DEFAULT_BUILD_INFO_DIR,
): BuildInfoReader {
  return {
    read: () => ({
      status: 'files',
      files: specs.map(spec => ({
        file: absolute(
          spec.absolutePath ?? path.join(buildInfoDirectory, spec.name),
        ),
        output:
          'output' in spec ? spec.output : contractsOutput(spec.contracts ?? []),
      })),
    }),
    exists: DECLINES_EXISTENCE,
  };
}

/** An in-memory reader over a name→output map — the "second host" for INV-43. */
export function inMemoryReader(
  store: ReadonlyMap<string, unknown>,
): BuildInfoReader {
  return {
    read: (buildInfoDirectory: AbsolutePath) => {
      const files = [...store.entries()].map(([name, output]) => ({
        file: absolute(path.join(buildInfoDirectory, name)),
        output,
      }));
      return files.length === 0
        ? { status: 'absent' }
        : { status: 'files', files };
    },
    // The second host answers the probe from the same in-memory store, so
    // INV-43's embed covers both methods rather than declaring one and stubbing
    // the other.
    exists: (file: AbsolutePath) => store.has(path.basename(file)),
  };
}

/** Two build-info files that both define `Box` — the collision fixture. */
export function collidingReader(
  buildInfoDirectory: string = DEFAULT_BUILD_INFO_DIR,
): BuildInfoReader {
  return filesReader(
    [
      {
        name: 'aaa.output.json',
        contracts: [
          { sourcePath: 'contracts/Box.sol', contractNames: ['Box'] },
        ],
      },
      {
        name: 'bbb.output.json',
        contracts: [
          {
            sourcePath: 'contracts/vendor/Box.sol',
            contractNames: ['Box', 'Unique'],
          },
        ],
      },
    ],
    buildInfoDirectory,
  );
}

/** One build-info file defining exactly one contract — the `unique` fixture. */
export function singleContractReader(
  contractName = 'Box',
  sourcePath = 'contracts/Box.sol',
  buildInfoDirectory: string = DEFAULT_BUILD_INFO_DIR,
): BuildInfoReader {
  return filesReader(
    [
      {
        name: 'aaa.output.json',
        contracts: [{ sourcePath, contractNames: [contractName] }],
      },
    ],
    buildInfoDirectory,
  );
}
