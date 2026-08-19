import fs from 'node:fs';
import path from 'node:path';
import { afterAll } from 'vitest';

import {
  artifactBytecodeFor,
  artifactDeployedBytecodeFor,
  ladderCorpus,
  upgradePairsFixture,
  type CorpusCompile,
} from './ladder-fixtures';
import { migrateShapedHandles, type HandleShape } from './handles';
import { makeTempDir } from './locate';

const TOOLKIT_PROJECT_DIRS = new Set<string>();

afterAll(() => {
  for (const root of TOOLKIT_PROJECT_DIRS) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A real, on-disk TronBox-shaped project for `createOperationToolkit`'s
 * `validateImplementation`, built from one of `ladder-corpus.json`'s
 * standalone compiles.
 *
 * This is a different kind of fixture than `ladder-fixtures.ts`'s
 * `ladderProject`: that one drives `deriveValidationInput` directly, with a
 * fully faked `env.artifacts`. `createOperationToolkit` builds `env.artifacts`
 * for real, through `resolveEnvironment` → `createArtifactAccess`, which reads
 * `paths.buildInfoDirectory` off the real filesystem with no injection seam —
 * so proving the toolkit's own wiring (rather than the pipeline's) needs real
 * files on a real temp directory, not an in-memory `exists`/`readSource` pair.
 *
 * `sourceKey` is written as the artifact's own file name under `contracts/`
 * (TronBox's own convention — `sourceKey` in a build record is already
 * relative to `contractsDirectory`, per `source-key.ts:sourceKey`), and the
 * artifact abstraction's `_json` carries exactly the five fields
 * `readArtifactRecord` reads, plus a top-level `abi` — the one field
 * `validateImplementation` reads directly off the abstraction rather than
 * through `_json`, mirroring TronBox's own `Contract.abi` getter.
 */
export interface RealToolkitProjectSpec {
  /** A standalone id from `test/fixtures/upgrade-pairs.json`. */
  readonly standaloneId: string;
  /**
   * Writes a second, deliberately malformed `*.output.json` alongside the
   * real one — `output.contracts` is a bare string, which fails
   * `buildArtifactAmbiguityIndex`'s own object-record check and aborts its
   * whole report into `status: 'indeterminate'`, while
   * `consultBuildRecord`'s independent, more tolerant scan (`recordMaps`
   * simply `continue`s past a file it cannot parse as maps) still finds the
   * real file and reports it fresh. That asymmetry is what lets
   * `deriveValidationInput` succeed while `env.artifacts.resolve` reports
   * `'indeterminate'` — the one combination `validateImplementation`'s own
   * indeterminate-resolution site exists to disclose.
   */
  readonly withMalformedCompanion?: boolean;
  /**
   * Writes a second, well-formed copy of the build-info pair alongside the
   * real one, so the ambiguity index reports the same `(sourcePath,
   * contractName)` from two records — the accumulation shape a recompile
   * with a differing compiler input leaves behind. Both records verify by
   * deployed-bytecode identity, so `consultBuildRecord` proceeds whichever
   * it reads.
   */
  readonly withDuplicateRecord?: boolean;
}

export interface RealToolkitProject {
  readonly root: string;
  readonly shape: HandleShape;
  readonly contractName: string;
}

function corpusCompileFor(standaloneId: string): {
  readonly compile: CorpusCompile;
  readonly sourceKey: string;
  readonly contractName: string;
} {
  const spec = upgradePairsFixture().standalone[standaloneId];
  if (spec === undefined) {
    throw new Error(`no standalone source "${standaloneId}" in upgrade-pairs.json`);
  }
  const entry = ladderCorpus().standalone[standaloneId];
  if (entry === undefined) {
    throw new Error(`the corpus has no standalone "${standaloneId}" — regenerate it`);
  }
  return {
    compile: entry.astOnly,
    sourceKey: entry.sourceKey,
    contractName: entry.contract,
  };
}

export function realToolkitProject(
  spec: RealToolkitProjectSpec,
): RealToolkitProject {
  const { compile, sourceKey, contractName } = corpusCompileFor(spec.standaloneId);

  const root = makeTempDir('toolkit-project');
  TOOLKIT_PROJECT_DIRS.add(root);
  const contractsDir = path.join(root, 'contracts');
  const buildInfoDir = path.join(root, 'build', 'build-info');
  fs.mkdirSync(contractsDir, { recursive: true });
  fs.mkdirSync(buildInfoDir, { recursive: true });

  const sourceEntry = compile.input.sources[sourceKey];
  const content = sourceEntry?.content;
  if (content === undefined) {
    throw new Error(`the corpus compile for "${spec.standaloneId}" has no source "${sourceKey}"`);
  }
  const sourcePath = path.join(contractsDir, sourceKey);
  fs.writeFileSync(sourcePath, content);

  fs.writeFileSync(
    path.join(buildInfoDir, 'aaaa.output.json'),
    JSON.stringify(compile.output),
  );
  fs.writeFileSync(
    path.join(buildInfoDir, 'aaaa.json'),
    JSON.stringify(compile.input),
  );

  if (spec.withMalformedCompanion === true) {
    // Sorted after "aaaa" so the real record is enumerated first; the
    // ambiguity index still aborts into `indeterminate` regardless of order
    // (it has no per-file skip), while `consultBuildRecord` skips this one
    // and keeps looking — see this module's own doc comment.
    fs.writeFileSync(
      path.join(buildInfoDir, 'zzzz.output.json'),
      JSON.stringify({ contracts: 'not-an-object', sources: {} }),
    );
  }

  if (spec.withDuplicateRecord === true) {
    fs.writeFileSync(
      path.join(buildInfoDir, 'bbbb.output.json'),
      JSON.stringify(compile.output),
    );
    fs.writeFileSync(
      path.join(buildInfoDir, 'bbbb.json'),
      JSON.stringify(compile.input),
    );
  }

  const bytecode = artifactBytecodeFor(compile, sourceKey, contractName);
  const deployedBytecode = artifactDeployedBytecodeFor(compile, sourceKey, contractName);
  // `SolcOutput`'s contract-entry type declares only `evm` and `storageLayout`
  // — the same gap `ladder-fixtures.ts:deployedBytecodeOf` already works
  // around, because upstream's published type is narrower than what solc's
  // real standard-JSON output (and this corpus, compiled with `abi` in its
  // own `outputSelection`) actually carries.
  const contractEntry: unknown = (
    compile.output.contracts as Record<string, Record<string, unknown>>
  )[sourceKey]?.[contractName];
  const abi =
    typeof contractEntry === 'object' && contractEntry !== null
      ? (contractEntry as { abi?: unknown }).abi ?? []
      : [];

  const abstraction = {
    contractName,
    sourcePath,
    abi,
    _json: {
      compiler: { version: upgradePairsFixture().compiler.longVersion },
      source: content,
      sourcePath,
      bytecode,
      deployedBytecode,
    },
  };

  const shape = migrateShapedHandles(
    { root },
    { abstractions: { [contractName]: abstraction } },
  );

  return { root, shape, contractName };
}
