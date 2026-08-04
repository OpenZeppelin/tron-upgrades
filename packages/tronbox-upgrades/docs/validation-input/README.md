# Validation inputs — the lazy compile ladder

> Turns a contract name into the exact standard-JSON input/output pair
> `@openzeppelin/upgrades-core` needs to decide whether an upgrade is storage-safe — reusing
> the build record TronBox already wrote when it describes the same compiled bytes, and
> compiling one contract when it does not. Or one of eleven enumerated refusals, each naming
> the failing thing and what to do about it.

**This is not the package README.** It is internal documentation for the sub-features built on
top of this module. `@openzeppelin/tronbox-upgrades` exposes no part of it to end users; the
package's public entry point is SF-11's, and the user-facing README is assembled and proved
followable by SF-12. See [`readme-contributions.md`](./readme-contributions.md) for the facts
this module contributes to that README.

**Audience:** the sibling modules that consume a validation input — the deploy/upgrade
operations (SF-4), artifact resolution policy (SF-5), the validation call itself (SF-6), and
the result and output contract (SF-10).

---

## Why the module exists

`upgrades-core` does not take a contract name. It takes a solc standard-JSON **input** and the
matching **output**, and it reads three things out of them: the ASTs for its own validation
run, `storageLayout` where one is present, and `sources[key].content` for its version check on
namespace annotations. Something has to produce that pair for a TronBox project, and the two
obvious ways to produce it are both wrong:

- **Always compile.** Correct, and it costs a full solc invocation on every upgrade — including
  under `tronbox test`, where every migration is replayed on every run.
- **Always reuse TronBox's build record.** Free, and the record cannot be trusted on
  provenance alone: the build-info directory is never pruned, so one contract name routinely
  has several records from several moments with no marker saying which describes the artifact
  in hand.

So the module does neither. It **content-verifies** the record first, and compiles only when
verification fails or when the alternative was refusing anyway.

Two structural rules hold the boundary:

- **One function on the face** (`deriveValidationInput`) and no second entry point. `policy`,
  `diagnose`, `detectFidelity`, `buildSolcInput` and the rest stay reachable by direct module
  import — which is how the tests see them — but are not exported from
  [`src/validation-input/index.ts`](../../src/validation-input/index.ts), because a consumer
  that could assemble an input from the parts plus its own compile would bypass the refusal
  policy entirely.
- **A refusal is a value, never a throw.** `deriveValidationInput` returns
  `{ kind: 'refused', cause, diagnosis }`. The only two things it throws denote plugin bugs:
  `ValidationInputInvariantError` and `CompilerRetiredError`.

---

## Quick start

```ts
import { deriveValidationInput } from '../validation-input';

const outcome = await deriveValidationInput({
  contract: 'MyToken',
  env: {
    paths: env.paths,          // contractsDirectory, buildInfoDirectory, root
    artifacts: env.artifacts,  // resolve, record
    compiler: env.compiler,    // resolvedVersion, settings, family
    output: channel,           // note, degraded — the operation's own channel
  },
});

if (outcome.kind === 'refused') {
  // Eleven causes, one rendered diagnosis. Never compose your own sentence.
  throw new ValidationInputRefusedError(outcome.cause, outcome.diagnosis);
}

const { solcInput, solcOutput, fidelity, provenance } = outcome.input;
provenance.basis.kind; // 'build-record-ast' → nothing was compiled
```

Three things to notice, because each is load-bearing:

1. **You did not say whether to compile, and there is no option to.** The decision is the
   ladder below, taken from the state of your project.
2. **`env.output` is the operation's own channel, not one this module mints.** A
   reduced-fidelity statement has to ride the operation's returned result, and a result's notes
   are exactly one channel's `recorded`. A channel created here would write notes that reach no
   result.
3. **The signature is `async` and the compile is not.** `solidity_compile` is a synchronous
   `cwrap` that blocks the event loop for its whole duration, so there is no wall-clock bound
   to be had from a `Promise` — the async signature exists for the caller's convenience, and
   `AbortSignal` would be a promise this module cannot keep.

---

## The ladder

Validation compiles **lazily**. Steps 1 and 2 are a gate; steps 3 through 5 are its outcomes.

1. **Read the host's build record** for this `<source key>:<contract>` pair, from
   `paths.buildInfoDirectory`.
2. **Content-verify it against the artifact** — the artifact's `deployedBytecode` against the
   record's `evm.deployedBytecode.object`.
3. **Verified** → validate from the record's ASTs. **Zero compiles.**
4. **Stale or absent** → compile that one contract and its import closure.
5. **An AST-only check refuses on a shape that needs slot positions** → compile that one
   contract and re-ask.

| Path | Reached when | Compiles | `fidelity` |
|---|---|---|---|
| `fresh` | a record was located and verified | **0** | `declaration-order-only` |
| `stale` | records were located, every candidate rejected | 1 | `slot-level` |
| `absent` | no record for this pair | 1 | `slot-level` |
| `escalated` | **from `fresh` only**, on a non-empty AST-only report | 1 | `slot-level` |

Measured compile counts, taken from a stub for `deps.loadCompiler`:
`fresh` **0**, `stale` **1**, `absent` **1**, `escalated` **1** — one contract's closure, never
the project.

**The common path costs zero compiles**, and a compile happens only when the record does not
describe the artifact or when the alternative was refusing anyway.

### Why the check is on bytecode and not on source text

Solc's deployed bytecode ends in a CBOR metadata section whose hash covers the sources **and
the settings**. So a source-text comparison can match while `optimizer.runs` or `evmVersion`
differed, and a deployed-bytecode comparison cannot. It also needs no extra read:
`evm.deployedBytecode.object` is already in TronBox's own `outputSelection`, in the
`*.output.json` the build-info reader parses — the paired `*.input.json` stays unread.

Three consequences worth knowing before you rely on it:

- **Any one candidate that verifies is sufficient.** The directory is never pruned and no
  `current` record exists, so a name may have N candidates from N moments; a record whose
  deployed bytecode matches the artifact describes these exact compiled bytes whatever its age.
  Candidates are taken in path order, so a tie is reproducible.
- **The file that verifies is the file consumed.** Verification and AST projection happen
  against the same object, and `provenance.basis.gate.file` names it.
- **Empty against empty is refused, not passed.** An interface or abstract contract has
  `deployedBytecode` of `'0x'` against a record `.object` of `''`. Those compare equal while
  comparing nothing, so the candidate is rejected as `'nothing-to-compare'`.

A project setting `metadata.bytecodeHash: "none"` strips the CBOR tail, and the claim weakens
from *"same sources and settings"* to *"same compiled output."* Sound in the safe direction
either way: a mismatch sends the caller to the compiler, never past a check.

---

## What the fresh path actually costs

**This is the section to read before writing anything about the fresh path**, because the
tempting summary — *"no storage checking"* — is false, and stating it would be worse than
saying nothing.

On the fresh path there is no `storageLayout` in the output, because TronBox never asks solc
for one. `upgrades-core` handles that by **reconstructing the layout from the contract's own
AST** (`dist/storage/extract.js:extractStorageLayout`), and a reconstructed layout makes the
engine **stricter, not blinder**:

- **Appends are structurally exempt.** The most common upgrade shape there is — add a variable
  at the end — validates identically with no compiler involved.
- **Field reordering is still detected.** So are renames, retypes, deletions, struct-member
  insertions and inheritance-order swaps.
- **Exactly two shapes genuinely need slot positions**: consuming a `__gap` array (`48 → 47`
  plus a new variable, the OpenZeppelin idiom), and inserting into unused padding inside an
  existing slot (`bool` added beside an `address`).

**Both of those are refused rather than accepted.** So the limitation is not that unsafe
upgrades slip through — it is that those two shapes are refused *even when they are safe*. It
fails in the correct direction.

Measured over nine upgrade pairs, run through the same `upgrades-core` in both modes
(`evidence/probe-ast-only-vs-slot-level.js`):

| | AST-only |
|---|---|
| Unsafe upgrade wrongly **accepted** (false negative) | **0** |
| Safe upgrade wrongly **rejected** (false positive) | **2** |

The two false positives are exactly the `__gap` and intra-slot-padding shapes. That is the only
fidelity measurement this module has, and it is the only one to quote.

Step 5 exists for those two rows: on a non-empty AST-only report the caller re-asks with
`escalateFrom`, and the compile that follows decides the shape with positions. So the fresh
path's reduced fidelity is not a hole — it is a cost deferred until something actually needs
paying for.

It is still **stated** rather than silent. Every fresh path records a
`storage-layout-unavailable` degraded note on the operation's channel, and the note's remedy is
that no action is needed because escalation will compile before refusing anything.

**If a refusal still looks wrong after escalation, the escape hatch is upstream's existing
`unsafeSkipStorageCheck` — passed through unchanged, and a last resort.** It disables the whole
storage check, not just the position-dependent part, so everything AST-only detects perfectly
well goes with it. There is deliberately no narrower slot-data flag: the maintainer ruled the
pass-through sufficient (2026-08-04), and the measured false-positive rate — two shapes over
nine pairs, both resolved by escalation — does not justify a second opt-out surface.

**One known limitation, currently unreachable and canaried.** Solidity 0.8.29's custom
storage layouts (`layout at <slot>`) are outside TronBox's compiler ceiling (0.8.26), so no
TronBox project can produce one today — which matters because the validation engine's
base-slot comparison for the slot-less mode is defeated upstream: the layout-rebuild that
every without-storage-layouts consumer reads through drops `baseSlot`, so a base-slot change
would pass silently — filed and confirmed as
<https://github.com/OpenZeppelin/openzeppelin-upgrades/issues/1296>, where the fix will land. Two suite canaries pin the boundary — one fails
when an upstream release fixes the rebuild, one fails when a TronBox release raises the
compiler ceiling — so the question reopens deliberately before the first affected contract
can compile. The one base-slot change that IS expressible today, renaming an ERC-7201
`@custom:storage-location` id, is refused in both validation modes.

**The long-term path is upstream of this plugin entirely**: a TronBox feature request to add
`storageLayout` to its compiler `outputSelection`, which would make every build record carry
positions and retire the fresh path's shortfall without a plugin change. The request ships with
evidence already measured here: adding that one entry leaves `evm.bytecode.object`,
`evm.deployedBytecode.object` and `metadata` byte-identical
(`evidence/probe-recompile-fidelity.js` §1), so it cannot perturb existing builds. Nothing in
this module is built against that future — if it lands, the ladder simply stops degrading.

---

## Escalation

**Escalation is caller-driven, and it has to be.** The report it turns on compares the new
layout against the **deployed** implementation's, which this module never sees. So the caller
re-asks with the input it already holds:

```ts
const first = await deriveValidationInput({ contract, env });
// … run the engine, get a report …
if (report.pass === false) {
  const second = await deriveValidationInput({
    contract,
    env,
    escalateFrom: first.input, // basis must be 'build-record-ast'
  });
  // … re-run the engine against `second`, which carries slot positions …
}
```

**It fires once, structurally rather than by a counter.** `escalateFrom` is accepted only when
its basis is `'build-record-ast'`, and what escalation returns is a `'plugin-compile'` input —
so escalating an escalated input is a `ValidationInputInvariantError`, and a loop is
unrepresentable rather than merely unobserved.

**There is no predicate on which reports escalate.** The obvious gate — escalate only where
every flagged operation is explicable by missing positions — was specified and then measured
unimplementable (`evidence/probe-p4-gate-observability.js`). On the decisive pair, a genuinely
safe intra-slot padding change and a genuine mid-layout insert produce reports identical in
every field a gate could key on: one `insert` op each, the same `originalLabel: null`, the same
absent positions, the same `changeUncertain: null`. The only difference is the name of the
inserted variable, and no gate may be built on a user-chosen identifier.

What that costs is one compile before refusing a genuine incompatibility. What it buys is two
things, and the second matters more than the extra accept:

- an escalation only ever happens where the alternative was refusing, so the compile is spent
  on a path that otherwise ends in a rejection the user has to debug;
- where the refusal stands, it can **name the number to change**. Upstream's
  `> Set __gap array to size 47` hint is computed from slot data, so escalating before a `__gap`
  refusal is what turns *"something is wrong with your storage"* into an instruction.

---

## Key concepts

### Eleven causes, one rendered diagnosis each

Every reason this module cannot produce an input is a member of a **closed** union, `Cause`.
Closed is the property that matters: it makes one generic *"could not validate"* covering
eleven situations unrepresentable, and it makes *"every obligation has a diagnosis"* checkable
by the compiler rather than by review — a twelfth member is a compile error until a headline, a
remedy and a policy row exist for it.

| # | `kind` | Fires when |
|---|---|---|
| 1 | `compiler-absent` | the version this project compiles with is not in `~/.tronbox` |
| 2 | `compiler-unsupported` | the version is outside `SUPPORTED_SOLC` (0.8.0–0.8.26) |
| 3 | `compiler-mismatched` | the loaded compiler's **long** version is not the artifact's |
| 4 | `source-unreadable` | a source in the closure is missing, or present and unreadable |
| 5 | `import-unresolvable` | an import does not resolve to a source the plugin may supply |
| 6 | `artifact-shape-unsupported` | the artifact lacks a field validation needs |
| 7 | `artifact-stale` | recompiling the sources produces different code |
| 8 | `compiler-resource-exhausted` | the wasm hit its own memory ceiling on this closure |
| 9 | `layout-vacuous` | the layout is empty for a contract that declares state |
| 10 | `library-name-unsupported` | a linked library's name is past the length the host encodes |
| 11 | `sources-do-not-compile` | the sources on disk do not compile |

Two properties of the messages, both enforced rather than reviewed: every headline interpolates
the concrete failing thing its own cause carries — the contract, the source key and path, the
specifier and its importer, the two long versions that disagreed, the library and its band —
and every remedy is **distinct** across the eleven. The pair that makes that rule earn its keep
is 7 versus 11: both are fixed by running `tronbox compile`, and the remedy is what tells the
user which situation they are in.

Every payload field is a scalar or a closed union, so no source text, settings object, host
handle or upstream `Error` can be assigned to one. Source text lives at exactly one address in
this module's output: `solcInput.sources[key].content`.

### One policy point

`refuse` versus `proceed-reduced` is decided by one total function over one table, with one
importer and one call site — [`src/validation-input/policy.ts`](../../src/validation-input/policy.ts).
**v1 refuses on all eleven.** The table is not injectable: a swappable table would restore
per-call-site variation through the back door, so `ValidationInputDependencies` has no `policy`
member.

Cause determination and message rendering are independent of it. `diagnose.ts` does not import
`policy.ts`, so a leniency change provably cannot alter what a refusal says.

### Namespaced storage is a shortfall on *every* path

Every OpenZeppelin 5.x contract puts its storage in a namespaced struct, and namespace members
are compared **without positions** whether the flat layout came from a build record or from
this plugin's own compile. Slot positions for them require a second compilation of the same
sources with a storage variable injected per namespaced struct, which this version does not
perform in either mode.

**The plugin states that shortfall itself.** Upstream's only slot-absence notice asks
`original.storage.some(item => item.slot === undefined)` — and a purely namespaced contract has
`storage: []`, so the branch never fires while every namespace member carries `slot: undefined`
(`evidence/probe-namespaced-without-second-compile.js`, measured in both modes). So a
`namespaced-ast-only` degraded note is recorded on every path that finds a namespace.

**What the note means, bounded by the upstream maintainer's ruling (2026-08-04): it is a
fidelity statement, not a safety warning.** A real change to a namespaced struct still surfaces
as a name or type change and is refused — the divergence direction without positions is
over-rejection, never silent acceptance. The note tells a caller how much the comparison could
see, not that anything was unsafe.

`flat === false` is read only as corroboration, never as the signal:
`dist/storage/extract.js` sets `flat = true` *inside* the loop over `storageLayout.storage`, so
a purely namespaced contract compiled **with** a full layout still reports `flat: false`.

### Provenance

Every input carries `provenance`, which reports what happened rather than what was expected:

```ts
input.provenance.basis.kind;        // 'build-record-ast' | 'plugin-compile'
input.provenance.partition.closure; // every source key, in the input's own order
input.fidelity.kind;                // 'slot-level' | 'declaration-order-only'
```

`basis` is a closed union rather than a set of optional fields, so *"which compiler ran"* and
*"which record verified"* can be neither both absent nor both present. On the fresh path no
compiler is located, loaded or read at all — there is no identity to record, and `solcVersion`
is the artifact's own long version, which the bytecode match verified by content.

`fidelity` is never optional, and the pipeline's return boundary asserts the biconditional
against the step that produced it: the fresh path reports `declaration-order-only` with a
non-empty `missingFor`, the three compiling paths report `slot-level`. An unconditional
`slot-level` claim — which this pipeline once carried — is a permissive mislabel, and it is the
bug the fidelity detector was rewritten to remove.

---

## Documents

| Document | Purpose |
|---|---|
| [`api-reference.md`](./api-reference.md) | Every export, with full TypeScript signatures |
| [`integration-guide.md`](./integration-guide.md) | Four end-to-end consumption patterns, and the mistakes to avoid |
| [`safety.md`](./safety.md) | The two refused-though-safe shapes, what is not promised, and the one trap |
| [`readme-contributions.md`](./readme-contributions.md) | User-observable facts this module contributes to the package README (SF-12 assembles) |
| [`examples/`](./examples) | Type-checked example modules |
