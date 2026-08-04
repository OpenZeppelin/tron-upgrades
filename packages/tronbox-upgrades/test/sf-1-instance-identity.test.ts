/**
 * SF-1 — INV-10, INV-25, INV-26, INV-37(c) and INV-11's eighth method.
 *
 * The whole mechanism rests on one measured fact and one arithmetic identity, and
 * both are hostile to the obvious implementation:
 *
 * **A TRON block hash leads with the 8-byte block height.** Mainnet block 1 is
 * `0x0000000000000001` + `0ff5414c…`; block 0 is `0x0000000000000000` +
 * `1ebf8850…`. So *every* chain's block 1 hash begins with the same eight bytes,
 * and any comparison that looks at a prefix — or that stores a truncated
 * fingerprint to keep a record small — reports `same` on every wiped node. § 1
 * drives exactly that specimen: two block-1 hashes sharing sixteen leading hex
 * characters and differing only in the trailing 24 bytes.
 *
 * **The chain id is the last four bytes of the genesis hash.** That gives a free
 * cross-check, and § 3 asserts a disagreement is reported as a *transport* fault —
 * because "the chain changed" is a claim about *a* chain, and a load balancer in
 * front of two nodes means there are two.
 *
 * INV-25's other half is negative and is asserted by scan in
 * `sf-1-absence-scans.test.ts`: no branch anywhere in `src/chain/**` decides that a
 * chain is a development, disposable or local node.
 */

import { describe, expect, it } from 'vitest';
import { ChainResultShapeError, ChainTransportError } from '../src/chain/errors';
import {
  blockHashHexChars,
  compareChainInstance,
  manifestPathFor,
  readChainInstanceIdentity,
  type ChainInstanceIdentity,
  type RecordedChainInstance,
} from '../src/chain/instance';
import {
  MAINNET_CHAIN_ID,
  bareProvider,
  mainnetFirstBlockHash,
  mainnetGenesisHash,
  type RpcTable,
} from './helpers/sf-1-chain';

const endpoint = Object.freeze({
  describe: 'http://node.internal:8545/jsonrpc',
  origin: 'derived' as const,
});

/** The real mainnet triple, canonical. Every § 1 fixture is a perturbation of it. */
const mainnet: ChainInstanceIdentity = Object.freeze({
  chainId: MAINNET_CHAIN_ID,
  genesisHash: mainnetGenesisHash,
  firstBlockHash: mainnetFirstBlockHash,
  observedThrough: endpoint.describe,
});

function identity(
  overrides: Partial<ChainInstanceIdentity> = {},
): ChainInstanceIdentity {
  return Object.freeze({ ...mainnet, ...overrides });
}

/** A block-1 hash from a *different* boot: same height prefix, different tail. */
const wipedFirstBlockHash =
  '0x0000000000000001aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff';

// ---------------------------------------------------------------------------
// 1. INV-10 — the height prefix, and why a prefix compare is a wrong answer
// ---------------------------------------------------------------------------

describe('INV-10: block 1 hashes share their leading eight bytes across every chain', () => {
  it('measures the shared prefix rather than asserting it', () => {
    // The premise, executed. Both hashes are block **1**, so both encode height 1
    // in their leading eight bytes. This is the fact that makes a prefix compare
    // return `same` for two different boots.
    const heightPrefix = '0x0000000000000001';
    expect(mainnetFirstBlockHash.startsWith(heightPrefix)).toBe(true);
    expect(wipedFirstBlockHash.startsWith(heightPrefix)).toBe(true);
    expect(mainnetFirstBlockHash.slice(0, 18)).toBe(
      wipedFirstBlockHash.slice(0, 18),
    );

    // And block 0 encodes height 0 the same way, which is why the genesis hash is
    // constant across a wipe and cannot carry the per-boot signal on its own.
    expect(mainnetGenesisHash.startsWith('0x0000000000000000')).toBe(true);
  });

  it('reports changed for two block-1 hashes that differ only in the trailing 24 bytes', () => {
    // The load-bearing case. A prefix compare, a truncated fingerprint, or a
    // fixed-width slice would all report `same` here — which is silently restoring
    // the behaviour the whole mechanism exists to prevent.
    const recorded: RecordedChainInstance = {
      chainId: MAINNET_CHAIN_ID,
      genesisHash: mainnetGenesisHash,
      firstBlockHash: mainnetFirstBlockHash,
    };

    const verdict = compareChainInstance(
      recorded,
      identity({ firstBlockHash: wipedFirstBlockHash }),
    );

    expect(verdict.kind).toBe('changed');
    expect(verdict.kind === 'changed' ? verdict.signal : undefined).toBe(
      'first-block-hash',
    );
  });

  it('would report same under every prefix width up to the discriminating byte', () => {
    // Non-vacuity for the case above, stated as a measurement instead of a claim.
    // Every prefix comparison from 1 to 18 characters agrees, so a guard written
    // with any of them passes while being wrong. Only the whole value separates.
    for (let width = 1; width <= 18; width += 1) {
      expect(
        mainnetFirstBlockHash.slice(0, width),
        `prefix width ${String(width)} already distinguishes the two boots`,
      ).toBe(wipedFirstBlockHash.slice(0, width));
    }
    expect(mainnetFirstBlockHash).not.toBe(wipedFirstBlockHash);
    // 0x + 64 hex characters. The comparator depends on the width, so it is pinned.
    expect(blockHashHexChars).toBe(64);
    expect(mainnetFirstBlockHash).toHaveLength(2 + blockHashHexChars);
  });

  it('pins the real mainnet pair, so a fixture drifting from the chain is visible', () => {
    // The one fixture INV-10's own test plan asks for by name. Measured live on
    // TronGrid mainnet: the genesis hash's last four bytes are the chain id.
    expect(mainnetGenesisHash.endsWith('2b6653dc')).toBe(true);
    expect(MAINNET_CHAIN_ID).toBe('0x2b6653dc');
    expect(compareChainInstance(
      { chainId: MAINNET_CHAIN_ID, genesisHash: mainnetGenesisHash, firstBlockHash: mainnetFirstBlockHash },
      mainnet,
    )).toEqual({ kind: 'same' });
  });
});

// ---------------------------------------------------------------------------
// 2. INV-10 — canonicalization on both sides
// ---------------------------------------------------------------------------

describe('INV-10: both sides are canonicalized, so casing is never a false refusal', () => {
  it('compares 0X2B6653DC and 0x2b6653dc as the same chain', () => {
    // The originally specified `chainId` shape was "`0x`-prefixed lowercase hex, **as the node
    // reports it**", and those clauses can disagree. An un-canonicalized compare
    // reports `changed` with `signal: 'chain-id'` — whose message leads with "a
    // different network", the strongest claim SF-1 makes — for a chain that has not
    // changed at all. A false refusal on the strongest wording is how a correct
    // safety feature gets switched off by its users.
    const verdict = compareChainInstance(
      { chainId: '0X2B6653DC', genesisHash: mainnetGenesisHash.toUpperCase().replace('0X', '0x'), firstBlockHash: mainnetFirstBlockHash.toUpperCase().replace('0X', '0x') },
      mainnet,
    );
    expect(verdict).toEqual({ kind: 'same' });
  });

  it('canonicalizes the *recorded* side too, not only the observed one', () => {
    // The direction a "the reader already lowercases" argument misses: the record
    // crossed a persistence boundary and may have been written by an older SF-3.
    expect(
      compareChainInstance(
        { chainId: '0x0002B6653DC', genesisHash: mainnetGenesisHash, firstBlockHash: mainnetFirstBlockHash },
        mainnet,
      ),
    ).toEqual({ kind: 'same' });
  });

  it('preserves a hash\'s leading zeros while reducing a chain id\'s', () => {
    // The two canonicalizations are deliberately different, and conflating them
    // breaks one or the other: a hash is fixed-width, so stripping its leading
    // zeros destroys it rather than normalizing it — and block 1's hash *begins*
    // with fifteen zeros and a one.
    const table: RpcTable = {
      eth_chainId: { result: '0x0002B6653DC' },
      eth_getBlockByNumber: { result: { hash: mainnetGenesisHash } },
    };
    const provider = bareProvider(table);
    return readChainInstanceIdentity(provider, endpoint).then(read => {
      expect(read.chainId).toBe('0x2b6653dc');
      expect(read.genesisHash).toBe(mainnetGenesisHash);
      expect(read.genesisHash.startsWith('0x0000000000000000')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. INV-10 — the cross-check is a TRANSPORT fault, not an instance change
// ---------------------------------------------------------------------------

/** A responder that answers block 0 and block 1 from different tags. */
function blockResponder(
  chainId: string,
  blocks: Readonly<Record<string, unknown>>,
): {
  send(method: string, params: readonly unknown[]): Promise<unknown>;
  readonly seen: readonly string[];
} {
  const seen: string[] = [];
  return {
    seen,
    send: async (method: string, params: readonly unknown[]): Promise<unknown> => {
      seen.push(method);
      if (method === 'eth_chainId') {
        return chainId;
      }
      if (method === 'eth_getBlockByNumber') {
        const tag = params[0];
        return typeof tag === 'string' && tag in blocks ? blocks[tag] : null;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

describe('INV-10: a genesis/chain-id disagreement is a transport inconsistency', () => {
  it('raises ChainTransportError rather than reporting an instance change', async () => {
    // A load balancer in front of two nodes is the plausible cause, and it is why
    // this cannot be an instance change: "the chain changed" is a claim about *a*
    // chain, and here there are two. Reporting a change would name a fingerprint
    // that was never coherent.
    const provider = blockResponder(MAINNET_CHAIN_ID, {
      // Nile's genesis hash against mainnet's chain id.
      '0x0': { hash: '0x00000000000000000000000000000000000000000000000000000000cd8690dc' },
    });

    const failure = await readChainInstanceIdentity(provider, endpoint).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(ChainTransportError);
    const error: Error = failure instanceof Error ? failure : new Error('none');
    expect(error.message).toContain('different chains');
    // The claim has to be checkable by the reader, so both operands are named.
    expect(error.message).toContain('0x2b6653dc');
    expect(error.message).toContain('0xcd8690dc');
  });

  it('does not read block 1 once the cross-check has failed', async () => {
    // Ordering matters for the cost claim (INV-40) and for the diagnosis: a third
    // round-trip against an endpoint already known to be incoherent buys nothing.
    const provider = blockResponder(MAINNET_CHAIN_ID, {
      '0x0': { hash: '0x00000000000000000000000000000000000000000000000000000000cd8690dc' },
    });

    await readChainInstanceIdentity(provider, endpoint).catch(() => undefined);

    expect(provider.seen).toEqual(['eth_chainId', 'eth_getBlockByNumber']);
  });

  it('accepts the coherent mainnet pair, so the cross-check refuses nothing real', async () => {
    const provider = blockResponder(MAINNET_CHAIN_ID, {
      '0x0': { hash: mainnetGenesisHash },
      '0x1': { hash: mainnetFirstBlockHash },
    });

    const read = await readChainInstanceIdentity(provider, endpoint);

    expect(read.chainId).toBe(MAINNET_CHAIN_ID);
    expect(read.genesisHash).toBe(mainnetGenesisHash);
    expect(read.firstBlockHash).toBe(mainnetFirstBlockHash);
    // INV-40: exactly three round-trips.
    expect(provider.seen).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getBlockByNumber',
    ]);
  });

  it('treats an absent genesis block as a transport fault', async () => {
    const provider = blockResponder(MAINNET_CHAIN_ID, {});
    const failure = await readChainInstanceIdentity(provider, endpoint).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ChainTransportError);
    const error: Error = failure instanceof Error ? failure : new Error('none');
    expect(error.message).toContain('no genesis block');
  });

  it('treats a block whose hash is not 32 bytes as a transport fault', async () => {
    // Saying "the chain changed" about an unparsed value would be a confident claim
    // built on nothing.
    const provider = blockResponder(MAINNET_CHAIN_ID, { '0x0': { hash: '0xabc' } });
    const failure = await readChainInstanceIdentity(provider, endpoint).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ChainTransportError);
  });

  it('accepts result: null for block 1 as an answer, not a failure', async () => {
    // Measured live: `eth_getBlockByNumber('0xfffffffff')` returns
    // `{"result":null}`, so "there is no block 1" is a **result** and INV-8 forbids
    // collapsing it into the same value as "the read failed".
    const provider = blockResponder(MAINNET_CHAIN_ID, {
      '0x0': { hash: mainnetGenesisHash },
    });

    const read = await readChainInstanceIdentity(provider, endpoint);

    expect(read.firstBlockHash).toBeNull();
  });

  it('validates the chain id it reads, so an unvalidated one cannot enter a fingerprint', async () => {
    const provider = blockResponder('728126428', {
      '0x0': { hash: mainnetGenesisHash },
    });
    const failure = await readChainInstanceIdentity(provider, endpoint).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ChainResultShapeError);
  });
});

// ---------------------------------------------------------------------------
// 4. INV-25 — total, pure, and indeterminate never refuses
// ---------------------------------------------------------------------------

describe('INV-25: the comparator is total over {absent, partial, complete}', () => {
  it('reports no-recorded-identity for an absent record', () => {
    // The state **every** existing project is in on the first run after this ships.
    expect(compareChainInstance(undefined, mainnet)).toEqual({
      kind: 'indeterminate',
      because: 'no-recorded-identity',
    });
  });

  it('reports no-recorded-identity for an empty chain id', () => {
    expect(compareChainInstance({ chainId: '' }, mainnet)).toEqual({
      kind: 'indeterminate',
      because: 'no-recorded-identity',
    });
  });

  it('reports recorded-identity-incomplete for a record missing the genesis hash', () => {
    expect(compareChainInstance({ chainId: MAINNET_CHAIN_ID }, mainnet)).toEqual({
      kind: 'indeterminate',
      because: 'recorded-identity-incomplete',
    });
  });

  it('reports recorded-identity-incomplete for a record missing the first-block hash', () => {
    expect(
      compareChainInstance(
        { chainId: MAINNET_CHAIN_ID, genesisHash: mainnetGenesisHash },
        mainnet,
      ),
    ).toEqual({ kind: 'indeterminate', because: 'recorded-identity-incomplete' });
  });

  it('reports changed with signal chain-id for a different network', () => {
    expect(
      compareChainInstance(
        { chainId: '0xcd8690dc', genesisHash: mainnetGenesisHash, firstBlockHash: mainnetFirstBlockHash },
        mainnet,
      ),
    ).toEqual({
      kind: 'changed',
      signal: 'chain-id',
      recorded: '0xcd8690dc',
      observed: MAINNET_CHAIN_ID,
    });
  });

  it('reports changed with signal genesis-hash when the chain id agrees', () => {
    const otherGenesis =
      '0x0000000000000000ffffffffffffffffffffffffffffffffffffffff2b6653dc';
    const verdict = compareChainInstance(
      { chainId: MAINNET_CHAIN_ID, genesisHash: otherGenesis, firstBlockHash: mainnetFirstBlockHash },
      mainnet,
    );
    expect(verdict.kind === 'changed' ? verdict.signal : undefined).toBe(
      'genesis-hash',
    );
  });

  it('compares in the order chain-id → genesis-hash → first-block-hash', () => {
    // When all three disagree, the reported signal must be the first — because the
    // message differs per signal and a chain-id change is the stronger statement.
    const verdict = compareChainInstance(
      { chainId: '0xcd8690dc', genesisHash: wipedFirstBlockHash, firstBlockHash: wipedFirstBlockHash },
      mainnet,
    );
    expect(verdict.kind === 'changed' ? verdict.signal : undefined).toBe('chain-id');
  });

  it('reports changed when a recorded first-block hash meets an observed null', () => {
    // The specified direction: a chain with no block 1 cannot contain the
    // deployments the records describe.
    const verdict = compareChainInstance(
      { chainId: MAINNET_CHAIN_ID, genesisHash: mainnetGenesisHash, firstBlockHash: mainnetFirstBlockHash },
      identity({ firstBlockHash: null }),
    );
    expect(verdict).toEqual({
      kind: 'changed',
      signal: 'first-block-hash',
      recorded: mainnetFirstBlockHash,
      observed: null,
    });
  });

  it('reports indeterminate for the reverse direction — recorded null, observed a hash', () => {
    // the implementation's decided default, pinned. This direction is genuinely undecidable:
    // a chain that had no block 1 when the record was written and has one now is
    // indistinguishable from one wiped and since restarted, because genesis is
    // constant across a TRE wipe. So it takes INV-25's non-refusing branch.
    expect(
      compareChainInstance(
        { chainId: MAINNET_CHAIN_ID, genesisHash: mainnetGenesisHash, firstBlockHash: null },
        mainnet,
      ),
    ).toEqual({ kind: 'indeterminate', because: 'recorded-identity-incomplete' });
  });

  it('reports same when both sides have no block 1', () => {
    expect(
      compareChainInstance(
        { chainId: MAINNET_CHAIN_ID, genesisHash: mainnetGenesisHash, firstBlockHash: null },
        identity({ firstBlockHash: null }),
      ),
    ).toEqual({ kind: 'same' });
  });

  it('never returns a refusal for any indeterminate input', () => {
    // The clause restated as a property over the whole partial-record space.
    const partials: readonly RecordedChainInstance[] = [
      { chainId: MAINNET_CHAIN_ID },
      { chainId: MAINNET_CHAIN_ID, genesisHash: mainnetGenesisHash },
      { chainId: '0X2B6653DC' },
    ];
    for (const recorded of partials) {
      const verdict = compareChainInstance(recorded, mainnet);
      expect(verdict.kind).not.toBe('changed');
    }
  });

  it('is pure — the same inputs give the same answer and nothing is mutated', () => {
    const recorded: RecordedChainInstance = {
      chainId: MAINNET_CHAIN_ID,
      genesisHash: mainnetGenesisHash,
      firstBlockHash: wipedFirstBlockHash,
    };
    const snapshot = JSON.stringify({ recorded, observed: mainnet });

    const first = compareChainInstance(recorded, mainnet);
    const second = compareChainInstance(recorded, mainnet);

    expect(first).toEqual(second);
    // INV-37(c): the comparator performs no read, so its verdict cannot depend on
    // when it was called. Purity is what makes that structural.
    expect(JSON.stringify({ recorded, observed: mainnet })).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// 5. INV-26 — the file the refusal has to be able to name
// ---------------------------------------------------------------------------

describe('INV-26: manifestPathFor names the file no user would guess', () => {
  it('resolves mainnet to .openzeppelin/unknown-728126428.json', () => {
    // `provider.js:networkNames` has 26 entries and **no TRON chain id**, so every
    // TRON network resolves to `unknown-<decimal>` — a name no user would guess,
    // which is exactly why the refusal must cite it.
    expect(manifestPathFor(MAINNET_CHAIN_ID)).toBe(
      '.openzeppelin/unknown-728126428.json',
    );
  });

  it.each([
    { network: 'Nile', decimal: 3_448_148_188 },
    { network: 'Shasta', decimal: 2_494_104_990 },
    { network: 'TRE', decimal: 3_360_022_319 },
  ])(
    'resolves $network to unknown-$decimal.json',
    ({ decimal }) => {
      // The hex is **derived** from the decimal rather than written twice. Writing
      // both invites exactly the transcription error this test caught on its first
      // run, and the decimal is the half that matters — it is the filename
      // upgrades-core writes and the string the refusal has to cite.
      const chainId = `0x${decimal.toString(16)}`;
      expect(manifestPathFor(chainId)).toBe(
        `.openzeppelin/unknown-${String(decimal)}.json`,
      );
    },
  );

  it('honours MANIFEST_DEFAULT_DIR through deps.env', () => {
    expect(
      manifestPathFor(MAINNET_CHAIN_ID, { MANIFEST_DEFAULT_DIR: 'build/oz' }),
    ).toBe('build/oz/unknown-728126428.json');
  });

  it('falls back to .openzeppelin for an empty MANIFEST_DEFAULT_DIR, as upstream does', () => {
    // upstream is `process.env.MANIFEST_DEFAULT_DIR || '.openzeppelin'`, so an
    // empty value is falsy there. Matching that matters because the name has to be
    // the file upgrades-core actually writes.
    expect(manifestPathFor(MAINNET_CHAIN_ID, { MANIFEST_DEFAULT_DIR: '' })).toBe(
      '.openzeppelin/unknown-728126428.json',
    );
  });

  it('refuses a non-hex chain id rather than naming unknown-NaN.json', () => {
    // The guard is re-applied rather than assumed, because SF-3 calls this with a
    // value that crossed a persistence boundary. Without it the refusal would cite
    // `.openzeppelin/unknown-NaN.json` — a file no run consults — as the remedy.
    for (const bad of ['728126428', '0x', '', 'not-hex']) {
      const failure = ((): Error => {
        try {
          manifestPathFor(bad);
          return new Error('no rejection');
        } catch (cause) {
          return cause instanceof Error ? cause : new Error('non-error');
        }
      })();
      expect(failure, `manifestPathFor accepted ${bad}`).toBeInstanceOf(
        ChainResultShapeError,
      );
    }
  });
});
