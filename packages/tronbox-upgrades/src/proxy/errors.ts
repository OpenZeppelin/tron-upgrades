/**
 * The proxy-lifecycle refusal family. Same construction rules as the
 * deployment seam's: one closed hierarchy, one class per cause, structured
 * fields, the message rendered by the constructor so fields and text cannot
 * disagree.
 */

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
        `\`import "openzeppelin-tron-solidity/contracts/proxy/transparent/` +
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
 * The upgrade transaction confirmed and the implementation slot does not hold
 * the new address — success was NOT assumed from the receipt.
 */
export class UpgradeVerificationFailedError extends ProxyOperationRefusedError {
  readonly code = 'upgrade-verification-failed';
  constructor(
    readonly proxyAddress: string,
    readonly expected: string,
    readonly observed: string,
  ) {
    super(
      `The upgrade transaction for ${proxyAddress} confirmed, but the ` +
        `implementation slot holds ${observed} where ${expected} was expected. ` +
        `The proxy's live implementation is NOT the one this operation deployed ` +
        `— investigate before running anything else against this proxy.`,
    );
    this.name = 'UpgradeVerificationFailedError';
  }
}

/**
 * The ported TRC1967Proxy rejects empty initialization data for both kinds,
 * so the refusal happens here — before any spend — with the two
 * user mistakes distinguished, because their remedies differ.
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
          `transaction, or use a beacon proxy.`
        : `Uninitialized deployment is not supported for kind "${kind}": the ` +
          `contract has no default initializer and the ported TRC1967Proxy ` +
          `rejects empty initialization data. Add an initializer function or ` +
          `use a beacon proxy.`,
    );
    this.name = 'EmptyInitializerRefusedError';
  }
}

/**
 * `resolveInitializer` resolved the operation's `initializer` to
 * `{ kind: 'none' }` — only an explicit `initializer: false` produces one,
 * since the omitted case follows the parity target's TRY-FIRST rule and lets
 * the ABI decide inside `encodeInitializer`. That leaves the deploy with no
 * initialization data — and unlike upstream's `ERC1967Proxy`, the ported
 * TRC1967Proxy and TransparentUpgradeableProxy REJECT an empty init-data
 * constructor argument (a deliberate parity break, safer than upstream).
 * Refusing here, before any spend, turns that guaranteed on-chain revert
 * into a named pre-flight error that states its own remedy. The
 * `'no-arguments'` cause is retired from `deployProxy` by the TRY-FIRST
 * rule — an argument-less deploy now succeeds or takes the encode step's
 * `EmptyInitializerRefusedError` — and stays declared only until the decided
 * consolidation of this class with that one.
 */
export class InitializerDataRequiredError extends ProxyOperationRefusedError {
  readonly code = 'initializer-data-required';
  constructor(
    readonly contractName: string,
    readonly because: 'initializer-false' | 'no-arguments',
  ) {
    super(
      because === 'initializer-false'
        ? `\`initializer: false\` is not supported for ${contractName}: the ` +
          `ported TRC1967Proxy and TransparentUpgradeableProxy reject empty ` +
          `initialization data — a deliberate parity break, safer than ` +
          `upstream's ERC1967Proxy. An uninitialized proxy cannot be ` +
          `deployed on TRON; add an initializer function instead.`
        : `${contractName} was deployed with no arguments and no ` +
          `\`initializer\` option: the ported TRC1967Proxy and ` +
          `TransparentUpgradeableProxy reject empty initialization data — a ` +
          `deliberate parity break, safer than upstream's ERC1967Proxy — so ` +
          `an uninitialized deploy is not supported on TRON. Add an ` +
          `initializer function.`,
    );
    this.name = 'InitializerDataRequiredError';
  }
}

/**
 * A prior deployment's record cannot vouch for this replay: the
 * artifact remembers an address, and the record layer reports it stale,
 * unrecorded, or never seen. Redeploying beside it would leave two proxies
 * answering one name, so the operation stops and says which investigation
 * comes first.
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
          `deployment record and the artifact's network entry, then re-run.`
        : because === 'unrecorded'
          ? `This migration previously deployed a proxy at ${proxyAddress}, ` +
            `and the address holds code, but the deployment record has no ` +
            `entry for it. Register it first with a force-import so upgrades ` +
            `validate against the right layout.`
          : `This migration previously deployed a proxy at ${proxyAddress}, ` +
            `but the deployment record knows nothing about that address — an ` +
            `out-of-band deployment, a deleted record, or another tool's ` +
            `write. Reconcile the record before deploying again.`,
    );
    this.name = 'StaleProxyRecordError';
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
