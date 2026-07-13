export type ProxyKind = 'transparent' | 'uups';
export type ValidationKind = ProxyKind | 'beacon';

export interface ValidationOptions {
  kind?: ValidationKind;
}
export interface DeployProxyOptions {
  kind?: ProxyKind;
  initializer?: string | false;
  initialOwner?: string;
}
export interface UpgradeProxyOptions {
  kind?: ProxyKind;
  from?: string;
  owner?: unknown; // a bridge signer (carries .tronWeb); default = deployer key
  call?: string;
}
export interface DeployBeaconOptions {
  initialOwner?: string;
}
export interface DeployBeaconProxyOptions {
  initializer?: string | false;
}
export interface UpgradeBeaconOptions {
  from?: string;
  owner?: unknown;
}

const KINDS: ProxyKind[] = ['transparent', 'uups'];

export function checkKind(kind: string): asserts kind is ProxyKind {
  if (!KINDS.includes(kind as ProxyKind)) {
    throw new Error(`kind "${kind}" not supported (expected one of: ${KINDS.join(' | ')})`);
  }
}
