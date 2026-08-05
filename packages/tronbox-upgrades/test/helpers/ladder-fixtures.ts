import fs from 'node:fs';
import path from 'node:path';

import {
  getStorageLayout,
  getStorageUpgradeErrors,
  solcInputOutputDecoder,
  validate,
  type SolcBytecode,
  type SolcInput,
  type SolcLinkReferences,
  type SolcOutput,
  type StorageLayout,
} from '@openzeppelin/upgrades-core';

import { soljsonPathFor } from '../../src/environment';
import type {
  ArtifactRecord,
  ArtifactRecordReport,
  BuildInfoReadResult,
  ContractAbstraction,
} from '../../src/environment';
import type { DegradedNote, OutputChannel } from '../../src/output';
import type { Cause } from '../../src/validation-input/causes';
import type { CompilerHandle } from '../../src/validation-input/compiler';
import type { Diagnosis } from '../../src/validation-input/diagnose';
import type {
  SolcStandardInput,
  SolcStandardOutput,
} from '../../src/validation-input/solc-input';
import type {
  ValidationInput,
  ValidationInputDependencies,
  ValidationInputEnvironment,
  ValidationInputOutcome,
} from '../../src/validation-input/pipeline';

import { absolute } from './readers';
import { testDir } from './locate';

/**
 * The validation ladder's fixture kit: the nine upgrade pairs, the real solc output they
 * compile to, and the four fakes `deriveValidationInput` needs to run with no
 * filesystem, no `~/.tronbox` and no wasm.
 *
 * ── Why the pairs live in JSON and the corpus is generated ────────────────────
 *
 * The ladder's fixtures are only worth anything if they are *non-vacuous*, and
 * every one of the discriminators turns on the validation engine's real answer over
 * a layout reconstructed from a real AST. An empty reference layout classifies every
 * variable in the new contract as a safe append — measured — so "compatible at zero
 * compiles" is satisfiable by a pipeline that validated nothing. The only way to
 * rule that out is to show the *same* fixture refusing a change it should refuse,
 * and that needs an AST solc actually produced.
 *
 * So the pairs are in `test/fixtures/upgrade-pairs.json` (one home, readable by both
 * this module and the plain-JS generator that compiles them) and their solc output is
 * in `test/fixtures/ladder-corpus.json`, generated once by
 * `test/fixtures/generate-ladder-corpus.js`. `test/sf-2-real-compiler.test.ts`
 * recompiles the decisive pairs and compares, so a stale corpus cannot quietly
 * become the thing under test.
 */

const fixturesDir = path.join(testDir, 'fixtures');

/** ─── The pairs ──────────────────────────────────────────────────────────── */

export interface PairVerdict {
  readonly accepts: boolean;
  /** Recorded only where the measurement captured the full list. */
  readonly kinds?: readonly string[];
}

export interface UpgradePair {
  readonly id: string;
  readonly name: string;
  /** Whether the change is in fact safe, independent of what any mode can see. */
  readonly safe: boolean;
  readonly before: string;
  readonly after: string;
  readonly astOnly: PairVerdict;
  readonly slotLevel: PairVerdict;
}

export interface MeasuredField {
  readonly label?: string;
  readonly slot: number;
  readonly offset: number;
  readonly bytes: number;
  readonly end: number;
}

export interface UpgradePairsFixture {
  readonly compiler: {
    readonly longVersion: string;
    readonly version: string;
    readonly engineVersion: string;
  };
  readonly pragma: string;
  readonly contract: string;
  readonly sourceKey: string;
  readonly pairs: readonly UpgradePair[];
  readonly measuredArithmetic: {
    readonly 'gap-consumption': {
      readonly field: string;
      readonly original: MeasuredField;
      readonly updated: MeasuredField;
      readonly isGapOriginal: boolean;
      readonly endMatchesGap: boolean;
    };
    readonly 'intra-slot-padding': {
      readonly insertedField: string;
      readonly original: readonly MeasuredField[];
      readonly updated: readonly MeasuredField[];
      readonly insertedOccupiesBytes: readonly [number, number];
      readonly overlapsOriginals: readonly string[];
    };
  };
  readonly vacuousPass: {
    readonly emptyOriginalAgainstRealUpdated: string;
    readonly realOriginalAgainstEmptyUpdated: readonly string[];
    readonly assertStorageUpgradeSafeThrows: boolean;
  };
  readonly outputSelection: {
    readonly hostContractOutputs: readonly string[];
    readonly pluginAddition: string;
  };
  readonly standalone: Readonly<Record<string, StandaloneSpec>>;
}

/**
 * One cast from `unknown`, at the boundary where a JSON document this suite wrote
 * becomes a typed value — the idiom `pipeline.ts` uses on the host's build record,
 * for the same reason: the alternative is `as unknown as`, which asserts twice.
 * Everything the cast claims is either checked immediately below or asserted by
 * `sf-2-ladder-fixtures.test.ts`, which is where the shape is the subject.
 */
function readFixture<T>(file: string, expectKeys: readonly string[]): T {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(fixturesDir, file), 'utf8'),
  );
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object`);
  }
  const missing = expectKeys.filter(key => !(key in parsed));
  if (missing.length > 0) {
    throw new Error(`${file} is missing ${missing.join(', ')}`);
  }
  return parsed as T;
}

let pairsCache: UpgradePairsFixture | undefined;

export function upgradePairsFixture(): UpgradePairsFixture {
  pairsCache ??= readFixture<UpgradePairsFixture>('upgrade-pairs.json', [
    'compiler',
    'pragma',
    'contract',
    'sourceKey',
    'pairs',
    'measuredArithmetic',
    'vacuousPass',
    'outputSelection',
  ]);
  return pairsCache;
}

export function upgradePairs(): readonly UpgradePair[] {
  return upgradePairsFixture().pairs;
}

export function upgradePair(id: string): UpgradePair {
  const found = upgradePairs().find(pair => pair.id === id);
  if (found === undefined) {
    throw new Error(`no upgrade pair "${id}" in upgrade-pairs.json`);
  }
  return found;
}

/** The full source text for one side, pragma included — what solc was handed. */
export function pairSource(pair: UpgradePair, side: 'before' | 'after'): string {
  return upgradePairsFixture().pragma + pair[side];
}

/** ─── The compiled corpus ────────────────────────────────────────────────── */

export interface CorpusCompile {
  readonly input: SolcInput;
  readonly output: SolcOutput;
}

interface CorpusPairEntry {
  readonly astOnly: {
    readonly before: CorpusCompile;
    readonly after: CorpusCompile;
  };
  readonly slotLevel?: {
    readonly before: CorpusCompile;
    readonly after: CorpusCompile;
  };
}

export interface LadderCorpus {
  readonly generatedFrom: string;
  readonly solcLongVersion: string;
  readonly solcVersion: string;
  readonly sourceKey: string;
  readonly contract: string;
  readonly pairs: Readonly<Record<string, CorpusPairEntry>>;
  readonly standalone: Readonly<
    Record<
      string,
      {
        readonly contract: string;
        readonly sourceKey: string;
        readonly astOnly: CorpusCompile;
        readonly slotLevel: CorpusCompile;
      }
    >
  >;
}

let corpusCache: LadderCorpus | undefined;

export function ladderCorpus(): LadderCorpus {
  corpusCache ??= readFixture<LadderCorpus>('ladder-corpus.json', [
    'solcLongVersion',
    'sourceKey',
    'contract',
    'pairs',
  ]);
  return corpusCache;
}

export type CorpusMode = 'astOnly' | 'slotLevel';

/** The real solc compile for one pair, one side, one output selection. */
export function corpusCompile(
  id: string,
  mode: CorpusMode,
  side: 'before' | 'after',
): CorpusCompile {
  const entry = ladderCorpus().pairs[id];
  if (entry === undefined) {
    throw new Error(`the corpus has no pair "${id}" — regenerate it`);
  }
  const bucket = mode === 'astOnly' ? entry.astOnly : entry.slotLevel;
  if (bucket === undefined) {
    throw new Error(
      `the corpus has no ${mode} compile for "${id}" — add it to the ` +
        `generator's slot-level set and regenerate`,
    );
  }
  return bucket[side];
}

/** ─── Driving the validation engine over a produced input ────────────────── */

/**
 * The layout the *consumer* will hold for the target, derived the way a consumer
 * derives it — `validate` then `getStorageLayout`, keyed by the bytecode-hash
 * version rather than by contract name, which is the keying the manifest uses.
 *
 * This is what makes every ladder assertion an assertion about information rather
 * than about shape. A produced input that carried no contracts, or a mis-keyed one,
 * yields an empty layout here — and an empty *original* layout accepts everything,
 * which is the trap the discriminators exist to close.
 */
export function consumerLayout(
  solcInput: SolcInput,
  solcOutput: SolcOutput,
  solcVersion: string,
  fullyQualifiedName: string,
): StorageLayout {
  const decoder = solcInputOutputDecoder(solcInput, solcOutput);
  const validations = validate(solcOutput, decoder, solcVersion, solcInput);
  const entry = validations[fullyQualifiedName];
  if (entry === undefined) {
    throw new Error(
      `the engine produced no validation entry for ${fullyQualifiedName}; ` +
        `it saw ${Object.keys(validations).join(', ') || '(nothing)'}`,
    );
  }
  if (entry.version === undefined) {
    throw new Error(`${fullyQualifiedName} has no bytecode (abstract)`);
  }
  return getStorageLayout({ version: '3.4', log: [validations] }, entry.version);
}

export interface EngineVerdict {
  readonly accepts: boolean;
  /** Every operation kind the engine flagged, sorted and de-duplicated. */
  readonly kinds: readonly string[];
}

/** The engine's own answer, reduced to the two things a fixture asserts on. */
export function engineVerdict(
  original: StorageLayout,
  updated: StorageLayout,
): EngineVerdict {
  const errors = getStorageUpgradeErrors(original, updated, {});
  return {
    accepts: errors.length === 0,
    kinds: [...new Set(errors.map(error => error.kind))].sort(),
  };
}

/** The measured vacuous reference: `storage: []` accepts every append. */
export const EMPTY_LAYOUT: StorageLayout = Object.freeze({
  storage: [],
  types: {},
});

/** ─── The project fixture ────────────────────────────────────────────────── */

export const PROJECT_ROOT = '/proj';
export const CONTRACTS_DIR = `${PROJECT_ROOT}/contracts`;
export const BUILD_INFO_DIR = `${PROJECT_ROOT}/build/build-info`;

export interface RecordingChannel extends Pick<OutputChannel, 'note' | 'degraded'> {
  readonly degradedNotes: readonly DegradedNote[];
  readonly notes: readonly { readonly title: string; readonly detail: readonly string[] }[];
}

export function recordingChannel(): RecordingChannel {
  const degradedNotes: DegradedNote[] = [];
  const notes: { title: string; detail: readonly string[] }[] = [];
  return {
    degradedNotes,
    notes,
    degraded(note) {
      degradedNotes.push(note);
      return note;
    },
    note(title, detail) {
      notes.push({ title, detail: detail ?? [] });
    },
  };
}

/** Every degraded code the channel recorded, in call order. */
export function degradedCodes(channel: RecordingChannel): readonly string[] {
  return channel.degradedNotes.map(note => note.code);
}

export interface ArtifactRecordSpec {
  readonly longCompilerVersion?: string;
  readonly bytecode?: string;
  readonly deployedBytecode?: string;
  readonly source?: string;
  readonly sourcePath?: string;
}

export function artifactRecord(spec: ArtifactRecordSpec = {}): ArtifactRecord {
  const fixture = upgradePairsFixture();
  return Object.freeze({
    longCompilerVersion: spec.longCompilerVersion ?? fixture.compiler.longVersion,
    bytecode: spec.bytecode ?? '0x60016000',
    deployedBytecode: spec.deployedBytecode ?? '0x60016000',
    source: spec.source ?? 'contract T {}',
    sourcePath: spec.sourcePath ?? `${CONTRACTS_DIR}/${fixture.sourceKey}`,
  });
}

export interface LadderProjectSpec {
  /** The artifact name `resolve` answers for, and the contract the record is for. */
  readonly contractName?: string;
  /** The source key file name under `contracts/`. Defaults to the pairs' own. */
  readonly sourceFile?: string;
  /** The Solidity text `readSource` returns for the target. */
  readonly sourceText?: string;
  readonly record?: ArtifactRecordSpec;
  /** Substitute the whole record report — for the incomplete-artifact branches. */
  readonly recordReport?: ArtifactRecordReport;
  readonly resolvedVersion?: string;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly family?: 'tvm' | 'evm';
  readonly viaLegacyFlag?: 'useZeroFourCompiler' | 'useZeroFiveCompiler';
  /** Extra sources on disk, keyed by absolute path. */
  readonly extraSources?: Readonly<Record<string, string>>;
}

export interface LadderProject {
  readonly env: ValidationInputEnvironment;
  readonly channel: RecordingChannel;
  readonly contractName: string;
  readonly sourceKey: string;
  readonly fullyQualifiedName: string;
  /** `exists` / `readSource` over the in-memory tree, for `deps`. */
  readonly filesystem: Pick<ValidationInputDependencies, 'exists' | 'readSource'>;
  readonly record: ArtifactRecord;
}

/**
 * A whole project as `deriveValidationInput` sees it, with nothing on disk.
 *
 * The abstraction handed to `resolve` is an empty object rather than anything
 * host-shaped, and that is the point: the validation ladder reads every
 * artifact fact through `artifacts.record()`, so a fixture that had to
 * populate `_json` would be evidence the boundary leaked.
 */
export function ladderProject(spec: LadderProjectSpec = {}): LadderProject {
  const fixture = upgradePairsFixture();
  const contractName = spec.contractName ?? fixture.contract;
  const sourceKey = spec.sourceFile ?? fixture.sourceKey;
  const sourcePath = `${CONTRACTS_DIR}/${sourceKey}`;
  const record = artifactRecord({ sourcePath, ...spec.record });
  const channel = recordingChannel();
  const abstraction: ContractAbstraction = {};

  const tree: Record<string, string> = {
    [sourcePath]: spec.sourceText ?? record.source,
    ...spec.extraSources,
  };

  const report: ArtifactRecordReport =
    spec.recordReport ??
    Object.freeze({
      status: 'complete',
      record,
      observedKeys: Object.freeze([
        'contract_name',
        'sourcePath',
        'source',
        'bytecode',
        'deployedBytecode',
        'compiler',
      ]),
      internalPathsRead: Object.freeze(['_json']),
    });

  const env: ValidationInputEnvironment = {
    paths: {
      root: absolute(PROJECT_ROOT),
      contractsDirectory: absolute(CONTRACTS_DIR),
      buildInfoDirectory: absolute(BUILD_INFO_DIR),
    },
    artifacts: {
      resolve: name => ({
        status: 'unique',
        name: name === contractName ? contractName : name,
        contract: abstraction,
        sourcePath,
      }),
      record: () => report,
    },
    compiler: {
      resolvedVersion: spec.resolvedVersion ?? fixture.compiler.version,
      settings: Object.freeze(spec.settings ?? {}),
      family: spec.family ?? 'tvm',
      ...(spec.viaLegacyFlag === undefined
        ? {}
        : { viaLegacyFlag: spec.viaLegacyFlag }),
      versionIsHostDefault: false,
      settingsSource: 'none',
    },
    output: channel,
  };

  return {
    env,
    channel,
    contractName,
    sourceKey,
    fullyQualifiedName: `${sourceKey}:${contractName}`,
    filesystem: {
      exists: candidate => candidate in tree,
      readSource: candidate => {
        const content = tree[candidate];
        if (content === undefined) {
          throw Object.assign(new Error(`ENOENT: ${candidate}`), {
            code: 'ENOENT',
          });
        }
        return content;
      },
    },
    record,
  };
}

/** ─── Narrowing an outcome without asserting on a union ──────────────────── */

/**
 * The produced input, or a failure naming the refusal.
 *
 * A function rather than `expect(outcome.kind).toBe('input')` because the latter
 * does not narrow the union for TypeScript, so every following line would need a
 * cast — and a cast is exactly what would let a refusal be read as an input.
 */
export function expectInput(outcome: ValidationInputOutcome): ValidationInput {
  if (outcome.kind === 'refused') {
    throw new Error(
      `expected a validation input, got a refusal: ${outcome.cause.kind} — ` +
        outcome.diagnosis.headline,
    );
  }
  return outcome.input;
}

export function expectRefusal(outcome: ValidationInputOutcome): {
  readonly cause: Cause;
  readonly diagnosis: Diagnosis;
} {
  if (outcome.kind === 'input') {
    throw new Error(
      `expected a refusal, got an input with ${outcome.input.fidelity.kind} ` +
        `fidelity on basis ${outcome.input.provenance.basis.kind}`,
    );
  }
  return { cause: outcome.cause, diagnosis: outcome.diagnosis };
}

/** ─── The dependency surface ─────────────────────────────────────────────── */

export const HOME_DIRECTORY = '/home/tester';

/**
 * Where TronBox would cache the compiler for this configuration — resolved through
 * the seam's own function rather than by joining strings here, so a fixture that
 * "makes the compiler present" cannot disagree with the convention the code reads.
 */
export function cachedCompilerPath(
  family: 'tvm' | 'evm',
  resolvedVersion: string,
  homeDirectory: string = HOME_DIRECTORY,
): string {
  const resolved = soljsonPathFor(homeDirectory, { family, resolvedVersion });
  if (resolved.status !== 'resolved') {
    throw new Error(`the fixture home directory ${homeDirectory} is not absolute`);
  }
  return resolved.soljsonPath;
}

export interface LadderDepsSpec {
  readonly loader?: CountingLoader;
  readonly readBuildInfo?: () => BuildInfoReadResult;
  /** Present by default. Set false to drive cause 1 without the compiler cached. */
  readonly compilerCached?: boolean;
  readonly homeDirectory?: string;
}

/**
 * `deriveValidationInput`'s whole injected surface, assembled from a project.
 *
 * The compiler cache is modelled as a file in the same in-memory tree the sources
 * live in — so `exists` answers one question about one tree, and a fixture cannot
 * accidentally report a compiler present on a path the production resolver would
 * not have looked at.
 */
export function ladderDeps(
  project: LadderProject,
  spec: LadderDepsSpec = {},
): ValidationInputDependencies {
  const home = spec.homeDirectory ?? HOME_DIRECTORY;
  const cached =
    spec.compilerCached === false
      ? undefined
      : cachedCompilerPath(
          project.env.compiler.family,
          project.env.compiler.resolvedVersion,
          home,
        );
  const loader = spec.loader;
  return {
    exists: candidate =>
      candidate === cached || project.filesystem.exists?.(candidate) === true,
    readSource: candidate => {
      const read = project.filesystem.readSource;
      if (read === undefined) {
        throw new Error('the project fixture has no readSource');
      }
      return read(candidate);
    },
    ...(loader === undefined
      ? { loadCompiler: forbiddenLoader() }
      : { loadCompiler: loader.load }),
    ...(spec.readBuildInfo === undefined
      ? {}
      : { readBuildInfo: spec.readBuildInfo }),
    homeDirectory: () => home,
  };
}

/** ─── The counting compiler loader ───────────────────────────────────────── */

export interface CountingLoader {
  /** Pass as `deps.loadCompiler`. */
  readonly load: (soljsonPath: string) => CompilerHandle;
  /** How many times a compiler was loaded. The ladder's primary observable. */
  readonly loads: () => number;
  /** How many times `compile` was invoked on a loaded handle. */
  readonly compiles: () => number;
  readonly inputs: () => readonly SolcStandardInput[];
  readonly paths: () => readonly string[];
}

export interface CountingLoaderSpec {
  readonly longVersion?: string;
  /** What `compile` answers. Defaults to an output with no contracts. */
  readonly output?: SolcStandardOutput;
  /** Throw instead of answering — for the wasm-abort and retirement arms. */
  readonly thrown?: () => never;
}

/**
 * A `loadCompiler` whose call count is the assertion.
 *
 * Counting *loads* rather than *compiles* is deliberate and it is the stronger
 * observable: on the fresh path no compiler is located, loaded or version-compared,
 * so a load count of zero rules out the whole compiler-bearing arm rather than only
 * the `compile` call at the end of it. Both counts are exposed because they are
 * different claims — a load with no compile would be a path that read `~/.tronbox`
 * for nothing.
 */
export function countingLoader(spec: CountingLoaderSpec = {}): CountingLoader {
  const fixture = upgradePairsFixture();
  const longVersion = spec.longVersion ?? fixture.compiler.longVersion;
  const paths: string[] = [];
  const inputs: SolcStandardInput[] = [];
  let compiles = 0;
  let retired = false;

  const emptyOutput: SolcStandardOutput = { contracts: {}, sources: {} };

  return {
    load: soljsonPath => {
      paths.push(soljsonPath);
      return {
        longVersion,
        compile: input => {
          if (retired) {
            throw new Error('the fixture handle was already used and retired');
          }
          compiles += 1;
          inputs.push(input);
          if (spec.thrown !== undefined) {
            retired = true;
            spec.thrown();
          }
          return spec.output ?? emptyOutput;
        },
      };
    },
    loads: () => paths.length,
    compiles: () => compiles,
    inputs: () => inputs,
    paths: () => paths,
  };
}

/** A `loadCompiler` that fails the test if it is called at all. */
export function forbiddenLoader(): (soljsonPath: string) => CompilerHandle {
  return soljsonPath => {
    throw new Error(
      `a compiler was loaded from ${soljsonPath} on a path that must load none`,
    );
  };
}

/** ─── Build records ──────────────────────────────────────────────────────── */

export interface BuildRecordSpec {
  readonly file?: string;
  /** Source key → the compile whose `contracts` / `sources` entries to project. */
  readonly from: CorpusCompile;
  readonly sourceKey: string;
  readonly contractName: string;
  /** Override the record's deployed bytecode object — the staleness lever. */
  readonly deployedObject?: string;
  /** Drop the target's `contracts` entry, keeping its `sources` entry. */
  readonly omitContract?: boolean;
  /** Drop the target's `sources` entry, keeping its `contracts` entry. */
  readonly omitAst?: boolean;
  /** Replace `evm.deployedBytecode` with nothing at all. */
  readonly omitDeployedBytecode?: boolean;
  /** Rename the contract definition in the AST so the target is not declared. */
  readonly hideContractDefinition?: boolean;
  /** Extra `contracts` / `sources` entries merged in, e.g. a second contract. */
  readonly alsoFor?: readonly Omit<BuildRecordSpec, 'file'>[];
}

/**
 * One `*.output.json` document, built out of a real compile rather than by hand.
 *
 * Hand-written build records were rejected for the same reason hand-written ASTs
 * were: the fresh path's whole claim is that the engine can reconstruct a layout
 * from what the host already wrote, and a stub AST proves the pipeline copies
 * fields, not that the reconstruction works.
 *
 * ── EVERY contract the compile emitted for the key, not only the target ───────
 *
 * A real `*.output.json` is solc's whole standard-JSON answer, so it holds an entry
 * for every contract in the file — the target's **base contracts included**. That is
 * not cosmetic: `validate` builds a validation entry only for names present in
 * `solcOutput.contracts[source]` (`upgrades-core@1.46.0`,
 * `dist/validate/run.js:100-103`) while it takes `inherit` from the AST's
 * `linearizedBaseContracts` regardless — so a record carrying only the target makes
 * `unfoldStorageLayout` dereference `runData['S.sol:Base'].layout` on `undefined` and
 * the consumer crashes with a `TypeError` instead of getting a layout. Measured: the
 * `inheritance-swap` pair did exactly that when this projected the target alone.
 *
 * A fixture that reproduced only the target would therefore have been testing a
 * document TronBox never writes, and would have hidden the one property
 * `projectBuildRecord` has to have — that it copies the **whole** `contracts` map for
 * each closure key rather than filtering it by contract name.
 */
export function buildRecord(spec: BuildRecordSpec): {
  readonly file: string;
  readonly output: unknown;
} {
  const contracts: Record<string, unknown> = {};
  const sources: Record<string, unknown> = {};

  const add = (one: Omit<BuildRecordSpec, 'file'>): void => {
    const compiled = one.from.output;
    const allForKey = compiled.contracts[one.sourceKey];
    const sourceEntry = compiled.sources[one.sourceKey];
    if (
      allForKey === undefined ||
      allForKey[one.contractName] === undefined ||
      sourceEntry === undefined
    ) {
      throw new Error(
        `the corpus compile has no ${one.sourceKey}:${one.contractName}`,
      );
    }

    const entries: Record<string, unknown> = {
      ...(contracts[one.sourceKey] as Record<string, unknown> | undefined),
    };
    for (const name of Object.keys(allForKey)) {
      const isTarget = name === one.contractName;
      if (isTarget && one.omitContract) {
        continue;
      }
      const entry = allForKey[name];
      if (entry === undefined) {
        continue;
      }
      const evm: Record<string, unknown> = { bytecode: entry.evm.bytecode };
      if (!(isTarget && one.omitDeployedBytecode)) {
        const deployed = deployedBytecodeOf(compiled, one.sourceKey, name);
        evm.deployedBytecode = {
          object:
            isTarget && one.deployedObject !== undefined
              ? one.deployedObject
              : deployed.object,
          linkReferences: deployed.linkReferences,
        };
      }
      entries[name] = { evm };
    }
    contracts[one.sourceKey] = entries;

    if (!one.omitAst) {
      sources[one.sourceKey] = one.hideContractDefinition
        ? withoutContractDefinition(sourceEntry, one.contractName)
        : sourceEntry;
    }
  };

  add(spec);
  for (const extra of spec.alsoFor ?? []) {
    add(extra);
  }

  return {
    file: spec.file ?? `${BUILD_INFO_DIR}/aaaa.output.json`,
    output: { contracts, sources },
  };
}

/**
 * The record's deployed bytecode, unprefixed, exactly as solc emitted it.
 *
 * Reached through a narrowing rather than a cast because upstream's `SolcOutput`
 * declares `evm.bytecode` and not `evm.deployedBytecode` — the field is real (the
 * host requests it) and simply outside the type upstream publishes.
 */
export function deployedBytecodeOf(
  output: SolcOutput,
  sourceKey: string,
  contractName: string,
): SolcBytecode {
  const evm: unknown = output.contracts[sourceKey]?.[contractName]?.evm;
  const deployed: unknown =
    typeof evm === 'object' && evm !== null
      ? (evm as { deployedBytecode?: unknown }).deployedBytecode
      : undefined;
  if (typeof deployed !== 'object' || deployed === null) {
    throw new Error(`no deployedBytecode for ${sourceKey}:${contractName}`);
  }
  const object: unknown = (deployed as { object?: unknown }).object;
  if (typeof object !== 'string') {
    throw new Error(`deployedBytecode.object for ${contractName} is not a string`);
  }
  // `SolcBytecode` rather than a structural literal, because that is the type
  // `verifyBuildRecordFreshness` and `compareArtifactIdentity` accept — a helper
  // that returned `linkReferences: unknown` would force every caller wanting to
  // exercise those to cast, which moves the one boundary cast into the tests and
  // multiplies it. The map's shape is checked here instead.
  const links: unknown =
    (deployed as { linkReferences?: unknown }).linkReferences ?? {};
  if (typeof links !== 'object' || links === null || Array.isArray(links)) {
    throw new Error(
      `deployedBytecode.linkReferences for ${contractName} is not an object`,
    );
  }
  return { object, linkReferences: links as SolcLinkReferences };
}

/** The artifact's own `deployedBytecode`, as TronBox writes it: `'0x' + object`. */
export function artifactDeployedBytecodeFor(
  compiled: CorpusCompile,
  sourceKey: string,
  contractName: string,
): string {
  return `0x${deployedBytecodeOf(compiled.output, sourceKey, contractName).object}`;
}

/** The artifact's `bytecode` (creation), as TronBox writes it. */
export function artifactBytecodeFor(
  compiled: CorpusCompile,
  sourceKey: string,
  contractName: string,
): string {
  const entry = compiled.output.contracts[sourceKey]?.[contractName];
  if (entry === undefined) {
    throw new Error(`no compile entry for ${sourceKey}:${contractName}`);
  }
  return `0x${entry.evm.bytecode.object}`;
}

/**
 * The hex index one past the executable region — where solc's CBOR tail begins.
 *
 * **The split is measured off the blob itself, not guessed from a length.** solc
 * ends deployed bytecode with a CBOR metadata section whose last two bytes are the
 * section's own length, big-endian — the same two bytes
 * `upgrades-core`'s `trimBytecodeMetadata` reads before it `cbor.decode`s the slice.
 * So the tail occupies `length + 2` bytes and the executable region is everything
 * before it. Measured on this corpus at TVM solc 0.8.26: the CBOR length is `51`
 * on every fixture, so the tail is 53 bytes / 106 hex digits, and the executable
 * region runs 18 hex digits for the bodiless pairs and 838 for
 * `constants-and-immutables`.
 *
 * This exists so that *"the mutated byte is in the executable region"* is a
 * **computed** claim rather than a magic character count. A threshold like
 * `length > 200` is not that claim: it is satisfied by a 200-digit string that is
 * pure metadata, and it fails on a perfectly good 124-digit fixture whose
 * executable region is nine bytes long.
 */
export function metadataTailStart(object: string): number {
  if (object.length < 4) {
    throw new Error(
      `a ${object.length}-digit bytecode object carries no CBOR length field`,
    );
  }
  const declared = Number.parseInt(object.slice(-4), 16);
  if (!Number.isInteger(declared)) {
    throw new Error(`the last four digits of the object are not hex: ${object.slice(-4)}`);
  }
  const start = object.length - (declared + 2) * 2;
  if (start <= 0 || start >= object.length) {
    throw new Error(
      `the declared CBOR length ${declared} does not fit a ` +
        `${object.length}-digit object — this blob has no metadata tail`,
    );
  }
  return start;
}

/** The executable region and the CBOR metadata tail, as two strings. */
export function splitMetadataTail(object: string): {
  readonly executable: string;
  readonly metadata: string;
} {
  const start = metadataTailStart(object);
  return {
    executable: object.slice(0, start),
    metadata: object.slice(start),
  };
}

function flipDigitAt(object: string, index: number): string {
  const digit = object[index];
  if (digit === undefined) {
    throw new Error(`the bytecode object has no digit at index ${index}`);
  }
  const replacement = digit === 'a' ? 'b' : 'a';
  return object.slice(0, index) + replacement + object.slice(index + 1);
}

/** Where {@link mutateExecutablePrefix} strikes. Index 2 is byte 1. */
export const EXECUTABLE_MUTATION_INDEX = 2;

/**
 * Flips one hex digit in the **executable prefix** of a deployed-bytecode object.
 *
 * The prefix rather than the tail on purpose, and this is what makes the staleness
 * fixture hold for every project rather than most: a project setting
 * `metadata.bytecodeHash: "none"` strips the CBOR section — so a fixture that
 * mutated the tail would be mutating bytes that are absent under that setting, and
 * the A/B would silently stop being an A/B. Index 2 is inside the dispatcher
 * preamble, which every contract has.
 *
 * The bound is **checked, not assumed**: mutating at or past
 * {@link metadataTailStart} raises here rather than producing a fixture that looks
 * like a staleness A/B and is really a metadata A/B.
 */
export function mutateExecutablePrefix(object: string): string {
  const start = metadataTailStart(object);
  if (EXECUTABLE_MUTATION_INDEX >= start) {
    throw new Error(
      `index ${EXECUTABLE_MUTATION_INDEX} is inside the CBOR metadata tail, ` +
        `which begins at ${start} — mutating it would not survive ` +
        `metadata.bytecodeHash: "none"`,
    );
  }
  return flipDigitAt(object, EXECUTABLE_MUTATION_INDEX);
}

/**
 * The offset, from the first digit of the CBOR section, that
 * {@link mutateMetadataTail} strikes.
 *
 * 20 is the first digit of the **source-hash digest** — the opaque byte string
 * every solc metadata layout carries. Measured on this corpus at TVM solc 0.8.26,
 * the section is
 * `a2 · 64 "tron" · 58 22 · 1220 · <32-byte digest> · 64 "solc" · 43 00081a · 0033`,
 * so digits 0–19 are the map header, the key and the multihash prefix, and 20–83
 * are the digest.
 *
 * **The offset is load-bearing, not decorative, and that is why it is a measured
 * constant rather than a 0.** `trimBytecodeMetadata`
 * (`upgrades-core/dist/version.js`) `cbor.decode`s the section and returns the
 * bytecode **unchanged** when the decode throws. So a flip at offset 0 corrupts
 * the CBOR map header, the trim silently does nothing, and the mutated blob's
 * trimmed identity *differs* from the original — a "metadata mutation" that reads
 * as a staleness signal, which is the exact opposite of this helper's purpose and
 * would have quietly inverted the discriminator it feeds. Inside the digest the
 * decoder sees opaque bytes, the section still decodes, and the trim still removes
 * all of it. Measured: 82 of the 106 offsets are trim-absorbed and every offset in
 * 20–83 is among them; offset 0 is not.
 */
export const METADATA_MUTATION_OFFSET = 20;

/**
 * Flips one hex digit **inside** the CBOR metadata tail — the discriminator that
 * makes {@link mutateExecutablePrefix}'s choice of region a measurement rather than
 * a preference.
 *
 * Never the last four digits: those are the length field `trimBytecodeMetadata`
 * parses, and corrupting them makes the trim bail and return the blob unchanged,
 * which would make a tail mutation look like a prefix mutation. Never the section
 * header either — see {@link METADATA_MUTATION_OFFSET}, which is where the digit
 * comes from and why.
 */
export function mutateMetadataTail(object: string): string {
  const start = metadataTailStart(object);
  const index = start + METADATA_MUTATION_OFFSET;
  if (index >= object.length - 4) {
    throw new Error(
      `offset ${METADATA_MUTATION_OFFSET} into a ${object.length - start}-digit ` +
        `CBOR section reaches the two-byte length field at ` +
        `${object.length - 4}, which trimBytecodeMetadata parses — flipping it ` +
        `would defeat the trim instead of being absorbed by it`,
    );
  }
  return flipDigitAt(object, index);
}

/** A reader over a fixed set of records, in the order given. */
export function buildInfoReader(
  records: readonly { readonly file: string; readonly output: unknown }[],
): () => BuildInfoReadResult {
  return () => ({
    status: 'files',
    files: records.map(record => ({
      file: absolute(record.file),
      output: record.output,
    })),
  });
}

export function absentBuildInfoReader(): () => BuildInfoReadResult {
  return () => ({ status: 'absent' });
}

export function unreadableBuildInfoReader(): () => BuildInfoReadResult {
  return () => ({
    status: 'unreadable',
    file: absolute(BUILD_INFO_DIR),
    cause: 'EACCES',
  });
}

export function throwingBuildInfoReader(): () => BuildInfoReadResult {
  return () => {
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  };
}

/** ─── AST surgery, for the arms a real compile cannot produce ────────────── */

/**
 * The same `sources` entry with the named `ContractDefinition` renamed away.
 *
 * The one place this kit edits a real AST, and it exists because the arm it feeds —
 * a record whose bytecode verifies but whose AST does not declare the target — is
 * not producible by compiling anything. Renaming rather than deleting keeps the
 * node count and every id intact, so the only thing the fixture changes is the one
 * field the check reads.
 */
function withoutContractDefinition(sourceEntry: unknown, contract: string): unknown {
  const cloned: unknown = JSON.parse(JSON.stringify(sourceEntry));
  const ast: unknown =
    typeof cloned === 'object' && cloned !== null
      ? (cloned as { ast?: unknown }).ast
      : undefined;
  const nodes: unknown =
    typeof ast === 'object' && ast !== null
      ? (ast as { nodes?: unknown }).nodes
      : undefined;
  if (!Array.isArray(nodes)) {
    throw new Error('the fixture source entry carries no AST nodes');
  }
  for (const node of nodes) {
    if (
      typeof node === 'object' &&
      node !== null &&
      (node as { nodeType?: unknown }).nodeType === 'ContractDefinition' &&
      (node as { name?: unknown }).name === contract
    ) {
      (node as { name: string }).name = `${contract}Renamed`;
    }
  }
  return cloned;
}

/** ─── Standalone sources: declarations rather than upgrade pairs ─────────── */

export interface StandaloneSpec {
  readonly contract: string;
  readonly sourceKey: string;
  readonly note: string;
  readonly source: string;
}

/** The declaration fixtures — namespaced, inherited, constant-bearing, stateless. */
export function standaloneSpec(id: string): StandaloneSpec {
  const specs = upgradePairsFixture().standalone;
  const found = specs[id];
  if (found === undefined) {
    throw new Error(`no standalone source "${id}" in upgrade-pairs.json`);
  }
  return found;
}

export interface StandaloneCompiles {
  readonly contract: string;
  readonly sourceKey: string;
  readonly fullyQualifiedName: string;
  readonly astOnly: CorpusCompile;
  readonly slotLevel: CorpusCompile;
}

/** One standalone source's two real compiles, both selections. */
export function standalone(id: string): StandaloneCompiles {
  const entry = ladderCorpus().standalone[id];
  if (entry === undefined) {
    throw new Error(`the corpus has no standalone "${id}" — regenerate it`);
  }
  return {
    ...entry,
    fullyQualifiedName: `${entry.sourceKey}:${entry.contract}`,
  };
}

/** The Solidity text for one standalone source, pragma included. */
export function standaloneSource(id: string): string {
  return standaloneSpec(id).source;
}

/**
 * The Solidity text **taken out of the compile that produced this standalone's
 * corpus artifacts** — solc's own `input.sources[key].content`, not the pairs
 * fixture's declaration.
 *
 * Two names for what is currently the same string, on purpose. A fixture that
 * builds its build record from {@link artifactBytecodeFor} over
 * `standalone(id).astOnly` is claiming *this artifact came from this source*, and
 * {@link standaloneSource} cannot support that claim: it reads
 * `upgrade-pairs.json`, which the generator consumes but the corpus does not
 * re-derive, so an edited declaration against an unregenerated corpus would hand
 * the pipeline a source text that never produced the bytecode beside it. Reading
 * the compile's own input closes that gap by construction.
 *
 * The agreement between the two is then **asserted rather than assumed**, which is
 * what makes this a staleness detector instead of a second accessor: if the corpus
 * is behind `upgrade-pairs.json` this raises and names both lengths, where the
 * silent version would have produced a fixture whose record and artifact disagree
 * for a reason no assertion in the suite mentions.
 */
export function standaloneSourceOf(id: string): string {
  const compiled = standalone(id);
  const entry = compiled.astOnly.input.sources[compiled.sourceKey];
  if (entry === undefined) {
    throw new Error(
      `the corpus compile for standalone "${id}" has no source entry ` +
        `"${compiled.sourceKey}"; it has ` +
        `${Object.keys(compiled.astOnly.input.sources).join(', ') || '(nothing)'}`,
    );
  }
  const { content } = entry;
  if (typeof content !== 'string') {
    throw new Error(
      `the corpus compile for standalone "${id}" carries no source text for ` +
        `"${compiled.sourceKey}" — regenerate it`,
    );
  }
  const declared = standaloneSource(id);
  if (content !== declared) {
    throw new Error(
      `the corpus compile for standalone "${id}" was produced from a different ` +
        `source than upgrade-pairs.json declares (${content.length} digits ` +
        `compiled vs ${declared.length} declared) — regenerate the corpus`,
    );
  }
  return content;
}

/**
 * A project whose artifact is the one the host would have written for a standalone
 * source — the same construction `pairProject` performs for a pair side.
 *
 * One helper rather than three copies inline, because the artifact's two bytecodes
 * have to come from the **host-only** compile on every fixture: that is the
 * selection TronBox uses, so a compile-arm identity match exercises the
 * measured host/plugin byte-identity end to end rather than a fixture
 * agreeing with itself. A fixture that took them from the slot-level compile
 * would still match — the two selections produce identical bytecode — and
 * would prove nothing about which one the host wrote.
 *
 * `contract` defaults to the standalone's declared target but can name any contract
 * the same file compiled, which is what the absent-path discriminator needs.
 */
export function standaloneProject(
  id: string,
  contract?: string,
): LadderProject {
  const compiled = standalone(id);
  const name = contract ?? compiled.contract;
  const source = standaloneSource(id);
  return ladderProject({
    contractName: name,
    sourceFile: compiled.sourceKey,
    sourceText: source,
    record: {
      source,
      bytecode: artifactBytecodeFor(compiled.astOnly, compiled.sourceKey, name),
      deployedBytecode: artifactDeployedBytecodeFor(
        compiled.astOnly,
        compiled.sourceKey,
        name,
      ),
    },
  });
}

/** ─── The layout arithmetic the two safe pairs turn on ───────────────────── */

/**
 * One flat-layout member reduced to the four numbers `measuredArithmetic` records.
 *
 * `end` is `slot * 32 + offset + bytes`, which is upstream's own
 * `storageFieldEnd` arithmetic (`dist/storage/compare.js`) — and it is the number the
 * gap-consumption fixture turns on: the pair is the *right* fixture only if the
 * updated `__gap` ends where the original one did, because that is what makes the
 * consumption safe rather than merely gap-shaped.
 */
export function measuredFieldsOf(
  layout: StorageLayout,
): readonly MeasuredField[] {
  return layout.storage.map(item => {
    const slot = Number(item.slot ?? Number.NaN);
    const offset = item.offset ?? Number.NaN;
    const declared = layout.types[item.type]?.numberOfBytes;
    const bytes = Number(declared ?? Number.NaN);
    return {
      label: item.label,
      slot,
      offset,
      bytes,
      end: slot * 32 + offset + bytes,
    };
  });
}

/** One named member of a measured layout, or a failure naming what was there. */
export function measuredFieldNamed(
  layout: StorageLayout,
  label: string,
): MeasuredField {
  const fields = measuredFieldsOf(layout);
  const found = fields.find(field => field.label === label);
  if (found === undefined) {
    throw new Error(
      `the layout declares no member "${label}"; it declares ` +
        `${fields.map(field => field.label ?? '?').join(', ') || '(nothing)'}`,
    );
  }
  return found;
}
