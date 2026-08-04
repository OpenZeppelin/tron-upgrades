import path from 'node:path';

import type { AbsolutePath } from '../environment';

import type { Cause } from './causes';
import {
  isExplicitlyRelative,
  isValidModuleSpecifier,
  modulePathOnDisk,
  resolveFileSystemImport,
  resolveModuleImport,
  sourceKey,
} from './source-key';

/**
 * The plugin's own import resolver. Causes 4 and 5 are born here.
 *
 * **Owning resolution is structural, not a preference.** The host's resolver is
 * off-limits under SF-0's INV-49, and F-12 measured the reason it would not help
 * anyway: `TronSolc.js:55` calls `compile(input, null, null)` — **no import
 * callback** — so every source has to be in the input before solc runs. A project
 * whose graph is not resolved first gets
 * `ParserError: Source "Nope.sol" not found: File not supplied initially`, which
 * names a mechanism inside the *plugin's* input assembly and is indistinguishable
 * from a genuine source error. Owning the walk is what turns a
 * previously undetectable condition into two causes with two different remedies.
 *
 * **The walk starts at the target and never enumerates the contracts directory**
 * (INV-43). That is what makes cost a function of graph depth rather than project
 * size: a 226-file project and a 2,260-file project present the compiler with the
 * same input for the same contract. `evidence/probe-oz-closure-static.js` measured
 * realistic OpenZeppelin upgradeable closures at min 3 · median 26 · max 39 files.
 */

/**
 * A source as the *host* addresses it, which is the distinction F-13 is about: a
 * project file is reached and keyed by absolute path, an npm import is reached by
 * filesystem path but **keyed by its own specifier**. Collapsing the two is the
 * single highest-consequence mistake available in this sub-feature.
 */
type SourceRef =
  | { readonly kind: 'file'; readonly absolutePath: string }
  | { readonly kind: 'module'; readonly specifier: string };

interface PendingRef {
  readonly ref: SourceRef;
  /**
   * How this source was named, and by whom. `null` for the target, which is not
   * an import — and that is precisely what makes cause 4's `'missing'` arm
   * distinct from cause 5: a *target* that is not on disk is a missing source,
   * while an *import* that is not on disk is an unresolvable import.
   */
  readonly importedFrom: { readonly by: string; readonly specifier: string } | null;
}

export interface SourceGraphRequest {
  /** The absolute path of the contract's own source, from the artifact record. */
  readonly targetPath: string;
  /** Names the contract in a refusal that has no importing file to name. */
  readonly targetLabel: string;
  readonly contractsDirectory: AbsolutePath;
  readonly root: AbsolutePath;
  readonly readSource: (candidate: string) => string;
  readonly exists: (candidate: string) => boolean;
}

export type SourceGraphResult =
  | {
      readonly ok: true;
      readonly targetKey: string;
      /** Discovery order. `partition.ts` decides the order solc sees. */
      readonly sources: ReadonlyMap<string, string>;
    }
  | { readonly ok: false; readonly cause: Cause };

/**
 * Strips comments while respecting string literals, so an import scan cannot be
 * fooled either way round.
 *
 * Both directions matter and each has burnt this repository's sibling scans
 * before: a naive strip turns `"http://x"` into a truncated literal, and a naive
 * scan finds an `import` inside `// import "Old.sol";` and refuses on a line the
 * user deliberately commented out.
 */
function stripComments(source: string): string {
  let out = '';
  let index = 0;
  const { length } = source;

  while (index < length) {
    const two = source.slice(index, index + 2);

    if (two === '//') {
      while (index < length && source[index] !== '\n') {
        index += 1;
      }
      continue;
    }
    if (two === '/*') {
      index += 2;
      while (index < length && source.slice(index, index + 2) !== '*/') {
        // Newlines are preserved so a reported position stays meaningful.
        if (source[index] === '\n') {
          out += '\n';
        }
        index += 1;
      }
      index += 2;
      continue;
    }

    const char = source[index] as string;
    if (char === '"' || char === "'") {
      out += char;
      index += 1;
      while (index < length) {
        const inner = source[index] as string;
        out += inner;
        index += 1;
        if (inner === '\\') {
          if (index < length) {
            out += source[index] as string;
            index += 1;
          }
          continue;
        }
        if (inner === char) {
          break;
        }
      }
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

const IMPORT_STATEMENT = /\bimport\b([^;]*);/g;
const FIRST_STRING_LITERAL = /"([^"]*)"|'([^']*)'/;

/**
 * Every path a source imports, in source order.
 *
 * **A regex scan rather than a parser, declared as such.** TronBox 4.9.0 parses
 * imports with `@solidity-parser/parser`, which this package does not depend on
 * and cannot add without widening its dependency surface — a decision outside
 * this stage. So the limits are stated rather than discovered:
 *
 * - An import statement must be terminated by `;`, which Solidity requires.
 * - The word `import` inside a *string literal* followed by a `;` on the same
 *   statement would be read as an import. The consequence is a **loud** refusal
 *   naming the specifier and the file (cause 5), not a silent wrong answer.
 * - A missed import is the failure mode that matters, and it does not pass
 *   silently either: solc reports `File not supplied initially`, which arrives as
 *   cause 11 with an error count. That is a *mislabelled* diagnosis rather than a
 *   wrong validation, and it is the one thing a real parser would improve here.
 */
export function extractImports(source: string): string[] {
  const stripped = stripComments(source);
  const specifiers: string[] = [];

  for (const match of stripped.matchAll(IMPORT_STATEMENT)) {
    const literal = FIRST_STRING_LITERAL.exec(match[1] ?? '');
    if (literal === null) {
      continue;
    }
    // Annotated because only one of the two alternation groups matches, so the
    // other is `undefined` at runtime while `RegExpExecArray` types both `string`.
    const specifier: string | undefined = literal[1] ?? literal[2];
    if (specifier !== undefined && specifier !== '') {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

function refPath(ref: SourceRef, root: AbsolutePath): string {
  return ref.kind === 'file'
    ? ref.absolutePath
    : modulePathOnDisk(root, ref.specifier);
}

function refAddress(ref: SourceRef): string {
  return ref.kind === 'file' ? ref.absolutePath : ref.specifier;
}

function unresolvableImport(pending: PendingRef, targetLabel: string): Cause {
  return pending.importedFrom === null
    ? {
        kind: 'import-unresolvable',
        importedBy: targetLabel,
        specifier: refAddress(pending.ref),
      }
    : {
        kind: 'import-unresolvable',
        importedBy: pending.importedFrom.by,
        specifier: pending.importedFrom.specifier,
      };
}

/**
 * Resolves and reads the target's transitive closure, or refuses.
 *
 * Reproduces the host's dispatch and rewriting rules exactly — see `source-key.ts`
 * for the clone citations behind each — because a graph resolved by different
 * rules is a *different set of keys*, and F-6 measured that a different key set
 * changes every identity the plugin computes.
 */
export function resolveSourceGraph(
  request: SourceGraphRequest,
): SourceGraphResult {
  const { contractsDirectory, root, targetLabel } = request;
  const sources = new Map<string, string>();
  const pending: PendingRef[] = [
    { ref: { kind: 'file', absolutePath: request.targetPath }, importedFrom: null },
  ];
  let targetKey: string | undefined;

  while (pending.length > 0) {
    const current = pending.shift() as PendingRef;
    const address = refAddress(current.ref);
    const key = sourceKey(address, contractsDirectory);

    if (!key.ok) {
      // A source the host itself refuses: its key would carry leading `..`
      // segments, which solc normalizes away during import lookup, breaking the
      // source-key match. Clone `Compile/index.js:53-60`.
      return { ok: false, cause: unresolvableImport(current, targetLabel) };
    }
    if (targetKey === undefined) {
      targetKey = key.key;
    }
    if (sources.has(key.key)) {
      continue;
    }

    const diskPath = refPath(current.ref, root);
    if (!request.exists(diskPath)) {
      return {
        ok: false,
        cause:
          current.importedFrom === null
            ? {
                kind: 'source-unreadable',
                sourceKey: key.key,
                path: diskPath,
                because: 'missing',
              }
            : unresolvableImport(current, targetLabel),
      };
    }

    let content: string;
    try {
      content = request.readSource(diskPath);
    } catch {
      // Present and unreadable is a different problem with a different remedy
      // from present-and-absent, which is why `because` exists (INV-27's two
      // fixtures). The throw itself is never quoted (INV-17).
      return {
        ok: false,
        cause: {
          kind: 'source-unreadable',
          sourceKey: key.key,
          path: diskPath,
          because: 'unreadable',
        },
      };
    }

    sources.set(key.key, content);

    for (const specifier of extractImports(content)) {
      if (path.isAbsolute(specifier)) {
        // The host rejects user-written absolute imports before any
        // normalization: clone `Compile/profiler.js:301-306` at `v4.9.0`.
        return {
          ok: false,
          cause: {
            kind: 'import-unresolvable',
            importedBy: key.key,
            specifier,
          },
        };
      }

      const next: SourceRef = isExplicitlyRelative(specifier)
        ? current.ref.kind === 'file'
          ? {
              kind: 'file',
              absolutePath: resolveFileSystemImport(
                current.ref.absolutePath,
                specifier,
              ),
            }
          : {
              kind: 'module',
              specifier: resolveModuleImport(current.ref.specifier, specifier),
            }
        : { kind: 'module', specifier };

      if (next.kind === 'module' && !isValidModuleSpecifier(next.specifier)) {
        return {
          ok: false,
          cause: {
            kind: 'import-unresolvable',
            importedBy: key.key,
            specifier,
          },
        };
      }

      pending.push({
        ref: next,
        importedFrom: { by: key.key, specifier },
      });
    }
  }

  if (targetKey === undefined) {
    // Unreachable: the queue starts with the target. Stated as a type narrowing
    // rather than a claim about behaviour.
    return {
      ok: false,
      cause: {
        kind: 'import-unresolvable',
        importedBy: targetLabel,
        specifier: request.targetPath,
      },
    };
  }

  return { ok: true, targetKey, sources };
}
