/**
 * The ERC-1967 slot keys, the three ABI selectors, and the pure address/word
 * helpers that decode what a storage read returns.
 *
 * **INV-45: this module has zero imports.** Not from the host, not from
 * `@openzeppelin/upgrades-core`, not from a Node built-in, not from a sibling in
 * `src/chain/`. That is what makes SF-11's extraction a file move plus a
 * re-export rather than a dependency untangling, and the import INV-45's
 * violation scenario names as the most likely one to creep in is `./errors` —
 * for a throw.
 *
 * So the two errors this module raises are **declared here** and re-exported
 * from `errors.ts`. INV-6 and INV-7 require `slotToAddress` and `toRpcAddress`
 * to *raise*; INV-45 requires this file to import nothing; an `Error` subclass
 * needs no import, so both hold at once. INV-19's "closed and enumerable from
 * `errors.ts`" survives because `import * as errors` sees a re-export, and the
 * reversal cost if that turns out wrong is a file move plus two lines.
 */

declare const ChainAddressBrand: unique symbol;

/**
 * A 20-byte address in **lowercase** `0x` hex, exactly as derived from a storage
 * word.
 *
 * Not checksummed, and the brand is what stops that from being a silent bug.
 * upgrades-core compares addresses with `===` while reading its own manifest, so
 * a casing mismatch silently drops a recorded proxy kind and layout — which is
 * why canonicalization has exactly one home, and it is SF-3's record boundary,
 * not here. SF-3 is expected to define its own brand for the canonical form, so
 * assignment fails in both directions.
 *
 * INV-5: for comparison use {@link sameAddress}. Never `===`.
 */
export type ChainAddress = string & {
  readonly [ChainAddressBrand]: 'lowercase-hex';
};

export type SlotLabel = 'implementation' | 'admin' | 'beacon';

/** A 32-byte storage word is 64 hex characters. */
const SLOT_WORD_HEX_CHARS = 64;
/** A 20-byte address is 40 hex characters. */
const ADDRESS_HEX_CHARS = 40;
/** The top 12 bytes of an address-bearing word must be zero. */
const ADDRESS_PAD_HEX_CHARS = SLOT_WORD_HEX_CHARS - ADDRESS_HEX_CHARS;
/** A `41`-prefixed TRON hex address is 21 bytes. */
const TRON_HEX_CHARS = ADDRESS_HEX_CHARS + 2;
/** TRON's Base58Check addresses are 34 characters and begin with `T`. */
const BASE58_ADDRESS_CHARS = 34;

/**
 * INV-44: nothing SF-1 renders is unbounded. A caller can hand these helpers an
 * arbitrarily long string — a whole HTML error page has reached a decoder before
 * — and the refusal has to stay readable.
 */
const RENDERED_MAX_CHARS = 80;

function renderExcerpt(value: string): string {
  return value.length <= RENDERED_MAX_CHARS
    ? JSON.stringify(value)
    : `${JSON.stringify(value.slice(0, RENDERED_MAX_CHARS))}… ` +
        `(${String(value.length)} characters total)`;
}

/**
 * D4: refuse rather than produce a plausible wrong value.
 *
 * The sibling plugin's `slotToAddress` is `'0x' + slotValue.slice(-40)` with no
 * check, so a `'0x'` result yields the string `'0x0x'` and a `null` throws a bare
 * `TypeError` — either way a wrong-looking address flows into a proxy-kind
 * decision. This adopts the engine's `utils/address.js:parseAddress` discipline
 * instead: exactly 32 bytes, top 12 zero, or nothing.
 */
export class ChainSlotMalformedError extends Error {
  readonly code = 'TRON_CHAIN_SLOT_MALFORMED' as const;

  constructor(
    readonly because: string,
    word: string,
  ) {
    super(
      'A storage word read from the chain is not a 32-byte value carrying a ' +
        `20-byte address: ${because}. Received ${renderExcerpt(word)}.`,
    );
    this.name = 'ChainSlotMalformedError';
  }
}

/**
 * INV-7: a Base58 `T…` address is refused here rather than forwarded.
 *
 * Measured live: `eth_getCode` with `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` returns
 * `-32602 exception decoding Hex string: invalid characters encountered in Hex
 * string`. Forwarded, that reaches a user who supplied the address in the form
 * TronBox itself prints everywhere, as a node-level hex-decoding complaint — the
 * wrong layer, the wrong vocabulary, and no statement of what to do. So the
 * message names the encoding it received and the encodings it accepts.
 */
export class ChainAddressUnusableError extends Error {
  readonly code = 'TRON_CHAIN_ADDRESS_UNUSABLE' as const;

  constructor(
    readonly because: string,
    address: string,
  ) {
    super(
      `This address cannot be used in a JSON-RPC request: ${because}. ` +
        'The Ethereum-compatible JSON-RPC service accepts a 20-byte address as ' +
        '0x-prefixed hex, as bare hex, or as 41-prefixed TRON hex — it does not ' +
        `accept TRON's Base58 form. Received ${renderExcerpt(address)}.`,
    );
    this.name = 'ChainAddressUnusableError';
  }
}

/**
 * The three modern ERC-1967 slot keys.
 *
 * Derived from upgrades-core's own `toEip1967Hash` and re-verified in-process at
 * `1.46.0` while writing this file. They are published as literals rather than
 * imported because the engine hardcodes none of them — it derives all five at
 * each call site — but INV-49 makes them a *pinned* copy: a test re-runs the
 * engine's derivation and compares, so a bump that changes a label or the
 * hashing fails a test instead of asking `eth_getStorageAt` about a different
 * slot than the engine reads.
 */
export const eip1967Slots: Readonly<Record<SlotLabel, string>> = Object.freeze({
  implementation:
    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
});

/**
 * The two legacy (`org.zeppelinos.*`) fallback slots, from
 * `toFallbackEip1967Hash`.
 *
 * **Beacon has no legacy fallback** — `eip-1967.js:getBeaconAddress` passes one
 * slot where the other two pass two. The asymmetry is the engine's and is
 * mirrored rather than smoothed: a reader that invented a legacy beacon slot
 * would disagree with the engine about where a beacon lives.
 */
export const legacyEip1967Slots: Readonly<
  Record<'implementation' | 'admin', string>
> = Object.freeze({
  implementation:
    '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3',
  admin: '0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b',
});

/**
 * The three selectors SF-1 needs, as constants.
 *
 * Each is `keccak256(signature)[0:4]` of a fixed string, so computing them at
 * runtime would buy nothing and cost a keccak dependency the package does not
 * have. Re-derived against `ethereumjs-util` while writing this file; INV-49
 * pins them the same way as the slots.
 */
export const selectors = Object.freeze({
  /** `UPGRADE_INTERFACE_VERSION()` */
  upgradeInterfaceVersion: '0xad3cb1cc',
  /** `owner()` */
  owner: '0x8da5cb5b',
  /** `implementation()` */
  implementation: '0x5c60da1b',
} as const);

/** The all-zero 32-byte word, as `eth_getStorageAt` reports an unset slot. */
export const zeroSlotWord = `0x${'0'.repeat(SLOT_WORD_HEX_CHARS)}`;

/** The 32-byte zero word rendered as a hash, for a harmless probe argument. */
export const zeroTransactionHash = zeroSlotWord;

function stripHexPrefix(value: string): string {
  return value.startsWith('0x') || value.startsWith('0X')
    ? value.slice(2)
    : value;
}

function isHexDigits(value: string): boolean {
  return /^[0-9a-fA-F]*$/.test(value);
}

/**
 * INV-6: decides emptiness without assuming a fixed length and without any
 * construction that throws on a short input.
 *
 * The engine's own `eip-1967.js:isEmptySlot` is
 * `BigInt(storage.replace(/^(0x)?/, '0x')) === 0n`, which throws `SyntaxError`
 * on `'0x'` — executed and confirmed at `1.46.0`. TRON always returns a full
 * 64-character word so that hazard does not fire today, but that is a property
 * of java-tron, not of this function.
 *
 * A value that is not hex at all is reported **not empty**, so the caller's next
 * step is {@link slotToAddress}, which refuses it by name. Reporting it empty
 * would turn garbage into "this slot is unset", which is a fact rather than a
 * failure and would be believed.
 */
export function isEmptySlotWord(word: string): boolean {
  const digits = stripHexPrefix(word);
  if (!isHexDigits(digits)) {
    return false;
  }
  return /^0*$/.test(digits);
}

/**
 * The total counterpart of {@link slotToAddress}: does this word carry an
 * address?
 *
 * Mirrors what `utils/address.js:parseAddress` answers with `undefined`, which
 * is how `inferProxyAdmin` decides whether an `owner()` answer is an address.
 * A predicate rather than a throw is what lets `looksLikeProxyAdmin` return
 * `false` for a non-address answer without conflating it with a failure.
 */
export function looksLikeSlotAddressWord(word: string): boolean {
  const digits = stripHexPrefix(word);
  return (
    digits.length === SLOT_WORD_HEX_CHARS &&
    isHexDigits(digits) &&
    /^0*$/.test(digits.slice(0, ADDRESS_PAD_HEX_CHARS))
  );
}

/**
 * The last 20 bytes of a 32-byte word, validated.
 *
 * INV-6: never produces a value by truncation alone. Exactly 32 bytes of hex,
 * top 12 bytes zero, or {@link ChainSlotMalformedError}.
 *
 * @throws {ChainSlotMalformedError} the word is not 32 bytes of hex, or its top
 *   12 bytes are non-zero.
 */
export function slotToAddress(word: string): ChainAddress {
  const digits = stripHexPrefix(word);
  if (!isHexDigits(digits)) {
    throw new ChainSlotMalformedError('it is not hexadecimal', word);
  }
  if (digits.length !== SLOT_WORD_HEX_CHARS) {
    throw new ChainSlotMalformedError(
      `it is ${String(digits.length)} hex characters rather than ` +
        `${String(SLOT_WORD_HEX_CHARS)}`,
      word,
    );
  }
  if (!/^0*$/.test(digits.slice(0, ADDRESS_PAD_HEX_CHARS))) {
    throw new ChainSlotMalformedError(
      'its top 12 bytes are not zero, so its low 20 bytes are not an address',
      word,
    );
  }
  return `0x${digits.slice(ADDRESS_PAD_HEX_CHARS).toLowerCase()}` as ChainAddress;
}

/** The zero address, minted through the same validation as every other. */
export const zeroChainAddress: ChainAddress = slotToAddress(zeroSlotWord);

/**
 * INV-5: the only sanctioned address comparison. Case-insensitive,
 * `0x`-optional, length-checked.
 *
 * Length-checked because a comparison that passes for two strings which are not
 * both addresses is worse than useless: `sameAddress('0x', '0x')` must be
 * `false`, or "no address" equals "no address" and a missing implementation
 * matches a missing implementation.
 */
export function sameAddress(a: string, b: string): boolean {
  const left = stripHexPrefix(a).toLowerCase();
  const right = stripHexPrefix(b).toLowerCase();
  if (left.length !== ADDRESS_HEX_CHARS || !isHexDigits(left)) {
    return false;
  }
  if (right.length !== ADDRESS_HEX_CHARS || !isHexDigits(right)) {
    return false;
  }
  return left === right;
}

function looksLikeBase58Address(value: string): boolean {
  return (
    value.length === BASE58_ADDRESS_CHARS &&
    value.startsWith('T') &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(value)
  );
}

/**
 * Canonicalizes an inbound address argument to `0x`-prefixed 20-byte hex.
 *
 * INV-7. Measured tolerance on java-tron: `0x`-prefixed accepted, bare hex
 * accepted, `41`-prefixed TRON hex accepted, **Base58 `T…` rejected**. So a
 * Base58 string is refused here rather than passed through, which is the
 * sibling's `looksLikeAddress` behaviour and the best-designed catch in it.
 *
 * @throws {ChainAddressUnusableError} the input is Base58, or is not a 20-byte
 *   address in any of the three accepted encodings.
 */
export function toRpcAddress(address: string): string {
  if (typeof address !== 'string' || address.length === 0) {
    throw new ChainAddressUnusableError('it is empty', String(address));
  }
  if (looksLikeBase58Address(address)) {
    throw new ChainAddressUnusableError(
      "it is TRON's Base58 form, which the JSON-RPC service refuses with a " +
        'hex-decoding error rather than a useful one',
      address,
    );
  }

  const digits = stripHexPrefix(address);
  if (!isHexDigits(digits)) {
    throw new ChainAddressUnusableError('it is not hexadecimal', address);
  }
  if (digits.length === ADDRESS_HEX_CHARS) {
    return `0x${digits.toLowerCase()}`;
  }
  if (
    digits.length === TRON_HEX_CHARS &&
    digits.slice(0, 2).toLowerCase() === '41'
  ) {
    return `0x${digits.slice(2).toLowerCase()}`;
  }
  throw new ChainAddressUnusableError(
    `it is ${String(digits.length)} hex characters, which is neither a ` +
      `20-byte address (${String(ADDRESS_HEX_CHARS)}) nor 41-prefixed TRON hex ` +
      `(${String(TRON_HEX_CHARS)})`,
    address,
  );
}
