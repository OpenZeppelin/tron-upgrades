// Forces `storageLayout` into the solc outputSelection for every compiler and
// per-file override. Upgrade-safety validation reads slot/offset/numberOfBytes
// from storageLayout; without it upgrades-core falls back to AST-only layout
// inference, which false-positives on safe changes (gap consumption, same-size
// retypes, inserts into intra-slot padding). The tron-solc compiler honors
// outputSelection like upstream solc, so requesting the layout is enough.
import { extendConfig } from 'hardhat/config';
import type { HardhatConfig, HardhatUserConfig } from 'hardhat/types';

// Plugin-level configuration, set under the `tronUpgrades` key in hardhat.config.
export interface TronUpgradesUserConfig {
  // When true, a failure to compile the namespaced (ERC-7201) recompile is a
  // thrown error instead of a warning + AST-only fallback. Off by default.
  namespacedCompileErrors?: boolean;
}
export interface TronUpgradesConfig {
  namespacedCompileErrors: boolean;
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
    namespacedCompileErrors: userConfig.tronUpgrades?.namespacedCompileErrors ?? false,
  };
});
