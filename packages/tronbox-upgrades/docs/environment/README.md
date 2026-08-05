# The TronBox environment seam

> Turns the untyped globals TronBox injects into a migration's sandbox into a frozen,
> validated composite of exactly the capabilities you asked for — or one of three typed
> failures that says which capability is missing and in which invocation contexts it exists
> at all.

**This is not the package README.** It is internal documentation for the sub-features built
on top of this seam. `@openzeppelin/tronbox-upgrades` exposes no part of the environment seam
to end users; the package's public entry point belongs to packaging, and the user-facing
README is assembled and proved followable by the consumer end-to-end harness. See
[`readme-contributions.md`](./readme-contributions.md) for the facts the environment seam
contributes to that README.

**Audience:** the sibling modules that consume the composite — validation and storage
layout, the deploy/upgrade operations, artifact resolution policy, the result and output
contract, packaging.

---

## Why the seam exists

A TronBox migration is evaluated inside a `vm` context. The migration file receives
`deployer`, `artifacts`, `tronWrap`, `tronWeb` and `waitForTransactionReceipt` as
context properties — and a plugin module `require`d from that migration runs in the *outer*
context, where none of them are visible (measured with a live sandbox-visibility probe). So
every capability the plugin needs has to be handed to it explicitly, by the migration, as
arguments.

Those arguments are host objects with no contract. TronBox reads its own configuration
through truthiness-guarded getters that substitute defaults on read, which means a
misspelled network name does not fail — it yields a complete, plausible, entirely fictional
configuration. The seam's job is to be the one place in the package that touches any of
that, so that everything downstream receives copied-out scalars and named handles or
receives nothing.

Two structural rules hold the boundary:

- **`src/environment/**` is the only directory that may read a TronBox-internal property
  path**. There are exactly two private hops in the whole package:
  `deployer.options.options` and `artifacts.resolver.options`
  (`src/environment/config-lineage.ts:inspectConfigLineages`).
- **The seam imports no other sub-feature's module**, so the dependency direction
  is one-way and a sibling can never create a cycle through it.

---

## Quick start

```ts
import { resolveEnvironment } from '../environment';

// Inside a function the migration calls, with the migration's own globals passed in.
const env = resolveEnvironment(
  { deployer, artifacts },
  { require: ['paths', 'network'], optional: ['output'] },
);

env.paths.root;              // AbsolutePath — required, so non-optional here
env.network.name;            // string
env.output?.logger.log('…'); // optional, so `| undefined` in the type
```

Three things to notice, because each is load-bearing:

1. **You ask for slots by name.** Required slots are non-optional in the returned type;
   optional slots are optional; every slot you did not name is structurally absent from the
   type, so it cannot be read at all. The literal arrays are captured by `const`
   type parameters, so `['paths', 'network']` narrows rather than widening to `SlotName[]`.
2. **It is fully synchronous.** No promise, no callback, no timer. It is a pure
   projection of the handles it is given, with no module-scope state — so a stale
   composite carried across migrations is not a rule to remember but a state that cannot be
   represented.
3. **Failure is a typed throw, never a partial composite.** If it returns, every slot you
   required is present.

---

## Key concepts

### Slots and the invocation-context matrix

Seven slots. Which handles back each, and which of the five invocation contexts supply
them, is a table — `src/environment/slots.ts:slotRequirements` — not prose, and error
messages render from that same table, so a table edit cannot leave a message
describing a different matrix.

| Slot | Backed by | Provided in |
|---|---|---|
| `paths` | `deployer` or `artifacts` | `migrate`, `test` migration phase, `test` mocha files |
| `network` | `deployer` or `artifacts` | `migrate`, `test` migration phase, `test` mocha files |
| `artifacts` | `artifacts` | `migrate`, `test` migration phase, `test` mocha files |
| `chain` | `tronWrap` or `tronWeb` | `migrate`, `test` migration phase, `test` mocha files, `console` |
| `receipts` | `waitForTransactionReceipt` | `migrate`, `test` migration phase, `test` mocha files |
| `scheduling` | `deployer` | `migrate`, `test` migration phase |
| `output` | `deployer` or `artifacts` | `migrate`, `test` migration phase |

The fifth context is `plain node` — named deliberately, because `EnvironmentAbsentError` is
the diagnosis for it and an unnamed context would render as an omission in every
`absentIn` list.

### Two Config lineages, cross-checked

TronBox exposes its configuration twice, and the two are not always the same object:

- **via the deployer** — `deployer.options.options`
- **via the artifacts intercept** — `artifacts.resolver.options`

Under `tronbox migrate` they are the identical object. Under `tronbox test` they are
distinct and can genuinely disagree, because
`build/lib/test.js:Test.performInitialDeploy` calls
`config.with({ reset: true, quiet: true, logger: { log(){} } })` and `Config.prototype.with`
returns a materialized snapshot.

When both are reachable, both must project successfully and agree on every field in the
group; agreement yields the value set, disagreement is an `EnvironmentInconsistentError`
naming the field and both values. There is no code path that picks a winner —
`src/environment/config-lineage.ts:compareConfigValues` returns either an empty list or the
disagreements, and no third thing, so the preference path is forbidden by the type rather
than by convention.

The compared field set is a closed **allow-list**,
`src/environment/types.ts:ConfigScalarField`, not a deny-list. That is deliberate:
`config.networks[name]` carries `privateKey` one property away from values the seam
legitimately projects, and the `inconsistent` message prints both compared values verbatim.

### Three diagnoses, strictly ordered

| Error | `code` | Means |
|---|---|---|
| `EnvironmentAbsentError` | `TRONBOX_ENV_ABSENT` | No handle bearing on *any* requested slot was supplied — you are outside a TronBox migration context |
| `EnvironmentIncompleteError` | `TRONBOX_ENV_INCOMPLETE` | A required capability could not be constructed |
| `EnvironmentInconsistentError` | `TRONBOX_ENV_INCONSISTENT` | Every required capability was constructed, and the sources disagree |

The order is enforced structurally, not by a rule repeated at each throw site: every
reachable lineage must construct before any comparison runs
(`src/environment/resolve.ts:resolveGroup`), so `inconsistent` is unreachable while
anything is still unconstructible. The family is fixed at three by
`EnvironmentDiagnosis` — a fourth failure class cannot be added without
deliberately widening that union.

### Provenance

Every composite carries `provenance`, which reports what actually happened rather than
what was expected:

```ts
env.provenance.slots;               // Record<SlotName, 'present' | 'absent'>
env.provenance.configLineages;      // which lineages were reachable, and whether cross-checked
env.provenance.internalPathsRead;   // every TronBox-internal property path this call read
```

`internalPathsRead` is recorded at each read site, never declared centrally, so it
is neither a static list nor a superset. It covers `resolveEnvironment` only — reads
performed later by `artifacts.resolve()` or `artifacts.ambiguities()` are outside the
snapshot.

### Handles are named, never modelled

Where a capability genuinely is a host object, the seam hands over that object under a
fixed name and models nothing about it: `chain.tronWrap`, `scheduling.deployer`,
`artifacts.intercept`, `output.logger`, `receipts.waitForTransactionReceipt`. Two
consequences you must know before you log or serialize anything:

- **The handles are safe in serialization only.** Read
  [`safety.md`](./safety.md#handles-are-safe-in-serialization-only) before writing any
  diagnostic that touches a composite. This is the one thing a consumer can get wrong.
- **`output.logger` declares `log` and nothing else.** Calling `logger.warn` is a
  `TypeError` on four of TronBox's five logger-injection paths. Read
  [`safety.md`](./safety.md#the-logger-declares-log-only).

---

## Documents

| Document | Purpose |
|---|---|
| [`api-reference.md`](./api-reference.md) | Every export, with full TypeScript signatures |
| [`integration-guide.md`](./integration-guide.md) | Three end-to-end consumption patterns, and the mistakes to avoid |
| [`safety.md`](./safety.md) | Secrets, logging, degraded modes, and what the seam does *not* promise |
| [`readme-contributions.md`](./readme-contributions.md) | User-observable facts the environment seam contributes to the package README (the consumer end-to-end harness assembles) |
| [`examples/`](./examples) | Type-checked example modules |
