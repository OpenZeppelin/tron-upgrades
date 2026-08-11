/**
 * The proxy-lifecycle face: the two operations and their refusal family. The
 * package entry module re-exports the operations; everything else here is for
 * the sibling operation sub-features.
 */

export { deployProxy, runDeployProxy, DEPLOY_PROXY_ACCEPTED_OPTIONS } from './deploy-proxy';
export { upgradeProxy, runUpgradeProxy, UPGRADE_PROXY_ACCEPTED_OPTIONS } from './upgrade-proxy';
export { planUpgradeDispatch, type DispatchProbe, type UpgradePlan, type UpgradeCallName } from './dispatch';
export { PROXY_CONTRACT_NAMES, requireProxyArtifact } from './artifacts';
export { decideDeployReplay, isAlreadyCurrent, type DeployReplayDecision } from './replay';
export {
  BeaconProxyRefusedError,
  EmptyInitializerRefusedError,
  InitialOwnerUnsupportedKindError,
  InitializerDataRequiredError,
  NotTransparentProxyError,
  ProxyAdminAsOwnerError,
  ProxyArtifactCollisionError,
  ProxyArtifactMissingError,
  ProxyOperationRefusedError,
  StaleProxyRecordError,
  UnknownProxyGenerationError,
  UpgradeVerificationFailedError,
} from './errors';
export type {
  OperationContext,
  OperationToolkit,
  RawOperationOptions,
  ResolvedForProxyOps,
  ValidatedImplementation,
} from './toolkit';
