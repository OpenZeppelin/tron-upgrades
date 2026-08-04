import fs from 'node:fs';
import os from 'node:os';

import {
  ArtifactNameAmbiguousError,
  fileSystemBuildInfoReader,
  type AbsolutePath,
  type ArtifactAccess,
  type ArtifactRecord,
  type ArtifactRecordField,
  type BuildInfoFile,
  type BuildInfoReader,
  type CompilerConfiguration,
  type ContractAbstraction,
  type ProjectPaths,
} from '../environment';
import type { OutputChannel } from '../output';

import {
  ARTIFACT_FIELDS_VERIFIED_SINCE,
  type Cause,
  type WasmAbort,
} from './causes';
import {
  isSupportedSolcVersion,
  loadCompiler,
  openCompiler,
  type CompilerHandle,
  type CompilerIdentity,
} from './compiler';
import { diagnose, type Diagnosis } from './diagnose';
import { ValidationInputInvariantError } from './errors';
import { resolveSourceGraph } from './import-graph';
import {
  absentFromRecompile,
  compareArtifactIdentity,
  libraryNameBand,
  verifyBuildRecordFreshness,
  type ArtifactIdentityComparison,
} from './identity';
import {
  countDeclaredStateVariables,
  declaresNamespacedStorage,
  detectFidelity,
  isLayoutVacuous,
  type LayoutBasis,
  type LayoutFidelity,
} from './layout-fidelity';
import {
  createCompileMemo,
  cutPartition,
  partitionIdentity,
  type CompileMemo,
  type Partition,
  type PartitionRecord,
} from './partition';
import { policy, type ReducedMode } from './policy';
import { absoluteSourcePath } from './source-key';
import {
  buildSolcInput,
  countErrorDiagnostics,
  type SolcStandardInput,
  type SolcStandardOutput,
} from './solc-input';

/**
 * The whole of SF-2, and **the one place `policy.ts` is imported and called**.
 *
 * A refusal is a value, never a throw. That is not stylistic: the pipeline has to
 * be *able* to carry a `proceed-reduced` disposition, and a thrown refusal cannot
 * become a proceed — catching it cannot manufacture the layouts a lenient path
 * would need to return. Returning a value is what makes the policy table the only
 * thing a leniency flip touches.
 *
 * The only two things this module throws are `ValidationInputInvariantError` and
 * `CompilerRetiredError`, both of which denote plugin bugs.
 *
 * ── The ladder, which is this module's shape ─────────────────────────────────
 *
 * Validation compiles **lazily**. Steps 1–2 are a gate — *locate* a build record
 * for the target, then *content-verify* it — and steps 3–5 are the gate's
 * outcomes. Four paths, and the compile is one arm rather than the trunk:
 *
 * | path | reached when | compiles | `fidelity` |
 * |---|---|---|---|
 * | fresh      | a record was located and verified                  | **0** | `declaration-order-only` |
 * | stale      | records were located, every candidate rejected     | 1     | `slot-level` |
 * | absent     | no record for this pair                            | 1     | `slot-level` |
 * | escalated  | **from fresh only**, on a non-empty AST-only report | 1     | `slot-level` |
 *
 * **Escalation is caller-driven, and it must be**: the report the escalation
 * turns on compares the new layout against the *deployed* implementation's, which
 * this sub-feature never sees. So the caller re-asks with the input it already
 * holds ({@link ValidationInputRequest.escalateFrom}), and the single-fire
 * property is structural rather than a counter — escalation accepts only an input
 * whose basis is `'build-record-ast'`, and what it returns is a
 * `'plugin-compile'` input, so a second escalation of the same chain is a type
 * the entry point refuses.
 *
 * **Reduced fidelity on the fresh path is not a degradation to apologise for, and
 * the pipeline does not pretend otherwise.** Reconstructing the layout from the
 * AST makes the engine *stricter*, not blinder: appends are structurally exempt,
 * and reordering, renames, retypes and deletions are all still detected. Exactly
 * two shapes need positions — a `__gap` consumption and intra-slot repacking —
 * and those are what escalation exists for. It is still *stated* rather than
 * silent, because a refusal the user cannot distinguish from an observed
 * incompatibility is the failure this plugin is not allowed to ship.
 */

/** ─── What consumers receive ─────────────────────────────────────────────── */

export interface ValidationInput {
  /**
   * The reconstructed solc standard-JSON input.
   *
   * Reconstructed from the contracts directory on **every** path, including the
   * fresh one, and that is deliberate: the consumer's engine reads
   * `sources[key].content` for its own namespace-annotation version check and
   * would throw on a key the output carries and the input does not. Its
   * `settings.outputSelection` describes what this plugin asks for when it
   * compiles; on the fresh path nothing was compiled from it, and
   * {@link InputProvenance.basis} is what says so.
   */
  readonly solcInput: SolcStandardInput;
  /** Either the host's own build record, projected, or this plugin's compile. */
  readonly solcOutput: SolcStandardOutput;
  /** LONG form, e.g. `0.8.26+commit.733b4d28.Emscripten.clang`. */
  readonly solcVersion: string;
  /**
   * Never optional. **Its value is a function of the step that produced the
   * input, and the return boundary asserts the biconditional**: the fresh path
   * reports `declaration-order-only` with a non-empty `missingFor`, the three
   * compiling paths report `slot-level`. An unconditional `slot-level` assertion
   * — which this pipeline once carried — raises on the ordinary path; a
   * `declaration-order-only` claim on a compiled input understates what was
   * measured and would refuse shapes it could have decided.
   */
  readonly fidelity: LayoutFidelity;
  readonly provenance: InputProvenance;
}

/** Why the gate sent this call down the path it took. */
export type BuildRecordGate =
  | {
      readonly kind: 'fresh';
      /** The file whose bytecode verified — and whose ASTs were consumed. */
      readonly file: string;
      /**
       * How many candidates were examined, this one included. Candidates after
       * the one that verified are never read, so this is a count of work done
       * rather than of records held.
       */
      readonly candidates: number;
    }
  | {
      readonly kind: 'stale';
      /** Every located candidate, with the reason it could not be used. */
      readonly rejected: readonly BuildRecordRejection[];
    }
  | {
      readonly kind: 'absent';
      readonly because:
        | 'directory-absent'
        | 'directory-unreadable'
        | 'no-record-for-target';
    };

export interface BuildRecordRejection {
  readonly file: string;
  readonly reason:
    | 'deployed-bytecode-differs'
    | 'nothing-to-compare'
    | 'ast-closure-incomplete'
    | 'target-definition-absent';
}

/**
 * Where `solcOutput` came from — the one field that tells the four paths apart.
 *
 * A closed union rather than a set of optional fields, so *"which compiler ran"*
 * and *"which record verified"* cannot both be absent or both be present. On the
 * fresh path no compiler is located, loaded or read: there is no
 * {@link CompilerIdentity} to record, and the long version is the artifact's own
 * — the build record that verified against it was produced by that compiler, by
 * content.
 */
export type InputBasis =
  | {
      readonly kind: 'build-record-ast';
      readonly gate: Extract<BuildRecordGate, { kind: 'fresh' }>;
      /** `ArtifactRecord.longCompilerVersion`, verified by the bytecode match. */
      readonly compilerLongVersion: string;
    }
  | {
      readonly kind: 'plugin-compile';
      readonly reason: CompileReason;
      /**
       * The gate result that sent this call to the compiler. On an escalation it
       * is the `fresh` gate of the input being escalated — which is the record of
       * *escalated from a verified record*, and the reason no separate flag is
       * needed to read the path off a produced input.
       */
      readonly gate: BuildRecordGate;
      readonly compiler: CompilerIdentity;
      /** Both identities, so a metadata-only difference is reportable. */
      readonly identity: ArtifactIdentityComparison;
    };

export type CompileReason =
  | 'build-record-stale'
  | 'build-record-absent'
  | 'ast-only-escalation';

/**
 * The basis vocabulary is shared with the fidelity detector on purpose, and this
 * pin is what keeps it shared.
 *
 * Both instruments in `layout-fidelity.ts` take a {@link LayoutBasis}, and the
 * question they answer is *this* union's question — where the output came from.
 * Two spellings of one distinction is how the permissive mislabel got in the
 * first time: one place decided "we compiled it" and another read "the key is
 * present". Renaming either member now fails to compile instead.
 */
type AssertAssignable<Narrow extends Wide, Wide> = Narrow;
type _BasisVocabularyIsShared = AssertAssignable<
  InputBasis['kind'],
  LayoutBasis
>;

export interface InputProvenance {
  /**
   * `solcInput`'s origin, which is the contracts directory on every path. It is
   * `solcOutput`'s origin that varies, and {@link basis} carries it.
   */
  readonly reconstructedFrom: 'contracts-directory';
  readonly basis: InputBasis;
  readonly partition: PartitionRecord;
  /** Every source key in the input, in the input's own order. The audit trail. */
  readonly sourceKeys: readonly string[];
}

/** No throw on a refusal — it is a value the caller can carry. */
export type ValidationInputOutcome =
  | { readonly kind: 'input'; readonly input: ValidationInput }
  | {
      readonly kind: 'refused';
      readonly cause: Cause;
      readonly diagnosis: Diagnosis;
    };

/** ─── What the caller supplies ───────────────────────────────────────────── */

/**
 * Exactly what SF-2 needs from the environment seam, and no more.
 *
 * **`buildInfoDirectory` is picked, and that reverses an earlier decision rather
 * than relaxing one.** The earlier shape left it out so that reading a build
 * record was a *compile error*, on the grounds that a record can never supply a
 * storage layout — the host's `outputSelection` requests `'': ['ast']` and ten
 * contract-level outputs, and `storageLayout` is not among them. That
 * measurement is unchanged and is exactly why the fresh path is AST-only. What it
 * does not support is the conclusion that a record is therefore useless: the AST
 * is what the engine reconstructs a layout from, and a record whose deployed
 * bytecode matches the artifact is evidence about *content*, not provenance —
 * which is the one question the four mis-pairing hazards left undecidable.
 *
 * **`contractsBuildDirectory` is still not picked.** Every artifact fact SF-2
 * needs — both bytecodes, the source, the source path, the long compiler version
 * — arrives off `ArtifactAccess.record`, with no filesystem access at all.
 * Declaring it would be a dependency claim with no reader behind it.
 *
 * **`output` is the operation's own `OutputChannel`.** A reduced-fidelity note
 * has to *ride the operation's result*, and a result's notes are exactly one
 * channel's `recorded`. A channel SF-2 minted for itself would be a second
 * channel whose records reach no result — the note written and then lost.
 */
export interface ValidationInputEnvironment {
  readonly paths: Pick<
    ProjectPaths,
    'contractsDirectory' | 'buildInfoDirectory' | 'root'
  >;
  readonly artifacts: Pick<ArtifactAccess, 'resolve' | 'record'>;
  readonly compiler: CompilerConfiguration;
  readonly output: Pick<OutputChannel, 'note' | 'degraded'>;
}

/**
 * The wasm, the filesystem and nothing else.
 *
 * **There is no `policy` member and there must not be**: an injectable table
 * restores per-call-site variation through the back door. The flip test
 * substitutes `policy.ts` at its module boundary in a fixture, which is a test
 * affordance and not an API.
 *
 * There is no writer either: SF-2 persists nothing, so the injected surface has
 * no write capability to misuse. Production defaults are resolved **inside** the
 * call rather than captured at module scope, which is what lets the nine
 * non-compiler causes — and now the whole fresh path — be exercised with no
 * `~/.tronbox` populated.
 */
export interface ValidationInputDependencies {
  readonly loadCompiler?: (soljsonPath: string) => CompilerHandle;
  readonly readSource?: (candidate: string) => string;
  readonly exists?: (candidate: string) => boolean;
  /**
   * The build-record reader, which is the seam's own — one directory listing plus
   * at most one read-and-parse per `*.output.json` entry, and the paired
   * compiler-*input* file never read. Injected for the same reason as `exists`:
   * the three-way `absent` / `unreadable` / `files` result has to be drivable
   * without arranging a corrupt build tree on a real disk.
   */
  readonly readBuildInfo?: BuildInfoReader['read'];
  /**
   * The machine's home directory, under which TronBox caches compilers.
   *
   * On this surface rather than inside `compiler.ts` because the seam that owns
   * the `~/.tronbox` convention cannot read it — it imports no ambient module and
   * is a function of its arguments alone — and `compiler.ts` must not read it
   * either, or the module that constructs a `createRequire` resolver would also be
   * the module that decides where it points.
   */
  readonly homeDirectory?: () => string;
}

export interface ValidationInputRequest {
  /** Artifact name as the user named it; the seam's resolver owns the ambiguity. */
  readonly contract: string;
  readonly env: ValidationInputEnvironment;
  readonly deps?: ValidationInputDependencies;
  /**
   * The AST-only input whose report came back non-empty — the escalation seam.
   *
   * **Escalation fires on ANY non-empty report, and there is no predicate.** The
   * obvious gate — escalate only where every flagged operation is explicable by
   * missing positions — was specified and then *measured unimplementable*
   * (`evidence/probe-p4-gate-observability.js`). Two findings killed it. On the
   * decisive pair, a truly safe intra-slot padding change and a genuine
   * mid-layout insert produce reports identical in every field a gate could key
   * on — one `insert` op each, the same `originalLabel: null`, the same absent
   * positions, the same `changeUncertain: null`; **the only difference is the
   * name of the inserted variable**, and no gate may be built on a user-chosen
   * identifier. And the position half of the predicate is a *tautology* in the
   * mode it was written for: `dist/storage/compare.js:storageFieldBegin` returns
   * `undefined` whenever `slot` or `offset` is undefined, and AST-only output
   * carries neither, so it scored true on all six probe rows including all four
   * genuine rejects.
   *
   * What that costs is one compile before refusing a genuine incompatibility.
   * What it buys is that an escalation only ever happens where the alternative
   * was refusing — so the extra compile buys a possible accept on a path that
   * otherwise ends in a rejection the user has to debug, and where the refusal
   * stands it can name the number to change.
   */
  readonly escalateFrom?: ValidationInput;
}

/** ─── The refusal / leniency boundary ────────────────────────────────────── */

/**
 * How a caught throw out of `compile` is classified, without quoting it.
 *
 * Detected by `name` rather than `instanceof WebAssembly.RuntimeError` for one
 * reason worth stating: the `WebAssembly` global's typing depends on which `lib`
 * the consuming project compiles with, and a validation failing to recognise the
 * compiler's own ceiling because of a `lib` setting would be absurd. Emscripten's
 * `RuntimeError` carries `name === 'RuntimeError'` either way, which is what
 * `evidence/probe-wasm-memory-ceiling.js` captured verbatim as
 * `RuntimeError: memory access out of bounds`.
 *
 * Anything that is **not** a wasm abort is re-raised: a timeout is a different
 * event from an OOM and would be a *new* cause, never a widening of cause 8.
 */
const CEILING_MESSAGE = 'memory access out of bounds';

function classifyWasmAbort(thrown: unknown): WasmAbort | null {
  if (!(thrown instanceof Error) || thrown.name !== 'RuntimeError') {
    return null;
  }
  return thrown.message.includes(CEILING_MESSAGE)
    ? 'memory-access-out-of-bounds'
    : 'other-wasm-abort';
}

/** Builds the reduced-fidelity input a `proceed-reduced` disposition needs. */
type ReducedInputFactory = (mode: ReducedMode) => ValidationInput;

/**
 * **The single `policy` call site.** Diagnosis first, disposition second — always
 * in that order, so the message is produced unconditionally and a flip provably
 * cannot change it.
 *
 * `proceedWith` is `null` for every cause discovered before there is a compiled
 * output, and a `proceed-reduced` row on such a cause raises rather than silently
 * refusing. That is deliberate: there is nothing to proceed *with*, and a flip
 * that cannot be honoured has to fail at the moment it is made rather than look
 * like it worked.
 */
function dispose(
  cause: Cause,
  channel: Pick<OutputChannel, 'degraded'>,
  proceedWith: ReducedInputFactory | null,
): ValidationInputOutcome {
  const diagnosis = diagnose(cause);
  const disposition = policy(cause);

  if (disposition.kind === 'refuse') {
    return { kind: 'refused', cause: disposition.cause, diagnosis };
  }

  if (proceedWith === null) {
    throw new ValidationInputInvariantError(
      `the policy table says "proceed-reduced" for the cause "${cause.kind}", ` +
        `which is decided before the compiler produces any output — so there is ` +
        `no layout to proceed with. A cause that can be treated leniently has to ` +
        `be one that arises after a successful compile.`,
    );
  }

  channel.degraded({
    code: 'storage-layout-unavailable',
    summary: diagnosis.headline,
    detail: [
      'Upgrade-safety validation is continuing with declaration-order-only ' +
        'storage information, which cannot tell a `__gap` consumption or an ' +
        'intra-slot repacking from an unsafe change.',
    ],
    remedy: diagnosis.remedy,
  });

  return { kind: 'input', input: proceedWith(disposition.mode) };
}

/** ─── Assertions on the return boundary ─────────────────────────────────── */

/**
 * Everything asserted about a produced input, in one place, on the way out.
 *
 * Two families. The first is the audit trail: an empty or mis-keyed closure
 * produces an output with no contracts, nothing detects a missing layout, and the
 * measured vacuous pass fires — `getStorageUpgradeErrors(EMPTY, real)` returns no
 * errors, so every variable in the new contract is classified as a safe append.
 *
 * The second is **the fidelity biconditional**, which is the assertion this
 * pipeline used to get backwards. It is not *"fidelity is `slot-level`"*: it is
 * *"the fidelity reported equals the fidelity the producing step can deliver"*.
 * A `slot-level` claim on an AST-only input is the permissive mislabel the
 * fidelity detector exists to catch; a `declaration-order-only` claim on a
 * compiled input understates what was measured. The one licensed exception is a
 * policy-chosen reduction — the leniency flip — which is why `reducedByPolicy`
 * is a parameter rather than something inferred from the value.
 */
function assertInput(input: ValidationInput, reducedByPolicy: boolean): void {
  const { provenance, fidelity } = input;
  const inputKeys = Object.keys(input.solcInput.sources);

  if (provenance.sourceKeys.length === 0) {
    throw new ValidationInputInvariantError(
      'a validation input was produced with no source keys.',
    );
  }
  if (
    provenance.sourceKeys.length !== inputKeys.length ||
    provenance.sourceKeys.some((key, index) => key !== inputKeys[index])
  ) {
    throw new ValidationInputInvariantError(
      `the recorded source keys are not the input's own key set in the input's ` +
        `own order: ${provenance.sourceKeys.length} recorded against ` +
        `${inputKeys.length} in the input.`,
    );
  }
  if (!provenance.partition.closure.includes(provenance.partition.target)) {
    throw new ValidationInputInvariantError(
      `the partition's closure does not contain its own target ` +
        `"${provenance.partition.target}".`,
    );
  }
  if (input.solcVersion === '') {
    throw new ValidationInputInvariantError(
      'a validation input was produced with an empty compiler version.',
    );
  }

  const basis = provenance.basis;
  if (basis.kind === 'build-record-ast') {
    if (fidelity.kind !== 'declaration-order-only') {
      throw new ValidationInputInvariantError(
        `a validation input assembled from the host's build record reports ` +
          `"${fidelity.kind}" fidelity. No build record carries storage ` +
          `positions — TronBox does not request them — so this claims a ` +
          `fidelity the input cannot have.`,
      );
    }
    if (fidelity.missingFor.length === 0) {
      throw new ValidationInputInvariantError(
        'a validation input assembled from the host\'s build record reports ' +
          'reduced fidelity for no contract at all, so its output carries no ' +
          'contracts and the reference layout would be empty.',
      );
    }
    return;
  }

  if (!basis.identity.withoutMetadataMatches) {
    throw new ValidationInputInvariantError(
      `a validation input was produced for an artifact whose identity does not ` +
        `match the recompile; that outcome should have been cause 7.`,
    );
  }
  if (fidelity.kind !== 'slot-level' && !reducedByPolicy) {
    throw new ValidationInputInvariantError(
      `a compiled validation input reports "${fidelity.kind}" fidelity for ` +
        `${fidelity.missingFor.length} contract(s), inside a supported compiler ` +
        `range where every build emits positions. The policy table did not ask ` +
        `for a reduction, so this is a plugin bug rather than a degradation.`,
    );
  }
}

/** ─── Artifact resolution ────────────────────────────────────────────────── */

/**
 * Resolves the artifact, or hands the decision back to whoever owns it.
 *
 * `resolve` reports three statuses and only one of them is SF-2's:
 *
 * - **`unique`** — proceed.
 * - **`ambiguous`** — *policy for this branch is the operation's*, stated in the
 *   seam itself, and the operation is expected to decide before calling here.
 *   When it has not, SF-2 fails closed by raising the seam's **own** diagnosis
 *   rather than validating one of N same-named contracts: picking silently is the
 *   mis-pairing class this whole sub-feature exists to remove, and
 *   `ArtifactNameAmbiguousError` renders the candidates itself, so no sentence is
 *   hand-written here.
 * - **`indeterminate`** — the build-info index could not be built, so *collisions
 *   could not be checked*; the abstraction still came from the host's own
 *   resolver for that name. The operation owns the statement for it
 *   (`'artifact-name-indeterminate'`) and SF-2 must not invent a second
 *   rendering, so it proceeds on the abstraction and says nothing.
 */
function artifactAbstraction(
  env: ValidationInputEnvironment,
  contract: string,
): { readonly name: string; readonly contract: ContractAbstraction } {
  const resolution = env.artifacts.resolve(contract);
  if (resolution.status === 'unique') {
    return { name: resolution.name, contract: resolution.contract };
  }
  if (resolution.status === 'indeterminate') {
    return { name: resolution.name, contract: resolution.unverifiedContract };
  }
  throw new ArtifactNameAmbiguousError(resolution.name, resolution.candidates);
}

/** ─── Steps 1 and 2: the gate ────────────────────────────────────────────── */

/**
 * The shapes the gate reads out of a build record, declared structurally.
 *
 * The reader hands `output` back as `unknown` on purpose — it is raw solc
 * standard-JSON off a file this plugin did not write — so every field is narrowed
 * here rather than assumed. `linkReferences` is typed with mutable arrays because
 * it is handed to upstream's own `extractLinkReferences`, whose parameter is.
 */
interface RecordLinkOffset {
  readonly start: number;
  readonly length: number;
}

interface RecordBytecode {
  readonly object: string;
  readonly linkReferences: Record<string, Record<string, RecordLinkOffset[]>>;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asBytecode(value: unknown): RecordBytecode | undefined {
  const holder = asObject(value);
  if (holder === undefined || typeof holder.object !== 'string') {
    return undefined;
  }
  const linkReferences = asObject(holder.linkReferences) ?? {};
  return {
    object: holder.object,
    linkReferences: linkReferences as Record<
      string,
      Record<string, RecordLinkOffset[]>
    >,
  };
}

/** One build record narrowed to the two maps the gate reads. */
interface RecordMaps {
  readonly contracts: Record<string, unknown>;
  readonly sources: Record<string, unknown>;
}

function recordMaps(output: unknown): RecordMaps | undefined {
  const top = asObject(output);
  const contracts = asObject(top?.contracts);
  const sources = asObject(top?.sources);
  return contracts === undefined || sources === undefined
    ? undefined
    : { contracts, sources };
}

/**
 * The projected output: the target's own closure, and nothing else.
 *
 * **Projection is not tidiness, it is a requirement of the consumer.** The engine
 * iterates `solcOutput.contracts` and reads `solcInput.sources[source].content`
 * for each source it finds, so a record covering sources outside this target's
 * closure — the whole-project compile, which is the common case — would send the
 * consumer looking for input entries the reconstructed input does not have. The
 * closure is the same set the compile path hands solc, so the two paths produce
 * the same key space.
 *
 * **It is also where the one assumption the fresh path rests on gets checked at
 * runtime instead of trusted.** A record's `sources` list can be a *subset* of
 * the project — measured, two entries after touching one of seven — and the
 * reasoning that a contract present in `contracts` must have its whole import
 * closure in the same file (solc cannot emit bytecode for a source whose imports
 * are absent) is sound but not something to bet a silent vacuous pass on. Any
 * closure key whose AST is missing rejects the candidate, and the caller compiles.
 */
function projectBuildRecord(
  maps: RecordMaps,
  closure: readonly string[],
): SolcStandardOutput | undefined {
  const sources: Record<string, unknown> = {};
  const contracts: Record<string, unknown> = {};

  for (const key of closure) {
    const source = asObject(maps.sources[key]);
    if (source === undefined || asObject(source.ast) === undefined) {
      return undefined;
    }
    sources[key] = source;
    const contractsForKey = asObject(maps.contracts[key]);
    if (contractsForKey !== undefined) {
      contracts[key] = contractsForKey;
    }
  }

  // One cast, from `unknown`, at the boundary where JSON becomes a typed record —
  // the same idiom the compiler wrapper uses on solc's own answer. Everything the
  // cast asserts has been checked immediately above, except the AST's interior,
  // which is the engine's subject and not this module's.
  const projected: unknown = { contracts, sources };
  return projected as SolcStandardOutput;
}

interface GateRequest {
  readonly readBuildInfo: BuildInfoReader['read'];
  readonly buildInfoDirectory: ProjectPaths['buildInfoDirectory'];
  /** The host's own OS-independent source key for the target. */
  readonly targetKey: string;
  readonly contractName: string;
  readonly artifactDeployedBytecode: string;
  readonly closure: readonly string[];
}

/**
 * The gate's own two-way answer, discriminated at the top level so the caller's
 * branch narrows the projected output with it: a `fresh` gate without the output
 * it verified — or an output without the gate that verified it — is not
 * representable, which is the object-identity half of *"the file that verifies is
 * the file consumed."*
 */
type GateResult =
  | {
      readonly kind: 'fresh';
      readonly gate: Extract<BuildRecordGate, { kind: 'fresh' }>;
      readonly output: SolcStandardOutput;
      /**
       * The verified record's own `evm.bytecode`, carried out so the fresh path
       * can decide cause 10 from the same object that verified. Absent only if
       * the host's record omitted the field, which no supported version does.
       */
      readonly creationBytecode: RecordBytecode | undefined;
    }
  | {
      readonly kind: 'fallback';
      readonly gate: Exclude<BuildRecordGate, { kind: 'fresh' }>;
    };

/**
 * Steps 1 and 2: locate a record for this pair, then content-verify it.
 *
 * **Any one candidate that verifies is sufficient**, which is what dissolves the
 * accumulated-directory problem: the directory is never pruned, so a name
 * routinely has N candidates from N moments and no `current` exists — but a
 * record whose deployed bytecode matches the artifact describes these exact
 * compiled bytes whatever its age or provenance. Candidates are taken in path
 * order so that a two-candidate tie is reproducible.
 *
 * **The file that verifies is the file consumed.** Verifying record A and then
 * reading ASTs from record B would reintroduce the mis-pairing this check exists
 * to remove, so verification and projection happen against the same object and
 * the result carries its file name.
 */
function consultBuildRecord(request: GateRequest): GateResult {
  let result;
  try {
    result = request.readBuildInfo(request.buildInfoDirectory);
  } catch {
    // A reader that raises is the same situation as one that reports the
    // directory unreadable: no record can be consulted, so the caller compiles.
    return {
      kind: 'fallback',
      gate: { kind: 'absent', because: 'directory-unreadable' },
    };
  }

  if (result.status === 'absent') {
    return {
      kind: 'fallback',
      gate: { kind: 'absent', because: 'directory-absent' },
    };
  }
  if (result.status === 'unreadable') {
    return {
      kind: 'fallback',
      gate: { kind: 'absent', because: 'directory-unreadable' },
    };
  }

  const files: readonly BuildInfoFile[] = [...result.files].sort((left, right) =>
    left.file.localeCompare(right.file),
  );

  const rejected: BuildRecordRejection[] = [];
  for (const file of files) {
    const maps = recordMaps(file.output);
    if (maps === undefined) {
      continue;
    }
    const entry = asObject(asObject(maps.contracts[request.targetKey])?.[
      request.contractName
    ]);
    if (entry === undefined) {
      // Located nothing for this pair in this file. Not a rejection: a record of
      // some other compile is not a stale record of this one.
      continue;
    }

    const deployed = asBytecode(asObject(entry.evm)?.deployedBytecode);
    if (deployed === undefined) {
      rejected.push({ file: file.file, reason: 'nothing-to-compare' });
      continue;
    }

    const freshness = verifyBuildRecordFreshness({
      buildRecordDeployed: deployed,
      artifactDeployedBytecode: request.artifactDeployedBytecode,
    });
    if (!freshness.ok) {
      rejected.push({ file: file.file, reason: freshness.reason });
      continue;
    }

    const output = projectBuildRecord(maps, request.closure);
    if (output === undefined) {
      rejected.push({ file: file.file, reason: 'ast-closure-incomplete' });
      continue;
    }
    if (
      isLayoutVacuous(
        output,
        request.targetKey,
        request.contractName,
        'build-record-ast',
      )
    ) {
      // The bytecode verified and the closure's ASTs are all present, but this
      // record's AST for the target source declares no such contract — so the
      // layout the engine reconstructs would be empty against a contract that is
      // not. A record to stop using, not a bug to report.
      rejected.push({ file: file.file, reason: 'target-definition-absent' });
      continue;
    }

    return {
      kind: 'fresh',
      gate: {
        kind: 'fresh',
        file: file.file,
        candidates: rejected.length + 1,
      },
      output,
      creationBytecode: asBytecode(asObject(entry.evm)?.bytecode),
    };
  }

  return rejected.length === 0
    ? {
        kind: 'fallback',
        gate: { kind: 'absent', because: 'no-record-for-target' },
      }
    : {
        kind: 'fallback',
        gate: { kind: 'stale', rejected: Object.freeze(rejected) },
      };
}

/** ─── The compile step ───────────────────────────────────────────────────── */

type CompileOutcome =
  | { readonly ok: true; readonly output: SolcStandardOutput }
  | { readonly ok: false; readonly cause: Cause };

/**
 * One partition, one invocation — and **no retry, no split, no fallback**. One
 * contract's closure is the smallest input this plugin can offer, so the ceiling
 * is terminal; a retry would meet a poisoned handle and report a plugin bug where
 * the user needs an actionable refusal.
 *
 * **The memo is call-scoped and amortises nothing.** It holds at most one entry,
 * because one call derives one contract, and it is created inside the call, so it
 * cannot hit across calls — any statement that it amortises the compile is false,
 * and under the ladder it is more false than it was: three paths in four compile
 * at most once and the fourth does not compile at all. It ships because it is the
 * seam a union-first partition would need and because it is directly testable at
 * the partition module's own boundary, not because it saves anything today.
 */
function compilePartition(
  handle: CompilerHandle,
  memo: CompileMemo,
  identityKey: string,
  input: SolcStandardInput,
  record: PartitionRecord,
): CompileOutcome {
  const memoized = memo.get(identityKey);
  if (memoized !== undefined) {
    return { ok: true, output: memoized };
  }
  try {
    const output = handle.compile(input);
    memo.set(identityKey, output);
    return { ok: true, output };
  } catch (thrown) {
    const raised = classifyWasmAbort(thrown);
    if (raised === null) {
      // Not the compiler's own ceiling. The handle has already retired itself,
      // and this is not one of the eleven, so it is not dressed as one.
      throw thrown;
    }
    return {
      ok: false,
      cause: {
        kind: 'compiler-resource-exhausted',
        target: record.target,
        closureSize: record.closure.length,
        raised,
      },
    };
  }
}

/** ─── The two arms ───────────────────────────────────────────────────────── */

/** Everything both arms need, assembled once before the gate is consulted. */
interface ArmContext {
  readonly name: string;
  readonly record: ArtifactRecord;
  readonly env: ValidationInputEnvironment;
  readonly partition: Partition;
  readonly solcInput: SolcStandardInput;
  readonly channel: Pick<OutputChannel, 'note' | 'degraded'>;
}

interface FinishRequest {
  readonly context: ArmContext;
  readonly solcOutput: SolcStandardOutput;
  readonly solcVersion: string;
  readonly fidelity: LayoutFidelity;
  readonly basis: InputBasis;
  readonly reducedByPolicy: boolean;
}

function finishInput(request: FinishRequest): ValidationInput {
  const { context } = request;
  const input: ValidationInput = Object.freeze({
    solcInput: context.solcInput,
    solcOutput: request.solcOutput,
    solcVersion: request.solcVersion,
    fidelity: request.fidelity,
    provenance: Object.freeze({
      reconstructedFrom: 'contracts-directory' as const,
      basis: Object.freeze(request.basis),
      partition: context.partition.record,
      sourceKeys: context.partition.record.closure,
    }),
  });
  assertInput(input, request.reducedByPolicy);
  return input;
}

/**
 * The namespaced shortfall, stated on **every** path because it is present on
 * every path.
 *
 * A namespace's members get no `slot` and no `offset` unless the sources are
 * compiled a second time with a storage variable injected for each namespaced
 * struct, which this version does not do — so they are position-less whether the
 * flat layout came from a build record or from this plugin's own compile. And
 * upstream's only slot-absence branch reads the flat `storage` list, which for a
 * contract whose storage lives entirely in namespaces is **empty**, so the branch
 * never fires while every namespace member lacks positions. Every OZ 5.x contract
 * is in that state.
 *
 * What the note means — bounded by the upstream maintainer's ruling (2026-08-04):
 * this is a fidelity statement, not a safety patch. A real change to a namespaced
 * struct still surfaces as a name or type change and is refused, so the class an
 * upstream slot-absence notice would have guarded here is empty; the divergence
 * direction without positions is over-rejection, never silent acceptance. The
 * note is recorded because a reduced-fidelity comparison must be stated (SC-003)
 * — a caller reading `namespaced-ast-only` learns how much the comparison could
 * see, not that it was unsafe.
 */
function stateNamespaceShortfall(
  context: ArmContext,
  output: SolcStandardOutput,
): void {
  const namespaces = declaresNamespacedStorage(
    output,
    context.partition.record.target,
    context.name,
  );
  if (namespaces.length === 0) {
    return;
  }
  context.channel.degraded({
    code: 'namespaced-ast-only',
    summary:
      `${context.name}: namespaced storage (${namespaces.join(', ')}) is ` +
      `compared by name and declaration order, not by slot position.`,
    detail: [
      'Slot positions for namespaced members require a second compilation of ' +
        'the same sources with a storage variable injected for each namespaced ' +
        'struct. This version does not perform it, in either validation mode.',
      'The validation engine reports nothing here on its own: its ' +
        'reduced-information check reads only the flat storage list, and for a ' +
        'contract whose storage lives entirely in namespaces that list is empty.',
    ],
    remedy:
      'Add new members at the end of each namespaced struct and leave reserved ' +
      'padding in place. Renames, retypes, reorders and deletions inside a ' +
      'namespace are still refused; a change that needs slot positions is ' +
      'refused rather than silently accepted.',
  });
}

/**
 * Step 3 — the fresh path. **Zero compiles**, and no compiler is located, loaded
 * or version-compared.
 *
 * **Exactly two causes are unreachable from here, and both for a reason rather
 * than by omission.** Cause 1, a *missing* compiler, cannot refuse a validation
 * whose layouts come from the host's own record — which is what makes validation
 * work under the tool's own test command, where the artifact tree is a fresh
 * temporary copy and no compile has run. Cause 3, a compiler-versus-artifact
 * *mismatch*, is decided here by content instead: the record's deployed bytecode
 * matched the artifact's, which is stronger evidence than two version strings
 * agreeing. **Every other cause the path can reach, it does reach** — the range
 * gate ahead of it, the source-resolution causes ahead of it, and cause 10 below.
 */
function freshArm(
  context: ArmContext,
  gate: Extract<BuildRecordGate, { kind: 'fresh' }>,
  output: SolcStandardOutput,
  creationBytecode: RecordBytecode | undefined,
): ValidationInputOutcome {
  if (creationBytecode !== undefined) {
    /**
     * **Cause 10 is decided on this path too, and it has to be.** A library name
     * past the band corrupts the *artifact's* bytecode — measured through the
     * host with a 45-character name, which produced an artifact whose `bytecode`
     * had an odd hex digit count — and that is a property of the project, not of
     * which path validated it. This path never hashes the artifact, so the
     * failure would not surface here; it would surface later, in whatever reads
     * the implementation identity, as upstream's `Bytecode is not a valid hex
     * string`, which names neither the library nor the cause. The band is read
     * off the verified record's own link references, which the host requests.
     */
    const band = libraryNameBand(creationBytecode);
    if (band !== undefined) {
      return dispose(band, context.channel, null);
    }
  }

  const fidelity = detectFidelity(output, 'build-record-ast');

  context.channel.degraded({
    code: 'storage-layout-unavailable',
    summary:
      `${context.name}: upgrade-safety validation is comparing storage by ` +
      `declaration order, without slot positions.`,
    detail: [
      'TronBox does not ask the compiler for storage layouts, so the build ' +
        'record it wrote for this contract carries none and the layout is ' +
        'reconstructed from the contract source instead.',
      'A reconstructed layout is stricter, not blinder: renames, retypes, ' +
        'reordering and deletions are all still detected, and appending new ' +
        'variables is still safe. What it cannot decide is whether a change ' +
        'fits inside space a `__gap` array or intra-slot padding already ' +
        'reserved.',
    ],
    remedy:
      'No action needed: if the check reaches one of those two shapes, the ' +
      'plugin compiles this one contract itself and re-checks with slot ' +
      'positions before refusing anything.',
  });

  stateNamespaceShortfall(context, output);

  return {
    kind: 'input',
    input: finishInput({
      context,
      solcOutput: output,
      solcVersion: context.record.longCompilerVersion,
      fidelity,
      basis: {
        kind: 'build-record-ast',
        gate,
        compilerLongVersion: context.record.longCompilerVersion,
      },
      reducedByPolicy: false,
    }),
  };
}

interface CompileArmRequest {
  readonly context: ArmContext;
  readonly gate: BuildRecordGate;
  readonly reason: CompileReason;
  readonly exists: (candidate: string) => boolean;
  readonly load: (soljsonPath: AbsolutePath) => CompilerHandle;
  readonly homeDirectory: () => string;
}

/**
 * Steps 4 and 5 — the compiling paths, which are the same code reached for three
 * different reasons.
 *
 * Nothing here cares *why* it was reached: a stale record, no record, and an
 * escalated AST-only refusal all need the same single-contract compile with
 * `storageLayout` requested, and the reason is carried into the provenance rather
 * than branched on. That is the property that made the earlier always-compile
 * draft reusable instead of rewritable.
 */
function compileArm(request: CompileArmRequest): ValidationInputOutcome {
  const { context, gate, reason } = request;
  const { env, name, record, channel, solcInput, partition } = context;
  const target = partition.record.target;

  const opened = openCompiler({
    compiler: env.compiler,
    artifactLongVersion: record.longCompilerVersion,
    exists: request.exists,
    load: request.load,
    homeDirectory: request.homeDirectory,
  });
  if (!opened.ok) {
    return dispose(opened.cause, channel, null);
  }

  const compiled = compilePartition(
    opened.handle,
    createCompileMemo(),
    partitionIdentity(
      partition.record,
      env.compiler.settings,
      opened.identity.longVersion,
    ),
    solcInput,
    partition.record,
  );
  if (!compiled.ok) {
    return dispose(compiled.cause, channel, null);
  }
  const solcOutput = compiled.output;

  const errorCount = countErrorDiagnostics(solcOutput);
  if (errorCount > 0) {
    // Cause 11, never cause 7: a failed compile produces no artifact to compare,
    // so it cannot honestly reach the identity gate at all.
    return dispose(
      { kind: 'sources-do-not-compile', target, errorCount },
      channel,
      null,
    );
  }

  const contractOutput = solcOutput.contracts?.[target]?.[name];

  if (contractOutput !== undefined) {
    const band = libraryNameBand(contractOutput.evm.bytecode);
    if (band !== undefined) {
      // Before any identity work: past the band, upstream's own hashing throws
      // `Bytecode is not a valid hex string`, which names neither the library nor
      // the cause.
      return dispose(band, channel, null);
    }
  }

  const identity =
    contractOutput === undefined
      ? { comparison: absentFromRecompile() }
      : compareArtifactIdentity({
          recompiled: contractOutput.evm.bytecode,
          artifactBytecode: record.bytecode,
        });

  if (!identity.comparison.withoutMetadataMatches) {
    return dispose({ kind: 'artifact-stale', contract: name }, channel, null);
  }

  const basis: InputBasis = {
    kind: 'plugin-compile',
    reason,
    gate,
    compiler: opened.identity,
    identity: identity.comparison,
  };

  /**
   * Unconditionally, and one call site — above both the reduced path and the
   * ordinary one, so *every* produced input has had the detector run over it.
   * Calling it only where degradation is suspected would let the flip test pass
   * while production never ran the detector, and the day the table flips a
   * reduced input would ship reading `slot-level`.
   */
  const detected = detectFidelity(solcOutput, 'plugin-compile');

  const build = (
    fidelity: LayoutFidelity,
    reducedByPolicy: boolean,
  ): ValidationInput =>
    finishInput({
      context,
      solcOutput,
      solcVersion: opened.identity.longVersion,
      fidelity,
      basis,
      reducedByPolicy,
    });

  /**
   * What a `proceed-reduced` row would produce. Switching on the mode rather than
   * ignoring it means a second `ReducedMode` member becomes a compile error here
   * instead of silently taking this branch.
   */
  const reducedInput: ReducedInputFactory = mode => {
    switch (mode.kind) {
      case 'declaration-order-only':
        return build(
          detected.kind === 'declaration-order-only'
            ? detected
            : {
                kind: 'declaration-order-only',
                // Documented never-empty, so it names the contract whose layout
                // is the reason the flip was reached.
                missingFor: Object.freeze([`${target}:${name}`]),
              },
          true,
        );
    }
  };

  if (isLayoutVacuous(solcOutput, target, name, 'plugin-compile')) {
    const declaredStateVariables = countDeclaredStateVariables(
      solcOutput,
      target,
      name,
    );
    if (declaredStateVariables > 0) {
      // A cause and not an invariant throw, because letting an empty reference
      // layout through is a measured *silent accept*.
      return dispose(
        { kind: 'layout-vacuous', contract: name, declaredStateVariables },
        channel,
        reducedInput,
      );
    }
  }

  stateNamespaceShortfall(context, solcOutput);

  if (identity.comparison.metadataOnlyDifference === true) {
    // Recorded in provenance *and* stated. The durable record is the provenance
    // flag; the channel statement is the courtesy, which is why it is a note
    // rather than a degraded-mode entry — nothing about the validation is
    // reduced, only the metadata blob differs.
    channel.note(
      `${name}: the compiled code matches the artifact exactly, but the ` +
        `compiler metadata differs.`,
      [
        'Validation is proceeding: upgrade safety is decided from the code, and ' +
          'the code is identical.',
      ],
    );
  }

  return { kind: 'input', input: build(detected, false) };
}

/**
 * The range gate, applied on **every** path including the one that never loads a
 * compiler.
 *
 * The compiler-opening step applies the same predicate to the same value, and
 * that is not a duplicated decision: there is one range constant and one
 * predicate reading it, and this is the call that makes an out-of-range project
 * refuse *before* any work on the path where nothing is ever loaded. Declaring a
 * support range and then honouring it only when a compile happens to be needed
 * would make the range a property of the cache state rather than of the plugin.
 */
function rangeGate(compiler: CompilerConfiguration): Cause | undefined {
  if (isSupportedSolcVersion(compiler.resolvedVersion)) {
    return undefined;
  }
  return {
    kind: 'compiler-unsupported',
    resolvedVersion: compiler.resolvedVersion,
    // `exactOptionalPropertyTypes`: spread in only when the seam reported a
    // flag, so it is absent rather than `undefined` and a message branch cannot
    // render "via undefined".
    ...(compiler.viaLegacyFlag === undefined
      ? {}
      : { viaLegacyFlag: compiler.viaLegacyFlag }),
  };
}

/**
 * The escalation source, validated — and this is where P4 fires **once**.
 *
 * Two conditions, both raising rather than refusing, because a caller that gets
 * either wrong has a bug the user cannot act on. The basis must be
 * `'build-record-ast'`: escalation exists to replace a reconstructed layout with
 * a compiled one, and an input that already carries positions has nothing to
 * escalate to — which is exactly why a second escalation of the same chain
 * cannot happen, since this function's own product is a `'plugin-compile'` input.
 * And the input must be *this* contract's, or the compile would answer a question
 * about a different target.
 */
function escalationGate(
  escalateFrom: ValidationInput,
  target: string,
): Extract<BuildRecordGate, { kind: 'fresh' }> {
  const basis = escalateFrom.provenance.basis;
  if (basis.kind !== 'build-record-ast') {
    throw new ValidationInputInvariantError(
      `an escalation was requested from an input this plugin compiled itself ` +
        `(reason "${basis.reason}"). Escalation replaces a layout reconstructed ` +
        `from the host's build record with a compiled one, so an already ` +
        `compiled input has nothing to escalate to — and asking twice for the ` +
        `same target means the second answer was not being accepted.`,
    );
  }
  if (escalateFrom.provenance.partition.target !== target) {
    throw new ValidationInputInvariantError(
      `an escalation for "${target}" was requested from an input derived for ` +
        `"${escalateFrom.provenance.partition.target}".`,
    );
  }
  return basis.gate;
}

/** ─── The face's implementation ──────────────────────────────────────────── */

export async function deriveValidationInput(
  request: ValidationInputRequest,
): Promise<ValidationInputOutcome> {
  const { contract, env } = request;
  const deps = request.deps ?? {};
  const exists = deps.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const readSource =
    deps.readSource ??
    ((candidate: string) => fs.readFileSync(candidate, 'utf8'));
  const load = deps.loadCompiler ?? loadCompiler;
  const readBuildInfo = deps.readBuildInfo ?? fileSystemBuildInfoReader.read;
  // `os.homedir` passed as a reference rather than called here: the gate inside
  // `openCompiler` decides whether the machine is read at all, and on the fresh
  // path it is not read even once.
  const homeDirectory = deps.homeDirectory ?? (() => os.homedir());
  const channel = env.output;

  const resolved = artifactAbstraction(env, contract);
  const name = resolved.name;

  // Every artifact fact arrives through the seam's projection: reading
  // `contract._json` here would be a TronBox-internal property path outside the
  // seam, and the trust-boundary scan forbids it by name.
  const report = env.artifacts.record(resolved.contract);
  if (report.status === 'incomplete') {
    // The *first* missing field, in the seam's own declaration order, so the
    // message is deterministic. The seam documents `missing` as non-empty by
    // construction; a message this specific does not rest on a doc comment.
    const missingField: ArtifactRecordField | undefined = report.missing[0];
    if (missingField === undefined) {
      throw new ValidationInputInvariantError(
        `the seam reported artifact "${name}" incomplete with no missing field.`,
      );
    }
    return dispose(
      {
        kind: 'artifact-shape-unsupported',
        contract: name,
        missingField,
        providedSince: ARTIFACT_FIELDS_VERIFIED_SINCE,
      },
      channel,
      null,
    );
  }
  const record = report.record;

  const outOfRange = rangeGate(env.compiler);
  if (outOfRange !== undefined) {
    return dispose(outOfRange, channel, null);
  }

  /**
   * The closure is resolved on every path, before the gate, and that ordering is
   * the design rather than an accident.
   *
   * The fresh path needs it twice over — the input the consumer receives is
   * assembled from it, and it is the key set the build record is projected onto —
   * so there is no path that can skip it and no branch on whether to. It also
   * keeps the source-resolution causes ahead of every compiler cause, which is
   * the honest order once the compiler is optional: a project with an unreadable
   * import has that problem whether or not it also lacks a cached compiler.
   */
  const graph = resolveSourceGraph({
    targetPath: absoluteSourcePath(record.sourcePath, env.paths.root),
    targetLabel: name,
    contractsDirectory: env.paths.contractsDirectory,
    root: env.paths.root,
    readSource,
    exists,
  });
  if (!graph.ok) {
    return dispose(graph.cause, channel, null);
  }

  const partition = cutPartition(graph.targetKey, graph.sources);
  const solcInput = buildSolcInput(partition.sources, env.compiler);
  const context: ArmContext = {
    name,
    record,
    env,
    partition,
    solcInput,
    channel,
  };

  if (request.escalateFrom !== undefined) {
    return compileArm({
      context,
      gate: escalationGate(request.escalateFrom, partition.record.target),
      reason: 'ast-only-escalation',
      exists,
      load,
      homeDirectory,
    });
  }

  const consulted = consultBuildRecord({
    readBuildInfo,
    buildInfoDirectory: env.paths.buildInfoDirectory,
    targetKey: graph.targetKey,
    contractName: name,
    artifactDeployedBytecode: record.deployedBytecode,
    closure: partition.record.closure,
  });

  if (consulted.kind === 'fresh') {
    return freshArm(
      context,
      consulted.gate,
      consulted.output,
      consulted.creationBytecode,
    );
  }

  return compileArm({
    context,
    gate: consulted.gate,
    reason:
      consulted.gate.kind === 'stale'
        ? 'build-record-stale'
        : 'build-record-absent',
    exists,
    load,
    homeDirectory,
  });
}
