import fs from 'node:fs';

import {
  ArtifactNameAmbiguousError,
  fileSystemBuildInfoReader,
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
  type BuildRecordRejection,
  type Cause,
} from './causes';
import { isSupportedSolcVersion } from './compiler';
import { diagnose, type Diagnosis } from './diagnose';
import { ValidationInputInvariantError } from './errors';
import { resolveSourceGraph } from './import-graph';
import { libraryNameBand, verifyBuildRecordFreshness } from './identity';
import {
  declaresNamespacedStorage,
  detectFidelity,
  isLayoutVacuous,
  type LayoutFidelity,
} from './layout-fidelity';
import { cutPartition, type PartitionRecord } from './partition';
import { policy, type ReducedMode } from './policy';
import { absoluteSourcePath } from './source-key';
import type { SolcStandardInput, SolcStandardOutput } from './solc-input';

/**
 * The whole of the validation pipeline, and **the one place `policy.ts` is
 * imported and called**.
 *
 * A refusal is a value, never a throw. That is not stylistic: the pipeline has to
 * be *able* to carry a `proceed-reduced` disposition, and a thrown refusal cannot
 * become a proceed — catching it cannot manufacture the layouts a lenient path
 * would need to return. Returning a value is what makes the policy table the only
 * thing a leniency flip touches.
 *
 * The only thing this module throws is `ValidationInputInvariantError` (plus
 * the seam's own `ArtifactNameAmbiguousError`, when the candidates span more
 * than one source and the calling operation skipped deciding that collision
 * itself — same-source candidates are the pipeline's own decision, below,
 * and never reach a throw), and both denote plugin bugs rather than user
 * conditions.
 *
 * ── The Foundry model, which is this module's shape ──────────────────────────
 *
 * Validation **never compiles**. Steps 1–2 are a gate — *locate* a build record
 * for the target, then *content-verify* it — and step 3 is the gate's outcome.
 * Two paths, and neither one reaches a compiler:
 *
 * | path | reached when | outcome | `fidelity` |
 * |---|---|---|---|
 * | fresh          | a record was located, verified, and its paired input is usable | proceed, from the record | `declaration-order-only` |
 * | stale / absent | every candidate rejected, or no record for this pair | **refuse** (`build-record-stale` / `build-record-absent`), remedy `tronbox compile --all` | — |
 *
 * This is the review's superseding maintainer decision (2026-08-07): adopt the
 * Foundry model. The earlier design compiled the one contract itself on the
 * stale and absent paths and on an escalation from a non-empty AST-only
 * report; all three compiling arms are deleted, because the remedy the user
 * already has — `tronbox compile --all` — regenerates the record and the
 * artifact together, and the `--all` flag forces recompilation of unchanged
 * sources, so the remedy works for any compilable concrete contract — though
 * not for an abstract contract or interface, since recompilation cannot
 * manufacture deployed bytecode where none can exist.
 *
 * **Reduced fidelity on the fresh path is not a degradation to apologise for, and
 * the pipeline does not pretend otherwise.** Reconstructing the layout from the
 * AST makes the engine *stricter*, not blinder: appends are structurally exempt,
 * and reordering, renames, retypes and deletions are all still detected. Exactly
 * two shapes need positions — a `__gap` consumption and intra-slot repacking —
 * and both are refused conservatively rather than silently accepted. It is
 * still *stated* rather than silent, because a refusal the user cannot
 * distinguish from an observed incompatibility is the failure this plugin is
 * not allowed to ship. When TronBox can emit `storageLayout` into its build
 * records, the same record read carries the layouts — which is why
 * {@link detectFidelity} keeps running unconditionally on every produced input.
 */

/** ─── What consumers receive ─────────────────────────────────────────────── */

export interface ValidationInput {
  /**
   * The solc standard-JSON input, **verbatim from the paired `<hash>.json`
   * file TronBox wrote next to the verified build record** — the exact input
   * that produced `solcOutput`, narrowed and handed on untouched.
   *
   * Deliberately not reconstructed from the contracts directory: source text
   * on disk can drift from what was compiled while the deployed bytecode
   * still verifies, and a consumer decoding the output's AST spans against
   * drifted text reads the wrong characters (the ex-M2 wrong-span hazard).
   * The pair is the one input whose spans match this output by construction.
   */
  readonly solcInput: SolcStandardInput;
  /** The host's own build record, projected onto the target's closure. */
  readonly solcOutput: SolcStandardOutput;
  /** LONG form, e.g. `0.8.26+commit.733b4d28.Emscripten.clang`. */
  readonly solcVersion: string;
  /**
   * Never optional. **Its value is a function of the step that produced the
   * input, and the return boundary asserts it**: the fresh path — the only
   * producing step — reports `declaration-order-only` with a non-empty
   * `missingFor`, because no supported TronBox requests `storageLayout` in its
   * `outputSelection`. The detector still runs over the real output rather
   * than being assumed, so the day the host starts emitting layouts, the
   * boundary assertion is what fails first — loudly, at the moment the claim
   * changes.
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

/**
 * The per-candidate rejection vocabulary lives with the causes — it is
 * `build-record-stale`'s payload — and is re-exported here because the gate is
 * what constructs it and provenance consumers read it off this module's types.
 */
export type { BuildRecordRejection } from './causes';

/**
 * Where the produced input came from.
 *
 * A single-member union on purpose: the Foundry model has exactly one
 * producing step, and keeping the discriminant means a future second basis
 * (TronBox emitting `storageLayout`, say) is an added member rather than a
 * reshaping — a consumer switching on `kind` today is already total.
 *
 * On the fresh path no compiler is located, loaded or read: the long version
 * is the artifact's own — the build record that verified against it was
 * produced by that compiler, by content.
 */
export type InputBasis = {
  readonly kind: 'build-record-ast';
  readonly gate: Extract<BuildRecordGate, { kind: 'fresh' }>;
  /** `ArtifactRecord.longCompilerVersion`, verified by the bytecode match. */
  readonly compilerLongVersion: string;
  /** The paired `<hash>.json` file `solcInput` was read from. The audit trail. */
  readonly inputFile: string;
};

export interface InputProvenance {
  readonly basis: InputBasis;
  readonly partition: PartitionRecord;
  /**
   * Every source key in `solcInput`, in the input's own order — the paired
   * file's whole key set, which is a superset of `partition.closure` (the
   * record was the whole-project compile in the common case). The audit trail.
   */
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
 * Exactly what the validation pipeline needs from the environment seam, and no more.
 *
 * **`buildInfoDirectory` is the pipeline's whole subject.** The record read out
 * of it is content evidence — a record whose deployed bytecode matches the
 * artifact describes these exact compiled bytes whatever its age or
 * provenance — and its paired `<hash>.json` compiler input is what consumers
 * receive as `solcInput`.
 *
 * **`contractsBuildDirectory` is still not picked.** Every artifact fact the
 * validation pipeline needs — both bytecodes, the source, the source path, the
 * long compiler version — arrives off `ArtifactAccess.record`, with no
 * filesystem access at all. Declaring it would be a dependency claim with no
 * reader behind it.
 *
 * **`compiler` is read for one field**: `resolvedVersion`, which the range
 * gate checks against `SUPPORTED_SOLC` before any work. No compiler is ever
 * located or loaded; the range gates which solc *output* this plugin
 * interprets.
 *
 * **`output` is the operation's own `OutputChannel`.** A reduced-fidelity note
 * has to *ride the operation's result*, and a result's notes are exactly one
 * channel's `recorded`. A channel the validation pipeline minted for itself
 * would be a second channel whose records reach no result — the note written
 * and then lost.
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
 * The filesystem and nothing else.
 *
 * **There is no `policy` member and there must not be**: an injectable table
 * restores per-call-site variation through the back door. A test that needs a
 * different table substitutes `policy.ts` at its module boundary in a fixture,
 * which is a test affordance and not an API.
 *
 * There is no writer either: the validation pipeline persists nothing, so the
 * injected surface has no write capability to misuse. Production defaults are
 * resolved **inside** the call rather than captured at module scope, which is
 * what lets every path be exercised with nothing on a real disk.
 */
export interface ValidationInputDependencies {
  /** Read by the import walk that derives the target's closure and source key. */
  readonly readSource?: (candidate: string) => string;
  readonly exists?: (candidate: string) => boolean;
  /**
   * The build-record reader, which is the seam's own — one directory listing plus
   * at most one read-and-parse per `*.output.json` entry, plus an existence
   * probe and, when the pair is present, one read-and-parse of its paired
   * compiler-*input* file (see `environment/ambiguity.ts`'s `BuildInfoFile` for
   * the full contract, including why a pair that is missing, corrupt, or could
   * not be read is not an error there — it becomes a per-candidate rejection
   * here). Injected for the same
   * reason as `exists`: the three-way `absent` / `unreadable` / `files` result
   * has to be drivable without arranging a corrupt build tree on a real disk.
   */
  readonly readBuildInfo?: BuildInfoReader['read'];
}

export interface ValidationInputRequest {
  /** Artifact name as the user named it; the seam's resolver owns the ambiguity. */
  readonly contract: string;
  readonly env: ValidationInputEnvironment;
  readonly deps?: ValidationInputDependencies;
}

/** ─── The refusal / leniency boundary ────────────────────────────────────── */

/** Builds the reduced-fidelity input a `proceed-reduced` disposition needs. */
type ReducedInputFactory = (mode: ReducedMode) => ValidationInput;

/**
 * **The single `policy` call site.** Diagnosis first, disposition second — always
 * in that order, so the message is produced unconditionally and a flip provably
 * cannot change it.
 *
 * `proceedWith` is `null` for every cause the pipeline can currently raise,
 * because under the Foundry model every cause is decided *before* an input
 * exists — so a `proceed-reduced` row raises rather than silently refusing.
 * That is deliberate: there is nothing to proceed *with*, and a flip that
 * cannot be honoured has to fail at the moment it is made rather than look
 * like it worked. The parameter and the emission below are kept because they
 * are what makes a future flip a one-row change plus the input to honour it.
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
        `which is decided before any validation input exists — so there is ` +
        `no layout to proceed with. A cause that can be treated leniently has to ` +
        `be one that arises with a produced input in hand.`,
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
 * The closure-containment clause is the input-side half of the same trap: every
 * source the output was projected onto must be present in the input the
 * consumer will decode spans against.
 *
 * The second is **the fidelity claim**: the one producing step assembles from
 * the host's build record, no build record carries storage positions — TronBox
 * does not request them — so a `slot-level` claim here is the permissive
 * mislabel the fidelity detector exists to catch, and a `declaration-order-only`
 * claim naming no contract at all means the output carried none, which is the
 * vacuous pass wearing a fidelity label.
 */
function assertInput(input: ValidationInput): void {
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
  for (const key of provenance.partition.closure) {
    if (input.solcInput.sources[key] === undefined) {
      throw new ValidationInputInvariantError(
        `the produced input carries no source for "${key}", which is in the ` +
          `closure the output was projected onto — the consumer would decode ` +
          `AST spans against a source it does not hold.`,
      );
    }
  }
  if (input.solcVersion === '') {
    throw new ValidationInputInvariantError(
      'a validation input was produced with an empty compiler version.',
    );
  }

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
}

/** ─── Artifact resolution ────────────────────────────────────────────────── */

/**
 * Resolves the artifact, or hands the decision back to whoever owns it.
 *
 * `resolve` reports three statuses:
 *
 * - **`unique`** — proceed.
 * - **`ambiguous`** — the pipeline decides for itself when every candidate
 *   names the same `(sourcePath, contractName)`: recompiles accumulate
 *   build-info files (two `tronbox compile` runs are enough), so that shape
 *   is one contract seen in several records, not a collision. Only DISTINCT
 *   sources are a collision a user must resolve, and *that* decision stays
 *   the operation's — stated in the seam itself, and expected before calling
 *   here. When it has not been made, the pipeline fails closed by raising the
 *   seam's **own** diagnosis rather than validating one of N distinctly
 *   sourced same-named contracts: picking silently is the mis-pairing class
 *   this whole sub-feature exists to remove, and `ArtifactNameAmbiguousError`
 *   renders the candidates itself, so no sentence is hand-written here. Same
 *   test as `proxy/artifacts.ts:requireProxyArtifact`, and safe for the same
 *   reason plus one more: `consultBuildRecord` below verifies every record by
 *   deployed-bytecode identity, so the record consumed matches these exact
 *   compiled bytes, whichever of the same-source candidates named it. That
 *   identity is weaker for metadata-free builds (`metadata.bytecodeHash:
 *   "none"`), where a stale record can still match — the storage-layout
 *   provenance follow-up owns that residue.
 * - **`indeterminate`** — the build-info index could not be built, so *collisions
 *   could not be checked*; the abstraction still came from the host's own
 *   resolver for that name. The operation owns the statement for it
 *   (`'artifact-name-indeterminate'`) and the validation pipeline must not
 *   invent a second rendering, so it proceeds on the abstraction and says
 *   nothing.
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
  const distinct = new Set(
    resolution.candidates.map(
      candidate => `${candidate.sourcePath}:${candidate.contractName}`,
    ),
  );
  if (distinct.size <= 1) {
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
 * iterates `solcOutput.contracts` and validates every contract it finds, so a
 * record covering sources outside this target's closure — the whole-project
 * compile, which is the common case — would make every validation pay for the
 * whole project. The paired input is *not* projected: its whole key set rides
 * along verbatim, which is harmless (the engine reads input sources by the
 * output's keys) and is what keeps `solcInput` the recorded file's own content.
 *
 * **It is also where the one assumption the fresh path rests on gets checked at
 * runtime instead of trusted.** A record's `sources` list can be a *subset* of
 * the project — measured, two entries after touching one of seven — and the
 * reasoning that a contract present in `contracts` must have its whole import
 * closure in the same file (solc cannot emit bytecode for a source whose imports
 * are absent) is sound but not something to bet a silent vacuous pass on. Any
 * closure key whose AST is missing rejects the candidate.
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

  // One cast, from `unknown`, at the boundary where JSON becomes a typed record.
  // Everything the cast asserts has been checked immediately above, except the
  // AST's interior, which is the engine's subject and not this module's.
  const projected: unknown = { contracts, sources };
  return projected as SolcStandardOutput;
}

/**
 * The paired compiler input, narrowed to the shape consumers are typed over —
 * and handed on **verbatim** when it fits.
 *
 * The checks assert exactly what `SolcStandardInput` declares: the language,
 * a `sources` map whose every entry carries string `content`, and a `settings`
 * object with an `outputSelection`. Nothing is copied, defaulted or repaired:
 * a pair that fails any check is not "fixed up", it rejects the candidate,
 * because a repaired input is no longer the input that produced the output —
 * which is the whole property the fresh path exists to preserve.
 */
function narrowRecordedInput(value: unknown): SolcStandardInput | undefined {
  const top = asObject(value);
  if (top === undefined || top.language !== 'Solidity') {
    return undefined;
  }
  const sources = asObject(top.sources);
  if (sources === undefined) {
    return undefined;
  }
  for (const entry of Object.values(sources)) {
    const source = asObject(entry);
    if (source === undefined || typeof source.content !== 'string') {
      return undefined;
    }
  }
  const settings = asObject(top.settings);
  if (settings === undefined || asObject(settings.outputSelection) === undefined) {
    return undefined;
  }
  return value as SolcStandardInput;
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
 * the file consumed."* The same holds for the paired input: it rides the same
 * result member as the gate that vouched for it.
 */
type GateResult =
  | {
      readonly kind: 'fresh';
      readonly gate: Extract<BuildRecordGate, { kind: 'fresh' }>;
      readonly output: SolcStandardOutput;
      /**
       * The verified record's own `evm.bytecode`, carried out so the fresh path
       * can decide the library-name cause from the same object that verified.
       * Absent only if the host's record omitted the field, which no supported
       * version does.
       */
      readonly creationBytecode: RecordBytecode | undefined;
      /** The paired `<hash>.json` content, narrowed, verbatim. */
      readonly solcInput: SolcStandardInput;
      readonly inputFile: string;
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
 * the result carries its file name. The paired input is held to the same rule:
 * only the verified candidate's own `<hash>.json` may become `solcInput`, and a
 * candidate whose pair is missing, unparseable or not this output's input is
 * **rejected** rather than patched over — the reasons are the last three
 * members of `BuildRecordRejection`.
 *
 * A `fallback` result no longer sends the caller to a compiler: it is the
 * evidence a `build-record-stale` / `build-record-absent` refusal carries.
 */
function consultBuildRecord(request: GateRequest): GateResult {
  let result;
  try {
    result = request.readBuildInfo(request.buildInfoDirectory);
  } catch {
    // A reader that raises is the same situation as one that reports the
    // directory unreadable: no record can be consulted, so the caller refuses.
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
    if (isLayoutVacuous(output, request.targetKey, request.contractName)) {
      // The bytecode verified and the closure's ASTs are all present, but this
      // record's AST for the target source declares no such contract — so the
      // layout the engine reconstructs would be empty against a contract that is
      // not. A record to stop using, not a bug to report.
      rejected.push({ file: file.file, reason: 'target-definition-absent' });
      continue;
    }

    // The paired compiler input, checked last because it is only ever needed
    // for the candidate everything above vouched for. The `inputFile` /
    // `input` split is the reader's own contract: `inputFile` undefined means
    // the pair does not exist; `inputFile` set with `input` undefined means it
    // exists and did not parse.
    if (file.inputFile === undefined) {
      rejected.push({ file: file.file, reason: 'input-pair-absent' });
      continue;
    }
    if (file.input === undefined) {
      rejected.push({ file: file.file, reason: 'input-pair-unparseable' });
      continue;
    }
    const solcInput = narrowRecordedInput(file.input);
    if (
      solcInput === undefined ||
      request.closure.some(key => solcInput.sources[key] === undefined)
    ) {
      // Parses but is not the solc input of this output: wrong shape, or it
      // lacks a source the record's own output covers — either way, handing it
      // to a consumer would decode this output's spans against the wrong text.
      rejected.push({ file: file.file, reason: 'input-pair-unusable' });
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
      solcInput,
      inputFile: file.inputFile,
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

/** ─── Step 3: the fresh arm ──────────────────────────────────────────────── */

/** Everything the fresh arm needs, assembled once before the gate is consulted. */
interface ArmContext {
  readonly name: string;
  readonly record: ArtifactRecord;
  readonly partition: PartitionRecord;
  readonly channel: Pick<OutputChannel, 'note' | 'degraded'>;
}

/**
 * The namespaced shortfall, stated because it is present on the one producing
 * path.
 *
 * A namespace's members get no `slot` and no `offset` unless the sources are
 * compiled a second time with a storage variable injected for each namespaced
 * struct, which this plugin never does — so they are position-less in every
 * input this pipeline produces. And upstream's only slot-absence branch reads
 * the flat `storage` list, which for a contract whose storage lives entirely in
 * namespaces is **empty**, so the branch never fires while every namespace
 * member lacks positions. Every OZ 5.x contract is in that state.
 *
 * What the note means — bounded by the upstream maintainer's ruling (2026-08-04):
 * this is a fidelity statement, not a safety patch. A real change to a namespaced
 * struct still surfaces as a name or type change and is refused, so the class an
 * upstream slot-absence notice would have guarded here is empty; the divergence
 * direction without positions is over-rejection, never silent acceptance. The
 * note is recorded because a reduced-fidelity comparison must be stated
 * — a caller reading `namespaced-ast-only` learns how much the comparison could
 * see, not that it was unsafe.
 */
function stateNamespaceShortfall(
  context: ArmContext,
  output: SolcStandardOutput,
): void {
  const namespaces = declaresNamespacedStorage(
    output,
    context.partition.target,
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
        'struct. This version does not perform it.',
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
 * Step 3 — the fresh path, which is the pipeline's only producing path.
 * **Zero compiles**, and no compiler is located, loaded or version-compared.
 *
 * **The compiler causes are unreachable from here for a reason rather than by
 * omission.** A missing or mismatched compiler cannot refuse a validation
 * whose layouts come from the host's own record — which is what makes
 * validation work under the tool's own test command, where the artifact tree
 * is a fresh temporary copy and no compile has run. The record's deployed
 * bytecode matched the artifact's, which is stronger evidence than two
 * version strings agreeing. Every cause the path can reach, it does reach —
 * the range gate ahead of it, the source-resolution causes ahead of it, and
 * the library-name band below. Nothing on this path can raise
 * `build-record-stale`: a candidate that fails content verification is a
 * rejection inside the gate, decided before this arm is entered.
 */
function freshArm(
  context: ArmContext,
  fresh: Extract<GateResult, { kind: 'fresh' }>,
): ValidationInputOutcome {
  if (fresh.creationBytecode !== undefined) {
    /**
     * **The library-name cause is decided here, and it has to be.** A library
     * name past the band corrupts the *artifact's* bytecode — measured through
     * the host with a 45-character name, which produced an artifact whose
     * `bytecode` had an odd hex digit count — and that is a property of the
     * project, not of which path validated it. This path never hashes the
     * artifact, so the failure would not surface here; it would surface later,
     * in whatever reads the implementation identity, as upstream's `Bytecode
     * is not a valid hex string`, which names neither the library nor the
     * cause. The band is read off the verified record's own link references,
     * which the host requests.
     */
    const band = libraryNameBand(fresh.creationBytecode);
    if (band !== undefined) {
      return dispose(band, context.channel, null);
    }
  }

  /**
   * Unconditionally, on every produced input — never assumed from the basis.
   * Today every build record is AST-only, so the detector's answer is always
   * `declaration-order-only`; the day TronBox emits `storageLayout` into its
   * records, this call is what notices, and the return-boundary assertion is
   * what fails loudly instead of a stale claim shipping silently.
   */
  const fidelity = detectFidelity(fresh.output);

  context.channel.degraded({
    code: 'storage-layout-unavailable',
    summary:
      `${context.name}: upgrade-safety validation is comparing storage by ` +
      `declaration order, without slot positions.`,
    detail: [
      'TronBox does not ask the compiler for storage layouts, so the build ' +
        'record it wrote for this contract carries none and the layout is ' +
        'reconstructed from the record\'s own AST.',
      'A reconstructed layout is stricter, not blinder: renames, retypes, ' +
        'reordering and deletions are all still detected, and appending new ' +
        'variables is still safe. What it cannot decide is whether a change ' +
        'fits inside space a `__gap` array or intra-slot padding already ' +
        'reserved — those two shapes are refused rather than silently ' +
        'accepted.',
    ],
    remedy:
      'Storage-layout positions were not available from the TronBox build ' +
      'record, so the comparison used declaration order. See the README ' +
      'section "Validation without storage layouts" for what that mode can ' +
      'and cannot decide.',
  });

  stateNamespaceShortfall(context, fresh.output);

  const input: ValidationInput = Object.freeze({
    solcInput: fresh.solcInput,
    solcOutput: fresh.output,
    solcVersion: context.record.longCompilerVersion,
    fidelity,
    provenance: Object.freeze({
      basis: Object.freeze({
        kind: 'build-record-ast' as const,
        gate: fresh.gate,
        compilerLongVersion: context.record.longCompilerVersion,
        inputFile: fresh.inputFile,
      }),
      partition: context.partition,
      sourceKeys: Object.freeze(Object.keys(fresh.solcInput.sources)),
    }),
  });
  assertInput(input);
  return { kind: 'input', input };
}

/**
 * The range gate, applied before any record is read.
 *
 * No compiler is ever loaded, but declaring a support range and honouring it
 * only sometimes would make the range a property of the project's state rather
 * than of the plugin: the record this pipeline interprets was produced by the
 * project's compiler, and this plugin's reading of that output is verified
 * only across `SUPPORTED_SOLC`. An out-of-range project refuses *before* any
 * work, with the range named.
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
  const readBuildInfo = deps.readBuildInfo ?? fileSystemBuildInfoReader.read;
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
   * The closure is resolved before the gate, and that ordering is the design
   * rather than an accident.
   *
   * The gate needs it twice over — it is the key set the build record is
   * projected onto, and the derived `targetKey` is how the record's
   * `contracts` map is indexed for this contract at all. It also keeps the
   * source-resolution causes ahead of the record causes, which is the honest
   * order: a project with an unreadable import has that problem whether or
   * not it also lacks a build record, and `tronbox compile --all` cannot fix
   * a reference the compiler itself would refuse.
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
  const context: ArmContext = {
    name,
    record,
    partition,
    channel,
  };

  const consulted = consultBuildRecord({
    readBuildInfo,
    buildInfoDirectory: env.paths.buildInfoDirectory,
    targetKey: graph.targetKey,
    contractName: name,
    artifactDeployedBytecode: record.deployedBytecode,
    closure: partition.closure,
  });

  if (consulted.kind === 'fresh') {
    return freshArm(context, consulted);
  }

  return dispose(
    consulted.gate.kind === 'stale'
      ? { kind: 'build-record-stale', rejected: consulted.gate.rejected }
      : { kind: 'build-record-absent', because: consulted.gate.because },
    channel,
    null,
  );
}
