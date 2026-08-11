# Validation inputs — the build-record gate

> Turns a contract name into the exact standard-JSON input/output pair
> `@openzeppelin/upgrades-core` needs to decide whether an upgrade is storage-safe — by
> reading the build record TronBox already wrote and content-verifying that it describes the
> compiled artifact in hand. Never by compiling: when no record verifies, the outcome is one
> of seven enumerated refusals, each naming the failing thing and what to do about it.

**This is not the package README.** It is internal documentation for the sub-features built on
top of this module. `@openzeppelin/tronbox-upgrades` exposes no part of it to end users; the
package's public entry point belongs to packaging, and the user-facing README is assembled and
proved followable by the consumer end-to-end harness.

**Audience:** the sibling modules that consume a validation input — the deploy/upgrade
operations, artifact resolution policy, the validation call itself, and the result and output
contract.

---

## Why the module exists

`upgrades-core` does not take a contract name. It takes a solc standard-JSON **input** and the
matching **output**, and it reads three things out of them: the ASTs for its own validation
run, `storageLayout` where one is present, and `sources[key].content` for its version check on
namespace annotations. Something has to produce that pair for a TronBox project, and the two
obvious ways to produce it are both wrong:

- **Compile it ourselves.** Correct-looking, and this module's earlier design did it on the
  paths where the record could not be used. The maintainer decision of 2026-08-07 deleted it —
  adopt the Foundry model instead: the plugin validates from the host's own build output and
  never runs a compiler, because the user already holds a remedy that regenerates everything
  at once (`tronbox compile --all`), and an embedded compiler is a second toolchain to keep
  honest against the host's.
- **Trust TronBox's build record on provenance alone.** Free, and wrong: the build-info
  directory is never pruned, so one contract name routinely has several records from several
  moments with no marker saying which describes the artifact in hand.

So the module **content-verifies** the record first, and **refuses** when no candidate
verifies — with the remedy that regenerates the record and the artifact together.

Two structural rules hold the boundary:

- **One function on the face** (`deriveValidationInput`) and no second entry point. `policy`,
  `diagnose`, `detectFidelity` and the rest stay reachable by direct module import — which is
  how the tests see them — but are not exported from
  [`src/validation-input/index.ts`](../../src/validation-input/index.ts), because a consumer
  that could assemble an input from the parts would bypass the refusal policy entirely.
- **A refusal is a value, never a throw.** `deriveValidationInput` returns
  `{ kind: 'refused', cause, diagnosis }`. The only thing it throws denotes a plugin bug:
  `ValidationInputInvariantError`.

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
  // Seven causes, one rendered diagnosis. Never compose your own sentence.
  throw new ValidationInputRefusedError(outcome.cause, outcome.diagnosis);
}

const { solcInput, solcOutput, fidelity, provenance } = outcome.input;
provenance.basis.kind; // 'build-record-ast' — the only producing step there is
```

Two things to notice, because each is load-bearing:

1. **There is no compile and no option to ask for one.** The gate below decides between
   proceeding from the record and refusing with the remedy, from the state of your project.
2. **`env.output` is the operation's own channel, not one this module mints.** A
   reduced-fidelity statement has to ride the operation's returned result, and a result's notes
   are exactly one channel's `recorded`. A channel created here would write notes that reach no
   result.

---

## The gate

Validation **never compiles**. Steps 1 and 2 are a gate; step 3 is its outcome.

1. **Read the host's build record** for this `<source key>:<contract>` pair, from
   `paths.buildInfoDirectory`.
2. **Content-verify each candidate against the artifact** — the artifact's `deployedBytecode`
   against the record's `evm.deployedBytecode.object` — and check the record is usable whole:
   the target's AST closure is complete, the target's definition is present, and the paired
   `<hash>.json` compiler input exists, parses, and is this output's input.
3. **Verified** → validate from the record, `fidelity: 'declaration-order-only'`.
   **Every candidate rejected, or no record at all** → **refuse**.

| Path | Reached when | Outcome | `fidelity` |
|---|---|---|---|
| fresh | a candidate verified and its pair is usable | proceed, from the record | `declaration-order-only` |
| stale | records were located, every candidate rejected | refuse: `build-record-stale`, carrying one `BuildRecordRejection` per candidate | — |
| absent | no build-info directory, or no record for this pair | refuse: `build-record-absent` | — |

Both refusals carry the same remedy, rendered with the reason it always works: run
**`tronbox compile --all`** — the `--all` flag forces recompilation of unchanged sources, so a
fresh build record and artifact are written together even when TronBox considers the project
up to date.

### Why the check is on bytecode and not on source text

Solc's deployed bytecode ends in a CBOR metadata section whose hash covers the sources **and
the settings**. So a source-text comparison can match while `optimizer.runs` or `evmVersion`
differed, and a deployed-bytecode comparison cannot. The bytes compared are already in
TronBox's own `outputSelection`, in the `*.output.json` the build-info reader parses.

Three consequences worth knowing before you rely on it:

- **Any one candidate that verifies is sufficient.** The directory is never pruned and no
  `current` record exists, so a name may have N candidates from N moments; a record whose
  deployed bytecode matches the artifact describes these exact compiled bytes whatever its age.
  Candidates are taken in path order, so a tie is reproducible.
- **The file that verifies is the file consumed.** Verification and AST projection happen
  against the same object, `provenance.basis.gate.file` names it, and
  `provenance.basis.inputFile` names the paired `<hash>.json` the `solcInput` was read from.
- **Empty against empty is refused, not passed.** An interface or abstract contract has
  `deployedBytecode` of `'0x'` against a record `.object` of `''`. Those compare equal while
  comparing nothing, so the candidate is rejected as `'nothing-to-compare'`.

A project setting `metadata.bytecodeHash: "none"` strips the CBOR tail, and the claim weakens
from *"same sources and settings"* to *"same compiled output."* Sound in the safe direction
either way: a mismatch is a rejection that flows into a refusal, never past a check.

### Why `solcInput` is the paired file, verbatim

Consumers receive the recorded compiler input — the `<hash>.json` TronBox wrote next to the
verified `<hash>.output.json` — **narrowed but never reconstructed**. Rebuilding the input
from the contracts directory reads source text that can drift from what was compiled while the
deployed bytecode still verifies, and a consumer decoding the output's AST spans against
drifted text reads the wrong characters. The pair is the one input whose spans match this
output by construction. A candidate whose pair is missing, unparseable or not this output's
input is rejected at the gate (`'input-pair-absent'`, `'input-pair-unparseable'`,
`'input-pair-unusable'`) and the refusal names the file.

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
  at the end — validates identically with no positions involved.
- **Field reordering is still detected.** So are renames, retypes, deletions, struct-member
  insertions and inheritance-order swaps.
- **Exactly two shapes genuinely need slot positions**: consuming a `__gap` array (`48 → 47`
  plus a new variable, the OpenZeppelin idiom), and inserting into unused padding inside an
  existing slot (`bool` added beside an `address`).

**Both of those are refused rather than accepted.** So the limitation is not that unsafe
upgrades slip through — it is that those two shapes are refused *even when they are safe*. It
fails in the correct direction, and the practical way out is to restructure the change as an
append. The user-facing statement of this trade lives in the package README, section
**"Validation without storage layouts"**.

Measured over nine upgrade pairs, run through the same `upgrades-core` in both modes
(measured with a live AST-only-vs-slot-level compile probe, before the compiler was deleted):

| | AST-only |
|---|---|
| Unsafe upgrade wrongly **accepted** (false negative) | **0** |
| Safe upgrade wrongly **rejected** (false positive) | **2** |

The two false positives are exactly the `__gap` and intra-slot-padding shapes. That is the only
fidelity measurement this module has, and it is the only one to quote.

It is still **stated** rather than silent. Every fresh path records a
`storage-layout-unavailable` degraded note on the operation's channel, and the note states
only what ran: positions were unavailable, the comparison used declaration order, and the
README section above says what that mode can and cannot decide.

**If a refusal looks wrong, the escape hatch is upstream's existing
`unsafeSkipStorageCheck` — passed through unchanged, and a last resort.** It disables the
whole storage check, not just the position-dependent part, so everything AST-only detects
perfectly well goes with it. There is deliberately no narrower slot-data flag: the maintainer
ruled the pass-through sufficient (2026-08-04), and two refused-though-safe shapes — both
restructurable as appends — do not justify a second opt-out surface.

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
`evm.deployedBytecode.object` and `metadata` byte-identical (measured with a live
recompile-fidelity probe, part 1), so it cannot perturb existing builds. Nothing in this
module is built against that future — `detectFidelity` runs unconditionally over the real
output rather than assuming the answer, so the day the host starts emitting layouts, the
same build-record read carries them and the pipeline's return-boundary assertion is what
notices first.

---

## Key concepts

### Seven causes, one rendered diagnosis each

Every reason this module cannot produce an input is a member of a **closed** union, `Cause`.
Closed is the property that matters: it makes one generic *"could not validate"* covering
seven situations unrepresentable, and it makes *"every obligation has a diagnosis"* checkable
by the compiler rather than by review — an eighth member is a compile error until a headline, a
remedy and a policy row exist for it.

| # | `kind` | Fires when |
|---|---|---|
| 1 | `compiler-unsupported` | the project's version is outside `SUPPORTED_SOLC` (0.8.0–0.8.26) |
| 2 | `source-unreadable` | a source in the closure is missing, or present and unreadable |
| 3 | `import-unresolvable` | an import does not resolve to a source the plugin may read |
| 4 | `artifact-shape-unsupported` | the artifact lacks a field validation needs |
| 5 | `build-record-absent` | no build-info directory, or no record for this contract |
| 6 | `build-record-stale` | records exist and every candidate was rejected, each with its reason |
| 7 | `library-name-unsupported` | a linked library's name is past the length the host encodes |

This union used to have eleven members, four of them about the plugin's own embedded
compiler (`compiler-absent`, `compiler-mismatched`, `compiler-resource-exhausted`,
`sources-do-not-compile`) — deleted with it. `artifact-stale` was absorbed into
`build-record-stale`: the recompiled-vs-artifact comparison is gone, and the
record-vs-artifact freshness comparison that remains is decided per candidate at the gate,
with the file named. `layout-vacuous` went the same way — the hazard is decided per candidate
(`'target-definition-absent'`) and flows into `build-record-stale`.

Cause 1 loads nothing: no compiler is ever located or read, but the range still gates which
solc **output** this plugin interprets — measurement showed a sub-0.5.13 compiler accepting a
`storageLayout` request with zero diagnostics and simply omitting the key.

Two properties of the messages, both enforced rather than reviewed: every headline interpolates
the concrete failing thing its own cause carries — the contract, the source key and path, the
specifier and its importer, the rejected record files and their reasons, the library and its
band — and every remedy is **distinct** across the seven. The pair that makes that rule earn
its keep is 5 versus 6: both are fixed by `tronbox compile --all`, and the remedy's tail is
what tells the user which situation they are in — a record written where none existed, versus
a record and artifact regenerated to describe the same compile.

Every payload field is a scalar or a closed union, so no source text, settings object, host
handle or upstream `Error` can be assigned to one. Source text lives at exactly one address in
this module's output: `solcInput.sources[key].content`.

### One policy point

`refuse` versus `proceed-reduced` is decided by one total function over one table, with one
importer and one call site — [`src/validation-input/policy.ts`](../../src/validation-input/policy.ts).
**v1 refuses on all seven.** The table is not injectable: a swappable table would restore
per-call-site variation through the back door, so `ValidationInputDependencies` has no `policy`
member.

Cause determination and message rendering are independent of it. `diagnose.ts` does not import
`policy.ts`, so a leniency change provably cannot alter what a refusal says.

### Namespaced storage is a shortfall on the producing path

Every OpenZeppelin 5.x contract puts its storage in a namespaced struct, and namespace members
are compared **without positions**: slot positions for them require a second compilation of
the same sources with a storage variable injected per namespaced struct, which this plugin
performs in no mode — it performs no compilation at all.

**The plugin states that shortfall itself.** Upstream's only slot-absence notice asks
`original.storage.some(item => item.slot === undefined)` — and a purely namespaced contract has
`storage: []`, so the branch never fires while every namespace member carries `slot: undefined`
(measured with a live namespaced-without-second-compile probe). So a
`namespaced-ast-only` degraded note is recorded whenever the produced input finds a namespace.

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
input.provenance.basis.kind;       // 'build-record-ast' — single-member union
input.provenance.basis.gate.file;  // the record that verified
input.provenance.basis.inputFile;  // the paired <hash>.json solcInput came from
input.provenance.sourceKeys;       // every key in solcInput, in the input's own order
input.fidelity.kind;               // 'declaration-order-only' today
```

`basis` keeps its discriminant although it has one member: the Foundry model has exactly one
producing step, and a future second basis (TronBox emitting `storageLayout`, say) is then an
added member rather than a reshaping — a consumer switching on `kind` today is already total.
On the fresh path no compiler is located, loaded or read at all — there is no identity to
record, and `solcVersion` is the artifact's own long version, which the bytecode match
verified by content.

`fidelity` is never optional, and the pipeline's return boundary asserts it against the step
that produced it: the fresh path — the only producing step — reports `declaration-order-only`
with a non-empty `missingFor`, because no supported TronBox requests `storageLayout`. The
detector still runs over the real output rather than being assumed, so the day the host emits
layouts, the boundary assertion fails loudly at the moment the claim changes.

---

## Documents

| Document | Purpose |
|---|---|
| [`api-reference.md`](./api-reference.md) | Every export, with full TypeScript signatures |
| [`integration-guide.md`](./integration-guide.md) | End-to-end consumption patterns, and the mistakes to avoid |
| [`examples/`](./examples) | Type-checked example modules |
