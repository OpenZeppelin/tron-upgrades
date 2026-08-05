/**
 * The chain layer's error family — slot validation, address canonicalization,
 * the closed enumeration, bounded messages, engine-derived literals, and **the
 * deliberate class-location default made into a standing test**.
 *
 * ## The class-location default is the reason this file exists in this shape
 *
 * The zero-import rule requires `slots.ts` to import **nothing**; the slot and
 * address rules require `slotToAddress` and `toRpcAddress` to **raise** `ChainSlotMalformedError` /
 * `ChainAddressUnusableError`. A module with zero imports cannot throw a class
 * declared elsewhere, so the implementation declared both classes *in* `slots.ts` and
 * re-exported them from `errors.ts`. **That arrangement is a default taken
 * deliberately, and it is not settled** — which is why § 1 pins it.
 *
 * the implementation discharged the proof by execution, in a throwaway script. § 1 makes it
 * a standing test, which is what makes a later reversal safe rather than merely
 * cheap: if someone moves the two declarations into `errors.ts`, these five
 * assertions are what confirm the move preserved the closed enumeration and the
 * instantiate-all-eleven check.
 *
 * **The reversal is not just a file move.** `slots.ts` would have to return a
 * discriminated result that `read.ts` converts to a throw, which means relaxing the
 * two validators from *raises* to *reports*. So the choice is about which rule bends,
 * and § 1.6 pins the current *raising* behaviour separately from the class locations —
 * so a reversal fails the location tests and the behaviour tests independently, and
 * a reader can see which of the two they are changing.
 */

import { describe, expect, it } from 'vitest';
import {
  toEip1967Hash,
  toFallbackEip1967Hash,
} from '@openzeppelin/upgrades-core';
import { keccak256 } from 'ethereumjs-util';
import * as errors from '../src/chain/errors';
import * as slots from '../src/chain/slots';
import {
  ChainAddressUnusableError,
  ChainSlotMalformedError,
  eip1967Slots,
  isEmptySlotWord,
  legacyEip1967Slots,
  looksLikeSlotAddressWord,
  sameAddress,
  selectors,
  slotToAddress,
  toRpcAddress,
  zeroChainAddress,
  zeroSlotWord,
  type SlotLabel,
} from '../src/chain/slots';

/** The eleven `TRON_CHAIN_*` classes, enumerated from the module rather than listed. */
function errorSubclasses(): readonly { name: string; ctor: new (...args: never[]) => Error }[] {
  const found: { name: string; ctor: new (...args: never[]) => Error }[] = [];
  for (const [name, value] of Object.entries(errors)) {
    if (
      typeof value === 'function' &&
      value.prototype instanceof Error
    ) {
      // The enumeration idiom the environment seam's `error-semantics.test.ts:84` established: a
      // twelfth class added without a message fails a test instead of passing review.
      found.push({ name, ctor: value as new (...args: never[]) => Error });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// 1. CLASS LOCATION — the deliberate default, pinned
// ---------------------------------------------------------------------------

describe('Class location (an open default): the two validation classes live in slots.ts and are re-exported', () => {
  it('sees eleven Error subclasses through errors.ts', () => {
    // "Closed and enumerable from `errors.ts`" must hold against
    // `errors.ts`, not against `slots.ts`, or every consumer needs to know where a
    // class happens to be declared.
    const found = errorSubclasses();
    expect(found.map(entry => entry.name)).toEqual([
      'ChainAddressUnusableError',
      'ChainBeaconNotFoundError',
      'ChainBlockTagRefusedError',
      'ChainEndpointRefusedError',
      'ChainImplementationNotFoundError',
      'ChainInstanceChangedError',
      'ChainMethodRefusedError',
      'ChainResultShapeError',
      'ChainRpcError',
      'ChainSlotMalformedError',
      'ChainTransportError',
    ]);
    expect(found).toHaveLength(11);
  });

  it('makes both slots.ts classes visible THROUGH errors.ts', () => {
    expect(errors.ChainSlotMalformedError).toBeDefined();
    expect(errors.ChainAddressUnusableError).toBeDefined();
    expect(typeof errors.ChainSlotMalformedError).toBe('function');
    expect(typeof errors.ChainAddressUnusableError).toBe('function');
  });

  it('gives the same class identity on both import routes — no duplicate class', () => {
    // The condition that makes the re-export sound rather than merely convenient. Two
    // distinct classes with the same name would make `instanceof` depend on which
    // module the catching code imported from, and the failure would be a caught error
    // that does not match.
    expect(errors.ChainSlotMalformedError).toBe(slots.ChainSlotMalformedError);
    expect(errors.ChainAddressUnusableError).toBe(slots.ChainAddressUnusableError);
  });

  it('constructs all eleven through errors.ts, each an Error with a non-empty message', () => {
    // Every member constructs as an Error with a message, and that is
    // load-bearing rather than tidy:
    // `call-optional-signature.js:12` reads `e.message` **unguarded** inside its
    // catch, so a thrown string or a message-less object raises a secondary
    // `TypeError` *inside upstream's error handler* — replacing this layer's diagnosis with
    // a stack trace from a module the user has never heard of, at the moment the
    // plugin was trying to explain itself.
    const instances = [
      new errors.ChainMethodRefusedError('anvil_metadata', 'because'),
      new errors.ChainBlockTagRefusedError('eth_call', 'because'),
      new errors.ChainEndpointRefusedError('the source', 'because'),
      new errors.ChainRpcError('eth_call', { code: -32000, message: 'REVERT opcode executed' }, 'http://n:8545'),
      new errors.ChainTransportError('eth_call', { kind: 'timeout' }, 'http://n:8545'),
      new errors.ChainResultShapeError('eth_chainId', 'hex', '0x'),
      new errors.ChainImplementationNotFoundError('0x0'),
      new errors.ChainBeaconNotFoundError('0x0'),
      new errors.ChainInstanceChangedError(
        { kind: 'changed', signal: 'first-block-hash', recorded: '0xa', observed: '0xb' },
        { manifestFile: '.openzeppelin/unknown-1.json', recordCount: 2, endpoint: 'http://n:8545' },
      ),
      new errors.ChainSlotMalformedError('it is not hexadecimal', '0x'),
      new errors.ChainAddressUnusableError('it is Base58', 'T9yD14…'),
    ];

    expect(instances).toHaveLength(11);
    for (const instance of instances) {
      expect(instance).toBeInstanceOf(Error);
      expect(typeof instance.message).toBe('string');
      expect(instance.message.length).toBeGreaterThan(0);
      expect(typeof instance.name).toBe('string');
      expect(instance.name.length).toBeGreaterThan(0);
    }
  });

  it('carries eleven unique TRON_CHAIN_* codes', () => {
    const codes = [
      new errors.ChainMethodRefusedError('m', 'b').code,
      new errors.ChainBlockTagRefusedError('m', 'b').code,
      new errors.ChainEndpointRefusedError('s', 'b').code,
      new errors.ChainRpcError('m', { code: -1, message: 'x' }, 'e').code,
      new errors.ChainTransportError('m', { kind: 'timeout' }, 'e').code,
      new errors.ChainResultShapeError('m', 'e', 'o').code,
      new errors.ChainImplementationNotFoundError('0x0').code,
      new errors.ChainBeaconNotFoundError('0x0').code,
      new errors.ChainInstanceChangedError(
        { kind: 'changed', signal: 'chain-id', recorded: null, observed: null },
        { manifestFile: 'f', recordCount: 0, endpoint: 'e' },
      ).code,
      new errors.ChainSlotMalformedError('a', 'b').code,
      new errors.ChainAddressUnusableError('a', 'b').code,
    ];

    expect(new Set(codes).size).toBe(11);
    for (const code of codes) {
      expect(code, `${code} is not in the TRON_CHAIN_* namespace`).toMatch(
        /^TRON_CHAIN_[A-Z_]+$/,
      );
    }
  });

  it('makes a throw raised INSIDE slots.ts catchable as the errors.ts class', () => {
    // The fifth and most operationally important condition: consumers catch through
    // `errors.ts`, and `slots.ts` is where the throw originates.
    const fromSlots = ((): unknown => {
      try {
        slotToAddress('0x');
        return undefined;
      } catch (cause) {
        return cause;
      }
    })();
    expect(fromSlots).toBeInstanceOf(errors.ChainSlotMalformedError);

    const fromToRpc = ((): unknown => {
      try {
        toRpcAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
        return undefined;
      } catch (cause) {
        return cause;
      }
    })();
    expect(fromToRpc).toBeInstanceOf(errors.ChainAddressUnusableError);
  });

  it('pins that the two validators currently RAISE, separately from where the classes live', () => {
    // Deliberately its own case. Reversing that default means `slots.ts` returns a
    // discriminated result instead of throwing, which relaxes the validators from
    // *raises* to *reports* — so the behaviour change and the location change fail
    // different tests, and a reader can see which one a proposed patch actually makes.
    expect(() => slotToAddress('0x')).toThrow(ChainSlotMalformedError);
    expect(() => toRpcAddress('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb')).toThrow(
      ChainAddressUnusableError,
    );
  });

  it('adds no member to the environment seam\'s three-diagnosis family', () => {
    // The closed enumeration's negative. The seam's own suite asserts its family is exactly three,
    // and `code` there is a template-literal type over `EnvironmentDiagnosis` — so a
    // fourth member fails **both** suites, which is the condition the reuse decision
    // attached to reusing the seam's error idiom.
    const subclassNames = errorSubclasses().map(entry => entry.name);
    for (const name of subclassNames) {
      expect(name.startsWith('Chain'), `${name} is not a chain-layer class`).toBe(true);
    }
    expect(subclassNames).not.toContain('TronBoxEnvironmentError');
    expect(subclassNames).not.toContain('EnvironmentIncompleteError');
  });
});

// ---------------------------------------------------------------------------
// 2. slot words — validated whole, and isEmptySlotWord is total
// ---------------------------------------------------------------------------

describe('slotToAddress validates the whole word and refuses', () => {
  const IMPL = '0x2222222222222222222222222222222222222222';

  it('accepts a well-formed 32-byte word with zero top bytes', () => {
    expect(slotToAddress(`0x${'0'.repeat(24)}${IMPL.slice(2)}`)).toBe(IMPL);
  });

  it.each([
    { label: "'0x'", word: '0x' },
    { label: 'an empty string', word: '' },
    { label: 'a 31-byte word', word: `0x${'0'.repeat(62)}` },
    { label: 'a 33-byte word', word: `0x${'0'.repeat(66)}` },
    { label: 'a non-hex word', word: `0x${'z'.repeat(64)}` },
    { label: 'a word with a non-zero byte in the top 12', word: `0x01${'0'.repeat(22)}${IMPL.slice(2)}` },
  ])('refuses $label', ({ word }) => {
    // Two live specimens motivate this. The sibling's `slotToAddress` is
    // `'0x' + slotValue.slice(-40)` with no check, so a `'0x'` result yields the
    // string `'0x0x'` — a plausible-looking wrong address flowing into a proxy-kind
    // decision. And it never produces a value by truncation alone: the top-12-zero
    // check is what makes a word carrying data above the address a refusal rather
    // than a silent slice.
    expect(() => slotToAddress(word)).toThrow(ChainSlotMalformedError);
  });

  it('is 0x-prefix-optional, and that cannot yield a wrong address', () => {
    // Measured while writing this suite, and worth recording rather than asserting
    // away: a bare 64-character hex word is **accepted**. That is deliberate and
    // safe. It matches the engine's own idiom (`storage.replace(/^(0x)?/, '0x')`) and
    // `sameAddress`'s stated `0x`-optionality, and it cannot produce a
    // plausible-but-wrong address, because the two checks that matter — 32 bytes of
    // hex, top 12 bytes zero — still both apply to the digits. The hazard is
    // truncation and a silent slice, not a missing prefix.
    expect(slotToAddress(`${'0'.repeat(24)}${IMPL.slice(2)}`)).toBe(IMPL);
    // And the validation is genuinely still applied to the un-prefixed form.
    expect(() => slotToAddress('0'.repeat(63))).toThrow(ChainSlotMalformedError);
    expect(() => slotToAddress(`01${'0'.repeat(22)}${IMPL.slice(2)}`)).toThrow(
      ChainSlotMalformedError,
    );
  });

  it('names the slot, the observed word and why, bounded', () => {
    const failure = ((): Error => {
      try {
        slotToAddress('0x');
        return new Error('no throw');
      } catch (cause) {
        return cause instanceof Error ? cause : new Error('non-error');
      }
    })();
    expect(failure.message.length).toBeGreaterThan(20);
    expect(failure.message.length).toBeLessThan(600);
  });

  it('bounds a pathologically long word in the message', () => {
    const huge = `0x${'a'.repeat(100_000)}`;
    const failure = ((): Error => {
      try {
        slotToAddress(huge);
        return new Error('no throw');
      } catch (cause) {
        return cause instanceof Error ? cause : new Error('non-error');
      }
    })();
    expect(failure.message.length).toBeLessThan(1_000);
  });

  it('returns a boolean from isEmptySlotWord for every input, never throwing', () => {
    // The engine's own `eip-1967.js:isEmptySlot` is
    // `BigInt(storage.replace(/^(0x)?/, '0x'))`, which throws `SyntaxError` on `'0x'`
    // — executed and confirmed at 1.46.0. TRON always returns a full 64-character
    // word today, but that is a property of java-tron, not of this function.
    for (const word of ['0x', '', '0x0', zeroSlotWord, `0x${'0'.repeat(63)}`, 'nonsense', '0xzz']) {
      const answer = isEmptySlotWord(word);
      expect(typeof answer, `isEmptySlotWord(${JSON.stringify(word)}) is not a boolean`).toBe(
        'boolean',
      );
    }
    expect(isEmptySlotWord(zeroSlotWord)).toBe(true);
    expect(isEmptySlotWord(`0x${'0'.repeat(24)}${IMPL.slice(2)}`)).toBe(false);
  });

  it('treats looksLikeSlotAddressWord as a total predicate too', () => {
    for (const word of ['0x', '', zeroSlotWord, `0x${'f'.repeat(64)}`, 'nonsense']) {
      expect(typeof looksLikeSlotAddressWord(word)).toBe('boolean');
    }
    expect(looksLikeSlotAddressWord(`0x${'0'.repeat(24)}${IMPL.slice(2)}`)).toBe(true);
    // A word with data above the address is not an address word — which is what
    // makes `readBeaconImplementation`'s `answer-is-not-an-address` reachable.
    expect(looksLikeSlotAddressWord(`0x${'f'.repeat(64)}`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Base58 refused rather than forwarded
// ---------------------------------------------------------------------------

describe('inbound addresses are canonicalized, and Base58 is refused', () => {
  const BARE = '2222222222222222222222222222222222222222';

  it('accepts all three encodings and returns the same 0x form', () => {
    expect(toRpcAddress(`0x${BARE}`)).toBe(`0x${BARE}`);
    expect(toRpcAddress(BARE)).toBe(`0x${BARE}`);
    // `41`-prefixed TRON hex — 21 bytes, the network's own hex encoding.
    expect(toRpcAddress(`41${BARE}`)).toBe(`0x${BARE}`);
    expect(toRpcAddress(`0x41${BARE}`)).toBe(`0x${BARE}`);
  });

  it('lowercases, so no comparison depends on the caller\'s casing', () => {
    expect(toRpcAddress(`0x${BARE.toUpperCase()}`)).toBe(`0x${BARE}`);
  });

  it.each([
    { label: 'a Base58 mainnet address', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
    { label: 'another Base58 address', address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb' },
    { label: 'a short hex string', address: '0x1234' },
    { label: 'an empty string', address: '' },
    { label: 'a non-hex string', address: 'not-an-address' },
  ])('refuses $label', ({ address }) => {
    // Measured live: `eth_getCode` with `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` returns
    // `-32602 exception decoding Hex string: invalid characters encountered in Hex
    // string`. Forwarded, that surfaces to a user who supplied the address in the
    // form TronBox itself prints everywhere as a node-level hex-decoding complaint —
    // the wrong layer, the wrong vocabulary, and no statement of what to do.
    expect(() => toRpcAddress(address)).toThrow(ChainAddressUnusableError);
  });

  it('names the encoding rather than saying "invalid address"', () => {
    const failure = ((): Error => {
      try {
        toRpcAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
        return new Error('no throw');
      } catch (cause) {
        return cause instanceof Error ? cause : new Error('non-error');
      }
    })();
    // The remedy has to be derivable from the message: the user has a Base58 address
    // and needs to know that is the problem.
    expect(failure.message.toLowerCase()).toContain('base58');
  });
});

// ---------------------------------------------------------------------------
// 4. sameAddress over a casing and length matrix
// ---------------------------------------------------------------------------

describe('sameAddress is case-insensitive, 0x-optional and length-checked', () => {
  const A = '0x2222222222222222222222222222222222222222';

  it('matches across casing and prefix', () => {
    expect(sameAddress(A, A.toUpperCase())).toBe(true);
    expect(sameAddress(A, A.slice(2))).toBe(true);
    expect(sameAddress(A.slice(2).toUpperCase(), A)).toBe(true);
  });

  it('does not match different addresses', () => {
    expect(sameAddress(A, `0x${'3'.repeat(40)}`)).toBe(false);
  });

  it('does not match on a truncation or a prefix', () => {
    // The property that keeps a shortened comparison from reading as a match.
    expect(sameAddress(A, A.slice(0, 20))).toBe(false);
    expect(sameAddress(A.slice(0, 20), A)).toBe(false);
    expect(sameAddress(A, '')).toBe(false);
  });

  it('applies no EIP-55 checksum', () => {
    // The chain layer emits lowercase branded hex; canonicalization belongs to the
    // record boundary. If the chain layer imposed a checksum, canonicalization would have two homes and
    // they would disagree the first time one changed.
    expect(slotToAddress(`0x${'0'.repeat(24)}${'aB'.repeat(20)}`)).toBe(
      `0x${'ab'.repeat(20)}`,
    );
  });

  it('mints the zero address as a branded value', () => {
    expect(zeroChainAddress).toBe(`0x${'0'.repeat(40)}`);
    expect(sameAddress(zeroChainAddress, `0x${'0'.repeat(40)}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. the literals re-derived from the installed engine
// ---------------------------------------------------------------------------

describe('the slot keys are pinned against the engine\'s own derivation', () => {
  const labels: readonly { readonly label: SlotLabel; readonly eip: string }[] = [
    { label: 'implementation', eip: 'eip1967.proxy.implementation' },
    { label: 'admin', eip: 'eip1967.proxy.admin' },
    { label: 'beacon', eip: 'eip1967.proxy.beacon' },
  ];

  it.each(labels)('derives $label from toEip1967Hash at test time', ({ label, eip }) => {
    // The engine hardcodes no hex literal — it derives all five at each call site, so
    // grepping `dist/` for them returns zero hits. That makes this layer's literals a
    // **copy of a computation**, and a copy with no pin drifts silently.
    expect(eip1967Slots[label]).toBe(toEip1967Hash(eip));
  });

  it.each([
    { label: 'implementation', eip: 'org.zeppelinos.proxy.implementation' },
    { label: 'admin', eip: 'org.zeppelinos.proxy.admin' },
  ] as const)('derives the legacy $label from toFallbackEip1967Hash', ({ label, eip }) => {
    // Typed as the two legacy labels rather than as `SlotLabel`: the legacy table has
    // no `beacon` key, and the compiler saying so is the asymmetry clause
    // enforced at the type level rather than only in the runtime case below.
    expect(legacyEip1967Slots[label]).toBe(toFallbackEip1967Hash(eip));
  });

  it('checks the derived keys are a full 64 hex characters, which is luck rather than construction', () => {
    // `toEip1967Hash` is `'0x' + (keccak(label) - 1n).toString(16)` with **no
    // zero-padding**. For these three labels the result happens to be 64 characters;
    // a future label whose value has a leading zero byte would produce a 63-character
    // key, and `eth_getStorageAt` would be asked about a different slot than the
    // engine reads — with no error at all.
    for (const label of ['implementation', 'admin', 'beacon'] as const) {
      expect(eip1967Slots[label], `${label} is not a full 32-byte key`).toHaveLength(
        66,
      );
    }
    for (const label of ['implementation', 'admin'] as const) {
      expect(legacyEip1967Slots[label]).toHaveLength(66);
    }
  });

  it('has no legacy fallback for the beacon, mirroring the engine', () => {
    // `eip-1967.js:getBeaconAddress` passes one slot where the other two pass two.
    // The asymmetry is the engine's and is mirrored rather than smoothed.
    expect('beacon' in legacyEip1967Slots).toBe(false);
  });

  it.each([
    { name: 'owner' as const, signature: 'owner()' },
    { name: 'implementation' as const, signature: 'implementation()' },
    { name: 'upgradeInterfaceVersion' as const, signature: 'UPGRADE_INTERFACE_VERSION()' },
  ])('derives $name from a keccak of $signature at test time', ({ name, signature }) => {
    // The rule asks for the selectors to be verified "against a keccak of the fixed
    // signature strings", and that is done here rather than transcribed: `keccak256`
    // comes from `ethereumjs-util`, which is already in the tree as an upgrades-core
    // dependency. A literal comparison would only pin what someone typed; this pins
    // the *computation*, which is the same standard the slot keys are held to above.
    const digest = keccak256(Buffer.from(signature, 'utf8')).toString('hex');
    expect(selectors[name]).toBe(`0x${digest.slice(0, 8)}`);
  });

  it('keeps every selector to the four-byte form', () => {
    for (const selector of Object.values(selectors)) {
      expect(selector).toMatch(/^0x[0-9a-f]{8}$/);
    }
  });

  it('exposes frozen constant tables', () => {
    expect(Object.isFrozen(eip1967Slots)).toBe(true);
    expect(Object.isFrozen(legacyEip1967Slots)).toBe(true);
    expect(Object.isFrozen(selectors)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. the purity clause — same input, same output
// ---------------------------------------------------------------------------

describe('the three zero-import modules export pure functions', () => {
  it('gives identical output for identical input, twice', () => {
    const word = `0x${'0'.repeat(24)}${'2'.repeat(40)}`;
    expect(slotToAddress(word)).toBe(slotToAddress(word));
    expect(isEmptySlotWord(zeroSlotWord)).toBe(isEmptySlotWord(zeroSlotWord));
    expect(toRpcAddress(`0x${'2'.repeat(40)}`)).toBe(toRpcAddress(`0x${'2'.repeat(40)}`));
    expect(sameAddress(word, word)).toBe(sameAddress(word, word));
  });

  it('reads no ambient state — the same call answers the same under a mutated env', () => {
    const before = slotToAddress(`0x${'0'.repeat(24)}${'2'.repeat(40)}`);
    const saved = process.env['TRONBOX_UPGRADES_RPC_URL'];
    process.env['TRONBOX_UPGRADES_RPC_URL'] = 'http://elsewhere.example:8545/jsonrpc';
    try {
      expect(slotToAddress(`0x${'0'.repeat(24)}${'2'.repeat(40)}`)).toBe(before);
    } finally {
      if (saved === undefined) {
        delete process.env['TRONBOX_UPGRADES_RPC_URL'];
      } else {
        process.env['TRONBOX_UPGRADES_RPC_URL'] = saved;
      }
    }
  });
});
