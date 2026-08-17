/** The per-network entry a write-back lands in, exposed for assertions. */
export interface WriteBackBearing {
  readonly contractName: string;
  readonly network: { address?: unknown; transactionHash?: unknown };
  readonly resetAddress: () => void;
}

/**
 * A stand-in for the host's write-back surface, mirroring exactly the members
 * `restoreWriteBack` touches: `address` and `transactionHash` are accessors
 * routed through a per-network entry, and `resetAddress` deletes the address off
 * that entry — verbatim what TronBox's own `Contract` does
 * (`resetAddress: function () { delete this.network.address }`), and the reason
 * its `isDeployed()` is exactly `!!network.address`.
 *
 * Non-configurable accessors on purpose: the host defines them with
 * `Object.defineProperty(..., {configurable: false})`, so `delete abstraction.address`
 * does NOT work there and `resetAddress` is the only undo. A stand-in with plain
 * data properties would let a wrong implementation pass here and fail live.
 *
 * The installed host's own behaviour is pinned separately in
 * `deploy-real-host.test.ts`; this mirror exists so the unit suites can observe
 * whether an operation undid the write-back at all. Shared by the proxy, beacon
 * and standalone suites, which all pin the same `restoreWriteBack` wiring.
 */
export function writeBackBearingArtifact(contractName: string): WriteBackBearing {
  const network: { address?: unknown; transactionHash?: unknown } = {};
  const artifact = {
    contractName,
    network,
    resetAddress: () => {
      delete network.address;
    },
  };
  Object.defineProperty(artifact, 'address', {
    configurable: false,
    enumerable: false,
    get: () => {
      if (network.address === undefined) {
        // The host's getter throws for an abstraction with no address, which is
        // what `readWriteBack`'s guard exists to absorb.
        throw new Error(`Cannot find deployed address: ${contractName}`);
      }
      return network.address;
    },
    set: (value: unknown) => {
      if (value === undefined || value === null || value === '') {
        throw new Error(`Cannot set deployed address; malformed value: ${String(value)}`);
      }
      network.address = value;
    },
  });
  Object.defineProperty(artifact, 'transactionHash', {
    configurable: false,
    enumerable: false,
    get: () => network.transactionHash,
    set: (value: unknown) => {
      network.transactionHash = value;
    },
  });
  return artifact;
}
