/**
 * The reader surface: every no-answer reason is a named union member, so
 * "nothing is deployed here" never arrives as "this is not a proxy".
 *
 * The distinction is not theoretical. Upstream's `beacon.ts:assertIsBeacon` tells a
 * user their address "is not an upgradeable beacon: its `implementation()` getter
 * did not return an address" when in fact nothing is deployed there at all. Every
 * union in `src/chain/read.ts` exists to keep those apart, and the compiler is what
 * makes you handle both.
 */
import {
  createProvider,
  createRpcChannel,
  eip1967Slots,
  legacyEip1967Slots,
  readProxySlots,
  sameAddress,
  selectors,
  slotToAddress,
  toRpcAddress,
  type ChainAccess,
  type ChainAddress,
  type EndpointDescriptor,
  type JsonRpcPost,
  type SlotLabel,
} from '../../../src/chain';

// ---------------------------------------------------------------------------
// 1. `readProxySlots` — the minimum that keeps "no code" distinguishable
// ---------------------------------------------------------------------------

/**
 * One `eth_getCode` first, and the slot reads happen only if there is code
 * (`src/chain/read.ts:237`). So a no-code address costs **one** round-trip, not
 * six — the observable that proves the ordering.
 *
 * `null` for a slot means the word is zero in the modern slot *and* in the legacy
 * (`org.zeppelinos.*`) fallback where one exists. The beacon has no legacy
 * fallback, mirroring `eip-1967.js:getBeaconAddress` rather than smoothing the
 * asymmetry (`src/chain/read.ts:161`).
 */
export async function describeProxy(
  access: ChainAccess,
  address: string,
): Promise<string> {
  const read = await access.read.readProxySlots(address);
  switch (read.kind) {
    case 'no-code':
      return `${address}: nothing is deployed at this address`;
    case 'code':
      return [
        `${address}: has code`,
        `  implementation: ${read.implementation ?? '(slot empty)'}`,
        `  admin:          ${read.admin ?? '(slot empty)'}`,
        `  beacon:         ${read.beacon ?? '(slot empty)'}`,
      ].join('\n');
  }
}

/** Ask for fewer slots when you only need fewer. Duplicates are de-duplicated. */
export async function implementationSlotOnly(
  access: ChainAccess,
  address: string,
): Promise<ChainAddress | null> {
  const labels: readonly SlotLabel[] = ['implementation'];
  const read = await access.read.readProxySlots(address, labels);
  return read.kind === 'code' ? read.implementation : null;
}

// ---------------------------------------------------------------------------
// 2. The engine's own asymmetry, mirrored rather than tidied
// ---------------------------------------------------------------------------

/**
 * `readImplementationAddress` and `readBeaconAddress` **throw** for an empty slot;
 * `readAdminAddress` returns the **zero address** (`src/chain/read.ts:193-210`).
 *
 * That is upstream's asymmetry, and mirroring it is deliberate:
 * `eip-1967-type.js:isTransparentProxy` is `!isEmptySlot(adminAddress)`, so a
 * reader that threw for an empty admin slot would make that predicate throw
 * instead of returning `false` — and the plugin would disagree with the engine
 * about whether an address is a proxy.
 */
export async function adminOrZero(
  access: ChainAccess,
  proxy: string,
): Promise<ChainAddress> {
  return access.read.readAdminAddress(proxy);
}

/**
 * Comparing addresses: `sameAddress`, never `===` (`src/chain/slots.ts:268`).
 *
 * `ChainAddress` is branded lowercase hex, exactly as derived from a storage word —
 * **not** checksummed. upgrades-core compares addresses with `===` while reading
 * its own manifest, so a casing mismatch silently drops a recorded proxy kind and
 * layout. Canonicalization for persistence is the record layer's job, not this
 * one's.
 *
 * `sameAddress` is also length-checked, which matters more than it looks:
 * `sameAddress('0x', '0x')` is `false`, or else "no implementation" would match
 * "no implementation".
 */
export function isCurrentImplementation(
  observed: ChainAddress,
  expected: string,
): boolean {
  return sameAddress(observed, expected);
}

// ---------------------------------------------------------------------------
// 3. Optional calls — a union, never `string | undefined`
// ---------------------------------------------------------------------------

/**
 * `tvmCallOptional` replaces upstream's `callOptionalSignature`, and the reason no
 * message translation is needed is measured: `'REVERT opcode
 * executed'.includes('revert')` is `false`, so upstream's four case-sensitive
 * substrings miss both of TRON's probe outcomes (`src/chain/read.ts:272-291`).
 *
 * Only a node error whose diagnosis is a probe outcome — reverted, or no contract
 * at the address — returns. A transport failure, a wrong-shaped result and an
 * `unclassified` node error all raise, so "out of energy" (which arrives on the
 * same `-32000` as a revert) cannot silently disable a safety check.
 */
export async function ownerAnswer(
  access: ChainAccess,
  address: string,
): Promise<string> {
  const outcome = await access.read.tvmCallOptional(address, selectors.owner);
  switch (outcome.kind) {
    case 'answered':
      return `owner() returned ${outcome.data}`;
    case 'no-answer':
      return outcome.because === 'reverted'
        ? 'owner() reverted — the contract has no such getter, or it refused'
        : 'nothing is deployed at this address';
  }
}

/**
 * `readBeaconImplementation` keeps three outcomes apart where upstream collapses
 * two of them into `InvalidBeacon` (`src/chain/read.ts:435`).
 */
export async function describeBeacon(
  access: ChainAccess,
  beacon: string,
): Promise<string> {
  const read = await access.read.readBeaconImplementation(beacon);
  switch (read.kind) {
    case 'implementation':
      return `beacon implementation: ${read.address}`;
    case 'no-code-at-beacon':
      return 'nothing is deployed at this address — check the address itself';
    case 'not-a-beacon':
      return read.because === 'call-did-not-answer'
        ? 'a contract is deployed here, but implementation() did not answer'
        : 'implementation() answered with something that is not an address';
  }
}

/**
 * The one place `| undefined` is permitted in the chain layer's surface, and
 * it mirrors upstream's documented contract for a **present, answering**
 * contract with no such getter (`src/chain/read.ts:390`). It is the only one.
 */
export async function interfaceVersion(
  access: ChainAccess,
  address: string,
): Promise<string> {
  const version = await access.read.readUpgradeInterfaceVersion(address);
  return version ?? '(no UPGRADE_INTERFACE_VERSION getter)';
}

// ---------------------------------------------------------------------------
// 4. The published constants, and why they are constants
// ---------------------------------------------------------------------------

/**
 * The five ERC-1967 slot keys and the three selectors are published as literals
 * because the engine hardcodes none of them — it derives all five at every call
 * site (`src/chain/slots.ts:117-167`). They are a **pinned** copy: a test re-runs
 * the engine's own derivation and compares, so an engine bump that changed the
 * hashing fails a test rather than quietly asking `eth_getStorageAt` about a
 * different slot than the engine reads.
 */
export const slotKeys = {
  modern: eip1967Slots,
  legacy: legacyEip1967Slots,
  selectors,
} as const;

/**
 * `slotToAddress` never produces a value by truncation alone: exactly 32 bytes of
 * hex with the top 12 zero, or `ChainSlotMalformedError`
 * (`src/chain/slots.ts:235`). The sibling plugin's version is
 * `'0x' + slotValue.slice(-40)` with no check, so a `'0x'` result yields the string
 * `'0x0x'` and flows into a proxy-kind decision.
 *
 * `toRpcAddress` canonicalizes an inbound argument and refuses TRON's Base58 `T…`
 * form by name, because the node refuses it with a hex-decoding complaint at the
 * wrong layer (`src/chain/slots.ts:299`).
 */
export function decodeSlotWord(word: string): ChainAddress {
  return slotToAddress(word);
}

export function normalizeInboundAddress(address: string): string {
  return toRpcAddress(address);
}

// ---------------------------------------------------------------------------
// 5. Every reader is also a free function taking `send` first
// ---------------------------------------------------------------------------

/**
 * `access.read.readProxySlots(a)` and `readProxySlots(provider, a)` produce
 * identical results and identical request sequences — the binding is thin
 * (`src/chain/read.ts:469`).
 *
 * That shape is why "exactly one translation point" is structural: free functions
 * that each construct their own transport are how the sibling plugin ended up with
 * two, reading the implementation slot through one and *verifying* it through the
 * other, so its post-upgrade check can compare answers about two different
 * addresses. Taking `send` as a parameter means a second transport has to be passed
 * in explicitly, at a call site someone reviews.
 */
export async function readWithoutAComposite(
  endpoint: EndpointDescriptor,
  post: JsonRpcPost,
  address: string,
): Promise<string> {
  const provider = createProvider(createRpcChannel(endpoint, post));
  const read = await readProxySlots(provider, address);
  return read.kind === 'no-code' ? 'no code' : (read.implementation ?? 'empty');
}
