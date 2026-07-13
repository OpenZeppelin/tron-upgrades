import type { UpgradesAPI } from './types';

declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    upgrades: UpgradesAPI;
  }
}
