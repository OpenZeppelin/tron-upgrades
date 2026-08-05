import { unreachableCause, type Cause } from './causes';

/**
 * **The one enumerated policy point.** One total function from cause to
 * disposition, one table, one importer, one call site.
 *
 * This module is the founding architectural instruction made structural:
 * *"implement refusal as a single enumerated policy point, not as behaviour
 * spread across call sites. If the review comes back 'too strict to ship',
 * flipping it must be a one-value change plus a message, not a redesign."*
 *
 * Three properties hold it, and all three are properties of the *source* rather
 * than of behaviour, which is why they are pinned by scan and not by comment:
 *
 * - **Exactly one importer** — `pipeline.ts` — and exactly one call site.
 *   A second call site elsewhere makes the flip two edits in two files,
 *   one of which nobody remembers.
 * - **Exactly one module specifier imported here** — `./causes`. The
 *   exhaustiveness guard therefore lives with the union rather than in
 *   `errors.ts`, so this module needs no second import to raise.
 * - **Not injectable.** A swappable table restores per-call-site
 *   variation through the back door: one operation passes a lenient table "just
 *   for this check" and the single-policy-point guarantee becomes nominal.
 *   `ValidationInputDependencies` has no `policy` member. The flip test
 *   substitutes this module at its boundary in a fixture, which is a test
 *   affordance and not an API.
 *
 * **What v1 decides: refuse, on all eleven.** There is no input v1 produces
 * whose fidelity is anything but slot-level. The `proceed-reduced` machinery is
 * built anyway, because the reporting side is what makes a flip cheap — a
 * measurement showed that reduced fidelity is *unobservable* from upgrades-core
 * (the report carries no flag and `hasLayout` is not public), so a flip without
 * a detector and a rendered statement produces a plugin that proceeds silently,
 * violating the requirement that reduced-fidelity validation be disclosed.
 */

/** One member in v1, and v1 never constructs it outside the flip test. */
export type ReducedMode = { readonly kind: 'declaration-order-only' };

/**
 * Both variants carry the cause, so the message never derives from the disposition
 * and a leniency flip provably cannot change the diagnosis.
 *
 * Dropping it from `proceed-reduced` would force the reduced-fidelity statement
 * to be composed downstream from the mode alone — telling the user *that*
 * fidelity was reduced without telling them *why*, and re-coupling diagnosis to
 * disposition, which is the one thing the separation between this module and
 * `diagnose.ts` exists to prevent.
 */
export type Disposition =
  | { readonly kind: 'refuse'; readonly cause: Cause }
  | {
      readonly kind: 'proceed-reduced';
      readonly cause: Cause;
      readonly mode: ReducedMode;
    };

/**
 * A row of the table. Deliberately *not* a `Disposition`: a row cannot carry a
 * cause, because the cause is what the caller brings and the table is what the
 * project decides.
 */
type PolicyEntry =
  | { readonly disposition: 'refuse' }
  | { readonly disposition: 'proceed-reduced'; readonly mode: ReducedMode };

const REFUSE = { disposition: 'refuse' } as const;

/**
 * **The flip point.** One row per cause; flipping one is one edit here and
 * nothing anywhere else — `fidelity` is already non-optional,
 * `ReducedMode` is already constructible, and `'storage-layout-unavailable'` is
 * already a `DegradedCode` member (`src/output/types.ts:69`).
 *
 * The `Record<Cause['kind'], …>` annotation is what makes the table total: a
 * twelfth cause cannot be added to the union without a row appearing here (a
 * missing key is TS2741, an unknown key TS2353), and the failure is a compile
 * error at the moment the member is *added* rather than the moment it is first
 * *reached*.
 *
 * Annotated rather than `as const satisfies`, and the reason is worth recording
 * because the idiom elsewhere in this package is the latter: with `satisfies`,
 * TypeScript narrows a lookup on an all-`refuse` table to the literal
 * `{ disposition: 'refuse' }`, so the `proceed-reduced` arm below becomes
 * unreachable *type* rather than unreachable *value* — TS2678 — and the flip
 * scaffolding would not compile until the first row was already flipped. That is
 * exactly backwards from what the flip scaffolding asks for.
 */
const POLICY_TABLE: Readonly<Record<Cause['kind'], PolicyEntry>> = {
  'compiler-absent': REFUSE,
  'compiler-unsupported': REFUSE,
  'compiler-mismatched': REFUSE,
  'source-unreadable': REFUSE,
  'import-unresolvable': REFUSE,
  'artifact-shape-unsupported': REFUSE,
  'artifact-stale': REFUSE,
  'compiler-resource-exhausted': REFUSE,
  'layout-vacuous': REFUSE,
  'library-name-unsupported': REFUSE,
  'sources-do-not-compile': REFUSE,
};

/**
 * Total, pure, and called from exactly one place.
 *
 * No I/O, no config, no clock, no environment: one parameter in, one value out,
 * for every member of a closed union.
 */
export function policy(cause: Cause): Disposition {
  const entry: PolicyEntry = POLICY_TABLE[cause.kind];
  switch (entry.disposition) {
    case 'refuse':
      return { kind: 'refuse', cause };
    case 'proceed-reduced':
      return { kind: 'proceed-reduced', cause, mode: entry.mode };
    default:
      return unreachableCause(entry, 'policy');
  }
}
