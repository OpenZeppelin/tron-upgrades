/**
 * The proxy-lifecycle refusal family. Same construction rules as the
 * deployment seam's: one closed hierarchy, one class per cause, structured
 * fields, the message rendered by the constructor so fields and text cannot
 * disagree (INV-8's family pattern).
 */

/** The base every proxy-lifecycle refusal extends. */
export abstract class ProxyOperationRefusedError extends Error {
  abstract readonly code: string;
}

/**
 * The proxy's reported `UPGRADE_INTERFACE_VERSION` is outside the closed set
 * the dispatch matrix knows (INV-5). Refusing is the only safe answer: a
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
 * The proxy artifact is not in the project's build output (INV-8, scenario 6).
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
 * More than one artifact answers to the proxy contract's bare name (INV-8).
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
 * in-place upgrade through the proxy is the wrong operation (INV-4). Refused
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
 * the new address (INV-3) — success was NOT assumed from the receipt.
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
 * The ported TRC1967Proxy rejects empty initialization data for both kinds
 * (INV-11), so the refusal happens here — before any spend — with the two
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
 *`initialOwner` looks like a ProxyAdmin contract (INV-12): the v5 transparent
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
