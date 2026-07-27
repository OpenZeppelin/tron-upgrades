// Test config for the plugin itself. The plugin under test loads from the
// LOCAL BUILD (./dist) — `npm test` builds first. Tarball consumption is
// proven separately by examples/BoxUpgrades (npm run test:examples).
require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
require('@openzeppelin/hardhat-tron');
require('./dist/index.js');

module.exports = {
  solidity: {
    version: '0.8.26',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      viaIR: true,
      metadata: { bytecodeHash: 'ipfs', useLiteralContent: true },
    },
  },
  tre: {
    autoStart: true,
    image: 'tronbox/tre:2.0.0',
    compiler: { target: 'tron' },
  },
  defaultNetwork: 'tre',
  networks: {
    tre: {
      url: process.env.TRE_URL || 'http://127.0.0.1:9090/jsonrpc',
      tron: true,
      // Well-known TRE dev key — local tests only, never a real network.
      accounts: [
        process.env.TRE_PRIVATE_KEY ||
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      ],
    },
  },
};
