export type ProxyKind = 'transparent' | 'uups';
export type ValidationKind = ProxyKind | 'beacon';

export interface ValidationOptions {
  kind?: ValidationKind;
  unsafeAllow?: string[];
  unsafeAllowRenames?: boolean;
  unsafeSkipStorageCheck?: boolean;
}
export interface TxOverrides {
  value?: unknown;
  gasLimit?: unknown;
  [key: string]: unknown;
}
export interface ImplementationOptions extends ValidationOptions {
  constructorArgs?: unknown[];
  redeployImplementation?: 'always' | 'never' | 'onchange';
  timeout?: number;
  pollingInterval?: number;
  txOverrides?: TxOverrides;
}
export interface DeployProxyOptions extends ImplementationOptions {
  kind?: ProxyKind;
  initializer?: string | false;
  initialOwner?: string;
}
export interface UpgradeProxyOptions extends ImplementationOptions {
  kind?: ProxyKind;
  owner?: unknown; // a bridge signer (carries .tronWeb); default = deployer key
  call?: string | { fn: string; args?: unknown[] };
}
export interface DeployBeaconOptions extends ImplementationOptions {
  initialOwner?: string;
}
export interface DeployBeaconProxyOptions {
  initializer?: string | false;
  txOverrides?: TxOverrides;
}
export interface UpgradeBeaconOptions extends ImplementationOptions {
  owner?: unknown;
}
export interface DeployImplementationOptions extends ImplementationOptions {
  getTxResponse?: boolean;
}
export interface PrepareUpgradeOptions extends ImplementationOptions {
  getTxResponse?: boolean;
}
export interface TransferProxyAdminOwnershipOptions {
  owner?: unknown;
  txOverrides?: TxOverrides;
}

const KINDS: ProxyKind[] = ['transparent', 'uups'];

export function checkKind(kind: string): asserts kind is ProxyKind {
  if (!KINDS.includes(kind as ProxyKind)) {
    throw new Error(`kind "${kind}" not supported (expected one of: ${KINDS.join(' | ')})`);
  }
}

export function txOverridesOf(opts: { txOverrides?: TxOverrides }): TxOverrides | undefined {
  const overrides = opts.txOverrides;
  if (!overrides) return undefined;
  const unsupported = Object.keys(overrides).filter((key) => !['value', 'gasLimit'].includes(key));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported transaction overrides for TRON: ${unsupported.sort().join(', ')}`);
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}
