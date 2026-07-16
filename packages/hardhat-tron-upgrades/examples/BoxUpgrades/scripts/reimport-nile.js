'use strict';

// Rebuilds the local upstream-schema manifest for the two existing Nile demo
// proxies. forceImport performs reads and local manifest writes only; it does
// not submit a transaction.

const { ethers, network, tre, upgrades } = require('hardhat');

const PROXIES = [
  {
    base58: 'TAnsUmhTH3VnhKi9jB9r1NRzBobKfrbdhh',
    contract: 'BoxV2',
    kind: 'transparent',
  },
  {
    base58: 'TD59otFvS8pKoA4GrteZLq2jUfBxg7jSVF',
    contract: 'BoxUUPSV2',
    kind: 'uups',
  },
];

async function main() {
  if (network.name !== 'nile') {
    throw new Error('This script is only for --network nile');
  }
  const { tronWeb } = tre.makeTronWeb();
  for (const proxy of PROXIES) {
    const hex = tronWeb.address.toHex(proxy.base58);
    const address = ethers.getAddress(`0x${hex.slice(2)}`);
    await upgrades.forceImport(address, proxy.contract, { kind: proxy.kind });
    console.log(`imported ${proxy.base58} as ${proxy.kind} (${proxy.contract})`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
