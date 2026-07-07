'use strict';

// ERC-1967 well-known proxy slots (used verbatim by the TRC1967 port).
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

// Read a raw storage slot. Prefers the provider; falls back to the node's
// eth-compatible JSON-RPC endpoint when the bridge provider doesn't
// implement getStorage.
async function getSlot(hre, address, slot) {
  try {
    return await hre.ethers.provider.getStorage(address, slot);
  } catch (_) {
    const url =
      (hre.network && hre.network.config && hre.network.config.url) ||
      process.env.TRE_URL ||
      'http://127.0.0.1:9090/jsonrpc';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getStorageAt',
        params: [address, slot, 'latest'],
      }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`eth_getStorageAt failed: ${JSON.stringify(json.error)}`);
    return json.result;
  }
}

// A slot storing an address holds it left-padded; extract the 20-byte body.
function slotToAddress(slotValue) {
  return '0x' + slotValue.slice(-40);
}

module.exports = { IMPL_SLOT, ADMIN_SLOT, BEACON_SLOT, getSlot, slotToAddress };
