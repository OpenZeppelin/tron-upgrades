require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
require('@openzeppelin/hardhat-tron');
require('@openzeppelin/hardhat-tron-upgrades');

const fs = require('node:fs');
const path = require('node:path');

// Testnet key: env var wins, then the gitignored key file. There is NO
// fallback for public networks — selecting shasta/nile without a key throws
// here rather than ever signing with a publicly-known dev key. For all other
// commands (tre tests, compile) a placeholder keeps config parsing working.
function testnetKey() {
  if (process.env.TRON_TESTNET_KEY) {
    return '0x' + process.env.TRON_TESTNET_KEY.trim().replace(/^0x/, '');
  }
  const f = path.join(__dirname, '.testnet-key');
  if (fs.existsSync(f)) return '0x' + fs.readFileSync(f, 'utf8').trim().replace(/^0x/, '');
  // Network selection reaches config via CLI args OR HARDHAT_NETWORK.
  const selected = [process.env.HARDHAT_NETWORK, ...process.argv];
  if (selected.includes('shasta') || selected.includes('nile')) {
    throw new Error(
      'No testnet key configured: set TRON_TESTNET_KEY or create sandbox/.testnet-key ' +
        '(never use the TRE dev key on a public network).',
    );
  }
  // placeholder — never used unless a public network is actually selected
  return '0x' + '11'.repeat(32);
}

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
    shasta: {
      url: 'https://api.shasta.trongrid.io/jsonrpc',
      tron: true,
      accounts: [testnetKey()],
    },
    nile: {
      url: 'https://nile.trongrid.io/jsonrpc',
      tron: true,
      accounts: [testnetKey()],
    },
  },
};
