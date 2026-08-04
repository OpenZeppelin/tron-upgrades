# API reference — `src/validation-input`

Every export of [`src/validation-input/index.ts`](../../src/validation-input/index.ts), with
full signatures. One function, one constant, three error classes, and the types.

Signatures are transcribed from the source; where a doc comment and the source disagree, the
source is right and the disagreement is a documentation bug worth reporting.

---

## `deriveValidationInput`

```ts
function deriveValidationInput(
  request: ValidationInputRequest,
): Promise<ValidationInputOutcome>;
```

The whole module. Resolves the artifact, resolves the import closure, consults the build
record, and either produces an input or returns a refusal.

**Throws only on plugin bugs** — `ValidationInputInvariantError` and `CompilerRetiredError`.
Every user-facing condition is one of eleven causes, returned as a value.

**Async, and the compile inside it is not.** `solidity_compile` is a synchronous `cwrap` that
blocks the event loop for its whole duration; the returned promise carries no wall-clock bound
and no cancellation, and a signature that suggested otherwise would be promising something the
implementation cannot deliver.

**No option selects a path.** Whether a compile happens is decided by the state of the project
— see [the ladder](./README.md#the-ladder).

---

## `SUPPORTED_SOLC`

```ts
const SUPPORTED_SOLC: { readonly min: '0.8.0'; readonly max: '0.8.26' };
```

The verified compiler range, declared once and read by both the gate and the message that
reports being outside it. The gate is on the **version**, not on whether the output happened to
carry a layout: a sub-0.5.13 compiler accepts a `storageLayout` request with zero diagnostics
of any severity and simply omits the key, so an output-shaped gate would report a plugin bug
for a user's compiler choice.

The range is applied on **every** path, including the fresh one where no compiler is ever
loaded. Honouring a declared support range only when a compile happens to be needed would make
the range a property of the compiler-cache state rather than of the plugin.

---

## Errors

### `ValidationInputInvariantError`

```ts
class ValidationInputInvariantError extends Error {
  readonly code: 'VALIDATION_INPUT_INVARIANT';
  constructor(detail: string);
}
```

A broken invariant — always a plugin bug, never a user condition. The message says so and asks
for a report naming the contract.

### `CompilerRetiredError`

```ts
class CompilerRetiredError extends Error {
  readonly code: 'COMPILER_RETIRED';
  readonly retiredBy: string;
  constructor(retiredBy: string);
}
```

A `CompilerHandle` was used after its `compile` threw. Loud on purpose: emscripten's abort
poisons the module, so a silently reused handle turns one contract's memory ceiling into every
later contract's.

### `ValidationInputRefusedError`

```ts
class ValidationInputRefusedError extends Error {
  readonly code: 'VALIDATION_INPUT_REFUSED';
  readonly refusedCause: Cause;
  readonly diagnosis: Diagnosis;
  constructor(refusedCause: Cause, diagnosis: Diagnosis);
}
```

**This module never constructs or throws it.** It exists for the operation boundary, which
decides whether carrying a refusal or throwing it is right for its own contract.

**The constructor takes no `string`, and that absence is the enforcement.** A consumer cannot
word its own refusal sentence — that is a compile error rather than a review finding — so
eleven causes cannot become thirty-three messages as SF-5, SF-6 and SF-7 are written.

The cause is exposed as `refusedCause` rather than `cause` because ES2022's `Error.cause` means
*the error this one wraps*, and a `Cause` is not an error.

---

## What the caller supplies

### `ValidationInputRequest`

```ts
interface ValidationInputRequest {
  readonly contract: string;
  readonly env: ValidationInputEnvironment;
  readonly deps?: ValidationInputDependencies;
  readonly escalateFrom?: ValidationInput;
}
```

| Field | Notes |
|---|---|
| `contract` | The artifact name as the user named it. Ambiguity is the seam's resolver's problem, not this module's. |
| `env` | Exactly what this module needs from the environment seam, and no more. |
| `deps` | The wasm, the filesystem, and nothing else. Every member optional; production defaults are resolved **inside** the call. |
| `escalateFrom` | The AST-only input whose report came back non-empty. Must have `provenance.basis.kind === 'build-record-ast'` and the same target, or it raises. |

### `ValidationInputEnvironment`

```ts
interface ValidationInputEnvironment {
  readonly paths: Pick<
    ProjectPaths,
    'contractsDirectory' | 'buildInfoDirectory' | 'root'
  >;
  readonly artifacts: Pick<ArtifactAccess, 'resolve' | 'record'>;
  readonly compiler: CompilerConfiguration;
  readonly output: Pick<OutputChannel, 'note' | 'degraded'>;
}
```

Four things, and two deliberate omissions:

- **`contractsBuildDirectory` is not picked.** Every artifact fact this module needs — both
  bytecodes, the source, the source path, the long compiler version — arrives off
  `ArtifactAccess.record`, with no filesystem access at all. Declaring the path would be a
  dependency claim with no reader behind it.
- **`output` is the operation's own channel.** A reduced-fidelity note has to ride the
  operation's returned result, and a result's notes are exactly one channel's `recorded`. Pass
  the channel the operation will read `recorded` off; a channel minted here would write notes
  that reach no result.

`buildInfoDirectory` **is** picked, and that reverses an earlier decision rather than relaxing
one. A build record can never supply a storage layout — TronBox's `outputSelection` requests
`'': ['ast']` plus ten contract-level outputs and `storageLayout` is not among them — which is
exactly why the fresh path is AST-only. What that measurement does not support is the
conclusion that a record is therefore useless: the AST is what the engine reconstructs a layout
from, and a record whose deployed bytecode matches the artifact is evidence about *content*.

### `ValidationInputDependencies`

```ts
interface ValidationInputDependencies {
  readonly loadCompiler?: (soljsonPath: string) => CompilerHandle;
  readonly readSource?: (candidate: string) => string;
  readonly exists?: (candidate: string) => boolean;
  readonly readBuildInfo?: BuildInfoReader['read'];
  readonly homeDirectory?: () => string;
}
```

| Member | Default | Why it is injectable |
|---|---|---|
| `loadCompiler` | the module's own `loadCompiler` | Compile counting is the ladder's primary observable, and a stub is how you count. |
| `readSource` | `fs.readFileSync(_, 'utf8')` | Drives causes 4 and 5 without arranging a broken tree on disk. |
| `exists` | `fs.existsSync` | Drives cause 1 with no `~/.tronbox` populated. |
| `readBuildInfo` | `fileSystemBuildInfoReader.read` | The three-way `absent` / `unreadable` / `files` result has to be drivable without a corrupt build tree. |
| `homeDirectory` | `() => os.homedir()` | On this surface because the seam that owns the `~/.tronbox` convention reads no ambient module, and `compiler.ts` must not decide where its own resolver points. |

**There is no `policy` member and there must not be.** An injectable table restores
per-call-site variation through the back door — one operation passes a lenient table "just for
this check" and the single-policy-point guarantee becomes nominal.

**There is no writer either.** This module persists nothing, so the injected surface has no
write capability to misuse.

`readBuildInfo` is the seam's own reader: one directory listing plus at most one read-and-parse
per `*.output.json` entry, with the paired `*.input.json` never read.

---

## What the caller receives

### `ValidationInputOutcome`

```ts
type ValidationInputOutcome =
  | { readonly kind: 'input'; readonly input: ValidationInput }
  | {
      readonly kind: 'refused';
      readonly cause: Cause;
      readonly diagnosis: Diagnosis;
    };
```

A refusal is a value the caller can carry. That is not stylistic: the pipeline has to be *able*
to return a `proceed-reduced` disposition should the policy table ever change, and a thrown
refusal cannot become a proceed — catching it cannot manufacture the layouts a lenient path
would need.

### `ValidationInput`

```ts
interface ValidationInput {
  readonly solcInput: SolcStandardInput;
  readonly solcOutput: SolcStandardOutput;
  readonly solcVersion: string;
  readonly fidelity: LayoutFidelity;
  readonly provenance: InputProvenance;
}
```

Frozen, as is its `provenance`.

| Field | Notes |
|---|---|
| `solcInput` | Reconstructed from the contracts directory on **every** path, including the fresh one. The engine reads `sources[key].content` for its own namespace-annotation version check and would throw on a key the output carries and the input does not. Its `settings.outputSelection` describes what this plugin asks for *when it compiles*; on the fresh path nothing was compiled from it. |
| `solcOutput` | Either the host's build record, projected onto the closure, or this plugin's compile. `provenance.basis` says which. |
| `solcVersion` | **Long** form, e.g. `0.8.26+commit.733b4d28.Emscripten.clang`. On the fresh path it is the artifact's own, verified by the bytecode match rather than by a version string. |
| `fidelity` | Never optional. A function of the step that produced the input, asserted at the return boundary. |
| `provenance` | What happened, not what was expected. |

### `LayoutFidelity`

```ts
type LayoutFidelity =
  | { readonly kind: 'slot-level' }
  | {
      readonly kind: 'declaration-order-only';
      /** Fully-qualified names whose layout carries no positions. Never empty. */
      readonly missingFor: readonly string[];
    };
```

`declaration-order-only` on the fresh path, with `missingFor` holding every
`<source key>:<contract>` the output carries — a build record carries positions for none of
them, ever. `slot-level` on the three compiling paths.

`missingFor` is documented never-empty, and the pipeline asserts it: a
`declaration-order-only` claim with an empty list would be a fidelity statement about nothing.

### `InputProvenance`

```ts
interface InputProvenance {
  readonly reconstructedFrom: 'contracts-directory';
  readonly basis: InputBasis;
  readonly partition: PartitionRecord;
  readonly sourceKeys: readonly string[];
}
```

`reconstructedFrom` describes `solcInput`'s origin, which is the contracts directory on every
path. It is `solcOutput`'s origin that varies, and `basis` carries it.

`sourceKeys` is every source key in the input, in the input's own order — the audit trail. The
order is sorted rather than the host's graph-walk order, so two calls over an unchanged tree
produce byte-identical inputs.

### `InputBasis` — the field that tells the four paths apart

```ts
type InputBasis =
  | {
      readonly kind: 'build-record-ast';
      readonly gate: Extract<BuildRecordGate, { kind: 'fresh' }>;
      readonly compilerLongVersion: string;
    }
  | {
      readonly kind: 'plugin-compile';
      readonly reason: CompileReason;
      readonly gate: BuildRecordGate;
      readonly compiler: CompilerIdentity;
      readonly identity: ArtifactIdentityComparison;
    };

type CompileReason =
  | 'build-record-stale'
  | 'build-record-absent'
  | 'ast-only-escalation';
```

A closed union rather than a set of optional fields, so *"which compiler ran"* and *"which
record verified"* can be neither both absent nor both present.

On an escalation, `gate` is the `fresh` gate of the input being escalated — the record of
*escalated from a verified record*. That is why no separate flag is needed to read the path off
a produced input:

| `basis.kind` | `basis.reason` | Path |
|---|---|---|
| `'build-record-ast'` | — | `fresh` |
| `'plugin-compile'` | `'build-record-stale'` | `stale` |
| `'plugin-compile'` | `'build-record-absent'` | `absent` |
| `'plugin-compile'` | `'ast-only-escalation'` | `escalated` |

> **`InputBasis`, `BuildRecordGate`, `BuildRecordRejection` and `CompileReason` are reachable
> but not on the face.** `index.ts` exports `InputProvenance`, so `provenance.basis.kind`
> narrows structurally and a `switch` over it needs no import. Naming one of them in your own
> signature currently requires a deep import from `../validation-input/pipeline`. Prefer
> structural narrowing; if you need the name, that is worth raising rather than working around
> quietly.

### `BuildRecordGate`

```ts
type BuildRecordGate =
  | { readonly kind: 'fresh'; readonly file: string; readonly candidates: number }
  | { readonly kind: 'stale'; readonly rejected: readonly BuildRecordRejection[] }
  | {
      readonly kind: 'absent';
      readonly because:
        | 'directory-absent'
        | 'directory-unreadable'
        | 'no-record-for-target';
    };

interface BuildRecordRejection {
  readonly file: string;
  readonly reason:
    | 'deployed-bytecode-differs'
    | 'nothing-to-compare'
    | 'ast-closure-incomplete'
    | 'target-definition-absent';
}
```

`candidates` counts records examined including the one that verified — records after it are
never read, so it is a count of *work done*, not of records held.

The four rejection reasons, in the order the gate can reach them:

| `reason` | The candidate |
|---|---|
| `nothing-to-compare` | held an entry for the pair with no `evm.deployedBytecode` to compare, or both sides were empty (an interface or abstract contract) |
| `deployed-bytecode-differs` | described a different compile |
| `ast-closure-incomplete` | verified, but does not carry an AST for every source in the closure |
| `target-definition-absent` | verified with a complete closure, but its AST for the target source declares no such contract — so the reconstructed layout would be empty against a contract that is not |

A file holding no entry for the pair at all is **not** a rejection: a record of some other
compile is not a stale record of this one. That distinction is what separates `stale` from
`absent`.

### `PartitionRecord`

```ts
interface PartitionRecord {
  readonly target: string;
  readonly closure: readonly string[];
}
```

`target` is a **source key**, not a contract name — it names something a user can open, and it
is what `closure` is asserted to contain.

### `ArtifactIdentityComparison`

```ts
interface ArtifactIdentityComparison {
  readonly withoutMetadataMatches: boolean;
  readonly withMetadataMatches: boolean;
  /** Present iff the two disagree: the code is identical, the metadata is not. */
  readonly metadataOnlyDifference?: true;
}
```

Present on `basis` only for `'plugin-compile'`. On a `metadataOnlyDifference` the pipeline
records the flag **and** writes an advisory note — validation proceeds, because upgrade safety
is decided from the code and the code is identical.

On the refusal side, cause 7 (`artifact-stale`) carries **only the contract name**, and
deliberately: the comparison record is constant on that path (`{ false, false }` with
`metadataOnlyDifference` absent), so it would carry no information a message could name.

---

## Refusals

### `Cause`

The closed union of eleven members. Pure data — no policy, no rendering, no I/O. Every payload
field is a scalar or a closed union, so no source string, settings object, host handle or
upstream `Error` can be assigned to one.

```ts
type Cause =
  | { kind: 'compiler-absent'; requestedVersion: string; soljsonPath: string;
      family: 'tvm' | 'evm' }
  | { kind: 'compiler-unsupported'; resolvedVersion: string;
      viaLegacyFlag?: 'useZeroFourCompiler' | 'useZeroFiveCompiler' }
  | { kind: 'compiler-mismatched'; loadedLongVersion: string;
      artifactLongVersion: string; family: 'tvm' | 'evm' }
  | { kind: 'source-unreadable'; sourceKey: string; path: string;
      because: 'missing' | 'unreadable' }
  | { kind: 'import-unresolvable'; importedBy: string; specifier: string }
  | { kind: 'artifact-shape-unsupported'; contract: string;
      missingField: 'compiler.version' | 'source' | 'sourcePath' | 'bytecode'
        | 'deployedBytecode';
      providedSince: string }
  | { kind: 'artifact-stale'; contract: string }
  | { kind: 'compiler-resource-exhausted'; target: string; closureSize: number;
      raised: WasmAbort }
  | { kind: 'layout-vacuous'; contract: string; declaredStateVariables: number }
  | { kind: 'library-name-unsupported'; libraryName: string; length: number;
      band: '37-38' | '>=39' }
  | { kind: 'sources-do-not-compile'; target: string; errorCount: number };

type WasmAbort = 'memory-access-out-of-bounds' | 'other-wasm-abort';
```

(All fields are `readonly`; the modifier is elided above for width.)

Notes on the members whose payloads are easy to misread:

- **`compiler-mismatched` compares the long version**, not a triple.
  `~/.tronbox/solc/soljson_v0.8.26.js` reports `0.8.26+commit.733b4d28.Emscripten.clang` and
  `~/.tronbox/evm-solc/soljson_v0.8.26.js` reports `0.8.26+commit.8a97fa7a.Emscripten.clang` —
  same filename, different compilers, different bytecode. `family` is carried for the remedy,
  never for the comparison.
- **`compiler-resource-exhausted` fires by catching, not by timing**, and `raised` is a closed
  union so nothing quotes the wasm's own abort text. It is terminal: one contract's closure is
  the smallest input there is, so there is nothing smaller to retry with.
- **`layout-vacuous` is a cause and not an invariant throw**, even though it means the plugin
  has a bug, because letting it through is a measured *silent accept*:
  `getStorageUpgradeErrors(EMPTY_original, real_updated)` returns no errors and
  `assertStorageUpgradeSafe(EMPTY, real)` does not throw, so an empty reference layout
  classifies every variable in the new contract as a safe append. `declaredStateVariables` is
  what makes the refusal honest rather than paranoid — a contract that genuinely declares
  nothing has an empty layout legitimately.
- **`library-name-unsupported`'s two bands are two different failures.** TronBox builds
  `'__' + name`, pads with `_` to 40 and splices over a 40-character window without truncating,
  while upgrades-core normalizes on `/__\w{36}__/g`. At 37–38 characters the artifact is intact
  and hashing throws; at ≥ 39 the artifact's own bytecode is longer than the compiler produced
  and every following byte has shifted. Cap library names at **36** characters.
- **`sources-do-not-compile` carries the count, never the text.** solc's error strings are
  unbounded and routinely carry absolute filesystem paths, and TronBox already prints them in
  full — so the remedy points at `tronbox compile` instead of reproducing them.
- **`artifact-shape-unsupported`'s `providedSince` is `4.8.0`**, the oldest TronBox verified to
  write all five fields into every artifact. Deliberately not the package's declared peer range.

### `Diagnosis`

```ts
interface Diagnosis {
  /** One sentence naming the contract or input and the cause. */
  readonly headline: string;
  /** The remedy, as an imperative. One per cause; never shared between causes. */
  readonly remedy: string;
}
```

Both fields required, both non-empty — a blank one raises rather than rendering an empty line.
Rendering is unconditional and independent of policy: `diagnose.ts` does not import `policy.ts`,
so a leniency change provably cannot alter what a refusal says.

**Render these; do not paraphrase them.** `ValidationInputRefusedError`'s message is
`` `${diagnosis.headline} ${diagnosis.remedy}` ``, which is the intended rendering.

---

## Compiler types

### `CompilerHandle`

```ts
interface CompilerHandle {
  readonly longVersion: string;
  /** Throws `CompilerRetiredError` if called after a previous throw. */
  compile(input: SolcStandardInput): SolcStandardOutput;
}
```

`compile` is **synchronous**, and that is structural rather than incidental:
`solidity_compile` is a synchronous `cwrap` that blocks the event loop for its whole duration,
so `Promise.race` and `AbortSignal` cannot bound it. A promise-returning signature would imply
a wall-clock bound this version does not have and cannot have without a worker thread or a
child process.

Single-use-after-failure: once `compile` throws, the handle is retired.

### `CompilerIdentity`

```ts
interface CompilerIdentity {
  readonly family: 'tvm' | 'evm';
  /** The triple the config resolved to. Used to *locate*, never to compare. */
  readonly requestedVersion: string;
  /** What `version()` returned. This is what cause 3 compares. */
  readonly longVersion: string;
  readonly soljsonPath: string;
}
```

Present on `basis` only for `'plugin-compile'`. On the fresh path no compiler is located,
loaded or read, so there is no identity to record.

---

## Solc types

```ts
interface SolcStandardInput {
  readonly language: 'Solidity';
  /** The only place Solidity source text exists in this module. */
  readonly sources: Readonly<Record<string, { readonly content: string }>>;
  readonly settings: SolcStandardSettings;
}

type SolcStandardSettings = Readonly<Record<string, unknown>> & {
  readonly outputSelection: Readonly<Record<string, Record<string, string[]>>>;
};

type SolcStandardOutput = SolcOutput; // upstream's own
```

`SolcStandardInput` is pinned assignable to upstream's `SolcInput` by a type-level assertion,
so `validate`'s fourth argument and `solcInputOutputDecoder`'s first accept it without a cast.

`settings` spreads the project's own solc settings and then overwrites `outputSelection` — the
same shape TronBox itself uses, plus `storageLayout`. Note the direction: TronBox's own literal
comes *after* its user-settings spread, so a user-supplied `outputSelection` is overwritten by
the host rather than merely not extended. That single omission of `storageLayout` from the
host's list is why this module exists.

---

## Not on the face, and why

`policy`, `diagnose`, `sourceKey`, `detectFidelity`, `positionShortfall`, `buildSolcInput`,
`resolveSourceGraph`, `cutPartition` and `openCompiler` are deliberately **not** exported from
`index.ts`. If they were, a consumer could assemble a validation input from the parts plus its
own compile and bypass the policy point entirely — and the single-call-site scan that pins
`policy` would still pass, because that second pipeline would never call `policy` at all.

They stay reachable by direct module import, which is how the tests see them. Reaching for one
from a sibling sub-feature is a signal that something belongs on the face; raise it rather than
deep-importing quietly.
