/**
 * The one canonical address form, and the one place it is minted.
 *
 * Exactly one form enters or queries the deployment record: **EIP-55 EVM hex** —
 * `0x` plus 40 checksummed hex digits. That is not a display preference. The engine's
 * own lookups match on exact string equality (`getProxyFromAddress`'s
 * `d?.address === address`, `dist/manifest.js`), and those comparisons live inside a
 * pinned dependency, so a record written under a second spelling is a record the
 * engine cannot find. One canonical form, one entry point, no exceptions.
 *
 * **`toHex` is not a validator, and this module never uses it as one.** Measured at
 * `tronweb@6.4.0`: `toHex('0xdeadbeef')` returns `41deadbeef`, a wrong prefix byte
 * (`42…`) is returned unchanged, and a bare 40-hex tail comes back with no `41`
 * added — while genuinely malformed base58 throws. So it throws on one of three
 * malformed shapes and silently passes the other two, and code that treats "it did
 * not throw" as validation produces a record key that is not an address. Hence
 * **gate on shape, convert, then re-assert the conversion's result**, in that order,
 * with none of the three optional.
 *
 * **Every function here is synchronous, pure and total in its own failure mode**, and
 * nothing in the module can throw except by way of one typed error. That is what
 * makes the highest-consequence code in the sub-feature testable with 200 fixtures
 * and no network, and it is only available because `TronWeb.utils.address` is a
 * static namespace usable with no instance and no node.
 *
 * **Imports `tronweb`, `ethers` and this directory's own error module, and nothing
 * else** — no seam, no engine, no Node built-in. `./errors` imports nothing at all,
 * so this module's whole transitive closure inside the package is empty.
 */

import { utils } from 'tronweb';
import { getAddress } from 'ethers';
import {
  AddressNotCanonicalizableError,
  type AddressRejectionCause,
} from './errors';

declare const canonicalAddressBrand: unique symbol;

/**
 * An address in the record's one canonical form.
 *
 * Branded, and minted only by {@link canonicalizeAddress},
 * {@link tryCanonicalizeAddress} and {@link assertCanonicalAddress} — all three in
 * this module, all three past the same gate. The idiom is the package's own: the
 * seam's `AbsolutePath` is minted only by its asserting constructor, so a reader
 * meets one pattern rather than two.
 */
export type CanonicalAddress = string & {
  readonly [canonicalAddressBrand]: true;
};

/** `0x` + 40 hex digits. The canonical shape, casing aside. */
const EVM_HEX = /^0x[0-9a-fA-F]{40}$/;
/** TRON's 21-byte hex form: the fixed `41` prefix byte + 20 address bytes. */
const TRON_HEX = /^41[0-9a-fA-F]{40}$/;
/** `0x` followed by hex digits, of any length — the shape triage, not the gate. */
const PREFIXED_HEX = /^0x[0-9a-fA-F]*$/;
/** Hex digits with no prefix, of any length. */
const BARE_HEX = /^[0-9a-fA-F]+$/;
/**
 * base58check as TRON writes it: a leading `T` (the `41` prefix byte's base58 image)
 * and Bitcoin's base58 alphabet, which omits `0`, `O`, `I` and `l`.
 */
const BASE58_SHAPE = /^T[1-9A-HJ-NP-Za-km-z]+$/;
/** Both cases of a hex letter present, which is what makes a spelling a checksum. */
const HAS_LOWER_HEX_LETTER = /[a-f]/;
const HAS_UPPER_HEX_LETTER = /[A-F]/;

const TRON_HEX_CHARS = 42;
const EVM_HEX_DIGITS = 40;
const BASE58_ADDRESS_CHARS = 34;
/** TRON's prefix byte, fixed across every address including the zero address. */
const TRON_PREFIX = '41';

/** The triage's answer: 40 hex digits with the caller's casing, or why not. */
type TailResult =
  | { readonly tail: string }
  | { readonly because: AddressRejectionCause };

/**
 * Step 1 and step 2: triage the input into one of the three accepted encodings by
 * shape, then convert to a bare 40-hex tail with the caller's casing preserved.
 *
 * Total — it never throws, so both the throwing and the non-throwing mint can be
 * built on it without either one duplicating the other's rules.
 *
 * Casing is preserved deliberately. A mixed-case hex address *is* a checksum
 * assertion, and step 3 is what checks it; lower-casing here would silently accept a
 * mistyped address whose own capitalisation says it is wrong.
 */
function evmTailOf(input: string): TailResult {
  if (PREFIXED_HEX.test(input)) {
    const digits = input.slice(2);
    return digits.length === EVM_HEX_DIGITS
      ? { tail: digits }
      : { because: 'wrong-length' };
  }

  if (BARE_HEX.test(input)) {
    if (input.length !== TRON_HEX_CHARS) {
      return { because: 'wrong-length' };
    }
    // The prefix byte is exact rather than inferred: `41` is fixed for every TRON
    // address, so anything else in that position is a different chain's value or a
    // hex string that is not an address at all.
    if (!input.startsWith(TRON_PREFIX)) {
      return { because: 'wrong-prefix-byte' };
    }
    return { tail: input.slice(TRON_PREFIX.length) };
  }

  if (BASE58_SHAPE.test(input)) {
    if (input.length !== BASE58_ADDRESS_CHARS) {
      return { because: 'wrong-length' };
    }
    // `isAddress` verifies the base58check checksum. It is the gate; `toHex` is
    // called only after it passes, and never in its place.
    if (!utils.address.isAddress(input)) {
      return { because: 'base58-checksum' };
    }
    const tronHex = utils.address.toHex(input);
    // Step 3, first half: the **result** is re-asserted. The sibling plugin carries
    // this same assertion, and it is load-bearing rather than belt-and-braces — it is
    // the only thing between a silently mis-converted value and a manifest key.
    return TRON_HEX.test(tronHex)
      ? { tail: tronHex.slice(TRON_PREFIX.length) }
      : { because: 'post-conversion-shape' };
  }

  return { because: 'unrecognised-encoding' };
}

/**
 * Whether a hex spelling asserts a checksum.
 *
 * The same rule the underlying library applies — it verifies EIP-55 only when the
 * input carries both cases of a hex letter — reproduced here as an explicit
 * comparison rather than relied on through a thrown exception. Making the rule
 * explicit is what lets the non-throwing mint exist without a second code path, and
 * it removes the last `try` from this module.
 */
function assertsChecksum(tail: string): boolean {
  return HAS_LOWER_HEX_LETTER.test(tail) && HAS_UPPER_HEX_LETTER.test(tail);
}

/**
 * Step 3: EIP-55 casing.
 *
 * Called with an all-lowercase argument, where the underlying checksummer cannot
 * fail, so this function is total.
 */
function checksummed(tail: string): CanonicalAddress {
  return getAddress(`0x${tail.toLowerCase()}`) as CanonicalAddress;
}

/** The whole mint, total: a branded address or the one cause that rejected it. */
type MintResult =
  | { readonly address: CanonicalAddress }
  | { readonly because: AddressRejectionCause };

function mintFrom(input: string): MintResult {
  const triaged = evmTailOf(input);
  if ('because' in triaged) {
    return { because: triaged.because };
  }
  const address = checksummed(triaged.tail);
  // Step 3, second half, and it is part of the **gate** rather than a formatting
  // step: a mixed-case spelling is a claim about the address, and a claim that does
  // not hold means the value was mistyped somewhere.
  if (assertsChecksum(triaged.tail) && `0x${triaged.tail}` !== address) {
    return { because: 'post-conversion-shape' };
  }
  return { address };
}

/**
 * Gate, convert, re-assert. Accepts base58check `T…`, 21-byte TRON hex `41…`, or EVM
 * hex `0x…`, and returns the one canonical form.
 *
 * The prefix swap between TRON hex and EVM hex is exact rather than approximate: the
 * `41` byte is fixed across every sample including the zero address, and TRON's
 * checksummed tail agreed with EIP-55 in 200 of 200 derived addresses — one checksum
 * algorithm, two prefixes.
 *
 * @throws {AddressNotCanonicalizableError} naming the address input and one of five
 *   distinct causes. It never reports a missing deployment record: a mistyped address
 *   diagnosed as an absent record points the user at the wrong subsystem.
 */
export function canonicalizeAddress(input: string): CanonicalAddress {
  if (typeof input !== 'string') {
    // Unreachable through TypeScript, reachable from JavaScript, and a guard whose
    // only caller is a mistake still has to fail closed rather than let a regular
    // expression coerce the value into a shape.
    throw new AddressNotCanonicalizableError(
      String(input),
      'unrecognised-encoding',
    );
  }
  const minted = mintFrom(input);
  if ('because' in minted) {
    throw new AddressNotCanonicalizableError(input, minted.because);
  }
  return minted.address;
}

/**
 * The same mint, answering `undefined` instead of throwing.
 *
 * Exists for exactly one caller: the load-time migration of addresses already stored
 * in a user's manifest, which must be able to leave a value it cannot convert exactly
 * where it is rather than refuse the whole run over one unrelated record. Built on
 * the same triage as {@link canonicalizeAddress}, so the two cannot disagree about
 * what is acceptable — and it is a separate function rather than a `try` at the call
 * site because a caught-and-discarded error is the shape that turns a failed write
 * into a silent no-op.
 */
export function tryCanonicalizeAddress(
  input: string,
): CanonicalAddress | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  const minted = mintFrom(input);
  return 'because' in minted ? undefined : minted.address;
}

/**
 * Whether a value already is the canonical form — `0x` + 40 hex with EIP-55 casing.
 */
export function isCanonicalAddress(value: string): value is CanonicalAddress {
  if (typeof value !== 'string' || !EVM_HEX.test(value)) {
    return false;
  }
  return checksummed(value.slice(2)) === value;
}

/**
 * Re-assert the brand at a boundary the type system cannot reach.
 *
 * The engine's lookup methods are declared over plain `string`, so no amount of type
 * work on this side can make them require the brand. This is what the record wrapper
 * calls one step earlier than the engine can, so a suppressed type error or a
 * JavaScript consumer still fails closed.
 *
 * @throws {AddressNotCanonicalizableError} always, when `value` is not canonical —
 *   with the cause that names what is wrong with the value itself when it is not an
 *   address at all, and `'post-conversion-shape'` when it is an address written in
 *   some other form. Arriving here un-minted is the defect either way.
 */
export function assertCanonicalAddress(value: string): CanonicalAddress {
  if (isCanonicalAddress(value)) {
    return value;
  }
  // Throws with the precise cause when the value is not an address at all.
  void canonicalizeAddress(value);
  throw new AddressNotCanonicalizableError(value, 'post-conversion-shape');
}

/**
 * base58check `T…` — the only form a TRON user recognises, and the form this
 * sub-feature's own messages use.
 *
 * Changes no result field: the plugin's results carry addresses exactly as the tool
 * produced them, and the canonical form is internal to the record, the lookups and
 * these messages.
 */
export function toBase58(address: CanonicalAddress): string {
  return utils.address.fromHex(toTronHex(address));
}

/**
 * 21-byte TRON hex `41…`.
 *
 * **Correlation only, and internal**: it exists to line a record up against an
 * address the host wrote in its own artifacts — never to key, trust or write one. Not
 * on this directory's face.
 */
export function toTronHex(address: CanonicalAddress): string {
  return `${TRON_PREFIX}${address.slice(2)}`;
}
