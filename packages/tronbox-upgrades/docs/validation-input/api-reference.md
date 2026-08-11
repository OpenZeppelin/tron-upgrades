# API reference — `src/validation-input`

Every export of [`src/validation-input/index.ts`](../../src/validation-input/index.ts), with
full signatures. One function, one constant, two error classes, and the types.

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
record, and either produces an input or returns a refusal. **Validation never compiles**: the
one producing path reads the build record TronBox already wrote, content-verifies it against
the artifact, and hands on the record's paired compiler input verbatim. The work behind the
returned promise is a directory listing and a handful of file reads.

**Throws only on plugin bugs** — `ValidationInputInvariantError`, plus the environment seam's
own `ArtifactNameAmbiguousError` for an operation that skipped its ambiguity decision. Every
user-facing condition is one of seven causes, returned as a value.

**No option selects a path.** Whether the fresh path produces an input or a refusal fires is
decided by the state of the build-info directory — a record either verifies or it does not —
and the remedy for both refusals is the same `tronbox compile --all`.

---

## `SUPPORTED_SOLC`

```ts
const SUPPORTED_SOLC: { readonly min: '0.8.0'; readonly max: '0.8.26' };
```

The verified compiler range, declared once and read by both the gate and the message that
reports being outside it. **No compiler is ever loaded** — the range gates which solc *output*
this plugin interprets: the build record the pipeline validates from was produced by the
project's compiler, and this plugin's reading of that output is verified only across the
declared range. The gate is on the **version**, not on whether the output happened to carry a
layout: a sub-0.5.13 compiler accepts a `storageLayout` request with zero diagnostics of any
severity and simply omits the key, so an output-shaped gate would report a plugin bug for a
user's compiler choice.

The gate is applied before any work — an out-of-range project refuses before a record is read,
with the range named.

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
seven causes cannot become twenty-one messages as the proxy operations, the standalone
operations and adoption (forceImport) are written.

The cause is exposed as `refusedCause` rather than `cause` because ES2022's `Error.cause` means
*the error this one wraps*, and a `Cause` is not an error.

> There used to be a third class, `CompilerRetiredError`, guarding reuse of a poisoned wasm
> compiler handle. It was **deleted** with the embedded compiler (the Foundry-model decision,
> 2026-08-07): the pipeline never loads one, so there is no handle to retire.

---

## What the caller supplies

### `ValidationInputRequest`

```ts
interface ValidationInputRequest {
  readonly contract: string;
  readonly env: ValidationInputEnvironment;
  readonly deps?: ValidationInputDependencies;
}
```

| Field | Notes |
|---|---|
| `contract` | The artifact name as the user named it. Ambiguity is the seam's resolver's problem, not this module's. |
| `env` | Exactly what this module needs from the environment seam, and no more. |
| `deps` | The filesystem, and nothing else. Every member optional; production defaults are resolved **inside** the call. |

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

Four things, and the boundaries worth naming:

- **`buildInfoDirectory` is the pipeline's whole subject.** The record read out of it is
  content evidence — a record whose deployed bytecode matches the artifact describes these
  exact compiled bytes whatever its age or provenance — and its paired `<hash>.json` compiler
  input is what consumers receive as `solcInput`.
- **`contractsBuildDirectory` is not picked.** Every artifact fact this module needs — both
  bytecodes, the source, the source path, the long compiler version — arrives off
  `ArtifactAccess.record`, with no filesystem access at all. Declaring the path would be a
  dependency claim with no reader behind it.
- **`compiler` is read for one field**: `resolvedVersion`, which the range gate checks against
  `SUPPORTED_SOLC` before any work. No compiler is ever located or loaded.
- **`output` is the operation's own channel.** A reduced-fidelity note has to ride the
  operation's returned result, and a result's notes are exactly one channel's `recorded`. Pass
  the channel the operation will read `recorded` off; a channel minted here would write notes
  that reach no result.

### `ValidationInputDependencies`

```ts
interface ValidationInputDependencies {
  readonly readSource?: (candidate: string) => string;
  readonly exists?: (candidate: string) => boolean;
  readonly readBuildInfo?: BuildInfoReader['read'];
}
```

| Member | Default | Why it is injectable |
|---|---|---|
| `readSource` | `fs.readFileSync(_, 'utf8')` | Drives causes 2 and 3 without arranging a broken tree on disk. |
| `exists` | `fs.existsSync` | Read by the same import walk; the other half of driving causes 2 and 3. |
| `readBuildInfo` | `fileSystemBuildInfoReader.read` | The three-way `absent` / `unreadable` / `files` result has to be drivable without a corrupt build tree — it is what decides the gate, and with it causes 5 and 6. |

**There is no `policy` member and there must not be.** An injectable table restores
per-call-site variation through the back door — one operation passes a lenient table "just for
this check" and the single-policy-point guarantee becomes nominal.

**There is no writer either.** This module persists nothing, so the injected surface has no
write capability to misuse.

`readBuildInfo` is the seam's own reader: one directory listing plus at most one read-and-parse
per `*.output.json` entry, plus an existence probe for the paired compiler-*input* file and,
when the pair is present, one read-and-parse of it. A pair that is missing, corrupt, or could
not be read is not an error at the reader — it becomes a per-candidate rejection at the gate.

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
| `solcInput` | **Verbatim from the paired `<hash>.json` file TronBox wrote next to the verified build record** — the exact input that produced `solcOutput`, narrowed and handed on untouched. Deliberately not reconstructed from the contracts directory: source text on disk can drift from what was compiled while the deployed bytecode still verifies, and a consumer decoding the output's AST spans against drifted text reads the wrong characters (the ex-M2 wrong-span hazard). |
| `solcOutput` | The host's own build record, projected onto the target's closure. |
| `solcVersion` | **Long** form, e.g. `0.8.26+commit.733b4d28.Emscripten.clang`. The artifact's own, verified by the bytecode match rather than by a version string. |
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

Every produced input reports `declaration-order-only`, with `missingFor` holding every
`<source key>:<contract>` the output carries — a build record carries positions for none of
them, because no supported TronBox requests `storageLayout` in its `outputSelection`. The
pipeline asserts exactly that on its way out.

The `slot-level` member is **not currently producible** and stays in the union on purpose: the
detector scans every produced output's real positions rather than assuming, so the day TronBox
starts emitting `storageLayout` into its build records, the detector's answer changes and the
return-boundary assertion fails loudly — at the moment the claim changes, instead of a stale
fidelity label shipping silently.

`missingFor` is documented never-empty, and the pipeline asserts it: a
`declaration-order-only` claim with an empty list would be a fidelity statement about nothing.

### `InputProvenance`

```ts
interface InputProvenance {
  readonly basis: InputBasis;
  readonly partition: PartitionRecord;
  readonly sourceKeys: readonly string[];
}
```

`sourceKeys` is every source key in `solcInput`, **in the input's own order** — the paired
file's whole key set, which is a superset of `partition.closure` (the record was the
whole-project compile in the common case). The audit trail.

### `InputBasis`

```ts
type InputBasis = {
  readonly kind: 'build-record-ast';
  readonly gate: Extract<BuildRecordGate, { kind: 'fresh' }>;
  /** `ArtifactRecord.longCompilerVersion`, verified by the bytecode match. */
  readonly compilerLongVersion: string;
  /** The paired `<hash>.json` file `solcInput` was read from. The audit trail. */
  readonly inputFile: string;
};
```

A single-member union on purpose: the Foundry model has exactly one producing step, and keeping
the discriminant means a future second basis (TronBox emitting `storageLayout`, say) is an
added member rather than a reshaping — a consumer switching on `kind` today is already total.

No compiler is located, loaded or read on the way to a produced input: `compilerLongVersion` is
the artifact's own, and the build record that verified against it by deployed bytecode was
produced by that compiler, by content rather than by claim.

`InputBasis`, `BuildRecordGate` and `BuildRecordRejection` are all exported from the face, so a
consumer can name them in its own signatures without a deep import.

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
    | 'target-definition-absent'
    | 'input-pair-absent'
    | 'input-pair-unparseable'
    | 'input-pair-unusable';
}
```

Why the gate sent this call down the path it took. A `fresh` gate rides the produced input's
`basis`; a `stale` gate's `rejected` list becomes `build-record-stale`'s payload, and an
`absent` gate's `because` becomes `build-record-absent`'s.

`candidates` counts records examined including the one that verified — records after it are
never read, so it is a count of *work done*, not of records held.

The seven rejection reasons, in the order the gate decides them per candidate:

| `reason` | The candidate |
|---|---|
| `nothing-to-compare` | held an entry for the pair with no deployed bytecode to compare, or both sides were empty (an interface or abstract contract: `'0x'` against `''` is a match of two absences, not evidence) |
| `deployed-bytecode-differs` | described a different compile |
| `ast-closure-incomplete` | verified, but does not carry an AST for every source in the closure |
| `target-definition-absent` | verified with a complete closure, but its AST for the target source declares no such contract — so the reconstructed layout would be empty against a contract that is not |
| `input-pair-absent` | verified, but the paired `<hash>.json` compiler input does not exist next to it |
| `input-pair-unparseable` | the pair exists and is not valid JSON |
| `input-pair-unusable` | the pair parses but is not the solc standard-JSON input of this output: wrong shape, or missing a source the record's own output covers |

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

---

## Refusals

### `Cause`

The closed union of seven members. Pure data — no policy, no rendering, no I/O. Every payload
field is a scalar, a closed union, or a list of records made of exactly those, so no source
string, settings object, host handle or upstream `Error` can be assigned to one. The one
non-scalar payload, cause 6's `rejected` list, is a `readonly` array of `BuildRecordRejection`
— a file path plus a closed-union reason — and carries the same property member-wise.

```ts
type Cause =
  | { kind: 'compiler-unsupported'; resolvedVersion: string;
      viaLegacyFlag?: 'useZeroFourCompiler' | 'useZeroFiveCompiler' }
  | { kind: 'source-unreadable'; sourceKey: string; path: string;
      because: 'missing' | 'unreadable' }
  | { kind: 'import-unresolvable'; importedBy: string; specifier: string }
  | { kind: 'artifact-shape-unsupported'; contract: string;
      missingField: 'compiler.version' | 'source' | 'sourcePath' | 'bytecode'
        | 'deployedBytecode';
      providedSince: string }
  | { kind: 'build-record-absent';
      because: 'directory-absent' | 'directory-unreadable'
        | 'no-record-for-target' }
  | { kind: 'build-record-stale'; rejected: readonly BuildRecordRejection[] }
  | { kind: 'library-name-unsupported'; libraryName: string; length: number;
      band: '37-38' | '>=39' };
```

(All fields are `readonly`; the modifier is elided above for width.)

This union used to have eleven members, four of them about the plugin's own embedded compiler.
The Foundry-model decision (2026-08-07) **deleted** `compiler-absent`, `compiler-mismatched`,
`compiler-resource-exhausted` and `sources-do-not-compile` — no plugin compile exists —
**absorbed** `artifact-stale` into `build-record-stale`, and **deleted** `layout-vacuous`,
whose only producer was the compile arm; on the record path the same hazard is decided per
candidate at the gate (`target-definition-absent`) and flows into `build-record-stale`.

Notes on the members whose payloads are easy to misread:

- **`compiler-unsupported` fires with no compiler loaded.** The range gates which solc output
  this plugin interprets, and it is checked before any record is read. `viaLegacyFlag` is
  carried so the remedy can name the config flag that produced the version.
- **`build-record-absent`'s three `because` values are three situations with one remedy**: the
  build-info directory is not there, it could not be read, or it is there and readable and
  simply holds no record naming this source-key/contract pair. All three mean the same thing —
  there is nothing to validate from — and `tronbox compile --all` regenerates the record
  unconditionally, because the `--all` flag forces recompilation of unchanged sources.
- **`build-record-stale`'s payload is the gate's own per-file evidence**: which record failed
  and why, one `BuildRecordRejection` per candidate examined. The common single-candidate case
  is `deployed-bytecode-differs` — the record no longer describes the compiled artifact — and
  the remedy is the same `tronbox compile --all`, which regenerates both sides of the
  comparison at once.
- **`library-name-unsupported`'s two bands are two different failures.** TronBox builds
  `'__' + name`, pads with `_` to 40 and splices over a 40-character window without truncating,
  while upgrades-core normalizes on `/__\w{36}__/g`. At 37–38 characters the artifact is intact
  and hashing throws; at ≥ 39 the artifact's own bytecode is longer than the compiler produced
  and every following byte has shifted. Cap library names at **36** characters.
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

Every remedy is distinct across the seven. The pair that makes that rule earn its keep is 5
versus 6: both are fixed by running `tronbox compile --all`, and the remedy is what tells the
user which situation they are in — no record was ever written for this contract, or every
record found no longer describes the compiled artifact.

**Render these; do not paraphrase them.** `ValidationInputRefusedError`'s message is
`` `${diagnosis.headline} ${diagnosis.remedy}` ``, which is the intended rendering.

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

**Nothing is assembled into this shape any more.** The input a consumer receives is the paired
`<hash>.json` compiler input TronBox wrote next to the verified build record, narrowed to this
shape at the gate and handed on verbatim. Nothing is copied, defaulted or repaired: a pair that
fails any check rejects the candidate, because a repaired input is no longer the input that
produced the output — which is the whole property the fresh path exists to preserve.

---

## Not on the face, and why

`policy`, `diagnose`, `sourceKey`, `detectFidelity`, `resolveSourceGraph` and `cutPartition`
are deliberately **not** exported from `index.ts`. If they were, a consumer could assemble a
validation input from the parts and bypass the policy point entirely — and the
single-call-site scan that pins `policy` would still pass, because that second pipeline would
never call `policy` at all.

They stay reachable by direct module import, which is how the tests see them. Reaching for one
from a sibling sub-feature is a signal that something belongs on the face; raise it rather than
deep-importing quietly.
