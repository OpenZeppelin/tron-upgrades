/**
 * The proxy-lifecycle refusal family. Same construction rules as the
 * deployment seam's: one closed hierarchy, one class per cause, structured
 * fields, the message rendered by the constructor so fields and text cannot
 * disagree.
 */

// The one import this module takes: the shared message-form rule — addresses
// print in base58, structured fields stay canonical (review decision on #18).
import { printedAddress } from '../deploy/errors';

/** The base every proxy-lifecycle refusal extends. */
export abstract class ProxyOperationRefusedError extends Error {
  abstract readonly code: string;
}

/**
 * The proxy's reported `UPGRADE_INTERFACE_VERSION` is outside the closed set
 * the dispatch matrix knows. Refusing is the only safe answer: a
 * guessed entry point sends a live proxy a call its generation does not
 * implement — or worse, one it implements with different semantics.
 */
export class UnknownProxyGenerationError extends ProxyOperationRefusedError {
  readonly code = 'unknown-proxy-generation';
  constructor(
    readonly subject: 'proxy' | 'admin',
    readonly reportedVersion: string,
  ) {
    super(
      `The ${subject} reports UPGRADE_INTERFACE_VERSION "${reportedVersion}", ` +
        `which this plugin does not recognise (it knows the pre-5 shape, where ` +
        `the getter is absent, and "5.0.0"). Upgrading through a guessed entry ` +
        `point could brick the proxy, so nothing was sent. Check whether a newer ` +
        `plugin version supports this generation.`,
    );
    this.name = 'UnknownProxyGenerationError';
  }
}

/**
 * The proxy artifact is not in the project's build output (scenario 6).
 * The remedy is the one-import-file step, stated verbatim rather than pointed
 * at.
 */
export class ProxyArtifactMissingError extends ProxyOperationRefusedError {
  readonly code = 'proxy-artifact-missing';
  constructor(readonly artifactName: string) {
    super(
      `The proxy contract artifact ${artifactName} is not among this project's ` +
        `compiled contracts. Add a file such as contracts/Proxies.sol containing ` +
        `\`import "@openzeppelin/tron-contracts/proxy/transparent/` +
        `TransparentUpgradeableProxy.sol";\` (see the plugin README for the full ` +
        `file), then run \`tronbox compile\`.`,
    );
    this.name = 'ProxyArtifactMissingError';
  }
}

/**
 * More than one artifact answers to the proxy contract's bare name.
 * Never picked silently: TronBox's artifact index is bare-name keyed, so the
 * pick would be decided by directory iteration order.
 */
export class ProxyArtifactCollisionError extends ProxyOperationRefusedError {
  readonly code = 'proxy-artifact-collision';
  constructor(
    readonly artifactName: string,
    readonly candidatePaths: readonly string[],
  ) {
    super(
      `${artifactName} matches ${candidatePaths.length} different compiled ` +
        `contracts: ${candidatePaths.join(', ')}. TronBox looks artifacts up by ` +
        `bare name, so which one deploys would be an accident of file order. ` +
        `Rename or remove the colliding contracts so exactly one remains.`,
    );
    this.name = 'ProxyArtifactCollisionError';
  }
}

/**
 * The target is a beacon proxy: its implementation lives on the beacon, so an
 * in-place upgrade through the proxy is the wrong operation. Refused
 * BEFORE kind processing, whose missing-record default would otherwise route
 * it down the transparent path.
 */
export class BeaconProxyRefusedError extends ProxyOperationRefusedError {
  readonly code = 'beacon-proxy-refused';
  constructor(
    readonly proxyAddress: string,
    readonly beaconAddress: string,
  ) {
    super(
      `Proxy ${proxyAddress} is a beacon proxy — its implementation lives on ` +
        `the beacon at ${beaconAddress}. Upgrade the beacon instead; every proxy ` +
        `pointing at it follows.`,
    );
    this.name = 'BeaconProxyRefusedError';
  }
}

/** A transparent-path upgrade found no admin in the 1967 admin slot. */
export class NotTransparentProxyError extends ProxyOperationRefusedError {
  readonly code = 'not-transparent-proxy';
  constructor(readonly proxyAddress: string) {
    super(
      `Proxy ${proxyAddress} has no admin in its 1967 admin slot, so it is not ` +
        `a transparent proxy. For a UUPS proxy pass \`kind: 'uups'\`.`,
    );
    this.name = 'NotTransparentProxyError';
  }
}

/**
 * The upgrade transaction confirmed and the target does not report the new
 * implementation — success was NOT assumed from the receipt.
 *
 * `target` rather than `proxyAddress`, because `upgradeBeacon` throws this for
 * a beacon: the verified fact is the same either way — "what you upgraded does
 * not now answer the implementation this operation deployed". Named WITH the
 * transaction hash: this refusal fires after a CONFIRMED transaction, in the
 * case where the hash matters most — a confirmed upgrade call that did not
 * produce the expected result smells like a no-op or broken upgradeTo, and the
 * user's first move is looking that transaction up (review comment on #18).
 */
export class UpgradeVerificationFailedError extends ProxyOperationRefusedError {
  readonly code = 'upgrade-verification-failed';
  constructor(
    readonly target: string,
    readonly expected: string,
    readonly observed: string,
    readonly transactionHash: string,
  ) {
    super(
      `The upgrade transaction ${transactionHash} for ` +
        `${printedAddress(target)} confirmed, but the target now reports ` +
        `implementation ${printedAddress(observed)} where ` +
        `${printedAddress(expected)} was expected. The live implementation is ` +
        `NOT the one this operation deployed — investigate that transaction ` +
        `before running anything else against this target.`,
    );
    this.name = 'UpgradeVerificationFailedError';
  }
}

/**
 * The ported TRC1967Proxy rejects empty initialization data for transparent
 * and UUPS kinds, and `encodeInitializer` — the one choke point every kind's
 * initializer is encoded through, `deployProxy` and `deployBeaconProxy`
 * alike — refuses the same shape uniformly for `'beacon'` too, so the
 * refusal happens here before any spend, with the two user mistakes
 * distinguished, because their remedies differ. **Neither remedy is "use a
 * beacon proxy instead"**: a beacon proxy reaches this exact class through
 * the exact same encoding step (`beacon/index.ts:runDeployBeaconProxy`), so
 * that would lead the caller straight back into the same refusal.
 *
 * **The sole class for this refusal.** `deployProxy`'s own pre-flight (the
 * explicit `initializer: false` arm, before the queue) used to throw a
 * second, near-identical class, `InitializerDataRequiredError` — this one
 * absorbed it: same input, same class, whether the refusal comes from that
 * pre-flight or from `encodeInitializer`'s ABI-has-no-default-initializer
 * arm. `InitializerDataRequiredError` carried a `contractName` field this
 * class does not; it is not migrated here, because every call site already
 * has the proxy `kind` in hand (a more actionable field for this message)
 * and nothing outside the deleted class ever read `contractName`.
 */
export class EmptyInitializerRefusedError extends ProxyOperationRefusedError {
  readonly code = 'empty-initializer-refused';
  constructor(
    readonly kind: string,
    readonly because: 'initializer-false' | 'no-default-initializer',
  ) {
    super(
      because === 'initializer-false'
        ? `\`initializer: false\` is not supported for kind "${kind}": the ` +
          `ported TRC1967Proxy rejects empty initialization data, so an ` +
          `uninitialized proxy cannot be deployed. Initialize in the same ` +
          `transaction.`
        : `Uninitialized deployment is not supported for kind "${kind}": the ` +
          `contract has no default initializer and the ported TRC1967Proxy ` +
          `rejects empty initialization data. Add an initializer function.`,
    );
    this.name = 'EmptyInitializerRefusedError';
  }
}

/**
 * A prior deployment's record cannot vouch for this replay: the
 * artifact remembers an address, and the record layer reports it stale,
 * unrecorded, or never seen. `deployProxy` always deploys a fresh proxy
 * regardless (Hardhat parity — a prior address is never reused), but it
 * refuses to do so while the artifact's own prior address is one the
 * tooling can no longer account for: the operation stops and says which
 * investigation comes first, rather than layering a new, correctly-recorded
 * deploy beside an entry already gone bad.
 */
export class StaleProxyRecordError extends ProxyOperationRefusedError {
  readonly code = 'stale-proxy-record';
  constructor(
    readonly proxyAddress: string,
    readonly because: 'no-code-at-address' | 'unrecorded' | 'no-verdict',
  ) {
    super(
      because === 'no-code-at-address'
        ? `This migration previously deployed a proxy at ${proxyAddress}, but ` +
          `that address holds no code on the current chain — the node was ` +
          `likely wiped or replaced. Deploying a second proxy beside the stale ` +
          `record is refused. If the chain really was reset, clear the ` +
          `deployment record and the artifact's network entry — delete the ` +
          `build directory and run \`tronbox compile --all\` — then re-run.`
        : because === 'unrecorded'
          ? `This migration previously deployed a proxy at ${proxyAddress}, ` +
            `and the address holds code, but the deployment record has no ` +
            `entry for it. Register it first with a force-import so upgrades ` +
            `validate against the right layout.`
          : `This migration previously deployed a proxy at ${proxyAddress}, ` +
            `but the deployment record knows nothing about that address — an ` +
            `out-of-band deployment, a deleted record, or another tool's ` +
            `write. Reconcile the record before deploying again. If the ` +
            `record was deleted on purpose after a chain wipe, clear the ` +
            `artifact's per-network write-back too — delete the build ` +
            `directory and run \`tronbox compile --all\` — then re-run.`,
    );
    this.name = 'StaleProxyRecordError';
  }
}

/**
 * `redeployImplementation: 'never'` — including its deprecated spelling,
 * `useDeployedImplementation: true` (collapsed into `'never'` before either
 * reaches this class; see `options/resolve.ts:resolveRedeployMode`) — asks
 * every consumer that reaches `fetchOrDeployImplementation` (`deployProxy`,
 * `upgradeProxy`, the beacon and standalone operations) to reuse ONLY an
 * implementation deployment already recorded for the exact contract version
 * being validated, never a fresh one. There is no such record here, so the
 * deploy this policy exists to forbid is refused before anything spends.
 *
 * Mirrors the parity target's own MECHANISM, not its class: Hardhat's
 * `resolveImplementation` wraps the identical `deploy` callback handed to
 * `fetchOrDeployGetDeployment` and throws from inside it — reached only when
 * that call's own cache lookup found nothing to reuse
 * (`hardhat-tron-upgrades/dist/utils/deploy-impl.js:18-23`: `"The
 * implementation contract ${contractName} was not previously deployed on
 * this network"`). `proxy/toolkit.ts`'s `fetchOrDeployImplementation` wraps
 * that same callback the same way, so every one of its callers inherits this
 * refusal with no per-operation copy — including `forceImport`'s adoption
 * probe, which never reaches it in practice, because adoption always calls
 * through with `'onchange'` then `'always'`, never the caller's own policy
 * (`adopt/index.ts:runForceImport`).
 */
export class ImplementationNotPreviouslyDeployedError extends ProxyOperationRefusedError {
  readonly code = 'implementation-not-previously-deployed';
  constructor(readonly contractName: string) {
    super(
      `redeployImplementation: 'never' was set, but the implementation ` +
        `contract ${contractName} was not previously deployed on this ` +
        `network — there is no recorded deployment of this exact contract ` +
        `version to reuse, so the fresh deploy this policy exists to forbid ` +
        `was refused before anything spent. Deploy it once with ` +
        `'onchange' or 'always' (or with the option omitted), or drop ` +
        `'never' if a fresh deploy is acceptable here.`,
    );
    this.name = 'ImplementationNotPreviouslyDeployedError';
  }
}

/**
 * `initialOwner` was supplied for a proxy kind that has no admin for it to
 * own: a UUPS proxy authorizes upgrades through the implementation itself,
 * so accepting the option would silently drop the one thing the caller asked
 * for. Mirrors the parity target's refusal — upstream throws
 * `InitialOwnerUnsupportedKindError` from `deployProxy` before anything
 * deploys (verified root-exported at `@openzeppelin/upgrades-core@1.46.0`,
 * `dist/usage-error.js:72`) — as a local class, because this family's
 * consumers may not import the engine: it loads only behind the toolkit
 * factory's deferred imports, and the entry's dynamic-edge set is pinned by
 * exact specifier.
 */
export class InitialOwnerUnsupportedKindError extends ProxyOperationRefusedError {
  readonly code = 'initial-owner-unsupported-kind';
  constructor(readonly kind: string) {
    super(
      `The \`initialOwner\` option is not supported for this kind of proxy ` +
        `('${kind}'). Set the initial owner as part of your contract's ` +
        `initializer arguments instead.`,
    );
    this.name = 'InitialOwnerUnsupportedKindError';
  }
}

/**
 * `deployBeacon` could not derive an owner for the `UpgradeableBeacon` it is
 * about to deploy: no `initialOwner` was given, and the effective-sender
 * resolution came back `'unconfigured'` (no `from` in the network config),
 * so the plugin genuinely does not know who will sign. Passing `null` as the
 * owner is refused HERE rather than let it reach the host: the beacon's
 * `Ownable(initialOwner)` constructor treats a zero address as invalid and
 * reverts, but `null` never gets that far — measured against both installed
 * TronBox minors, one crashes internally before attempting any deploy
 * (`tronbox-4.8.0`, no null guard in `filterEnergyParameter`) and the other
 * fails ABI-encoding the constructor's `address` argument
 * (`tronbox-4.9.0`, `ethers.AbiCoder` refuses `null` for `address`). Neither
 * failure names the real cause or its remedy, so this one does instead.
 */
export class BeaconInitialOwnerRequiredError extends ProxyOperationRefusedError {
  readonly code = 'beacon-initial-owner-required';
  constructor() {
    super(
      `deployBeacon could not determine an initial owner for the beacon: no ` +
        `\`initialOwner\` option was given, and the configured network names ` +
        `no sending account to fall back to. Configure a sending account ` +
        `(\`from\`) in your network settings, or pass \`initialOwner\` ` +
        `explicitly.`,
    );
    this.name = 'BeaconInitialOwnerRequiredError';
  }
}

/**
 * `deployProxy` (transparent) could not derive an owner for the proxy's
 * admin: no `initialOwner` was given and the effective-sender resolution
 * came back `'unconfigured'`. Refused HERE, before the queued step, because
 * the alternative is measured and worse: the null rides in the MIDDLE of
 * the constructor args, past the trailing-argument guard, so the operation
 * deploys and pays for the implementation and THEN fails client-side in
 * the host's ABI encoder with `invalid address … value=null` — a message
 * about an address when the real problem is that no owner was named.
 * `deployBeacon` refuses the identical state with its own class; this is
 * the transparent twin.
 */
export class TransparentInitialOwnerRequiredError extends ProxyOperationRefusedError {
  readonly code = 'transparent-initial-owner-required';
  constructor() {
    super(
      `deployProxy could not determine an initial owner for the transparent ` +
        `proxy's admin: no \`initialOwner\` option was given, and the ` +
        `configured network names no sending account to fall back to. ` +
        `Configure a sending account (\`from\`) in your network settings, ` +
        `or pass \`initialOwner\` explicitly.`,
    );
    this.name = 'TransparentInitialOwnerRequiredError';
  }
}

/**
 *`initialOwner` looks like a ProxyAdmin contract: the v5 transparent
 * proxy deploys its OWN admin owned by `initialOwner`, so handing it an
 * existing ProxyAdmin is almost always a v4-era habit that buries the real
 * owner one contract deeper.
 */
export class ProxyAdminAsOwnerError extends ProxyOperationRefusedError {
  readonly code = 'proxy-admin-as-owner';
  constructor(readonly ownerAddress: string) {
    super(
      `\`initialOwner\` must not be a ProxyAdmin contract: the v5 transparent ` +
        `proxy deploys its own admin, owned by initialOwner. If the contract at ` +
        `${ownerAddress} really should own the new admin, skip this check with ` +
        `\`unsafeSkipProxyAdminCheck\`.`,
    );
    this.name = 'ProxyAdminAsOwnerError';
  }
}

/**
 * The old Hardhat/Truffle-shaped API also accepted an options object in the
 * position `args` now occupies — `deployProxy(Contract, opts)`,
 * `deployBeaconProxy(beaconAddress, Contract, opts)` — with no separate
 * argument list at all. That overload is gone: `args` is always the
 * constructor/initializer argument list, and an options object landing there
 * is never reinterpreted as options. Left unrefused, the object would either
 * throw an opaque native error the first time something tries to spread it
 * (`[...args]` on a plain object is a `TypeError`), or — worse — get treated
 * as a single positional argument, silently misencoding the call. Refused
 * here, by name, before anything spends.
 */
export class OptionsInArgsPositionError extends ProxyOperationRefusedError {
  readonly code = 'options-in-args-position';
  constructor(
    readonly operation: string,
    readonly receivedType: string,
    readonly looksLikeOptions: boolean,
  ) {
    super(
      `${operation}'s argument list must be an array, but received a ` +
        `${receivedType}` +
        (looksLikeOptions
          ? ' that carries option keys — it looks like an options object was ' +
            'passed positionally, where the argument list belongs.'
          : '.') +
        ` There is no overload that accepts options in this position: pass ` +
        `an array of constructor/initializer arguments (or an empty array) ` +
        `here, and any options as the following argument.`,
    );
    this.name = 'OptionsInArgsPositionError';
  }
}

/**
 * The proxy is live and confirmed on-chain, and writing it into the deployment
 * record failed.
 *
 * The worst-shaped failure in the whole operation, which is why it gets its own
 * class rather than letting the underlying error through. What the user used to
 * see was the underlying cause alone — most often a lock file, since the record's
 * lock is the likeliest thing to fail here — with no hint that a proxy had just
 * been deployed at their expense and that nothing remembers it. Unrecorded is not
 * a harmless state: the next `upgradeProxy` on that address has no stored layout
 * to validate against, and `deployProxy` re-run deploys a second proxy beside it.
 *
 * The underlying cause is kept as `cause` rather than folded into the text, so a
 * caller can still branch on it — `RecordLockedError` for contention,
 * `RecordUnreadableError` for a record that cannot be read at all.
 */
export class ProxyRecordWriteFailedError extends ProxyOperationRefusedError {
  readonly code = 'proxy-record-write-failed';
  constructor(
    readonly proxyAddress: string,
    readonly transactionHash: string,
    override readonly cause: unknown,
  ) {
    super(
      `A proxy was deployed and confirmed at ${printedAddress(proxyAddress)} ` +
        `(transaction ${transactionHash}), and writing it into the deployment ` +
        `record failed. The proxy is live; nothing about this refusal removes ` +
        `it. What is missing is only this plugin's record of it — which ` +
        `upgrades validate against, so leaving it unrecorded means the next ` +
        `upgradeProxy on this address has no stored layout to check, and a ` +
        `re-run of deployProxy deploys a second proxy beside this one.\n\n` +
        `Resolve the cause below, then record the existing proxy with ` +
        `forceImport('${printedAddress(proxyAddress)}'). Do not re-run the ` +
        `migration first.\n\nCause: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'ProxyRecordWriteFailedError';
  }
}

/**
 * Runs a record write that follows a confirmed on-chain deployment, so a failure
 * arrives as {@link ProxyRecordWriteFailedError} with the live proxy named.
 *
 * A helper rather than three copies of the same `try`/`catch`: `deployProxy`,
 * `upgradeProxy` and `deployBeaconProxy` all write a proxy record as the last
 * statement inside their queued step, all three after an irreversible success,
 * and a rule enforced in one place cannot be applied inconsistently in three.
 */
export async function recordingLiveProxy<T>(
  live: { readonly address: string; readonly transactionHash: string },
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (cause) {
    throw new ProxyRecordWriteFailedError(
      live.address,
      live.transactionHash,
      cause,
    );
  }
}
