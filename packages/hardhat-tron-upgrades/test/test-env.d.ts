// Test-only ambient types.
//
// - The TronWeb bridge (@openzeppelin/hardhat-tron) ships no TypeScript
//   declarations yet: hre.tre is typed as `any` here. hre.ethers gets its
//   types transitively from hardhat-ethers (via the chai-matchers types);
//   hre.upgrades stays fully typed via this package's own type-extensions.
// - The bridge's TVM-aware chai matchers mirror hardhat-chai-matchers, whose
//   global Chai augmentation provides the assertion types (emit, reverted…).

/// <reference types="@nomicfoundation/hardhat-chai-matchers" />

import 'hardhat/types/runtime';

declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    tre: any;
  }
}
