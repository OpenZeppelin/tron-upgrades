'use strict';

const { expect } = require('chai');
const hre = require('hardhat');
const { UpgradeableContract } = require('@openzeppelin/upgrades-core');

// The upgrade-safety validator consumes compiler build-info (AST + storage
// layout). These tests feed it tron-solc output and check that both the
// unsafe-pattern detection and the storage-layout diff behave correctly.
async function loadContract(fqName, shortName) {
  const buildInfo = await hre.artifacts.getBuildInfo(fqName);
  if (!buildInfo) throw new Error(`no build-info for ${fqName} — run hardhat compile first`);
  return new UpgradeableContract(shortName, buildInfo.input, buildInfo.output, {}, buildInfo.solcVersion);
}

describe('Upgrade-safety validation over tron-solc build-info', function () {
  this.timeout(120_000);

  let v1, v2, v2broken;

  before(async () => {
    v1 = await loadContract('contracts/BoxV1.sol:BoxV1', 'BoxV1');
    v2 = await loadContract('contracts/BoxV2.sol:BoxV2', 'BoxV2');
    v2broken = await loadContract('contracts/BoxV2Broken.sol:BoxV2Broken', 'BoxV2Broken');
  });

  it('parses tron-solc build-info and finds no unsafe patterns in BoxV1', () => {
    const report = v1.getErrorReport();
    expect(report.ok, report.explain()).to.equal(true);
  });

  it('accepts a layout-compatible upgrade (append-only)', () => {
    const report = v1.getStorageUpgradeReport(v2);
    expect(report.ok, report.explain()).to.equal(true);
  });

  it('rejects a layout-incompatible upgrade (reordered slots)', () => {
    const report = v1.getStorageUpgradeReport(v2broken);
    expect(report.ok).to.equal(false);
    // the diagnosis must point at the actual problem
    const explanation = report.explain();
    expect(explanation).to.match(/value|owner/i);
  });
});
