import fs from 'node:fs';
import os from 'node:os';

import {
  ArtifactNameAmbiguousError,
  type ArtifactAccess,
  type ArtifactRecordField,
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
  type ArtifactIdentityComparison,
} from './identity';
import {
  countDeclaredStateVariables,
  detectFidelity,
  isLayoutVacuous,
  type LayoutFidelity,
} from './layout-fidelity';
import {
  createCompileMemo,
  cutPartition,
  partitionIdentity,
  type CompileMemo,
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
 * The whole of SF-2, and **the one place `policy.ts` is imported and called**
 * (INV-9).
 *
 * A refusal is a value, never a throw (INV-1). That is not stylistic: D1 requires
 * the pipeline to be *able* to carry a `proceed-reduced` disposition, and a thrown
 * refusal cannot become a proceed — catching it cannot manufacture the layouts a
 * lenient path would need to return. Returning a value is what makes the policy
 * table the only thing a leniency flip touches.
 *
 * The only two things this module throws are `ValidationInputInvariantError` and
 * `CompilerRetiredError`, both of which denote plugin bugs.
 */

/** ─── What consumers receive ─────────────────────────────────────────────── */

export interface ValidationInput {
  /** The reconstructed solc standard-JSON input, verbatim as compiled. */
  readonly solcInput: SolcStandardInput;
  /** The compiler's output for this partition, `storageLayout` included. */
  readonly solcOutput: SolcStandardOutput;
  /** LONG form, e.g. `0.8.26+commit.733b4d28.Emscripten.clang` (INV-5). */
  readonly solcVersion: string;
  /**
   * Never optional (D1 item 1). In v1 always `slot-level` on the ordinary success
   * path, **and that path asserts it** — the assertion is the thing a leniency
   * flip relaxes, not the thing a flip adds. The field exists so a mode added
   * later changes a *value* rather than this interface, after SF-2b, SF-5, SF-6
   * and SF-7 are written against it.
   */
  readonly fidelity: LayoutFidelity;
  readonly provenance: InputProvenance;
}

export interface InputProvenance {
  /** One variant in v1 (D3). A build-info shortcut would add one, not change it. */
  readonly reconstructedFrom: 'contracts-directory';
  readonly compiler: CompilerIdentity;
  readonly partition: PartitionRecord;
  /** Every source key in the input, in the input's own order. G2's audit trail. */
  readonly sourceKeys: readonly string[];
  /** Both identities, so a metadata-only difference is reportable (INV-31). */
  readonly identity: ArtifactIdentityComparison;
}

/** No throw on a refusal — it is a value the caller can carry (INV-1). */
export type ValidationInputOutcome =
  | { readonly kind: 'input'; readonly input: ValidationInput }
  | {
      readonly kind: 'refused';
      readonly cause: Cause;
      readonly diagnosis: Diagnosis;
    };

/** ─── What the caller supplies ───────────────────────────────────────────── */

/**
 * Exactly what SF-2 needs from SF-0's seam, and no more.
 *
 * **`buildInfoDirectory` and `BuildInfoReader` are absent on purpose** (D3,
 * INV-7), and the `Pick` is what makes reading one a **compile error** rather than
 * a convention: `ProjectPaths` declares `buildInfoDirectory` at
 * `src/environment/types.ts:85`, and it is not picked here. This is stronger than
 * *"optional behind a staleness gate"* — the input that causes the whole
 * mis-pairing failure class is not available to the module at all. F-11 is why
 * nothing is lost: the host requests `'': ['ast']` but never `storageLayout`, so a
 * perfectly fresh, correctly identified build-info still cannot supply a layout.
 *
 * **`contractsBuildDirectory` is not picked either, which is narrower than D3.**
 * D3 named it as one of SF-2's two path dependencies, and that was true of the
 * design it was written against. It stopped being true when SF-0 landed
 * `ArtifactAccess.record` (`src/environment/types.ts:294`): every artifact fact
 * SF-2 needs — both bytecodes, the source, the source path, the long compiler
 * version — now arrives off the abstraction the seam already resolved, with no
 * filesystem access at all. Nothing here opens the build tree, so declaring it
 * would be a dependency claim with no reader behind it. Re-admitting it is one
 * word.
 *
 * **`output` is SF-10's `OutputChannel`, not SF-0's `OutputChannelSlot`, and that
 * is a correction to Design.** INV-30 requires the reduced-fidelity note to be
 * *recorded* and to *ride the operation's result*, and SF-10's INV-37 makes a
 * result's `notes` exactly **one** channel's `recorded`
 * (`src/output/types.ts:151-155`). A channel SF-2 minted for itself out of the
 * slot would be a second channel whose records reach no result — the note would be
 * written and then lost, which is SC-003 satisfied in letter only. So the
 * operation's own channel is handed in.
 */
export interface ValidationInputEnvironment {
  readonly paths: Pick<ProjectPaths, 'contractsDirectory' | 'root'>;
  readonly artifacts: Pick<ArtifactAccess, 'resolve' | 'record'>;
  readonly compiler: CompilerConfiguration;
  readonly output: Pick<OutputChannel, 'note' | 'degraded'>;
}

/**
 * The wasm, the filesystem and nothing else.
 *
 * **There is no `policy` member and there must not be** (INV-10): an injectable
 * table restores per-call-site variation through the back door. The flip test
 * substitutes `policy.ts` at its module boundary in a fixture, which is a test
 * affordance and not an API.
 *
 * There is no writer either (INV-23): SF-2 persists nothing, so the injected
 * surface has no write capability to misuse. Production defaults are resolved
 * **inside** the call rather than captured at module scope (INV-44), which is what
 * lets the nine non-compiler causes be exercised with no `~/.tronbox` populated.
 */
export interface ValidationInputDependencies {
  readonly loadCompiler?: (soljsonPath: string) => CompilerHandle;
  readonly readSource?: (candidate: string) => string;
  readonly exists?: (candidate: string) => boolean;
  /**
   * The machine's home directory, under which TronBox caches compilers.
   *
   * On this surface rather than inside `compiler.ts` because the seam that owns the
   * `~/.tronbox` convention cannot read it — `src/environment/**` imports no ambient
   * module (INV-43) and is a function of its arguments alone (INV-44) — and
   * `compiler.ts` must not read it either, or the module that constructs a
   * `createRequire` resolver would also be the module that decides where it points.
   * So the machine reading lands here, with the same default-inside-the-call shape as
   * `exists` and `loadCompiler`.
   */
  readonly homeDirectory?: () => string;
}

export interface ValidationInputRequest {
  /** Artifact name as the user named it; SF-0's resolver owns the ambiguity. */
  readonly contract: string;
  readonly env: ValidationInputEnvironment;
  readonly deps?: ValidationInputDependencies;
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
 * Anything that is **not** a wasm abort is re-raised (INV-36): a timeout is a
 * different event from an OOM and would be a *new* cause, never a widening of
 * cause 8.
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
 * cannot change it (INV-11, INV-12).
 *
 * `proceedWith` is `null` for every cause discovered before there is a compiled
 * output, and a `proceed-reduced` row on such a cause raises rather than silently
 * refusing. That is deliberate: there is nothing to proceed *with* — Research's
 * rejected shape B, reached from the other side — and a flip that cannot be
 * honoured has to fail at the moment it is made rather than look like it worked.
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
 * INV-4, checked once where the input leaves.
 *
 * The violation it prevents is the worst outcome available here: an empty or
 * mis-keyed closure produces an output with no contracts, `detectFidelity` sees
 * nothing missing and reports `slot-level`, and F-4's measured vacuous pass fires —
 * `getStorageUpgradeErrors(EMPTY, real)` returns no errors, so every variable in
 * the new contract is classified as a safe append.
 */
function assertProvenance(
  provenance: InputProvenance,
  input: SolcStandardInput,
): void {
  const inputKeys = Object.keys(input.sources);
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
  if (provenance.compiler.longVersion === '') {
    throw new ValidationInputInvariantError(
      'a validation input was produced with an empty compiler version.',
    );
  }
  if (!provenance.identity.withoutMetadataMatches) {
    throw new ValidationInputInvariantError(
      `a validation input was produced for an artifact whose identity does not ` +
        `match the recompile; that outcome should have been cause 7.`,
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
 * - **`ambiguous`** — *policy for this branch is SF-5's*, stated in the seam
 *   itself at `src/environment/artifacts.ts:288-289`, and the operation is
 *   expected to decide before calling here. When it has not, SF-2 fails closed by
 *   raising the seam's **own** diagnosis rather than validating one of N
 *   same-named contracts: picking silently is the mis-pairing class this whole
 *   sub-feature exists to remove, and `ArtifactNameAmbiguousError` renders the
 *   candidates itself, so no sentence is hand-written here.
 * - **`indeterminate`** — the build-info index could not be built, so *collisions
 *   could not be checked*; the abstraction still came from the host's own resolver
 *   for that name. SF-5 owns the statement for it (`'artifact-name-indeterminate'`
 *   is SF-5's `DegradedCode` member, `src/output/types.ts:70`) and SF-2 must not
 *   invent a second rendering, so it proceeds on the abstraction and says nothing.
 *   Under `tronbox test` this is the routine state rather than a rare fallback:
 *   the host writes no build-info there at all (F-10).
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

/** ─── The compile step ───────────────────────────────────────────────────── */

type CompileOutcome =
  | { readonly ok: true; readonly output: SolcStandardOutput }
  | { readonly ok: false; readonly cause: Cause };

/**
 * One partition, one invocation — and **no retry, no split, no fallback**
 * (INV-37). One contract's closure is the smallest input this plugin can offer,
 * so the ceiling is terminal; a retry would meet a poisoned handle (INV-24) and
 * report a plugin bug where the user needs an actionable refusal.
 *
 * The memo lookup happens here, on every call. Its *hit* path is unreachable
 * through the one-contract-per-call API — see `partition.ts:CompileMemo`, where
 * that gap between Design and Invariants is recorded rather than papered over.
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
      // Not the compiler's own ceiling. The handle has already retired itself
      // (INV-24), and this is not one of the eleven, so it is not dressed as one.
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
  // `os.homedir` passed as a reference rather than called here: the gate inside
  // `openCompiler` decides whether the machine is read at all (INV-44's
  // read-inside-the-call shape, one level out).
  const homeDirectory = deps.homeDirectory ?? (() => os.homedir());
  const channel = env.output;

  const resolved = artifactAbstraction(env, contract);
  const name = resolved.name;

  // Every artifact fact arrives through the seam's projection. INV-8: reading
  // `contract._json` here would be a TronBox-internal property path outside
  // `src/environment/**`, and `test/trust-boundary.test.ts:443` forbids it by
  // name.
  const report = env.artifacts.record(resolved.contract);
  if (report.status === 'incomplete') {
    // The *first* missing field, in the seam's own declaration order, so the
    // message is deterministic (INV-19). The seam documents `missing` as
    // non-empty by construction; a message this specific does not rest on a doc
    // comment.
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

  const opened = openCompiler({
    compiler: env.compiler,
    artifactLongVersion: record.longCompilerVersion,
    exists,
    load,
    homeDirectory,
  });
  if (!opened.ok) {
    return dispose(opened.cause, channel, null);
  }

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
  const target = partition.record.target;

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
    // so it cannot honestly reach INV-32's `withoutMetadataMatches` gate at all.
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
      // the cause (INV-42).
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

  /**
   * D1 item 2 / INV-3: **unconditionally, and one call site.** It runs here —
   * above both the reduced path and the ordinary one — so *every* produced input
   * has had the detector run over it. Calling it only where degradation is
   * suspected would let the flip test pass while production never ran the
   * detector, and the day the table flips a reduced input would ship reading
   * `slot-level`.
   */
  const detected = detectFidelity(solcOutput);

  const buildInput = (fidelity: LayoutFidelity): ValidationInput => {
    const built: ValidationInput = Object.freeze({
      solcInput,
      solcOutput,
      solcVersion: opened.identity.longVersion,
      fidelity,
      provenance: Object.freeze({
        reconstructedFrom: 'contracts-directory' as const,
        compiler: opened.identity,
        partition: partition.record,
        sourceKeys: partition.record.closure,
        identity: identity.comparison,
      }),
    });
    assertProvenance(built.provenance, built.solcInput);
    return built;
  };

  /**
   * What a `proceed-reduced` row would produce. Switching on the mode rather than
   * ignoring it means a second `ReducedMode` member becomes a compile error here
   * instead of silently taking this branch.
   */
  const reducedInput: ReducedInputFactory = mode => {
    switch (mode.kind) {
      case 'declaration-order-only':
        return buildInput(
          detected.kind === 'declaration-order-only'
            ? detected
            : {
                kind: 'declaration-order-only',
                // Documented never-empty, so it names the contract whose layout
                // is the reason the flip was reached.
                missingFor: Object.freeze([`${target}:${name}`]),
              },
        );
    }
  };

  if (isLayoutVacuous(solcOutput, target, name)) {
    const declaredStateVariables = countDeclaredStateVariables(
      solcOutput,
      target,
      name,
    );
    if (declaredStateVariables > 0) {
      // A cause and not an invariant throw, because F-4 measured that letting an
      // empty reference layout through is a *silent accept* (INV-18).
      return dispose(
        { kind: 'layout-vacuous', contract: name, declaredStateVariables },
        channel,
        reducedInput,
      );
    }
  }

  if (detected.kind !== 'slot-level') {
    // v1's ordinary success path asserts slot-level. This is the assertion a
    // leniency flip relaxes — not one it adds — so if it fires in v1 that is a
    // plugin bug and not a degradation (D1 item 2, INV-3).
    throw new ValidationInputInvariantError(
      `the compiler returned slot-less storage layouts for ` +
        `${detected.missingFor.length} contract(s), inside a supported compiler ` +
        `range where every build emits slots. v1 has no reduced-fidelity path on ` +
        `the ordinary route, so this is a plugin bug rather than a degradation.`,
    );
  }

  if (identity.comparison.metadataOnlyDifference === true) {
    // INV-31: recorded in provenance *and* stated. The durable record is the
    // provenance flag; the channel statement is the courtesy, which is why it is
    // a note rather than a degraded-mode entry — nothing about the validation is
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

  return { kind: 'input', input: buildInput(detected) };
}
