/**
 * The reader surface: `hasCode`, the three ERC-1967 slot readers,
 * `readProxySlots`, `tvmCallOptional`, and the three replacements for
 * upgrades-core functions that are unsafe on TRON.
 *
 * **Every function here takes a `TronEthereumProvider` as its first
 * parameter.** This module closes over no channel, no handle, no endpoint and no
 * `ChainAccess`. That is what makes "exactly one translation point" a *shape*
 * rather than a rule: free functions that each construct their own transport are
 * how the sibling ended up with two — reading the implementation slot through one
 * and *verifying* it through the other, so its post-upgrade check can compare
 * answers about two different addresses. Taking `send` as a parameter means a
 * second transport has to be passed in explicitly at a call site someone reviews,
 * and it is simultaneously what makes these bodies host-free for packaging's
 * extraction.
 *
 * **This module's governing rule: no transport failure is ever converted
 * into a no-answer, a `false`, a zero address, an empty slot or `undefined`.**
 * Every catch below is predicated on `ChainRpcError` *and* on
 * `isProbeOutcome(diagnosis)`; there is no `catch (_)`, no bare `catch {}`, and no
 * catch without a discriminating predicate. The specimen is the sibling's
 * `slots.ts:getSlot`, whose blanket `catch (_)` reroutes to
 * `hre.network.config.url ?? process.env.TRE_URL ?? 'http://127.0.0.1:9090/jsonrpc'`
 * — so on a public network a *transient* failure silently reads ERC-1967 slots
 * from a local dev chain, and every ERC-1967 read in that plugin rides it. The
 * severity is not "a read failed"; it is that the read *succeeded* against the
 * wrong chain and the answer is plausible.
 */

import { isProbeOutcome, type ProbeDiagnosis } from './classify';
import {
  ChainBeaconNotFoundError,
  ChainImplementationNotFoundError,
  ChainRpcError,
} from './errors';
import { acceptedBlockTag } from './policy';
import { requireResultShape, type TronEthereumProvider } from './provider';
import {
  eip1967Slots,
  isEmptySlotWord,
  legacyEip1967Slots,
  looksLikeSlotAddressWord,
  selectors,
  slotToAddress,
  toRpcAddress,
  zeroChainAddress,
  type ChainAddress,
  type SlotLabel,
} from './slots';

/**
 * The outcome of an optional `eth_call` probe.
 *
 * A **union, not `string | undefined`**, because the two no-answer reasons
 * must stay distinguishable. `undefined` is where the sibling loses that, and the
 * user-facing result is measured: `beacon.ts:assertIsBeacon` tells a user their
 * address "is not an upgradeable beacon: its `implementation()` getter did not
 * return an address" when in fact **nothing is deployed there**.
 */
export type OptionalCallOutcome =
  | { readonly kind: 'answered'; readonly data: string }
  | {
      readonly kind: 'no-answer';
      readonly because: 'reverted' | 'no-contract-at-address';
    };

/** What `readProxySlots` found. `no-code` is a different fact from three `null`s. */
export type ProxySlotsRead =
  | { readonly kind: 'no-code' }
  | {
      readonly kind: 'code';
      /** `null` means the slot is a zero word — modern *and* legacy where one exists. */
      readonly implementation: ChainAddress | null;
      readonly admin: ChainAddress | null;
      readonly beacon: ChainAddress | null;
    };

/** `readBeaconImplementation`'s three outcomes. The first two are
   * "no code deployed" and "deployed but not a beacon", kept apart. */
export type BeaconRead =
  | { readonly kind: 'implementation'; readonly address: ChainAddress }
  | { readonly kind: 'no-code-at-beacon' }
  | {
      readonly kind: 'not-a-beacon';
      readonly because: 'call-did-not-answer' | 'answer-is-not-an-address';
    };

/** The reader surface bound to one provider. A thin binding, not a reimplementation. */
export interface ChainReaders {
  hasCode(address: string): Promise<boolean>;
  readImplementationAddress(proxy: string): Promise<ChainAddress>;
  readAdminAddress(proxy: string): Promise<ChainAddress>;
  readBeaconAddress(proxy: string): Promise<ChainAddress>;
  readProxySlots(
    address: string,
    slots?: readonly SlotLabel[],
  ): Promise<ProxySlotsRead>;
  tvmCallOptional(address: string, selector: string): Promise<OptionalCallOutcome>;
  readUpgradeInterfaceVersion(address: string): Promise<string | undefined>;
  looksLikeProxyAdmin(address: string): Promise<boolean>;
  readBeaconImplementation(beacon: string): Promise<BeaconRead>;
}

/** All three slots, which is `readProxySlots`'s default. */
export const slotLabels = Object.freeze([
  'implementation',
  'admin',
  'beacon',
] as const satisfies readonly SlotLabel[]);

/** Mirrors `provider.js:isEmpty` — `code.replace(/^0x/, '') === ''`. */
function isEmptyCode(code: string): boolean {
  return code.replace(/^0x/, '') === '';
}

async function getCode(
  send: TronEthereumProvider,
  address: string,
): Promise<string> {
  return requireResultShape(
    'eth_getCode',
    await send.send('eth_getCode', [toRpcAddress(address), acceptedBlockTag]),
  );
}

async function getStorageAt(
  send: TronEthereumProvider,
  address: string,
  slot: string,
): Promise<string> {
  return requireResultShape(
    'eth_getStorageAt',
    await send.send('eth_getStorageAt', [
      toRpcAddress(address),
      slot,
      acceptedBlockTag,
    ]),
  );
}

/**
 * Modern slot, then legacy, stopping at the first non-empty — so an
 * implementation or admin lookup can cost **two** storage reads. Mirrors
 * `eip-1967.js:getStorageFallback`, including returning the last word read when
 * every slot is empty.
 */
async function readSlotWithFallback(
  send: TronEthereumProvider,
  address: string,
  slots: readonly string[],
): Promise<{ readonly word: string; readonly empty: boolean }> {
  let word = '';
  for (const slot of slots) {
    word = await getStorageAt(send, address, slot);
    if (!isEmptySlotWord(word)) {
      return { word, empty: false };
    }
  }
  return { word, empty: true };
}

function slotsFor(label: SlotLabel): readonly string[] {
  // The beacon has **no legacy fallback** — one slot passed where the other two
  // pass two (`eip-1967.js:getBeaconAddress`). The asymmetry is the engine's and
  // is mirrored rather than smoothed.
  return label === 'beacon'
    ? [eip1967Slots.beacon]
    : [eip1967Slots[label], legacyEip1967Slots[label]];
}

/** One round-trip. */
export async function hasCode(
  send: TronEthereumProvider,
  address: string,
): Promise<boolean> {
  return !isEmptyCode(await getCode(send, address));
}

/**
 * @throws {ChainImplementationNotFoundError} both slots are empty. Mirrors the
 *   engine's `EIP1967ImplementationNotFound`, which **throws**.
 */
export async function readImplementationAddress(
  send: TronEthereumProvider,
  proxy: string,
): Promise<ChainAddress> {
  const read = await readSlotWithFallback(send, proxy, slotsFor('implementation'));
  if (read.empty) {
    throw new ChainImplementationNotFoundError(toRpcAddress(proxy));
  }
  return slotToAddress(read.word);
}

/**
 * Returns the **zero address** for an empty slot rather than throwing.
 *
 * This asymmetry is the engine's — `eip-1967.js:getAdminAddress` returns the
 * checksummed zero address while `getImplementationAddress` and
 * `getBeaconAddress` throw — and it is mirrored rather than smoothed, because
 * `eip-1967-type.js:isTransparentProxy` is `!isEmptySlot(adminAddress)` and a
 * reader that threw here would make that predicate throw instead of returning
 * `false`. A reader surface that tidied this up would make the plugin disagree
 * with the engine about whether an address is a proxy. Returning a checksummed zero
 * address for an empty slot would read as an answer rather than an absence, and
 * upstream diverges per slot — throwing for beacon, returning zero for admin — so
 * this surface matches it per slot rather than uniformly.
 */
export async function readAdminAddress(
  send: TronEthereumProvider,
  proxy: string,
): Promise<ChainAddress> {
  const read = await readSlotWithFallback(send, proxy, slotsFor('admin'));
  return read.empty ? zeroChainAddress : slotToAddress(read.word);
}

/** @throws {ChainBeaconNotFoundError} mirroring `EIP1967BeaconNotFound`. */
export async function readBeaconAddress(
  send: TronEthereumProvider,
  proxy: string,
): Promise<ChainAddress> {
  const read = await readSlotWithFallback(send, proxy, slotsFor('beacon'));
  if (read.empty) {
    throw new ChainBeaconNotFoundError(toRpcAddress(proxy));
  }
  return slotToAddress(read.word);
}

/**
 * The minimum that makes "nothing is deployed here" and "this is not a proxy"
 * distinguishable, without the chain layer deciding proxy kind.
 *
 * **One `eth_getCode` first**, and the slot reads happen only if there
 * is code — so a no-code address costs **one** round-trip rather than six, which
 * is the observable that proves the ordering. Bounded at 6 for all three
 * slots, and the bound does not depend on chain data, which is why the requested
 * labels are de-duplicated.
 *
 * Proxy-kind *judgment* stays with the proxy operations / the beacon
 * operations — this returns what the slots say, never what it means.
 */
export async function readProxySlots(
  send: TronEthereumProvider,
  address: string,
  slots: readonly SlotLabel[] = slotLabels,
): Promise<ProxySlotsRead> {
  if (isEmptyCode(await getCode(send, address))) {
    return Object.freeze({ kind: 'no-code' } as const);
  }

  const requested = [...new Set(slots)];
  const found: Record<SlotLabel, ChainAddress | null> = {
    implementation: null,
    admin: null,
    beacon: null,
  };

  for (const label of requested) {
    const read = await readSlotWithFallback(send, address, slotsFor(label));
    found[label] = read.empty ? null : slotToAddress(read.word);
  }

  return Object.freeze({
    kind: 'code',
    implementation: found.implementation,
    admin: found.admin,
    beacon: found.beacon,
  } as const);
}

function probeReason(
  diagnosis: ProbeDiagnosis,
): 'reverted' | 'no-contract-at-address' {
  return diagnosis.kind === 'reverted' ? 'reverted' : 'no-contract-at-address';
}

/**
 * The chain layer's replacement for `callOptionalSignature`, and the reason no
 * message translation is needed.
 *
 * Returns a union rather than `string | undefined`, and — the property that
 * matters — **never converts a transport failure into a no-answer**. Only a
 * `ChainRpcError` whose diagnosis satisfies `isProbeOutcome` returns; everything
 * else raises.
 *
 * The chain layer never appends, rewrites or augments a node error message so
 * that `call-optional-signature.js`'s four case-sensitive substrings match.
 * `'REVERT opcode executed'.includes('revert')` is `false`, verified by execution,
 * so all four miss both of TRON's probe outcomes and `callOptionalSignature`
 * rethrows where it should return `undefined`. Translating would depend on a
 * private implementation detail a minor bump can reword — the same
 * borrowed-premise failure the no-spoofing rule rejects — and it would report
 * "revert" for "Smart contract is not exist.", collapsing the
 * reverted/no-contract-at-address distinction at the engine boundary.
 * Supplying replacements and denying the plugin the five
 * upstream names is free because all five are reachable from plugin code only.
 */
export async function tvmCallOptional(
  send: TronEthereumProvider,
  address: string,
  selector: string,
): Promise<OptionalCallOutcome> {
  try {
    const data = requireResultShape(
      'eth_call',
      await send.send('eth_call', [
        // `call` sends `[{to, data}, block]` with no `from` and no `gas` —
        // verified at `1.46.0`, and mirrored so the node sees the same request
        // shape from both the engine and this reader.
        { to: toRpcAddress(address), data: selector },
        acceptedBlockTag,
      ]),
    );
    return Object.freeze({ kind: 'answered', data } as const);
  } catch (cause) {
    if (cause instanceof ChainRpcError && isProbeOutcome(cause.diagnosis)) {
      return Object.freeze({
        kind: 'no-answer',
        because: probeReason(cause.diagnosis),
      } as const);
    }
    // A transport failure, a wrong-shaped result, and an
    // `unclassified` node error all raise. "Out of energy" arrives on the same
    // `-32000` as a revert and is a real failure with a real remedy, so absorbing
    // it here would skip a transparent-proxy admin check on an account that
    // simply ran out of a resource the user could top up in a second.
    throw cause;
  }
}

// ── The three replacements for upgrades-core functions unsafe on TRON ────────
//
// Named differently from upstream on purpose, so a mis-import is visible at the
// call site rather than silently correct-looking. The no-translation rule's
// deny-list is closed at five names: `getUpgradeInterfaceVersion`, `inferProxyAdmin`,
// `getImplementationAddressFromBeacon`, `isBeacon`,
// `getImplementationAddressFromProxy` — no module in this package may call them.

const ABI_WORD_HEX_CHARS = 64;
/** An ABI-encoded `string` return puts its data offset in the first word, and it is 32. */
const ABI_STRING_OFFSET = 32;

/**
 * Decodes an ABI-encoded `string` return value, or `undefined` if it is not one.
 *
 * Mirrors `upgrade-interface-version.js` exactly, **including its `offset !== 32`
 * guard and its reason**: a fallback function can answer this call with something
 * that is not a string, and upstream deliberately returns `undefined` rather than
 * throwing for that. Truncating rather than throwing when the declared length
 * overruns the payload mirrors `Buffer.slice`'s behaviour there.
 */
function decodeAbiString(data: string): string | undefined {
  const hex = data.replace(/^0x/, '');
  if (hex.length < ABI_WORD_HEX_CHARS * 2) {
    return undefined;
  }
  const offset = Number.parseInt(hex.slice(0, ABI_WORD_HEX_CHARS), 16);
  if (offset !== ABI_STRING_OFFSET) {
    return undefined;
  }
  const length = Number.parseInt(
    hex.slice(ABI_WORD_HEX_CHARS, ABI_WORD_HEX_CHARS * 2),
    16,
  );
  if (!Number.isFinite(length) || length < 0) {
    return undefined;
  }

  const start = ABI_WORD_HEX_CHARS * 2;
  const bytes = hex.slice(start, start + length * 2);
  if (bytes.length % 2 !== 0) {
    return undefined;
  }

  // Percent-decoding is used rather than `Buffer` or `TextDecoder` so this module
  // reaches for no runtime object at all (in the spirit of the zero-imports
  // discipline, and to the letter of the no-Node-built-ins rule) — the
  // pairs are already validated hex by `stringResultMethods.eth_call`.
  const percentEncoded = (bytes.match(/../g) ?? [])
    .map(pair => `%${pair}`)
    .join('');
  try {
    return decodeURIComponent(percentEncoded);
  } catch (cause) {
    // `decodeURIComponent` throws exactly `URIError`, and only for a byte
    // sequence that is not valid UTF-8 — which means the answer was not a string,
    // the same conclusion upstream's `offset !== 32` guard reaches for the same
    // reason. Anything else propagates.
    if (cause instanceof URIError) {
      return undefined;
    }
    throw cause;
  }
}

/** Replaces `getUpgradeInterfaceVersion`. Same decode, same `offset !== 32` guard. */
export async function readUpgradeInterfaceVersion(
  send: TronEthereumProvider,
  address: string,
): Promise<string | undefined> {
  const outcome = await tvmCallOptional(
    send,
    address,
    selectors.upgradeInterfaceVersion,
  );
  // The one permitted `| undefined` in the chain layer's surface: it mirrors
  // upstream's documented contract for a **present, answering** contract that has
  // no such getter, and it is the only one.
  return outcome.kind === 'answered'
    ? decodeAbiString(outcome.data)
    : undefined;
}

/**
 * Replaces `inferProxyAdmin`.
 *
 * Upstream returns `false` for a *swallowed* error, which "silently disables a
 * safety check". This returns `false` only for a classified probe outcome or
 * a non-address answer, and raises otherwise. Mirrors upstream's decision rule
 * — `owner !== undefined && parseAddress(owner) !== undefined` — with a total
 * predicate in place of the throwing decoder.
 */
export async function looksLikeProxyAdmin(
  send: TronEthereumProvider,
  address: string,
): Promise<boolean> {
  const outcome = await tvmCallOptional(send, address, selectors.owner);
  return (
    outcome.kind === 'answered' && looksLikeSlotAddressWord(outcome.data)
  );
}

/**
 * Replaces `getImplementationAddressFromBeacon` / `isBeacon`.
 *
 * Probes `eth_getCode` **first**, which is what separates "nothing is deployed
   * there" from "deployed but not a beacon" — the node reports both identically, and
   * conflating them tells a user their address is not a beacon when in fact it is
   * not anything. It separates those two
 * conditions — upstream collapses them into `InvalidBeacon`, so a user with
 * nothing deployed at the address is told their contract "doesn't look like a
 * beacon" and the correct action, check the address, is not among the ones the
 * message suggests. One round-trip with no code, exactly two with code.
 */
export async function readBeaconImplementation(
  send: TronEthereumProvider,
  beacon: string,
): Promise<BeaconRead> {
  if (!(await hasCode(send, beacon))) {
    return Object.freeze({ kind: 'no-code-at-beacon' } as const);
  }

  const outcome = await tvmCallOptional(send, beacon, selectors.implementation);
  if (outcome.kind === 'no-answer') {
    return Object.freeze({
      kind: 'not-a-beacon',
      because: 'call-did-not-answer',
    } as const);
  }
  if (!looksLikeSlotAddressWord(outcome.data)) {
    return Object.freeze({
      kind: 'not-a-beacon',
      because: 'answer-is-not-an-address',
    } as const);
  }
  return Object.freeze({
    kind: 'implementation',
    address: slotToAddress(outcome.data),
  } as const);
}

/**
 * Binds the reader surface to one provider.
 *
 * A thin binding, so `access.read.readImplementationAddress(p)` and the
 * free `readImplementationAddress(access.provider, p)` produce identical results
 * and identical request sequences.
 */
export function bindChainReaders(send: TronEthereumProvider): ChainReaders {
  return Object.freeze({
    hasCode: (address: string) => hasCode(send, address),
    readImplementationAddress: (proxy: string) =>
      readImplementationAddress(send, proxy),
    readAdminAddress: (proxy: string) => readAdminAddress(send, proxy),
    readBeaconAddress: (proxy: string) => readBeaconAddress(send, proxy),
    readProxySlots: (address: string, slots?: readonly SlotLabel[]) =>
      slots === undefined
        ? readProxySlots(send, address)
        : readProxySlots(send, address, slots),
    tvmCallOptional: (address: string, selector: string) =>
      tvmCallOptional(send, address, selector),
    readUpgradeInterfaceVersion: (address: string) =>
      readUpgradeInterfaceVersion(send, address),
    looksLikeProxyAdmin: (address: string) =>
      looksLikeProxyAdmin(send, address),
    readBeaconImplementation: (beacon: string) =>
      readBeaconImplementation(send, beacon),
  });
}
