// Forces `storageLayout` into the solc outputSelection for every compiler and
// per-file override. Upgrade-safety validation reads slot/offset/numberOfBytes
// from storageLayout; without it upgrades-core falls back to AST-only layout
// inference, which false-positives on safe changes (gap consumption, same-size
// retypes, inserts into intra-slot padding). The tron-solc compiler honors
// outputSelection like upstream solc, so requesting the layout is enough.
import { extendConfig } from 'hardhat/config';
import type { HardhatConfig } from 'hardhat/types';

function ensureStorageLayout(settings: { outputSelection?: Record<string, any> }): void {
  const outputSelection = (settings.outputSelection ??= {});
  const star = (outputSelection['*'] ??= {});
  const starStar = (star['*'] ??= []);
  if (!starStar.includes('storageLayout')) {
    starStar.push('storageLayout');
  }
}

extendConfig((config: HardhatConfig) => {
  for (const compiler of config.solidity.compilers) {
    ensureStorageLayout((compiler.settings ??= {}));
  }
  for (const override of Object.values(config.solidity.overrides ?? {})) {
    ensureStorageLayout((override.settings ??= {}));
  }
});
