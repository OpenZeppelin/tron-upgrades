# Integration guide

Three patterns, in the order you will need them. Every snippet here is type-checked — see
[`examples/`](./examples) for the compiling versions and how to run the check.

- [Pattern 1: resolve inside an operation, asking for the minimum](#pattern-1-resolve-inside-an-operation-asking-for-the-minimum)
- [Pattern 2: inject a build-info reader so your own tests need no build tree](#pattern-2-inject-a-build-info-reader-so-your-own-tests-need-no-build-tree)
- [Pattern 3: render the invocation-context matrix instead of restating it](#pattern-3-render-the-invocation-context-matrix-instead-of-restating-it)
- [Common mistakes](#common-mistakes)

---

## Pattern 1: resolve inside an operation, asking for the minimum

This is the pattern for every sub-feature that needs host capabilities. Resolve **inside**
the function the migration calls, from handles the caller passes in — never at module load,
and never from an ambient global.

```ts
import {
  resolveEnvironment,
  type RawMigrationHandles,
} from '../environment';

export interface ValidateOptions {
  readonly handles: RawMigrationHandles;
  readonly contractName: string;
}

export function validateContract(options: ValidateOptions): string {
  const env = resolveEnvironment(options.handles, {
    require: ['paths', 'artifacts'],
    optional: ['output'],
  });

  // `paths` and `artifacts` are required, so they are non-optional here.
  const resolution = env.artifacts.resolve(options.contractName);

  // `output` is optional, so it is `OutputChannelSlot | undefined`.
  env.output?.logger.log(`resolving under ${env.paths.root}`);

  switch (resolution.status) {
    case 'unique':
      return resolution.sourcePath;
    case 'ambiguous':
      // Detection only. The refusal-or-pick policy belongs to
      // the proxy operations.
      return resolution.candidates[0]?.sourcePath ?? options.contractName;
    case 'indeterminate':
      // Routine — build info is never written under `tronbox test`.
      return options.contractName;
  }
}
```

### Ask for the minimum, and mean it

`spec.require` is not documentation. It changes both the type and the work performed:

- **The type.** A slot you did not name is *absent from the type*, so a later refactor cannot
  quietly start reading it. This is what lets every consumer omit null checks.
- **The work.** The cross-check compares exactly the field groups the requested slots expose,
  and the ambiguity index is built only if something asks for it. A resolution that does not
  request the index performs **zero** disk and zero network operations.

So `require: ['paths']` and `require: slotNames` are genuinely different calls, not different
spellings of one call.

### Required versus optional is a policy decision

Putting a slot in `require` means *"this operation cannot proceed without it, and the user
should get a named diagnosis saying where it exists."* Putting it in `optional` means *"use it
if it is there."*

The distinction matters most for `output` and `scheduling`, which are the two slots absent
from `tronbox console` and `plain node`. If your operation should work in a console session,
`output` belongs in `optional`.

### Handle the three errors structurally, never by message

Narrow with `instanceof`, **not** by switching on `code`:

```ts
import {
  EnvironmentAbsentError,
  EnvironmentIncompleteError,
  EnvironmentInconsistentError,
  resolveEnvironment,
  TronBoxEnvironmentError,
  type RawMigrationHandles,
} from '../environment';

export function describeEnvironmentFailure(
  handles: RawMigrationHandles,
): string | undefined {
  try {
    resolveEnvironment(handles, { require: ['paths', 'network'] });
    return undefined;
  } catch (error) {
    if (!(error instanceof TronBoxEnvironmentError)) {
      throw error; // Not ours — do not swallow it.
    }
    if (error instanceof EnvironmentAbsentError) {
      return `Run this through \`tronbox migrate\`; nothing bearing on ` +
        `[${error.requested.join(', ')}] was supplied.`;
    }
    if (error instanceof EnvironmentIncompleteError) {
      // Structured. Read it; do not parse the message.
      return error.unsatisfied
        .map(item => `${item.slot}: available in ${item.providedIn.join(', ')}`)
        .join('\n');
    }
    if (error instanceof EnvironmentInconsistentError) {
      return error.inconsistencies.map(item => item.kind).join(', ');
    }
    return error.message;
  }
}
```

> **Why not `switch (error.code)`?** `code` discriminates a *union* of the three classes, but
> a `catch` gives you the base class, and TypeScript does not narrow a class to its subclass
> from a literal property. Verified: switching on `code` and then reading `error.unsatisfied`
> is `TS2339: Property 'unsatisfied' does not exist on type 'TronBoxEnvironmentError'`. Use
> `code` when you are *reporting* the diagnosis; use `instanceof` when you need the payload.

`error.unsatisfied` and `error.inconsistencies` are the structured forms, and they carry
strictly more than the message: `providedIn` / `absentIn` per slot, the exact failing property
path, and whether that path was absent or **threw** when read. Rendering your own message from
those is better than forwarding the seam's, because you know the operation the user was
attempting and the seam does not.

### Memoize on a handle, never on the `Config`

If resolving per call is too much, memoize — but key on `deployer` or `artifacts`:

```ts
const perMigration = new WeakMap<object, ReturnType<typeof resolveFor>>();

function resolveFor(handles: RawMigrationHandles) {
  return resolveEnvironment(handles, { require: ['paths', 'network', 'artifacts'] });
}

export function cachedEnvironment(handles: RawMigrationHandles) {
  const key = handles.artifacts;
  if (typeof key !== 'object' || key === null) {
    return resolveFor(handles); // Nothing stable to key on.
  }
  let env = perMigration.get(key);
  if (env === undefined) {
    env = resolveFor(handles);
    perMigration.set(key, env);
  }
  return env;
}
```

`deployer` and `artifacts` are fresh per migration; the `Config` is **shared** across them.
A `Config`-keyed memo serves migration *N*'s composite to migration *N+1*. When you
key on one handle, `resolveEnvironment`'s own resolver-pairing check covers the other — that
is what makes a single-handle key safe.

---

## Pattern 2: inject a build-info reader so your own tests need no build tree

`resolveEnvironment`'s third parameter is the seam's one injection point. Use it to drive the
degraded paths without constructing a corrupt build directory on a real disk.

```ts
import {
  resolveEnvironment,
  type BuildInfoReader,
  type BuildInfoReadResult,
  type AbsolutePath,
  type RawMigrationHandles,
} from '../environment';

/** An in-memory reader over a name → parsed-output map. */
export function inMemoryReader(
  store: ReadonlyMap<string, unknown>,
): BuildInfoReader {
  return {
    read(buildInfoDirectory: AbsolutePath): BuildInfoReadResult {
      const files = [...store.entries()].map(([name, output]) => ({
        file: `${buildInfoDirectory}/${name}` as AbsolutePath,
        output,
      }));
      return files.length === 0
        ? { status: 'absent' }
        : { status: 'files', files };
    },
    // Answer the probe from the same store, so both methods are real.
    exists(file: AbsolutePath): boolean {
      return store.has(file.slice(file.lastIndexOf('/') + 1));
    },
  };
}

export function resolveWithFixture(
  handles: RawMigrationHandles,
  store: ReadonlyMap<string, unknown>,
) {
  return resolveEnvironment(
    handles,
    { require: ['paths', 'artifacts'] },
    { buildInfoReader: inMemoryReader(store) },
  );
}
```

Three rules for an implementation of this interface:

1. **`exists` must be stat-class.** `try { fs.readFileSync(file); return true } catch { return false }`
   satisfies the signature and defeats the point — it puts the file's bytes inside the seam and
   makes a large corrupt file cost a full read to answer a boolean.
2. **`exists` is required, not optional.** An optional probe would force `resolvePackaged` to
   keep a fallback for readers that decline it, which is where the missing-versus-malformed
   split would quietly regress to one message.
3. **Both methods must be synchronous.** An `async` reader does not type-check, and that is
   deliberate.

To reach all three `IndeterminateReason` branches, return each `read` status in turn:
`{ status: 'absent' }`, `{ status: 'unreadable', file, cause }`, and a `files` entry whose
`output` lacks a `contracts` object record.

> **Going deeper than this is a direct-module import.** `test/performance-and-reuse.test.ts`
> drives the artifact layer with **no TronBox present at all**, by importing
> `createArtifactAccess`, `buildProjectPaths` and `assertAbsolutePath` from their modules
> rather than through the seam's face. That is deliberate and test-only:
> `src/environment/index.ts` re-exports neither `createArtifactAccess` nor
> `assertAbsolutePath`, and without the latter you cannot mint the `AbsolutePath` brand a
> hand-built `ProjectPaths` needs. `buildArtifactAmbiguityIndex` *is* exported, but its
> `ProjectPaths` argument can only come from a resolved composite. So the supported
> injection point for consumers is `deps.buildInfoReader`, and the deeper embed is available
> to tests inside this package.

---

## Pattern 3: render the invocation-context matrix instead of restating it

When you tell a user a capability is unavailable, read the matrix. Do not hardcode a context
list — it will drift, and the seam's own error messages will then contradict yours.

```ts
import { slotRequirements, slotNames, type SlotName } from '../environment';

export function whereIsAvailable(slot: SlotName): string {
  const requirement = slotRequirements[slot];
  return [
    `"${slot}" needs one of: ${requirement.handles.join(', ')}`,
    `available in: ${requirement.providedIn.join(', ')}`,
    `absent in: ${requirement.absentIn.join(', ')}`,
  ].join('\n');
}

/** Every slot, for a `--verbose` diagnostic. */
export function capabilityTable(): string {
  return slotNames.map(whereIsAvailable).join('\n\n');
}
```

`absentIn` is computed as the complement of `providedIn` over all five contexts, so the two
can never disagree, and `EnvironmentIncompleteError`'s own message renders from this same
table.

`slotNames` is a frozen tuple, so it also serves as the "everything" spec:

```ts
const env = resolveEnvironment(handles, { require: slotNames });
// Every slot non-optional, fully narrowed.
```

---

## Common mistakes

**Treating `resolve()`'s `indeterminate` status as an error.** It is the normal state under
`tronbox test`, where build info is never written. Handling it as a failure breaks
`tronbox test` for every user.

**Reading `contract` off an `ambiguous` or `indeterminate` resolution.** Those branches carry
`unverifiedContract`. The name is different on purpose — it is the type system refusing to let
you store an unverified abstraction in a verified position.

**Calling `logger.warn`.** It does not compile, and if you route around the type it is a
`TypeError` under `--quiet` and under `tronbox test`. Probe first — see
[`safety.md`](./safety.md#the-capability-probe).

**Using `origin` or `hostQuietRequested` to decide whether output is visible.** Neither is a
visibility signal. A discarding channel is the normal case in two of five contexts. Put
anything that matters in the return value or in a thrown error.

**`console.log(env.scheduling)` while debugging.** The `toJSON` redaction is invisible to
`console.log` and to `util.inspect`. `JSON.stringify(env)` is safe; inspecting a raw handle is
not. See [`safety.md`](./safety.md#handles-are-safe-in-serialization-only).

**Substituting `config.resolver` for `artifacts.intercept`.** Abstractions from a fresh
resolver are functionally identical and absent from the intercept's cache, so the operation
succeeds and the deployed address is silently missing from the saved artifact afterwards.
Nothing fails; `artifacts.require('X').address` just returns the previous run's value, or
nothing.

**Memoizing a composite keyed on the `Config`.** The `Config` is shared across migrations.
Key on `deployer` or `artifacts`.

**Reading a TronBox-internal property path from your own module.** `src/environment/**` is the
only directory permitted to do that — not `.options.options`, not `.resolver.options`,
not `.basePath`, not `_values`, not `network_config`. If you need a value the seam does not
project, add it to the seam so it goes through the cross-check and the allow-list, rather than
reaching around.

**Trusting `network.artifactNetworkId` as chain identity.** It is metadata about the tool. The
seam performs no chain read at all, and exposes no chain-observed field — not even as `null`.

**Preflighting authority against `network.sender.address`.** The effective sender is chosen at
send time and can differ. The field's `kind` is `'configured-not-authoritative'` so that this
cannot be read past by accident.

**Passing a relative path where an `AbsolutePath` is expected.** The brand is mintable only
inside the seam, by an assertion that **refuses** a non-absolute input rather than resolving
it — because the cwd is wrong in principle here: TronBox chdirs to the migration's directory
for the file's top-level evaluation and restores it before the exported function runs.
