/**
 * SF-1's face to its siblings: one composite, built by one async factory.
 *
 * `src/chain/**` imports from `src/environment/**` and from
 * `@openzeppelin/upgrades-core` **types** only (INV-48). It imports no other
 * sub-feature's module — not `src/options/**`, `src/output/**`, `src/results/**`,
 * nor any future sibling — so SF-3, SF-5, SF-6, SF-7, SF-8 and SF-9 can depend on
 * it without a cycle. Within the directory the dependency direction is strictly
 * downward: `policy | classify | slots → errors → endpoint → transport → provider
 * → read | instance → index`.
 *
 * SF-11 owns the package entry point; this is the directory's face.
 */

import type { EthereumProvider } from '@openzeppelin/upgrades-core';
import type { ChainHandleSlot } from '../environment';
import {
  ChainResultShapeError,
  ChainRpcError,
  ChainTransportError,
  chainJsonRpcUnavailableError,
} from './errors';
import {
  resolveEndpoint,
  type EndpointDescriptor,
  type JsonRpcPost,
} from './endpoint';
import {
  acceptedBlockTag,
  refusedMethods,
  requiredMethods,
} from './policy';
import { createProvider, type TronEthereumProvider } from './provider';
import { createRpcChannel } from './transport';
import { bindChainReaders, type ChainReaders } from './read';
import {
  readChainInstanceIdentity,
  type ChainInstanceIdentity,
} from './instance';
import {
  eip1967Slots,
  selectors,
  zeroChainAddress,
  zeroTransactionHash,
} from './slots';
import { ChainMethodRefusedError } from './errors';

/**
 * **A single `send(string, unknown[]) => Promise<unknown>` was originally
 * specified as satisfying "the whole of `EthereumProvider` through its catch-all
 * overload". It does not, and the
 * compiler says so: assignability to an **overloaded** interface requires
 * compatibility with every signature, and `Promise<unknown>` is not assignable to
 * `Promise<HardhatMetadata>` — which two of the eleven overloads declare.
 *
 * So the two shapes are declared separately and bridged exactly once, here:
 *
 * - {@link TronEthereumProvider} is SF-1's **internal** seam, deliberately loose,
 *   because INV-47 requires every `read.ts` / `instance.ts` function to be callable
 *   with a bare `{ send }` object and no `ChainAccess` in existence. Narrowing it to
 *   the engine's overloads would make that impossible without a cast in every test.
 * - `ChainAccess.provider` is declared as the engine's **own** `EthereumProvider`,
 *   so INV-30's first defence still holds at compile time and holds *better*:
 *   `Manifest.forNetwork(access.provider)` type-checks and
 *   `Manifest.forNetwork(env.chain.tronWrap)` does not, and no consumer — SF-3,
 *   SF-5, SF-6, SF-7, SF-8, SF-9 — writes a cast of its own.
 *
 * What the bridge asserts, stated rather than buried: for the two `*_metadata`
 * overloads SF-1 **throws** (INV-12), which satisfies any declared return type; for
 * the five methods upstream reads unguarded, `stringResultMethods` validates the
 * result (INV-4); for the three transaction and block methods it forwards the
 * node's value unvalidated, which is the same trust upstream places in any
 * provider. The unvalidated three are recorded as a limitation rather than hidden
 * behind the cast.
 */
function asEngineProvider(provider: TronEthereumProvider): EthereumProvider {
  return provider as unknown as EthereumProvider;
}

/**
 * SF-1's whole outbound surface. One object, handed to upgrades-core and shared
 * with SF-3, which is what makes the spec's "exactly one translation point"
 * structural rather than conventional.
 *
 * **INV-3: handle-bearing by closure only.** No field holds `tronWrap`, anything
 * reachable from it, or the raw endpoint URL — both live in closures — so
 * `JSON.stringify(access)` cannot leak either and does not throw. That is why
 * `sealSlot` is unnecessary here: SF-0 met INV-40's guarantee by *redaction*
 * because its slots expose handles as named capabilities; SF-1 meets it by
 * *construction*, because there is no field to redact. The adapter was expected to
 * need sealing; it does not, and the reason is a
 * design property that the first field added for convenience would silently undo.
 */
export interface ChainAccess {
  /**
   * The only thing that goes to the engine. Never `env.chain.tronWrap`.
   *
   * Declared as the engine's own `EthereumProvider` so no consumer needs a cast —
   * see {@link asEngineProvider} for what that declaration asserts.
   */
  readonly provider: EthereumProvider;
  readonly endpoint: EndpointDescriptor;
  /** Read once per instance and memoized. `send` itself memoizes nothing (INV-23). */
  identity(): Promise<ChainInstanceIdentity>;
  readonly read: ChainReaders;
}

/**
 * The four seams — the complete set of things SF-1 takes from its environment,
 * each with a stated default (INV-46).
 *
 * A consumer embedding SF-1 in a different host changes configuration, not source:
 * SF-1's own test suite is the first consumer that is not TronBox and SF-12's
 * harness is the second, so a reached-for dependency would mean both need a live
 * node to test a pure classification.
 */
export interface ChainAccessDependencies {
  /**
   * Highest-precedence endpoint source. SF-1's own DI seam, not a user-facing
   * option — a per-network key in `tronbox-config.js` was rejected because reading
   * `networks[<name>].<key>` is a TronBox-internal property path and SF-0's INV-28
   * permits those only inside `src/environment/**`, so it would have required a
   * materially larger SF-0 change than the one authorized.
   */
  readonly endpointOverride?: string;
  /**
   * Injected rather than read from the global at module load (INV-24). Defaults to
   * `process.env`, read **once, here**, at factory time — a module-load read would
   * bake the endpoint into the process, so under `tronbox console`, where a user
   * legitimately switches network mid-session, the override would silently
   * continue to point at the first network.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to the handle's own `fullNode.request`, or to `fetch` across origins (INV-43). */
  readonly post?: JsonRpcPost;
  /**
   * Best-effort native-API reachability check, used **only** to choose between two
   * wordings of an unavailable-capability message. Its own failure never changes
   * the diagnosis (INV-32).
   */
  readonly probeNativeApi?: () => Promise<boolean>;
}

export interface CapabilityVerdict {
  readonly method: string;
  /** Whether the **node served the method**. See {@link verifyCapabilities}. */
  readonly ok: boolean;
  readonly detail?: string;
}

export interface RefusalVerdict {
  readonly method: string;
  /**
   * `true` when **SF-1** refused before any request. INV-38: a report that says
   * only "anvil_metadata: unavailable" is indistinguishable between "SF-1 refuses
   * this by policy" and "this node happens not to serve it" — and those have
   * opposite implications. The first is a guarantee; the second is a coincidence
   * SF-1 explicitly refuses to depend on.
   */
  readonly refusedLocally: boolean;
}

export interface CapabilityReport {
  readonly endpoint: EndpointDescriptor;
  readonly resolved: readonly CapabilityVerdict[];
  readonly refused: readonly RefusalVerdict[];
}

/**
 * Builds SF-1's composite from the seam's `chain` slot.
 *
 * Async because it performs **exactly one** capability probe — `eth_chainId` —
 * so that a target network without the eth-compat JSON-RPC service fails once, up
 * front, **naming the capability**, rather than at an arbitrary point inside an
 * operation (spec scenario 3). One method and not seven because java-tron registers
 * the eth-compat methods together at the service level, so "serves `eth_chainId`
 * but not `eth_getStorageAt`" is not a configuration the node produces; the
 * complete answer is available on demand through {@link verifyCapabilities}.
 *
 * **There is deliberately no unprobed variant** (INV-32): no
 * `createChainAccessUnchecked`, no `skipProbe`, no lazy mode. An escape hatch is
 * worse than no probe, because the diagnosis's main failure mode is a caller who
 * skipped it — and it will be skipped in exactly the harness where the endpoint is
 * least standard. Tests substitute `deps.post` instead.
 *
 * INV-50: this is **not** a module singleton. Constructing one per operation is
 * correct and costs one probe; holding one across a whole migration is supported
 * and cheaper, and is the only way to pay for the fingerprint once. SF-1 states and
 * **cannot enforce** that SF-3's records and the engine's must be written through
 * the *same* instance, because both must resolve the same chain id for their
 * records to land in the same manifest file — two instances against a
 * load-balanced endpoint can resolve two, and then each file is internally
 * consistent and neither describes the deployment.
 *
 * @throws {EnvironmentIncompleteError} the `chain` handle does not expose
 *   `fullNode.host` / `fullNode.request` (`handle-malformed`, preserving SF-0's
 *   `'missing'`/`'threw'` distinction), or it does but the endpoint cannot serve
 *   eth-compat JSON-RPC (`invariant-violated`, naming the capability, the config
 *   key, the port pair and the remedy).
 * @throws {ChainEndpointRefusedError} the resolved endpoint is structurally
 *   unusable — not http(s), or pointed at the host's `/tre` cheatcode path.
 */
export async function createChainAccess(
  chain: ChainHandleSlot,
  deps: ChainAccessDependencies = {},
): Promise<ChainAccess> {
  const env = deps.env ?? process.env;
  const resolved = resolveEndpoint(chain, deps.endpointOverride, env, deps.post);
  const channel = createRpcChannel(
    resolved.descriptor,
    deps.post ?? resolved.post,
  );
  const provider = createProvider(channel);

  await probeJsonRpc(provider, resolved, deps.probeNativeApi);

  // INV-23: the memo is the *promise*, so a second call while the first is in
  // flight awaits the first rather than issuing a second set of three reads — the
  // in-flight case is covered by construction rather than by a lock. A rejection
  // is memoized too, which is what "at most once per instance" means.
  let identityMemo: Promise<ChainInstanceIdentity> | undefined;

  return Object.freeze({
    provider: asEngineProvider(provider),
    endpoint: resolved.descriptor,
    identity(): Promise<ChainInstanceIdentity> {
      identityMemo ??= readChainInstanceIdentity(provider, resolved.descriptor);
      return identityMemo;
    },
    // Bound to the loose local, not to the widened field, so `read.ts` keeps its
    // `unknown` results and its own shape validation.
    read: bindChainReaders(provider),
  });
}

/**
 * INV-32's probe, and INV-37(a): it completes before any reader is reachable,
 * because `read` is only obtainable from this factory's resolved value.
 */
async function probeJsonRpc(
  provider: TronEthereumProvider,
  resolved: { readonly descriptor: EndpointDescriptor; probeNativeApi(): Promise<boolean> },
  overrideProbe: (() => Promise<boolean>) | undefined,
): Promise<void> {
  try {
    await provider.send('eth_chainId', []);
    return;
  } catch (cause) {
    // A discriminating predicate, not a blanket catch (INV-14): only the three
    // failures that *are* "this endpoint cannot serve eth-compat JSON-RPC" become
    // the capability diagnosis. A defect inside SF-1 propagates as itself rather
    // than being reported to the user as a problem with their node.
    if (
      !(cause instanceof ChainTransportError) &&
      !(cause instanceof ChainRpcError) &&
      !(cause instanceof ChainResultShapeError)
    ) {
      throw cause;
    }

    const probe = overrideProbe ?? (() => resolved.probeNativeApi());
    // INV-32 / INV-14: the **one** deliberate absorption in `src/chain/**`, and it
    // is mandated rather than tolerated — this probe's own failure may change only
    // the wording of the message, never the diagnosis, so all three outcomes
    // (`true`, `false`, threw) produce the same `code` and the same `cause.kind`.
    // It is safe because the value is consumed by nothing but a wording selector.
    const nativeApiReachable = await probe().then(
      ok => ok === true,
      () => false,
    );

    throw chainJsonRpcUnavailableError(
      resolved.descriptor.describe,
      nativeApiReachable,
      cause.message,
    );
  }
}

/** The one block-query tag the probe uses. Block-query methods accept heights. */
const GENESIS_BLOCK_TAG = '0x0';

/**
 * Harmless arguments for each required method: the zero address, the zero hash,
 * and block 0. INV-33: every one is a read.
 */
const probeArguments: Readonly<Record<string, readonly unknown[]>> =
  Object.freeze({
    eth_chainId: Object.freeze([]),
    web3_clientVersion: Object.freeze([]),
    eth_getCode: Object.freeze([zeroChainAddress, acceptedBlockTag]),
    eth_getStorageAt: Object.freeze([
      zeroChainAddress,
      eip1967Slots.implementation,
      acceptedBlockTag,
    ]),
    eth_call: Object.freeze([
      Object.freeze({ to: zeroChainAddress, data: selectors.owner }),
      acceptedBlockTag,
    ]),
    eth_getTransactionByHash: Object.freeze([zeroTransactionHash]),
    eth_getTransactionReceipt: Object.freeze([zeroTransactionHash]),
    eth_getBlockByNumber: Object.freeze([GENESIS_BLOCK_TAG, false]),
  });

function verdict(method: string, ok: boolean, detail?: string): CapabilityVerdict {
  // `exactOptionalPropertyTypes` is on, so the key is spread or absent rather
  // than explicitly `undefined`.
  return Object.freeze(
    detail === undefined ? { method, ok } : { method, ok, detail },
  );
}

async function probeMethod(
  provider: EthereumProvider,
  method: string,
): Promise<CapabilityVerdict> {
  const params = probeArguments[method];
  if (params === undefined) {
    return verdict(
      method,
      false,
      'this plugin defines no probe arguments for the method, which is a defect ' +
        'here rather than a fact about the node',
    );
  }

  try {
    await provider.send(method, [...params]);
    return verdict(method, true);
  } catch (cause) {
    if (cause instanceof ChainRpcError) {
      // A node error means the node **served** the method — it answered with a
      // JSON-RPC error about the arguments. `eth_call` against the zero address
      // returns `-32600 "Smart contract is not exist."` on every TRON network, and
      // reporting that as an unavailable capability would make the report useless.
      // Only `-32601` says the method itself is absent.
      return cause.diagnosis.kind === 'method-unsupported'
        ? verdict(method, false, 'the node does not serve this method')
        : verdict(
            method,
            true,
            'served; the node rejected the probe arguments, which is expected ' +
              `for a placeholder address: ${cause.rpcMessage}`,
          );
    }
    if (
      cause instanceof ChainTransportError ||
      cause instanceof ChainResultShapeError
    ) {
      return verdict(method, false, cause.message);
    }
    throw cause;
  }
}

/**
 * Probes all eight methods SF-1 depends on and reports each verdict, plus both
 * refusals.
 *
 * **Not on the hot path** — `createChainAccess` probes one method. This exists for
 * SF-12's harness and for a diagnostics command, where paying eight round-trips to
 * get a complete answer is the right trade. It performs no writes and changes no
 * state on the `ChainAccess` it is given, including leaving `identity()`'s memo
 * untouched (INV-38).
 *
 * `ok` means **the node served the method**, not "the probe succeeded": a node
 * error about the probe arguments is evidence the method exists, and only
 * `-32601` is evidence it does not.
 *
 * The two refusals are *measured* rather than restated from the table — the
 * refusal is driven through `send` and the resulting
 * {@link ChainMethodRefusedError} is what sets `refusedLocally`, so a report
 * claiming a local refusal cannot be produced by a build in which the refusal was
 * softened. INV-38's test turns on exactly that: a `post` that would answer
 * `anvil_metadata` successfully must still yield `refusedLocally: true` and **zero**
 * recorded posts for it.
 */
export async function verifyCapabilities(
  access: ChainAccess,
): Promise<CapabilityReport> {
  const resolvedVerdicts: CapabilityVerdict[] = [];
  for (const method of requiredMethods) {
    resolvedVerdicts.push(await probeMethod(access.provider, method));
  }

  const refusedVerdicts: RefusalVerdict[] = [];
  for (const method of refusedMethods) {
    let refusedLocally = false;
    try {
      await access.provider.send(method, []);
    } catch (cause) {
      if (!(cause instanceof ChainMethodRefusedError)) {
        throw cause;
      }
      refusedLocally = true;
    }
    refusedVerdicts.push(Object.freeze({ method, refusedLocally }));
  }

  return Object.freeze({
    endpoint: access.endpoint,
    resolved: Object.freeze(resolvedVerdicts),
    refused: Object.freeze(refusedVerdicts),
  });
}

// ── Re-exports: SF-1's public surface for its six consumers ──────────────────

export {
  ChainAddressUnusableError,
  ChainBeaconNotFoundError,
  ChainBlockTagRefusedError,
  ChainEndpointRefusedError,
  ChainImplementationNotFoundError,
  ChainInstanceChangedError,
  ChainMethodRefusedError,
  ChainResultShapeError,
  ChainRpcError,
  ChainSlotMalformedError,
  ChainTransportError,
  type ChainInstanceChange,
  type TransportFailure,
} from './errors';

export {
  classifyNodeError,
  isProbeOutcome,
  type JsonRpcErrorPayload,
  type ProbeDiagnosis,
  type TvmDiagnosis,
} from './classify';

export {
  DERIVED_RPC_PATH,
  RPC_URL_ENV_VAR,
  scrubEndpoint,
  type EndpointDescriptor,
  type EndpointOrigin,
  type JsonRpcPost,
} from './endpoint';

export {
  blockTagIndex,
  blockTagVerdict,
  methodPolicies,
  policyFor,
  refusedMethods,
  requiredMethods,
  stringResultMethods,
  type BlockTagVerdict,
  type MethodPolicy,
  type ResultShapeRule,
} from './policy';

export {
  createProvider,
  requireResultShape,
  type TronEthereumProvider,
} from './provider';

export {
  createRpcChannel,
  type JsonRpcOutcome,
  type JsonRpcRequest,
  type RpcChannel,
} from './transport';

export {
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
  type ChainAddress,
  type SlotLabel,
} from './slots';

export {
  bindChainReaders,
  hasCode,
  looksLikeProxyAdmin,
  readAdminAddress,
  readBeaconAddress,
  readBeaconImplementation,
  readImplementationAddress,
  readProxySlots,
  readUpgradeInterfaceVersion,
  slotLabels,
  tvmCallOptional,
  type BeaconRead,
  type ChainReaders,
  type OptionalCallOutcome,
  type ProxySlotsRead,
} from './read';

export {
  compareChainInstance,
  manifestPathFor,
  readChainInstanceIdentity,
  type ChainInstanceIdentity,
  type InstanceComparison,
  type RecordedChainInstance,
} from './instance';
