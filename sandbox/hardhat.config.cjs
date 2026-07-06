require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
require('@openzeppelin/hardhat-tron');

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
    image: 'tronbox/tre:dev',
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
          '0xdd23ca549a97cb330b011aebb674730df8b14acaee42d211ab45692699ab8ba5',
      ],
    },
  },
};
