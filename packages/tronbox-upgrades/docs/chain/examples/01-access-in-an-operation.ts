/**
 * The primary pattern: build one `ChainAccess` per operation, hand
 * `access.provider` — and never the host handle — to `@openzeppelin/upgrades-core`.
 *
 * Three things this file is here to show, because each is load-bearing:
 *
 *  1. `createChainAccess` is **async** and performs exactly one probe
 *     (`eth_chainId`), so a target network without the eth-compat JSON-RPC service
 *     fails once, up front, naming the capability
 *     (`src/chain/index.ts:203`, `src/chain/index.ts:240`).
 *  2. The engine receives `access.provider`. Passing `env.chain.tronWrap` instead
 *     does not compile, and that is the first of four defences
 *     (`src/chain/index.ts:101`).
 *  3. Both construction failures are typed and are narrowed structurally, never by
 *     message.
 */
import { Manifest } from '@openzeppelin/upgrades-core';
import {
  EnvironmentIncompleteError,
  resolveEnvironment,
  type RawMigrationHandles,
} from '../../../src/environment';
import {
  ChainEndpointRefusedError,
  createChainAccess,
  type ChainAccess,
} from '../../../src/chain';

// ---------------------------------------------------------------------------
// 1. Resolve the seam, then build the access object
// ---------------------------------------------------------------------------

/**
 * The whole of the wiring. `chain` is the only slot the chain layer needs, and
 * asking for more would make an operation fail in `tronbox console`, where
 * four of the seven slots are absent.
 */
export async function openChain(
  handles: RawMigrationHandles,
): Promise<ChainAccess> {
  const env = resolveEnvironment(handles, { require: ['chain'] });
  return createChainAccess(env.chain);
}

/**
 * The same thing with the two construction failures narrowed.
 *
 * `EnvironmentIncompleteError` covers both "the handle does not expose
 * `fullNode.host` / `fullNode.request`" and "it does, and the endpoint cannot
 * serve eth-compat JSON-RPC" — the second is the common one, and its `detail`
 * names the config key, the port pair and the remedy
 * (`src/chain/errors.ts:531`).
 *
 * `ChainEndpointRefusedError` covers a structurally unusable endpoint: not
 * http(s), a `/tre` path, or a different-origin override this runtime has no
 * transport for (`src/chain/errors.ts:192`).
 */
export async function openChainOrExplain(
  handles: RawMigrationHandles,
): Promise<{ readonly access: ChainAccess } | { readonly problem: string }> {
  try {
    return { access: await openChain(handles) };
  } catch (cause) {
    if (cause instanceof EnvironmentIncompleteError) {
      // `unsatisfied` is the structured form of the same facts the message
      // renders — one entry per slot that could not be built.
      const kinds = cause.unsatisfied.map(item => item.cause.kind).join(', ');
      return { problem: `${cause.code} (${kinds}): ${cause.message}` };
    }
    if (cause instanceof ChainEndpointRefusedError) {
      return {
        problem: `${cause.code}: ${cause.source} — ${cause.because}`,
      };
    }
    // Anything else is a defect in this plugin rather than a fact about the
    // node, and is left to propagate as itself.
    throw cause;
  }
}

// ---------------------------------------------------------------------------
// 2. Hand it to the engine
// ---------------------------------------------------------------------------

/**
 * `Manifest.forNetwork` is the engine entry point every deploy and every upgrade
 * goes through. It probes `anvil_metadata` and `hardhat_metadata`; the chain
 * layer throws for both, from a table, before any request, and
 * `getDevInstanceMetadata` absorbs both throws by design
 * (`node_modules/@openzeppelin/upgrades-core/dist/manifest.js:30-53`).
 *
 * So the refusals are invisible here, which is the point — see
 * [`../safety.md`](../safety.md#the-two-refusals-are-an-obligation-not-a-gap).
 */
export async function manifestFor(access: ChainAccess): Promise<Manifest> {
  return Manifest.forNetwork(access.provider);
}

/*
 * Deliberately NOT provided, because it is the trap the chain layer exists to
 * close:
 *
 *   Manifest.forNetwork(env.chain.tronWrap);   // does not compile
 *
 * The environment seam's `TronWrapHandle` is `{ trx: object }` and stays that
 * way. Widening it would make this line type-check, and `tronWrap.send` POSTs to
 * `networkConfig.fullNode + '/tre'` — which answers on a local TRE and returns
 * HTTP 405 on every public network, surfacing as
 * `TRE RPC 'eth_chainId': Request failed with status code 405`
 * (`src/chain/endpoint.ts:32-48`).
 */

// ---------------------------------------------------------------------------
// 3. One instance per operation, or one per migration — both are supported
// ---------------------------------------------------------------------------

/**
 * Memoized on the handle object, not on a module-scope variable.
 *
 * `createChainAccess` is deliberately not a singleton (`src/chain/index.ts:186`).
 * Constructing one per operation is correct and costs one probe; holding one
 * across a migration is supported, cheaper, and the only way to pay for the
 * instance fingerprint once.
 *
 * The obligation the chain layer states and cannot enforce: an operation's
 * deployment record and the engine's manifest write must go through the
 * **same** instance, because two instances against a load-balanced endpoint
 * can resolve two chain ids — and then each manifest file is internally
 * consistent and neither describes the deployment.
 */
const perHandle = new WeakMap<object, Promise<ChainAccess>>();

export function sharedChain(handles: RawMigrationHandles): Promise<ChainAccess> {
  const env = resolveEnvironment(handles, { require: ['chain'] });
  const key: object = env.chain.tronWrap;
  const existing = perHandle.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = createChainAccess(env.chain);
  perHandle.set(key, created);
  return created;
}

// ---------------------------------------------------------------------------
// 4. What the composite carries
// ---------------------------------------------------------------------------

/**
 * Four members and nothing else, and `JSON.stringify` of the whole object is safe
 * by construction: no field holds the host handle or the raw endpoint URL — both
 * live in closures (`src/chain/index.ts:94`).
 *
 * `endpoint.describe` is the **scrubbed** form: userinfo stripped, query and
 * fragment dropped (`src/chain/endpoint.ts:233`). There is no `url` field and no
 * field the raw URL can be reconstructed from.
 */
export function describeAccess(access: ChainAccess): string {
  return [
    `endpoint: ${access.endpoint.describe}`,
    `origin:   ${access.endpoint.origin}`,
    `readers:  ${Object.keys(access.read).length}`,
  ].join('\n');
}
