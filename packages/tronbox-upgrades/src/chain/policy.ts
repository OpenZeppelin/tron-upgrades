/**
 * Four tables as **data**, not as `switch` statements: which methods are
 * refused, which are required, which results must satisfy a shape, and which
 * methods carry a block tag at which parameter index.
 *
 * **INV-45: this module has zero imports.**
 *
 * INV-11 is why these are tables. Two concrete regressions they prevent: an
 * early four-method minimum was written down and then measured wrong twice
 * over, and a `switch` hides the set so the next person re-derives it from the
 * code paths they happen to read. And `eth_getBlockByNumber` is the one method
 * upgrades-core never calls, so a later
 * "simplify the required set to what the engine needs" removes exactly the
 * method the instance fingerprint depends on — silently disabling INV-26 while
 * every engine-facing test still passes.
 *
 * A test can read a table; it can only restate a `switch`. Spec scenario 7 asks
 * for a test that fails if the refusal is softened, and that is only possible
 * against data.
 */

export type MethodPolicy =
  | { readonly kind: 'forward' }
  | { readonly kind: 'refuse'; readonly because: string };

/**
 * The two methods the engine probes and answers **by catching**
 * (`manifest.js:getDevInstanceMetadata`). Refused here, locally, before any
 * request.
 *
 * INV-12: refusing locally makes it SF-1's declared property. Forwarding makes
 * it a property of java-tron's method registry — and depending on a third
 * party's continued *absence* of a feature is the borrowed-premise failure the
 * dev's no-spoofing ruling rejects, in mirror image. Forwarding works today on
 * all four measured networks (`-32601 method not found`, confirmed live), but the
 * day java-tron registers either method — or a proxy, a mock or a TRE variant
 * answers it — the adapter resolves a value and
 * `Broken invariant: … chainId undefined does not match eth_chainId 728126428`
 * fires on **every** call, from a change nobody in this repository made.
 *
 * It also saves two round-trips on the hot path of every deploy and every
 * upgrade, since `Manifest.forNetwork` probes both.
 */
export const refusedMethods = Object.freeze([
  'anvil_metadata',
  'hardhat_metadata',
] as const);

/**
 * The engine's seven, plus `eth_getBlockByNumber` — the eighth, which is SF-1's
 * own and which upgrades-core never calls.
 *
 * It is safe to depend on for a reason worth stating: java-tron's *block-query*
 * methods accept heights and named tags, while its *state* methods accept only
 * `latest`. Do not generalize either way (INV-20 refuses tags uniformly for the
 * state methods precisely because the node is not uniform).
 */
export const requiredMethods = Object.freeze([
  'eth_chainId',
  'web3_clientVersion',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_call',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBlockByNumber',
] as const);

const refusalBecause =
  'this plugin refuses the Hardhat/Anvil dev-instance probes rather than ' +
  'answering them, because a synthesized answer would misreport what chain ' +
  'this is. TRON instance identity is read from the chain itself instead';

export const methodPolicies: Readonly<Record<string, MethodPolicy>> =
  Object.freeze(
    Object.fromEntries(
      refusedMethods.map(method => [
        method,
        Object.freeze({ kind: 'refuse', because: refusalBecause } as const),
      ]),
    ),
  );

const forward: MethodPolicy = Object.freeze({ kind: 'forward' } as const);

/**
 * Defaults to `{ kind: 'forward' }`. Reads the table; a `switch` would hide the
 * policy where a table can be asserted (INV-11).
 */
export function policyFor(method: string): MethodPolicy {
  return Object.prototype.hasOwnProperty.call(methodPolicies, method)
    ? (methodPolicies[method] ?? forward)
    : forward;
}

/**
 * A per-method result-shape rule.
 *
 * The predicate narrows to `string` because all five gated methods return one,
 * which is what lets `read.ts` and `instance.ts` consume a validated result
 * without a cast.
 */
export interface ResultShapeRule {
  /** Rendered in the refusal, so the message states what was expected. */
  readonly describe: string;
  accepts(value: unknown): value is string;
}

function rule(
  describe: string,
  accepts: (value: string) => boolean,
): ResultShapeRule {
  return Object.freeze({
    describe,
    accepts: (value: unknown): value is string =>
      typeof value === 'string' && accepts(value),
  });
}

const HEX_QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;
const HEX_DATA = /^0x[0-9a-fA-F]*$/;

/**
 * The five methods whose result upgrades-core reads **unguarded**, each with
 * *that method's* required shape. Cited per method, verified at `1.46.0`:
 *
 * - `eth_chainId`        `provider.js:getChainId`            `id.replace(/^0x/, '')`
 * - `web3_clientVersion` `provider.js:113`                   `clientVersion.split('/', 1)`
 * - `eth_getStorageAt`   `provider.js:getStorageAt`          `storage.replace(/^0x/, '')`
 * - `eth_getCode`        `provider.js:isEmpty`               `code.replace(/^0x/, '')`
 * - `eth_call`           `upgrade-interface-version.js:13`   `encodedVersion.replace(/^0x/, '')`
 *
 * **INV-4 corrects Design Decision 15, which specified a one-line `typeof`
 * guard per method.** `typeof value === 'string'` is the floor, not the check,
 * and measurably insufficient for the one method whose value becomes the
 * manifest key. `getChainId` is `parseInt(id.replace(/^0x/, ''), 16)`, and
 * `parseInt` is not a validator. Executed while writing this file:
 *
 * - `'728126428'` — a **decimal** chain id, which is what java-tron itself
 *   returns from `net_version` and what a proxy or shim may well return —
 *   parses **as hex** to `30737065000`, and the manifest becomes
 *   `.openzeppelin/unknown-30737065000.json`.
 * - `'0x'`, `''`, `'0xzz'` and `'TRON/v4.8.2/Linux/Java1.8'` all parse to
 *   **`NaN`**, and the template `unknown-${chainId}` renders
 *   `.openzeppelin/unknown-NaN.json`.
 *
 * Either way every deployment record for that network lands in a file no later
 * run consults, with no error at any layer and no symptom until the next upgrade
 * reports the proxy as unregistered. That is the silent-misplacement failure
 * SF-1's High stakes rating names, reached through one unvalidated `parseInt`.
 */
export const stringResultMethods: Readonly<Record<string, ResultShapeRule>> =
  Object.freeze({
    eth_chainId: rule(
      'a 0x-prefixed hex quantity that parses to a positive integer',
      value => {
        if (!HEX_QUANTITY.test(value)) {
          return false;
        }
        const parsed = Number.parseInt(value.slice(2), 16);
        return Number.isFinite(parsed) && parsed > 0;
      },
    ),
    web3_clientVersion: rule('a non-empty string', value => value.length > 0),
    eth_getStorageAt: rule('a 0x-prefixed hex storage word', value =>
      HEX_DATA.test(value),
    ),
    eth_getCode: rule(
      "0x-prefixed hex, or exactly '0x' for an address with no code",
      value => HEX_DATA.test(value),
    ),
    eth_call: rule('0x-prefixed hex return data', value =>
      HEX_DATA.test(value),
    ),
  });

/**
 * Where the block tag sits, per method — re-read from `provider.js` at `1.46.0`.
 * The index differs, which is why this is a table and not a constant:
 * `call` sends `[{to, data}, block]` with no `from` and no `gas`.
 */
export const blockTagIndex: Readonly<Record<string, number>> = Object.freeze({
  eth_getStorageAt: 2,
  eth_getCode: 1,
  eth_call: 1,
});

/** The one tag java-tron's *state* methods accept. Every engine reader defaults to it. */
export const acceptedBlockTag = 'latest';

const refusedBlockTags = Object.freeze([
  'pending',
  'earliest',
  'finalized',
  'safe',
] as const);

export type BlockTagVerdict =
  | { readonly kind: 'accept' }
  | { readonly kind: 'refuse'; readonly because: string };

const accept: BlockTagVerdict = Object.freeze({ kind: 'accept' } as const);

function refuse(because: string): BlockTagVerdict {
  return Object.freeze({ kind: 'refuse', because } as const);
}

const historicalReadsUnsupported =
  `only "${acceptedBlockTag}" is supported: java-tron's Ethereum-compatible ` +
  'state methods answer from present state and cannot serve a historical read';

/**
 * Refuses `pending | earliest | finalized | safe`, a numeric height, and an
 * **EIP-1898 block object** — for **every** method carrying a block parameter,
 * uniformly, even though the node's own handling is not uniform.
 *
 * INV-20, and the non-uniformity is exactly why the refusal must be uniform.
 * Measured live at write time:
 *
 * - `eth_call` with `{"blockNumber":"0x1"}` is validated and then **silently
 *   answered from present state** — present-day data for a historical question,
 *   with no error at all.
 * - The same object on `eth_getCode` and `eth_getStorageAt` returns
 *   `-32700 "JSON parse error"` — a message naming JSON parsing rather than the
 *   block tag.
 * - A numeric height returns `-32602 "QUANTITY not supported, just support TAG
 *   as latest"`; `pending` returns `-32602 "TAG [earliest | pending | finalized
 *   | safe] not supported"`.
 *
 * One method answers a question it was not asked and two refuse for the wrong
 * stated reason. A per-method policy would encode that inconsistency into the
 * plugin. Every `provider.js` reader defaults to `'latest'`, so this refuses
 * nothing upstream sends today — it refuses what a later caller might, including
 * a third party who reads the catch-all overload and reasonably assumes
 * historical reads work.
 */
export function blockTagVerdict(
  method: string,
  params: readonly unknown[],
): BlockTagVerdict {
  if (!Object.prototype.hasOwnProperty.call(blockTagIndex, method)) {
    return accept;
  }
  const index = blockTagIndex[method];
  if (index === undefined || params.length <= index) {
    // The tag was omitted. There is nothing to refuse, and the node applies its
    // own default — which for these methods is present state, the only thing it
    // can serve.
    return accept;
  }

  const tag = params[index];
  if (tag === acceptedBlockTag) {
    return accept;
  }
  if (typeof tag === 'string') {
    if ((refusedBlockTags as readonly string[]).includes(tag)) {
      return refuse(
        `the block tag "${tag}" is not supported by this node — ` +
          historicalReadsUnsupported,
      );
    }
    if (HEX_QUANTITY.test(tag)) {
      return refuse(
        `the block height ${tag} names a historical block — ` +
          historicalReadsUnsupported,
      );
    }
    return refuse(
      `"${tag}" is not a block tag this plugin forwards — ` +
        historicalReadsUnsupported,
    );
  }
  if (typeof tag === 'number' || typeof tag === 'bigint') {
    return refuse(
      `the block height ${tag.toString()} names a historical block — ` +
        historicalReadsUnsupported,
    );
  }
  if (tag !== null && typeof tag === 'object') {
    return refuse(
      'an EIP-1898 block object was supplied. This node handles one ' +
        'inconsistently and dangerously: eth_call validates the object and then ' +
        'answers from present state with no error, while eth_getCode and ' +
        'eth_getStorageAt reject it as a JSON parse error. ' +
        historicalReadsUnsupported,
    );
  }
  return refuse(
    `a ${typeof tag} was supplied where a block tag was expected — ` +
      historicalReadsUnsupported,
  );
}
