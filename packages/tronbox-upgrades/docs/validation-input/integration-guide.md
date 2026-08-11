# Integration guide

Three patterns, in the order a consumer meets them, and then the mistakes worth naming.
[`examples/`](./examples) holds **type-checked counterparts for patterns 1 and 2**, and the
injectable-dependency shape both rely on. **Pattern 3 — validating under `tronbox test` — has
no example module**, so follow its section here rather than expecting a file.

- [Pattern 1 — derive inside the operation](#pattern-1--derive-inside-the-operation)
- [Pattern 2 — state what was checked](#pattern-2--state-what-was-checked)
- [Pattern 3 — expect validation to work under `tronbox test`](#pattern-3--expect-validation-to-work-under-tronbox-test)
- [Six mistakes](#six-mistakes)

---

## Pattern 1 — derive inside the operation

Handles arrive as arguments, the environment is resolved inside the call, and the validation
input is derived inside the operation that needs it. Nothing is cached at module scope.

```ts
import {
  deriveValidationInput,
  ValidationInputRefusedError,
} from '../validation-input';

export async function inputFor(
  contract: string,
  env: ValidationInputEnvironment,
): Promise<ValidationInput> {
  const outcome = await deriveValidationInput({ contract, env });

  if (outcome.kind === 'refused') {
    // The one rendering. Do not compose a sentence of your own.
    throw new ValidationInputRefusedError(outcome.cause, outcome.diagnosis);
  }

  return outcome.input;
}
```

Two decisions in that function are the whole pattern.

**Throwing versus carrying is yours.** `deriveValidationInput` returns the refusal as a value
precisely so the operation boundary can decide. An `upgradeProxy` that must not proceed should
throw; a `validate --dry-run` that wants to report every contract's verdict should carry.

**Switch on `cause.kind` only when you act differently.** If all seven causes end the same way
for your operation, the diagnosis is already rendered and there is nothing to switch on. Reach
for `cause.kind` when a category genuinely changes behaviour — causes 5 and 6
(`build-record-absent`, `build-record-stale`) are the pair an operation might want to treat as
"recompile and retry", because both remedies are the same `tronbox compile --all`. There is no
second, higher-fidelity derivation to re-ask for after a refusal: the pipeline never compiles,
so the remedy is the user's to run.

---

## Pattern 2 — state what was checked

Every degraded statement this module makes is recorded on the channel you passed in. Put
`channel.recorded` on the operation's result; do not re-derive the statements from `fidelity`.

```ts
const result = {
  // … the operation's own fields …
  notes: channel.recorded,   // includes 'storage-layout-unavailable' and
                             // 'namespaced-ast-only' where they applied
};
```

`fidelity` is for *your* branching, not for building a user-facing sentence:

```ts
switch (input.fidelity.kind) {
  case 'slot-level':
    break;                                   // not producible today; see below
  case 'declaration-order-only':
    input.fidelity.missingFor;                // non-empty, fully-qualified names
    break;
}
```

Every input the pipeline produces today reports `declaration-order-only` — no supported TronBox
requests `storageLayout`, so no build record carries positions — and the pipeline asserts that
at its return boundary. The `slot-level` arm stays in the union (and in your switch) because
the detector scans every output's real positions rather than assuming: the day TronBox emits
layouts into its records, that member is how the change arrives.

**The record is the guarantee and the log write is a courtesy.** TronBox replaces the log
channel with a no-op under `--quiet` and `--silent`, and passes a no-op throughout
`tronbox test` — the command that replays every migration on every run. A design that
discharged its degraded-mode obligation through a log line would be silent for every test run.

**Two statements, both meaning something specific:**

| `code` | Means | When |
|---|---|---|
| `storage-layout-unavailable` | the flat layout was reconstructed from the build record's AST, so it carries declaration order and not positions | every produced input |
| `namespaced-ast-only` | this contract declares namespaced storage, whose members carry no positions | every produced input where a namespace is found |

The second one surprises people, so it is worth saying plainly: namespace members get positions
only from a second compilation with a storage variable injected per namespaced struct, which
this plugin never performs — and upstream reports nothing about it because its only
slot-absence branch reads the flat `storage` list, which for a purely namespaced contract is
empty. Every OpenZeppelin 5.x contract is in that state.

---

## Pattern 3 — expect validation to work under `tronbox test`

`tronbox test` copies the artifact tree into a temporary directory and points
`contracts_build_directory` at the copy (`build/lib/commands/test.js`) — and it does **not**
redirect `build_info_directory`. The copied artifact and the build record still describe the
same compile, so the record's deployed bytecode matches the artifact's, the gate reports
`fresh`, and validation runs from the record exactly as it does under `tronbox migrate`.

**Two things follow for a consumer:**

1. **Do not treat "under `tronbox test`" as a reason to skip validation.** The content check is
   what makes the record trustworthy there: a record whose deployed bytecode matches the
   artifact describes these exact compiled bytes, whichever directory the artifact was copied
   into.
2. **Budget zero compiles, on every command.** The pipeline never invokes a compiler — not
   under `tronbox migrate`, not under `tronbox test`, not on any refusal path. A missing or
   never-populated `~/.tronbox` compiler cache is invisible to validation.

If the record genuinely does not describe the artifacts a test run is using — a tree copied
from a different build, a pruned build-info directory — the outcome is a
`build-record-stale` or `build-record-absent` refusal whose remedy is `tronbox compile --all`,
not a silent fallback.

---

## Six mistakes

### 1. Reaching for `unsafeSkipStorageCheck` after a `__gap` refusal

This is the one that turns a transparency gap into a safety regression, and it is why the
refusal message says what it says.

`unsafeSkipStorageCheck` does not disable *slot-position* checking. It disables the storage
check, which discards the appends, reorderings, renames, retypes and deletions AST-only detects
perfectly well. A user who reaches for it because a `__gap` refusal looked inexplicable has
traded two false positives for the whole check. It is a **last resort** — the same standing it
has in the Hardhat plugin's own documentation — and it is deliberately the *only* storage-check
opt-out: there is no narrower slot-data flag, ruled rather than pending (2026-08-04).

The two shapes that need slot positions — consuming a `__gap` array, and inserting into unused
padding inside an existing slot — are refused conservatively rather than silently accepted, and
this version has no path that produces positions. The safe move is to restructure the change as
an append (new variables at the end, `__gap` left in place) rather than to disable the check.

### 2. Paraphrasing the diagnosis

`diagnosis.headline` and `diagnosis.remedy` are the rendering, and
`ValidationInputRefusedError`'s constructor takes no `string` so that they stay it. Seven causes
becoming twenty-one sentences across three consuming sub-features is the failure that
constraint exists to prevent. If a diagnosis reads wrongly for your operation, fix it in
`diagnose.ts` where all consumers get the fix.

### 3. Caching a validation input

An input is a snapshot of the source tree, the artifact and the build record at the moment of
the call. Nothing in it is invalidated when the tree changes. Re-derive per operation; a
derivation is a directory listing and a handful of file reads — never a compile — which is what
makes re-deriving affordable.

There is no module-scope state to reuse anyway: production defaults for `deps` are resolved
inside the call rather than captured at module scope.

### 4. Branching on provenance

`provenance.basis` exists to be *reported*, not to be gated on. It is a single-member union
today — every produced input's basis is `'build-record-ast'` — so a branch on it decides
nothing, and a future second basis (TronBox emitting `storageLayout` into its records) will
arrive as an added member for consumers that *report*, not as a behaviour switch for consumers
that gate.

### 5. Treating `declaration-order-only` as "unchecked"

It is not, and a message that says so would be false. A reconstructed layout is **stricter**
than none and than most people expect: 0 false negatives over the nine measured upgrade pairs,
with the two false positives being safe shapes refused. See the README section
"Validation without storage layouts" for what that mode can and cannot decide, before writing
a sentence about it.

### 6. Catching `ValidationInputInvariantError` to keep going

It means the plugin broke one of its own rules, and its message says so and asks for a report.
Swallowing it converts a reproducible bug report into a mystery. Every *user* condition — a
stale record, an unreadable source, an out-of-range compiler — arrives as a refusal value, so
there is nothing a catch here could legitimately be waiting for.

---

## Where the real fixtures live

For richer fixtures than the examples here, read the suite.

- The pipeline suite under `test/` drives both gate outcomes — fresh, and every per-candidate
  rejection reason — plus the refusal causes, from stubs for `deps.readBuildInfo`, and asserts
  that no path compiles.
- `test/helpers/` ships the fixture builders, the recorded upgrade-pair corpus, and the
  build-record readers the stubs are made from.
- `test/fixtures/` holds the extracted upgrade pairs, including the `__gap` consumption and the
  intra-slot padding pair — the two shapes the pipeline refuses though they are safe.
