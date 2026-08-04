/**
 * The portable option surface shared by every operation.
 *
 * INV-43: this directory imports only `@openzeppelin/upgrades-core` — nothing from
 * the seam, nothing from another sub-feature's module.
 *
 * INV-47: no deployment-shaped option appears here. `deployer`, `txOverrides`,
 * account identity and TRON-native fee/resource options are all SF-4's, and their
 * absence is deliberate rather than an omission — it is what keeps SF-10 a
 * dependency root that does not wait on the deployer integration's open questions. Passing
 * one is a named `UnknownOptionError` rather than a silent ignore.
 *
 * SF-11 owns the package entry point; this is the directory's face to its
 * siblings.
 */
export {
  DEFAULT_INITIALIZER,
  MILLISECOND_OPTION_MINIMUM,
  defaultConstructorArgs,
  pluginOptionDefaults,
  recordedUpstreamValidationDefaults,
} from './defaults';

export {
  OptionConflictError,
  OptionUnsupportedOnTronError,
  OptionValueError,
  UnknownOptionError,
  UpgradesOptionError,
  optionsUnsupportedOnTron,
  renderReceived,
  type TronOptionRefusal,
} from './errors';

export {
  engineValidationOptions,
  requireProxyKind,
  resolveInitializer,
  resolveUpgradeOptions,
} from './resolve';

export {
  proxyKinds,
  redeployModes,
  unsafeAllowKinds,
  type CallOption,
  type DeployBeaconOptions,
  type DeployBeaconProxyOptions,
  type DeployImplementationOptions,
  type DeployProxyOptions,
  type ForceImportOptions,
  type InitializerOption,
  type InitializerResolution,
  type PrepareUpgradeOptions,
  type ProxyKind,
  type RedeployMode,
  type ResolvedUpgradeOptions,
  type StandaloneOptions,
  type UnsafeAllowKind,
  type UpgradeBeaconOptions,
  type UpgradeOptions,
  type UpgradeProxyOptions,
  type ValidateImplementationOptions,
  type ValidateUpgradeOptions,
} from './types';
