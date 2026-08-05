/**
 * Instance identity: how the chain layer tells "the same chain, restarted"
 * from "the same chain" without ever classifying a network as a dev node.
 *
 * The mechanism dissolves the classification rather than performing it
 * (`src/chain/instance.ts:1-18`). Chain id and genesis hash **survive** a TRE wipe;
 * **block 1's hash does not** — measured across four boots and two TRE image
 * versions. So the *same* comparison is a no-op on mainnet and a refusal on a wiped
 * local node, and there is no chain-id allow-list, no client-version match and no
 * port heuristic to misclassify a legitimate private production chain.
 *
 * Why this matters at all: both of upgrades-core's dev-network accommodations are
 * off for TRON, verified at `1.46.0`.
 *
 *  - `dist/provider.js:104-116` — `isDevelopmentNetwork` short-circuits only on
 *    chain id `1337`/`31337`, then requires a `HardhatNetwork` /
 *    `EthereumJS TestRPC` / `anvil` client-version prefix. TRON reports `TRON`.
 *  - `dist/manifest.js:30-53` — `getDevInstanceMetadata` returns `undefined` only by
 *    **catching** both metadata probes, so no TRON node supplies an `instanceId`.
 *
 * `dist/manifest.js:63-72` therefore takes the non-dev branch, and the manifest
 * lands at the persistent `.openzeppelin/unknown-<chainId>.json`
 * (`dist/manifest.js:78`) rather than an instance-keyed file under `os.tmpdir()`.
 * It accumulates entries across instances.
 */
import {
  ChainInstanceChangedError,
  compareChainInstance,
  manifestPathFor,
  type ChainAccess,
  type ChainInstanceIdentity,
  type InstanceComparison,
  type RecordedChainInstance,
} from '../../../src/chain';

// ---------------------------------------------------------------------------
// 1. Read the fingerprint — once per instance, memoized
// ---------------------------------------------------------------------------

/**
 * Three round-trips: `eth_chainId`, then `eth_getBlockByNumber` at `0x0` and `0x1`
 * (`src/chain/instance.ts:163`). `identity()` memoizes the **promise**, so a second
 * call while the first is in flight awaits the first rather than issuing a second
 * set of reads, and a rejection is memoized too — that is what "at most once per
 * instance" means (`src/chain/index.ts:221-229`).
 *
 * `firstBlockHash` is `null` when the chain has no block 1 yet. That is a
 * **result**, not a failure: `eth_getBlockByNumber` on a nonexistent block returns
 * `{"result":null}`, measured live.
 */
export async function fingerprint(
  access: ChainAccess,
): Promise<ChainInstanceIdentity> {
  return access.identity();
}

/**
 * What a record layer persists — a **subset**, so a partially written record is
 * representable and reads as `indeterminate` rather than as a change
 * (`src/chain/instance.ts:56`).
 */
export function toRecord(
  identity: ChainInstanceIdentity,
): RecordedChainInstance {
  return {
    chainId: identity.chainId,
    genesisHash: identity.genesisHash,
    firstBlockHash: identity.firstBlockHash,
  };
}

// ---------------------------------------------------------------------------
// 2. Compare — pure, total, and never refusing on `indeterminate`
// ---------------------------------------------------------------------------

/**
 * `compareChainInstance` performs no I/O and has a defined answer for every input
 * (`src/chain/instance.ts:252`). Signals are compared chain-id → genesis-hash →
 * first-block-hash and the **disagreeing one is reported**, because a chain-id
 * change means a *different network*, which is a stronger claim than a wipe.
 *
 * **`indeterminate` never produces a refusal**, and that clause is load-bearing: it
 * is the state every existing project is in on the first run after this ships.
 *
 * Every comparison is over the **entire** canonicalized value. A TRON block hash
 * leads with the 8-byte block height, so *every* chain's block-1 hash begins with
 * the same eight bytes — a prefix comparison at any width up to 18 characters
 * reports `same` on every wiped node.
 */
export function comparison(
  recorded: RecordedChainInstance | undefined,
  observed: ChainInstanceIdentity,
): InstanceComparison {
  return compareChainInstance(recorded, observed);
}

export function describeComparison(result: InstanceComparison): string {
  switch (result.kind) {
    case 'same':
      return 'the records describe this instance';
    case 'indeterminate':
      return result.because === 'no-recorded-identity'
        ? 'no recorded identity — first run, or records written before this check existed'
        : 'the recorded identity is incomplete, so no conclusion is available';
    case 'changed':
      return `${result.signal} differs: recorded ${
        result.recorded ?? 'none'
      }, observed ${result.observed ?? 'none'}`;
  }
}

// ---------------------------------------------------------------------------
// 3. The refusal — owned here, thrown by the record layer
// ---------------------------------------------------------------------------

/**
 * The chain layer holds the comparison and therefore owns the text; the
 * record layer decides that refusal is the policy and does the throwing
 * (`src/chain/errors.ts:415-457`).
 *
 * The message **discards nothing and names the remedy**, and the reason is the
 * failure mode it avoids:
 * a discarded manifest entry is a lost record of a live proxy if the detection is
 * ever wrong, and detection can be wrong in one direction — a node behind a load
 * balancer serving two forks reports a change that is true about what it observed
 * but not about the user's intent.
 *
 * "Discards nothing" is **structural, not a promise**: the chain layer has no
 * filesystem access at all, so it is incapable of modifying the file this
 * message names.
 */
export function refuseOnInstanceChange(
  result: InstanceComparison,
  observed: ChainInstanceIdentity,
  recordCount: number,
  access: ChainAccess,
): ChainInstanceChangedError | undefined {
  if (result.kind !== 'changed') {
    return undefined;
  }
  // Name the file from the **observed** chain id, not from `result.observed` —
  // that member is whichever signal disagreed, and for a genesis-hash or
  // first-block-hash change it is a block hash rather than a chain id.
  return new ChainInstanceChangedError(result, {
    manifestFile: manifestPathFor(observed.chainId),
    recordCount,
    endpoint: access.endpoint.describe,
  });
}

// ---------------------------------------------------------------------------
// 4. The file name the message has to be able to cite
// ---------------------------------------------------------------------------

/**
 * `provider.js:networkNames` has 26 entries and **no TRON chain id**, so every TRON
 * network resolves to `unknown-<decimal>` — a name no user would guess unaided,
 * which is exactly why the refusal has to cite it (`src/chain/instance.ts:304-342`).
 *
 * The four verified ids, all reproduced by `parseInt(hex, 16)` — upgrades-core's own
 * conversion at `dist/provider.js:getChainId`:
 *
 * | network | `eth_chainId` | manifest file |
 * |---|---|---|
 * | Mainnet | `0x2b6653dc` | `.openzeppelin/unknown-728126428.json` |
 * | Nile | `0xcd8690dc` | `.openzeppelin/unknown-3448148188.json` |
 * | Shasta | `0x94a9059e` | `.openzeppelin/unknown-2494104990.json` |
 * | TRE (local) | `0xc845df2f` | `.openzeppelin/unknown-3360022319.json` |
 *
 * `MANIFEST_DEFAULT_DIR` is honoured through the optional `env` argument, including
 * upstream's truthiness fallback, so an empty value behaves the same way here as it
 * does there.
 */
export const manifestFiles = {
  mainnet: manifestPathFor('0x2b6653dc'),
  nile: manifestPathFor('0xcd8690dc'),
  shasta: manifestPathFor('0x94a9059e'),
  tre: manifestPathFor('0xc845df2f'),
} as const;

/** Same chain id, a different manifest directory. */
export function manifestIn(chainId: string, dir: string): string {
  return manifestPathFor(chainId, { MANIFEST_DEFAULT_DIR: dir });
}
