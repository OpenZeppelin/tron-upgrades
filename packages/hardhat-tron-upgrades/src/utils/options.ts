export type ProxyKind = 'transparent' | 'uups';
export type ValidationKind = ProxyKind | 'beacon';

export interface ValidationOptions {
  kind?: ValidationKind;
}
export interface ImplementationOptions extends ValidationOptions {
  constructorArgs?: unknown[];
  redeployImplementation?: 'always' | 'never' | 'onchange';
  timeout?: number;
  pollingInterval?: number;
}
export interface DeployProxyOptions extends ImplementationOptions {
  kind?: ProxyKind;
  initializer?: string | false;
  initialOwner?: string;
}
export interface UpgradeProxyOptions extends ImplementationOptions {
  kind?: ProxyKind;
  owner?: unknown; // a bridge signer (carries .tronWeb); default = deployer key
  call?: string;
}
export interface DeployBeaconOptions extends ImplementationOptions {
  initialOwner?: string;
}
export interface DeployBeaconProxyOptions {
  initializer?: string | false;
}
export interface UpgradeBeaconOptions extends ImplementationOptions {
  owner?: unknown;
}
export interface DeployImplementationOptions extends ImplementationOptions {}
export interface PrepareUpgradeOptions extends ImplementationOptions {}
export interface TransferProxyAdminOwnershipOptions {
  owner?: unknown;
}

const KINDS: ProxyKind[] = ['transparent', 'uups'];

export function checkKind(kind: string): asserts kind is ProxyKind {
  if (!KINDS.includes(kind as ProxyKind)) {
    throw new Error(`kind "${kind}" not supported (expected one of: ${KINDS.join(' | ')})`);
  }
}
