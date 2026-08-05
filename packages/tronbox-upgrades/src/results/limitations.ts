import type { ContractHandle } from './types';

/**
 * Named non-capabilities on a returned contract handle.
 *
 * Where the host's abstraction cannot honour a capability, the limitation is
 * declared **at the return value** and refuses when reached, naming the mechanism
 * and the alternative — never an empty value a caller would reasonably read as
 * evidence that nothing happened (scenario 7 — a recorded divergence,
 * detailed below).
 *
 * The refusal is installed on a **`Proxy` over** the host handle, never on
 * the host handle itself, so `src/results/**` contains **no property-installation
 * site at all** and satisfies the host-object augmentation policy by
 * construction rather than by check — nothing is mutated, so there is nothing to
 * guard.
 *
 * **Why a proxy and not a throwing accessor, established by execution on TronBox
 * 4.9.0 and 4.8.0 alike:** `Object.defineProperty(handle, 'events', …)` **throws**.
 * `src/components/Contract/contract.js:Contract._static_methods.addProp` builds
 * every `_properties` member with `definition.enumerable = false; definition.
 * configurable = false`, and `Utils.bootstrap` applies it to the abstraction *and to
 * every clone* — it runs on `Contract` itself and again inside `clone()` on the
 * object it returns. So the designed mechanism raises `TypeError: Cannot redefine
 * property: events` on the deploy path, **after a successful on-chain
 * deployment**, which is the worst possible place to fail.
 *
 * A `get` trap is legal for precisely the reason `defineProperty` is not: `events`
 * is a non-configurable **accessor with a defined getter**, and the `[[Get]]` proxy
 * invariant constrains only non-configurable *data* properties and getter-less
 * accessors.
 *
 * The wrapper objections a reader will arrive with do not apply to a `Proxy`
 * specifically: prototype identity is the target's, so `instanceof` holds; and
 * there are no un-proxied host methods to miss, because TronBox's accessors close
 * over the target (`addProp` opens with `const self = this` and every getter it
 * builds calls through `self`) and are therefore receiver-independent.
 */

/** What the host cannot do, and what to do instead. Both required, neither empty. */
export interface Limitation {
  /** What the host cannot do, naming the actual mechanism. */
  readonly because: string;
  /** The correct alternative. Never empty. */
  readonly instead: string;
}

/** A registry of members to refuse, keyed by member name. */
export type LimitationRegistry = Readonly<Record<string, Limitation>>;

/** Reaching a capability the host cannot honour. Thrown from the proxy's `get` trap. */
export class ResultCapabilityUnavailableError extends Error {
  readonly code = 'RESULT_CAPABILITY_UNAVAILABLE' as const;
  readonly member: string;
  readonly limitation: Limitation;

  constructor(member: string, limitation: Limitation) {
    super(
      `"${member}" is not available on a contract handle this plugin returns. ` +
        `${limitation.because} ${limitation.instead}`,
    );
    this.name = 'ResultCapabilityUnavailableError';
    this.member = member;
    this.limitation = limitation;
  }
}

/**
 * A registry named a member the host does not have.
 *
 * Added while implementing: `sealUnavailable` must refuse such a member
 * "and say why" without naming the class, with a typed error carrying a
 * stable `code`.
 */
export class UnavailableMemberAbsentError extends Error {
  readonly code = 'UNAVAILABLE_MEMBER_ABSENT' as const;
  readonly member: string;

  constructor(member: string) {
    super(
      `Refusing to register "${member}" as unavailable: the host's contract ` +
        'abstraction has no such member, so reaching it already yields ' +
        'undefined, which is honest. Registering it would invent surface to ' +
        'disclaim and make the limitation list a fiction. If the host dropped ' +
        'a member this plugin registers, that is a host change to look at, not ' +
        'a condition to work around.',
    );
    this.name = 'UnavailableMemberAbsentError';
    this.member = member;
  }
}

/**
 * The v1 registry, whose sole member is `events`.
 *
 * **Scoped precisely, and the scoping is the finding.**
 * `build/components/Contract/contract.js:Contract._properties` declares
 * `events: function events(){ return [] }` — an **unconditional empty array**,
 * byte-identical on 4.9.0 and 4.8.0 — which a caller reasonably reads as "the
 * transaction emitted no events". That is the silent-wrong-answer class, and it is
 * the spec's own edge case.
 *
 * `logs` and `decodeLogs` are deliberately **not** registered, because they do not
 * exist: zero occurrences in `src/components/Contract/contract.js` at either tag,
 * and `'logs' in abstraction === false`. So `result.contract.logs` is plain
 * `undefined`, which is honest, whereas `result.contract.events` is a misleading
 * `[]`. Registering `logs` too would disclaim a capability the host never offered.
 * The distinction is recorded here so a later reader does not take the omission as
 * an oversight.
 *
 * Which receipt path the alternative names is the deploy seam's to finalise;
 * the option/result surface supplies the mechanism, the error type, and this
 * one established instance.
 */
export const unavailableContractMembers: LimitationRegistry = Object.freeze({
  events: Object.freeze({
    because:
      "TronBox's contract abstraction returns an unconditional empty array " +
      'for events — it decodes nothing — so a caller reading it would take an ' +
      'empty result as evidence that the transaction emitted no events.',
    instead:
      'Read the events from the transaction receipt for this transaction hash ' +
      'instead; the result carries the hash on its `transaction` field.',
  }),
});

/**
 * Returns a `Proxy` over `target` whose `get` trap refuses every member in
 * `registry` and forwards everything else unchanged.
 *
 * @throws {UnavailableMemberAbsentError} if the registry names a member the target
 *   does not have — checked at seal time, before the proxy exists, so a
 *   host change is reported where it happens rather than at the caller's first read.
 *
 * Sealing is **subtractive-on-read and neutral-on-shape**: only a `get`
 * trap, with no `set`, `defineProperty`, `ownKeys` or `getOwnPropertyDescriptor`
 * trap that could alter visibility. The sealed handle exposes exactly what the host
 * handle exposed, adds no enumerable member, and adds no member the host did not
 * have. `JSON.stringify`, `util.inspect` and spread behave as they do on the
 * unsealed handle — verified by execution on both minors: 21 own-enumerable keys
 * sealed and unsealed alike, neither serializer throws, and `'events' in sealed`
 * stays `true` so the shape remains truthful even though the read refuses.
 *
 * That neutrality matters more than it looks: `Object.keys` on TronBox's handle
 * already includes `_json` — the full artifact, bytecode and source map — so any
 * trap that changed enumerability would amplify an existing exposure. The
 * refusal message names the member and the remedy only, never the target's
 * internals, and no host-supplied object is ever passed to a formatter.
 *
 * The returned proxy travels to the migration author only. No plugin path
 * hands it back to `ResolverIntercept.require`/`contracts`, to `artifactor.saveAll`,
 * to a deployer step, or to any other host API — the proxy is created at the return
 * boundary, after every host interaction is complete. A host that read a trapped
 * member would turn a plugin refusal into a host crash the user cannot attribute.
 */
export function sealUnavailable(
  target: object,
  registry: LimitationRegistry = unavailableContractMembers,
): ContractHandle {
  for (const member of Object.keys(registry)) {
    if (!(member in target)) {
      throw new UnavailableMemberAbsentError(member);
    }
  }

  return new Proxy(target, {
    get(proxyTarget: object, property: string | symbol, receiver: unknown) {
      /*
       * `hasOwnProperty` rather than `registry[property] !== undefined`: a plain
       * object literal inherits `constructor`, `toString` and friends from
       * `Object.prototype`, so an index lookup would refuse `handle.constructor`
       * and report it as an unavailable capability.
       */
      if (
        typeof property === 'string' &&
        Object.prototype.hasOwnProperty.call(registry, property)
      ) {
        const limitation = registry[property];
        if (limitation !== undefined) {
          throw new ResultCapabilityUnavailableError(property, limitation);
        }
      }
      return Reflect.get(proxyTarget, property, receiver);
    },
  }) as ContractHandle;
}
