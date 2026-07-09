import type { UpgradesAPI } from './upgrades';

declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    upgrades: UpgradesAPI;
  }
}
