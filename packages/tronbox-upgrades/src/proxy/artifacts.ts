/**
 * Proxy-artifact triage over the seam's three-variant resolution:
 * exactly three outcomes, none silent.
 *
 * In v1 the proxy contracts are compiled by the CONSUMER project (one import
 * file plus `tronbox compile`), so the artifacts arrive through the same
 * bare-name index as the user's own contracts — which is why the collision
 * case exists and why it must refuse: the index is bare-name keyed, and a
 * silent pick would be decided by directory iteration order.
 */

import type { ArtifactAccess, ContractAbstraction } from '../environment';
import {
  ProxyArtifactCollisionError,
  ProxyArtifactMissingError,
} from './errors';

/** The proxy contracts the operations deploy, by their compiled bare names. */
export const PROXY_CONTRACT_NAMES = Object.freeze({
  transparent: 'TransparentUpgradeableProxy',
  trc1967: 'TRC1967Proxy',
  proxyAdmin: 'ProxyAdmin',
} as const);

/**
 * Resolves one proxy artifact or refuses by name. `resolve`'s `indeterminate`
 * status (build-info problems) is treated as missing — the remedy is the same
 * from the user's seat: compile the import file — while `ambiguous` names
 * every candidate path.
 */
export function requireProxyArtifact(
  artifacts: ArtifactAccess,
  name: string,
): ContractAbstraction {
  let resolution: ReturnType<ArtifactAccess['resolve']>;
  try {
    resolution = artifacts.resolve(name);
  } catch {
    // The host resolver throws for a name with no artifact at all; that is
    // the missing case, with the same remedy.
    throw new ProxyArtifactMissingError(name);
  }
  switch (resolution.status) {
    case 'unique':
      return resolution.contract;
    case 'ambiguous': {
      /*
       * The seam detects; the refusal-or-pick policy is this operation
       * layer's. Candidates that share one (sourcePath, contractName) are the
       * SAME contract seen in several build records — records accumulate when
       * the compiler input differs between runs (the filename is the sha256
       * of the solc input), and the first live migration hit exactly that
       * shape — so only DISTINCT sources constitute a collision a user must
       * resolve. With one distinct source the resolver's single abstraction
       * is unambiguous for deployment, whatever record later describes it.
       */
      const distinct = new Set(
        resolution.candidates.map(
          candidate => `${candidate.sourcePath}:${candidate.contractName}`,
        ),
      );
      if (distinct.size <= 1) {
        return resolution.unverifiedContract;
      }
      throw new ProxyArtifactCollisionError(
        name,
        [...new Set(resolution.candidates.map(candidate => candidate.sourcePath))],
      );
    }
    case 'indeterminate':
      throw new ProxyArtifactMissingError(name);
  }
}
