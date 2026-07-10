'use strict';

// Helpers for the upstream-schema manifest (.openzeppelin/unknown-<chainId>.json):
// impls keyed by version hash (with storage layouts), proxies as an array
// with kinds. Chain id comes from the node, so the filename is discovered,
// not assumed.

const fs = require('node:fs');
const path = require('node:path');
const { network, config } = require('hardhat');

async function manifestFile() {
  const chainIdHex = await network.provider.send('eth_chainId', []);
  return path.join(config.paths.root, '.openzeppelin', `unknown-${parseInt(chainIdHex, 16)}.json`);
}

async function readManifest() {
  return JSON.parse(fs.readFileSync(await manifestFile(), 'utf8'));
}

async function writeManifest(manifest) {
  fs.writeFileSync(await manifestFile(), JSON.stringify(manifest, null, 2) + '\n');
}

function proxyRecord(manifest, address) {
  return manifest.proxies.find((p) => p.address.toLowerCase() === address.toLowerCase());
}

// Finds the impls entry covering an address — primary or allAddresses.
function implEntry(manifest, address) {
  const target = address.toLowerCase();
  return Object.values(manifest.impls).find(
    (i) =>
      i.address.toLowerCase() === target ||
      (i.allAddresses ?? []).some((a) => a.toLowerCase() === target),
  );
}

module.exports = { manifestFile, readManifest, writeManifest, proxyRecord, implEntry };
