// Forces `storageLayout` into the solc outputSelection for every compiler and
// per-file override. Upgrade-safety validation reads slot/offset/numberOfBytes
// from storageLayout; without it upgrades-core falls back to AST-only layout
// inference, which false-positives on safe changes (gap consumption, same-size
// retypes, inserts into intra-slot padding). The tron-solc compiler honors
// outputSelection like upstream solc, so requesting the layout is enough.
import { extendConfig } from 'hardhat/config';
import type { HardhatConfig, HardhatUserConfig } from 'hardhat/types';

export type NamespacedCompileErrorsRule = 'error' | 'warn' | 'ignore';

// Plugin-level configuration, set under the `tronUpgrades` key in hardhat.config.
export interface TronUpgradesUserConfig {
  // What a failed namespaced (ERC-7201) recompile does: 'error' fails the run
  // (default, matching upstream hardhat-upgrades), 'warn' warns once and falls
  // back to AST-only namespace checks, 'ignore' falls back silently.
  namespacedCompileErrors?: NamespacedCompileErrorsRule;
}
export interface TronUpgradesConfig {
  namespacedCompileErrors: NamespacedCompileErrorsRule;
}

const NAMESPACED_COMPILE_ERRORS_RULES: readonly NamespacedCompileErrorsRule[] = ['error', 'warn', 'ignore'];

export function resolveNamespacedCompileErrors(value: unknown): NamespacedCompileErrorsRule {
  if (value === undefined) return 'error';
  if ((NAMESPACED_COMPILE_ERRORS_RULES as readonly unknown[]).includes(value)) {
    return value as NamespacedCompileErrorsRule;
  }
  throw new Error(
    `tronUpgrades.namespacedCompileErrors must be 'error', 'warn' or 'ignore' (got ${JSON.stringify(value)})`,
  );
}

declare module 'hardhat/types/config' {
  interface HardhatUserConfig {
    tronUpgrades?: TronUpgradesUserConfig;
  }
  interface HardhatConfig {
    tronUpgrades: TronUpgradesConfig;
  }
}

function ensureStorageLayout(settings: { outputSelection?: Record<string, any> }): void {
  const outputSelection = (settings.outputSelection ??= {});
  const star = (outputSelection['*'] ??= {});
  const starStar = (star['*'] ??= []);
  if (!starStar.includes('storageLayout')) {
    starStar.push('storageLayout');
  }
}

extendConfig((config: HardhatConfig, userConfig: Readonly<HardhatUserConfig>) => {
  for (const compiler of config.solidity.compilers) {
    ensureStorageLayout((compiler.settings ??= {}));
  }
  for (const override of Object.values(config.solidity.overrides ?? {})) {
    ensureStorageLayout((override.settings ??= {}));
  }
  config.tronUpgrades = {
    namespacedCompileErrors: resolveNamespacedCompileErrors(userConfig.tronUpgrades?.namespacedCompileErrors),
  };
});
