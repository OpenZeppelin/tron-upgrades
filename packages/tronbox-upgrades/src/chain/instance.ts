/**
 * The chain-observed instance identity, its comparator, and the manifest file
 * name the refusal message has to be able to cite.
 *
 * **INV-25: nothing in this module — nothing in `src/chain/**` — decides whether a
 * chain is a development, disposable, local or dev node.** No chain-id allow-list,
 * no client-version match, no port heuristic, no `isDevelopmentNetwork`-shaped
 * predicate. The mechanism dissolves the need: block 1's hash is immutable on a
 * persistent chain and per-boot on a disposable one, so the *same* comparison is a
 * no-op on mainnet and a refusal on a wiped TRE.
 *
 * That is what keeps SF-1 clear of the hazard the spec names — "inferring
 * 'disposable' from an unrecognized chain id would misclassify a legitimate
 * private production chain" — and the dissolution is only durable while the
 * classification stays absent. The first `if (chainId === TRE_CHAIN_ID)` added for
 * a "nicer local-node message" reintroduces it, and it will be added by someone
 * who reads the refusal text and wants to tailor it.
 */

import { ChainTransportError, type ChainInstanceChange } from './errors';
import type { EndpointDescriptor } from './endpoint';
import { requireResultShape, type TronEthereumProvider } from './provider';

/**
 * A chain instance's fingerprint, read from the chain.
 *
 * INV-10: every field that participates in a comparison is **canonicalized before
 * it is returned**. Design's doc said `chainId` was "`0x`-prefixed lowercase hex,
 * as the node reports it", and those two clauses can disagree — if a node version
 * changes its hex casing, or a proxy uppercases it, an un-canonicalized comparison
 * reports `changed` with `signal: 'chain-id'`, whose message leads with "a
 * different network", the strongest and most alarming claim SF-1 makes, for a chain
 * that has not changed at all. A false refusal on the strongest wording is how a
 * correct safety feature gets disabled by its users. Canonical wins.
 */
export interface ChainInstanceIdentity {
  /** `0x` + lowercase hex, reduced to its minimal form. */
  readonly chainId: string;
  /**
   * Block 0's hash, `0x` + 64 lowercase hex with **no** leading-zero
   * normalization. Constant across a TRE wipe — measured over four boots and two
   * image versions.
   */
  readonly genesisHash: string;
  /**
   * Block 1's hash — the only per-boot signal found. `null` when the chain has no
   * block 1 yet, which is a **result** and not a failure: measured live,
   * `eth_getBlockByNumber('0xfffffffff')` returns `{"result":null}`.
   */
  readonly firstBlockHash: string | null;
  /** Scrubbed endpoint that answered (INV-42). Diagnostic only; never a comparison operand. */
  readonly observedThrough: string;
}

/** What SF-3 persists. A subset, so a partially written record is representable. */
export interface RecordedChainInstance {
  readonly chainId: string;
  readonly genesisHash?: string;
  readonly firstBlockHash?: string | null;
}

export type InstanceComparison =
  | { readonly kind: 'same' }
  | ChainInstanceChange
  | {
      readonly kind: 'indeterminate';
      readonly because: 'no-recorded-identity' | 'recorded-identity-incomplete';
    };

const BLOCK_HASH_HEX_CHARS = 64;
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;
/** The chain id is the **last four bytes** of the genesis hash — confirmed live. */
const CHAIN_ID_BYTES = 4;

const GENESIS_BLOCK_TAG = '0x0';
const FIRST_BLOCK_TAG = '0x1';

/** upstream's default, read from the environment at `manifest.js:28`. */
const MANIFEST_DEFAULT_DIR = '.openzeppelin';

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  );
}

function stripHexPrefix(value: string): string {
  return value.startsWith('0x') || value.startsWith('0X')
    ? value.slice(2)
    : value;
}

/** `0x` + lowercase hex with leading zeros removed, so `0x0002B6653DC` and `0x2b6653dc` agree. */
function canonicalChainId(value: string): string {
  const digits = stripHexPrefix(value).toLowerCase().replace(/^0+(?=.)/, '');
  return `0x${digits}`;
}

/**
 * `0x` + lowercase hex, **with leading zeros preserved**.
 *
 * A hash is a fixed-width value, so stripping its leading zeros would not
 * normalize it — it would destroy it. TRON block hashes lead with the 8-byte block
 * height, so block 1's hash *begins* with fifteen zeros and a one.
 */
function canonicalHash(value: string): string {
  return `0x${stripHexPrefix(value).toLowerCase()}`;
}

function inconsistent(endpoint: EndpointDescriptor, detail: string): never {
  throw new ChainTransportError(
    'eth_chainId + eth_getBlockByNumber',
    { kind: 'malformed-envelope', detail },
    endpoint.describe,
  );
}

/**
 * Reads one block's hash, or `null` when there is no such block.
 *
 * A block that exists but whose `hash` is not a 32-byte hex value is a
 * transport-level inconsistency, not an instance change — the endpoint is not
 * answering as an Ethereum-compatible JSON-RPC service, and saying "the chain
 * changed" about it would be a confident claim built on an unparsed value.
 */
async function readBlockHash(
  send: TronEthereumProvider,
  endpoint: EndpointDescriptor,
  tag: string,
): Promise<string | null> {
  const block = await send.send('eth_getBlockByNumber', [tag, false]);
  if (block === null) {
    return null;
  }
  if (!isObjectLike(block)) {
    inconsistent(
      endpoint,
      `eth_getBlockByNumber(${tag}) answered a ${typeof block} rather than a ` +
        'block object or null',
    );
  }
  const hash = block['hash'];
  if (typeof hash !== 'string' || !BLOCK_HASH.test(hash)) {
    inconsistent(
      endpoint,
      `eth_getBlockByNumber(${tag}) answered a block whose "hash" is not a ` +
        '32-byte hex value',
    );
  }
  return canonicalHash(hash);
}

/**
 * Reads the fingerprint. Three round-trips (INV-40): `eth_chainId`, and
 * `eth_getBlockByNumber` at `0x0` and `0x1` with `false` for full transactions.
 *
 * `eth_getBlockByNumber` is the **eighth** method — SF-1's own, not the engine's.
 * It is the one place SF-1 depends on a method upgrades-core never calls, and it is
 * safe to depend on for a reason worth stating: java-tron's *block-query* methods
 * accept heights and named tags, while its *state* methods accept only `latest`.
 * Do not generalize either way.
 */
export async function readChainInstanceIdentity(
  send: TronEthereumProvider,
  endpoint: EndpointDescriptor,
): Promise<ChainInstanceIdentity> {
  const chainId = canonicalChainId(
    requireResultShape('eth_chainId', await send.send('eth_chainId', [])),
  );

  const genesisHash = await readBlockHash(send, endpoint, GENESIS_BLOCK_TAG);
  if (genesisHash === null) {
    // Every chain has a genesis block. An endpoint that says otherwise is not
    // describing a chain SF-1 can fingerprint.
    inconsistent(
      endpoint,
      'the endpoint reports no genesis block, so it is not serving a chain this ' +
        'plugin can identify',
    );
  }

  // INV-10's free internal cross-check: the chain id **is** the last four bytes
  // of the genesis hash (`0x…4196a1d22b6653dc` vs `0x2b6653dc`, confirmed live on
  // mainnet). A disagreement means the endpoint answered two questions from two
  // different chains — a load balancer in front of two nodes, most plausibly —
  // and that is a transport-level inconsistency rather than an instance change,
  // because "the chain changed" would be a claim about a chain, and there are two.
  const tail = canonicalChainId(
    genesisHash.slice(genesisHash.length - CHAIN_ID_BYTES * 2),
  );
  if (tail !== chainId) {
    inconsistent(
      endpoint,
      `eth_chainId reports ${chainId} but the genesis block's hash ends in ` +
        `${tail}; the chain id is the last four bytes of the genesis hash, so ` +
        'these two answers describe different chains',
    );
  }

  const firstBlockHash = await readBlockHash(send, endpoint, FIRST_BLOCK_TAG);

  return Object.freeze({
    chainId,
    genesisHash,
    firstBlockHash,
    observedThrough: endpoint.describe,
  });
}

function same(): InstanceComparison {
  return Object.freeze({ kind: 'same' } as const);
}

function indeterminate(
  because: 'no-recorded-identity' | 'recorded-identity-incomplete',
): InstanceComparison {
  return Object.freeze({ kind: 'indeterminate', because } as const);
}

function changed(
  signal: ChainInstanceChange['signal'],
  recorded: string | null,
  observed: string | null,
): InstanceComparison {
  return Object.freeze({ kind: 'changed', signal, recorded, observed } as const);
}

/**
 * Pure and total (INV-25): no I/O, no ambient state, and a defined answer for
 * every input. Signals are compared chain-id → genesis-hash → first-block-hash,
 * and the disagreeing one is reported so the message can differ — a chain-id
 * change means a *different network*, which is a stronger statement than a wipe.
 *
 * **INV-10: every comparison is over the entire canonicalized value.** No prefix,
 * no suffix, no truncation, no fixed-width slice. That is not a stylistic
 * preference: **a TRON block hash leads with the 8-byte block height.** Mainnet
 * block 1 is `0x0000000000000001` + `0ff5414c…`, block 0 is `0x0000000000000000` +
 * `1ebf8850…`, measured live. So *every* chain's block 1 hash begins with the same
 * eight bytes, and any comparison that looks at a prefix — or that stores a
 * truncated fingerprint to keep a record small — reports `same` on every wiped
 * node, silently restoring the exact behaviour this mechanism exists to prevent.
 * The discriminating material is only the trailing 24 bytes.
 *
 * Both sides are canonicalized here rather than trusted, so a record written by an
 * older SF-3 in a different casing does not read as a different chain.
 *
 * **`indeterminate` never produces a refusal**, and that clause is load-bearing:
 * it is the state **every** existing project is in on the first run after this
 * ships, and refusing there would make the feature a breaking change for a
 * condition it cannot tell apart from a first run.
 */
export function compareChainInstance(
  recorded: RecordedChainInstance | undefined,
  observed: ChainInstanceIdentity,
): InstanceComparison {
  if (recorded === undefined || recorded.chainId.length === 0) {
    return indeterminate('no-recorded-identity');
  }

  const recordedChainId = canonicalChainId(recorded.chainId);
  if (recordedChainId !== observed.chainId) {
    return changed('chain-id', recordedChainId, observed.chainId);
  }

  if (recorded.genesisHash === undefined) {
    return indeterminate('recorded-identity-incomplete');
  }
  const recordedGenesis = canonicalHash(recorded.genesisHash);
  if (recordedGenesis !== observed.genesisHash) {
    return changed('genesis-hash', recordedGenesis, observed.genesisHash);
  }

  if (!('firstBlockHash' in recorded)) {
    return indeterminate('recorded-identity-incomplete');
  }
  const recordedFirst = recorded.firstBlockHash;
  if (recordedFirst === null || recordedFirst === undefined) {
    // The record carries no first-block hash to compare — `null` is not a hash.
    // A chain that had no block 1 when the record was written and has one now is
    // indistinguishable from one that was wiped and has since produced a block, so
    // this is genuinely undecidable and takes the non-refusing branch (INV-25).
    return observed.firstBlockHash === null
      ? same()
      : indeterminate('recorded-identity-incomplete');
  }

  const recordedFirstHash = canonicalHash(recordedFirst);
  if (observed.firstBlockHash === null) {
    // Reported as `changed` rather than `indeterminate`: a chain with no block 1
    // cannot contain the deployments the records describe.
    return changed('first-block-hash', recordedFirstHash, null);
  }
  if (recordedFirstHash !== observed.firstBlockHash) {
    return changed(
      'first-block-hash',
      recordedFirstHash,
      observed.firstBlockHash,
    );
  }

  return same();
}

/**
 * The file the refusal message has to be able to name.
 *
 * `provider.js:networkNames` has 26 entries and **no TRON chain id** (0 hits for
 * all four measured ids), so every TRON network resolves to `unknown-<decimal>`:
 * mainnet `unknown-728126428`, Nile `unknown-3448148188`, Shasta
 * `unknown-2494104990`, TRE `unknown-3360022319`. A name no user would guess, which
 * is exactly why INV-26 requires the refusal to be able to cite it.
 *
 * The decimal is computed with the **same** `parseInt(hex, 16)` upstream uses in
 * `getChainId`, because the name has to match the file upgrades-core actually
 * writes — not because that parse is a good one. INV-4's guard is what makes it
 * safe here, and the guard is re-applied rather than assumed, since SF-3 calls this
 * with a value that has crossed a persistence boundary.
 *
 * Honours `MANIFEST_DEFAULT_DIR` through `env`, including upstream's truthiness
 * fallback (`process.env.MANIFEST_DEFAULT_DIR || '.openzeppelin'`), so an empty
 * value behaves the same way here as it does there.
 *
 * @throws {ChainResultShapeError} the chain id is not a hex quantity that parses
 *   to a positive integer — the condition that otherwise renders
 *   `.openzeppelin/unknown-NaN.json`, a file no later run consults.
 */
export function manifestPathFor(
  chainId: string,
  env?: Readonly<Record<string, string | undefined>>,
): string {
  const validated = requireResultShape('eth_chainId', chainId);
  const decimal = Number.parseInt(stripHexPrefix(validated), 16);
  const configured = env?.['MANIFEST_DEFAULT_DIR'];
  const dir =
    configured !== undefined && configured.length > 0
      ? configured
      : MANIFEST_DEFAULT_DIR;
  // A `/` join rather than `node:path` — INV-33 keeps every Node built-in out of
  // this directory, and this string is a name rendered into a message, not a path
  // SF-1 opens. SF-1 opens nothing.
  return `${dir.replace(/\/+$/, '')}/unknown-${String(decimal)}.json`;
}

/** Exported for the tests that pin the hash width the comparator depends on. */
export const blockHashHexChars = BLOCK_HASH_HEX_CHARS;
