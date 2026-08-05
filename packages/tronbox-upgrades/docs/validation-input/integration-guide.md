# Integration guide

Four patterns, in the order a consumer meets them, and then the mistakes worth naming.
[`examples/`](./examples) holds **type-checked counterparts for patterns 1 and 3**, and the
injectable-dependency shape both rely on. **Patterns 2 and 4 — escalating once, and telling a
slot-data refusal apart from a real incompatibility — do not yet have example modules**, so
follow their snippets here rather than expecting a file.

- [Pattern 1 — derive inside the operation](#pattern-1--derive-inside-the-operation)
- [Pattern 2 — escalate once, on any non-empty report](#pattern-2--escalate-once-on-any-non-empty-report)
- [Pattern 3 — state what was checked](#pattern-3--state-what-was-checked)
- [Pattern 4 — expect to compile under `tronbox test`](#pattern-4--expect-to-compile-under-tronbox-test)
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

**Switch on `cause.kind` only when you act differently.** If all eleven causes end the same way
for your operation, the diagnosis is already rendered and there is nothing to switch on. Reach
for `cause.kind` when a category genuinely changes behaviour — cause 9 (`layout-vacuous`) is the
one that is *the plugin's* fault, and an operation that collects bug reports may want to say so.

---

## Pattern 2 — escalate once, on any non-empty report

The fresh path hands you an input whose layout carries no slot positions. That is enough to
decide every upgrade shape except two, and when the engine's report comes back non-empty you do
not yet know which situation you are in. So you re-ask.

```ts
const first = await deriveValidationInput({ contract, env });
if (first.kind === 'refused') { /* … */ }

let input = first.input;
let report = runEngineReport(input);      // yours — the standalone operations'

// Escalate on ANY non-empty report, with no predicate of your own.
if (!report.pass && input.provenance.basis.kind === 'build-record-ast') {
  const escalated = await deriveValidationInput({
    contract,
    env,
    escalateFrom: input,
  });
  if (escalated.kind === 'refused') { /* … */ }

  input = escalated.input;               // basis is now 'plugin-compile'
  report = runEngineReport(input);        // and this report carries slot data
}

if (!report.pass) {
  // Refuse *here*, with positions in hand — so the message can name the number.
}
```

**Do not write a predicate.** The obvious gate — escalate only where every flagged operation is
explicable by missing positions — was specified and then measured unimplementable
(measured with a live gate-observability probe). A genuinely safe intra-slot padding change
and a genuine mid-layout insert produce reports identical in every field a gate could key on: one
`insert` op each, the same `originalLabel: null`, the same absent positions, the same
`changeUncertain: null`. The only difference is the name of the inserted variable, and no gate
may be built on a user-chosen identifier. The position half of such a predicate is worse than
useless — it is a tautology in AST-only mode, scoring true on every genuine reject too.

**The guard is `basis.kind`, not a counter of your own.** Escalation accepts only a
`'build-record-ast'` input and produces a `'plugin-compile'` one, so a second escalation of the
same chain raises `ValidationInputInvariantError`. Reading `basis.kind` before you escalate is
how you avoid provoking a bug report from your own retry logic; a `while` loop around this is
unrepresentable rather than merely discouraged.

**Escalate before you refuse, not after.** This is the part worth being deliberate about. Where
the refusal stands, the escalated report is what makes upstream's `> Set __gap array to size 47`
hint possible, because that number is computed from slot data. Refusing on the AST-only report
does not merely refuse less precisely — it refuses without the one instruction the user needs.

---

## Pattern 3 — state what was checked

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
    break;                                   // positions available
  case 'declaration-order-only':
    input.fidelity.missingFor;                // non-empty, fully-qualified names
    break;
}
```

**The record is the guarantee and the log write is a courtesy.** TronBox replaces the log
channel with a no-op under `--quiet` and `--silent`, and passes a no-op throughout
`tronbox test` — the command that replays every migration on every run. A design that
discharged its degraded-mode obligation through a log line would be silent for every test run.

**Two statements, both meaning something specific:**

| `code` | Means | Which paths |
|---|---|---|
| `storage-layout-unavailable` | the flat layout was reconstructed from the AST, so it carries declaration order and not positions | `fresh` only |
| `namespaced-ast-only` | this contract declares namespaced storage, whose members carry no positions in **either** mode | every path where a namespace is found |

The second one surprises people, so it is worth saying plainly: it is not a fresh-path artefact.
Namespace members get positions only from a second compilation with a storage variable injected
per namespaced struct, which this version does not perform — so a compiled input is in the same
state, and upstream reports nothing because its only slot-absence branch reads the flat
`storage` list, which for a purely namespaced contract is empty. Every OpenZeppelin 5.x contract
is in that state.

---

## Pattern 4 — expect to compile under `tronbox test`

`tronbox test` copies the artifact tree into a temporary directory and points
`contracts_build_directory` at the copy (`build/lib/commands/test.js`) — and it does **not**
redirect `build_info_directory`. So under the test command a build record for your contract is
frequently *present and describing a different build* than the artifacts the run is using.

That is exactly what the content check is for. The record's deployed bytecode does not match the
artifact's, the candidate is rejected as `deployed-bytecode-differs`, the gate reports `stale`,
and the ladder compiles that one contract. Validation runs.

**Two things follow for a consumer:**

1. **Do not treat "under `tronbox test`" as a reason to skip validation.** Refusing there — or
   proceeding unvalidated — would break the workflow for every user of upgradeable contracts,
   which is the reason the ladder falls through to a compile instead of to a refusal.
2. **Budget for one compile per validated contract in a test run, not zero.** The fresh path's
   zero-compile figure describes `tronbox migrate` against a tree the host just built. A test
   run's steady state is one compile of one contract's closure per validation.

It also means cause 1 (`compiler-absent`) is *reachable* under `tronbox test` where it is not on
a fresh path — the compile arm loads a compiler, and a project whose `~/.tronbox` cache was
never populated will hear about it there.

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

The path is: **escalate first**. If the escalated, slot-level check still refuses, the
incompatibility is real and the message can name the `__gap` size to set.

### 2. Paraphrasing the diagnosis

`diagnosis.headline` and `diagnosis.remedy` are the rendering, and
`ValidationInputRefusedError`'s constructor takes no `string` so that they stay it. Eleven causes
becoming thirty-three sentences across three consuming sub-features is the failure that
constraint exists to prevent. If a diagnosis reads wrongly for your operation, fix it in
`diagnose.ts` where all consumers get the fix.

### 3. Caching a validation input

An input is a snapshot of the source tree, the artifact and the build record at the moment of
the call. Nothing in it is invalidated when the tree changes. Re-derive per operation; the fresh
path costs zero compiles, which is what makes re-deriving affordable.

There is no module-scope state to reuse anyway: the compile memo is created per call, and
production defaults for `deps` are resolved inside the call rather than captured at module
scope.

### 4. Branching on whether a compile happened

`provenance.basis` exists to be *reported*, not to be gated on. There is no supported way to
request or forbid a compile, and an operation that behaves differently depending on which path
ran is an operation whose behaviour depends on whether the user recently ran `tronbox compile`.

The one legitimate read is the escalation guard in Pattern 2 — `basis.kind === 'build-record-ast'`
— which asks *"is there anything to escalate to"* rather than *"did we compile"*.

### 5. Treating `declaration-order-only` as "unchecked"

It is not, and a message that says so would be false. A reconstructed layout is **stricter**
than none and than most people expect: 0 false negatives over the nine measured upgrade pairs,
with the two false positives being safe shapes refused. See
[what the fresh path actually costs](./README.md#what-the-fresh-path-actually-costs) before
writing a sentence about it.

### 6. Catching `ValidationInputInvariantError` to keep going

It means the plugin broke one of its own rules, and its message says so and asks for a report.
Swallowing it converts a reproducible bug report into a mystery. The same applies to
`CompilerRetiredError`: a retired compiler is never reused because emscripten's abort poisons
the module, so retrying past it turns one contract's memory ceiling into every later contract's.

---

## Where the real fixtures live

For richer fixtures than the examples here, read the suite.

- `test/ladder-paths.test.ts` drives all four paths and asserts the compile count for each,
  from a stub for `deps.loadCompiler`. It is the executable form of the ladder table.
- `test/helpers/ladder-fixtures.ts` ships the fixture builders, the CBOR metadata split, and the
  compile-counting loader stub.
- `test/fixtures/` holds the extracted upgrade pairs, including the `__gap` consumption and the
  intra-slot padding pair — the two shapes the fresh path refuses though they are safe.
