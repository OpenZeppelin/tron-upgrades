import type { DegradedNote } from '../output';

/**
 * The shared result-type contract: for every operation, the declared return shape
 * and which fields are guaranteed observable.
 *
 * **The contract's rule, in one sentence:** every field a result declares is
 * present and meaningful whenever the result exists — there is no field whose
 * absence a caller has to interpret. Operations whose capability set differs get
 * **different result types**, never one type with optional fields (INV-5). That is
 * what makes SC-005's *"for every shipped operation, its declared return shape and
 * guaranteed observable fields are documented"* something the compiler participates
 * in rather than prose.
 *
 * INV-43: `src/results/**` imports only `../output`, and only for
 * {@link DegradedNote}.
 *
 * **Divergence D-6, recorded next to the type:** the parity target returns a bare
 * contract instance and reads `.address` and its transaction-hash accessor off it.
 * This design returns a small envelope with `contract`, `address` and
 * `transaction` as named siblings, because on TronBox the host's own accessors do
 * not guarantee what the parity target's did — and `forceImport`-style paths have
 * no transaction at all. Naming the fields lets the contract state which are
 * guaranteed; reading them off the host handle would make the guarantee the host's,
 * and the host does not offer one.
 */

/**
 * The host's contract abstraction, structurally.
 *
 * The index signature mirrors `plugin-truffle/src/utils/truffle.ts:ContractInstance`'s
 * `[other: string]: any` and is a knowing exception to this package's no-`any`
 * rule: the consumer base is JavaScript migrations calling arbitrary
 * ABI-derived methods, where a narrower type protects nobody and blocks every
 * legitimate contract call.
 *
 * INV-7: `src/environment/types.ts:ContractAbstraction` is assignable to
 * `Omit<ContractHandle, 'address'>`, pinned by a type-level assignment in the
 * **test** suite so no import edge is created in either direction. `address` is
 * outside the pin because SF-0 does not declare it and INV-6 makes supplying it the
 * plugin's obligation, not the host's — the stronger pin fails **TS2741**, which is
 * recorded as an executable `@ts-expect-error` rather than as prose.
 */
export interface ContractHandle {
  readonly address: string;
  [member: string]: any;
}

/**
 * The transaction a result refers to. Guaranteed by the plugin, never delegated to
 * a host accessor (INV-6).
 *
 * **Verified divergence between the two supported minors:**
 * `build/components/Contract/contract.js:Contract._properties`' transaction-hash
 * getter throws on a falsy value in 4.9.0 (`if (!…) throw`) but only on `null` in
 * 4.8.0 (`if (… === null) throw`), so on 4.8.0 an absent hash reads back as
 * `undefined` — precisely the "field left undefined that a caller would read as not
 * applicable" that SF-4 scenario 7 forbids. Both accessors are additionally
 * **non-configurable**, so the plugin cannot even repair them in place. The plugin
 * therefore carries the value the send path gave it and puts it on the envelope
 * itself; see {@link transactionIdentity}.
 */
export interface TransactionIdentity {
  readonly hash: string;
}

/**
 * The base of every operation result. SC-003 is discharged **here**, on the
 * returned value, not on the log.
 *
 * `notes` is always an array — possibly empty, never absent, always frozen. Under
 * `tronbox test`, the command SC-007 says forces a full replay of every migration
 * on every run, the injected logger is a noop that no flag produced, so a design
 * that discharged SC-003 through advisory output would be broken for every test
 * run.
 */
export interface OperationResult {
  readonly notes: readonly DegradedNote[];
}

export interface DeployedProxy extends OperationResult {
  /** Contract-call access at the proxy address, with the implementation's ABI. */
  readonly contract: ContractHandle;
  /** Tool-verbatim, deliberately not canonicalized — SF-3 owns the canonical form (INV-47). */
  readonly address: string;
  readonly transaction: TransactionIdentity;
}

export interface UpgradedProxy extends OperationResult {
  readonly contract: ContractHandle;
  readonly address: string;
  /** The upgrade transaction, not the original deployment's. */
  readonly transaction: TransactionIdentity;
  readonly implementation: string;
}

export interface ImplementationDeployment extends OperationResult {
  readonly address: string;
  readonly transaction: TransactionIdentity;
}

export interface DeployedBeacon extends OperationResult {
  readonly contract: ContractHandle;
  readonly address: string;
  readonly transaction: TransactionIdentity;
  readonly implementation: string;
}

/**
 * SF-6 and SF-7's validating operations: no transaction, so **no `transaction`
 * field to leave undefined**. A shared type with `transaction?: TransactionIdentity`
 * would force every caller of every operation to branch on absence, and the one
 * caller who forgets reads a property off `undefined` — which is SF-10 scenario 6
 * exactly.
 */
export interface ValidationOutcome extends OperationResult {}

/** SF-7. The adopted kind is on the result, per its scenarios 4, 5 and 6. */
export interface AdoptionOutcome extends OperationResult {
  readonly kind: 'uups' | 'transparent' | 'beacon' | 'implementation';
  readonly address: string;
  readonly contract: ContractHandle;
}

/** SF-8. */
export interface AuthorityTransfer extends OperationResult {
  readonly transaction: TransactionIdentity;
  readonly previousOwner: string;
  readonly newOwner: string;
}

/**
 * A result was constructed without the transaction identity the plugin guarantees.
 *
 * Added while implementing: INV-6 requires the envelope constructor to reject a falsy
 * hash "with a typed error naming the operation" but does not name the class, and
 * INV-8 requires every rejection to be a typed error carrying a stable `code`.
 *
 * This reports a plugin defect, not a user error — it fires when the send path did
 * not supply what SF-4 owes the envelope. It is deliberately loud: the alternative
 * is a result carrying `{ hash: undefined }`, which is the silent-wrong-answer class
 * this whole contract exists to remove.
 */
export class TransactionHashUnavailableError extends Error {
  readonly code = 'TRANSACTION_HASH_UNAVAILABLE' as const;
  readonly operation: string;

  constructor(operation: string) {
    super(
      `The "${operation}" operation produced no transaction identity. The ` +
        'plugin guarantees this field on every result that declares it and ' +
        'supplies the value itself rather than reading it back off TronBox\'s ' +
        'contract abstraction, whose accessor reports an absent hash ' +
        'differently on 4.8.0 and 4.9.0. Refusing to return a result whose ' +
        'transaction identity a caller would read as "not applicable".',
    );
    this.name = 'TransactionHashUnavailableError';
    this.operation = operation;
  }
}

/**
 * INV-6: the guarded constructor for a {@link TransactionIdentity}. The parameter
 * is `unknown` rather than `string` on purpose — the value arrives from the send
 * path, and a JavaScript caller's `undefined` has to be caught here rather than
 * type-checked away at a boundary that does not exist at runtime.
 */
export function transactionIdentity(
  hash: unknown,
  operation: string,
): TransactionIdentity {
  if (typeof hash !== 'string' || hash === '') {
    throw new TransactionHashUnavailableError(operation);
  }
  return Object.freeze({ hash });
}

/**
 * INV-37: the notes a result carries are exactly the channel's `recorded` — the
 * same members in the same order as the `degraded` calls that produced them, with
 * nothing added, reordered, deduplicated or dropped, frozen at the return
 * boundary.
 *
 * Called at every operation's return statement, so the freeze has one home. A note
 * about a fallback appearing before the note about the condition that caused it
 * would be a diagnostic that misleads about causation.
 */
export function operationNotes(
  recorded: readonly DegradedNote[],
): readonly DegradedNote[] {
  return Object.freeze([...recorded]);
}
