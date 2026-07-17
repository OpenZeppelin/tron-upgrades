import hre from 'hardhat';
import { UpgradeableContract } from '@openzeppelin/upgrades-core';
import { expect } from 'chai';

// These cases only decide correctly when build-info carries storageLayout
// (slot/offset/numberOfBytes). With AST-only build-info the gap and retype
// upgrades are false-positives (wrongly rejected); the repack must stay
// rejected either way.
async function load(fqName: string, shortName: string) {
  const bi = await hre.artifacts.getBuildInfo(fqName);
  if (!bi) throw new Error(`no build-info for ${fqName} — run hardhat compile first`);
  return new UpgradeableContract(shortName, bi.input, bi.output, {}, (bi as any).solcVersion);
}

describe('Storage-layout-aware upgrade validation', function () {
  this.timeout(120_000);

  it('accepts __gap consumption (add a variable, shrink the gap)', async () => {
    const v1 = await load('contracts/StorageGap.sol:StorageGapV1', 'StorageGapV1');
    const v2 = await load('contracts/StorageGap.sol:StorageGapV2', 'StorageGapV2');
    const report = v1.getStorageUpgradeReport(v2);
    expect(report.ok, report.explain()).to.equal(true);
  });

  it('accepts a same-size @custom:oz-retyped-from retype', async () => {
    const v1 = await load('contracts/StorageRetype.sol:StorageRetypeV1', 'StorageRetypeV1');
    const v2 = await load('contracts/StorageRetype.sol:StorageRetypeV2', 'StorageRetypeV2');
    const report = v1.getStorageUpgradeReport(v2);
    expect(report.ok, report.explain()).to.equal(true);
  });

  it('rejects an unsafe repack (uint128,uint128 -> uint256,uint128)', async () => {
    const v1 = await load('contracts/StorageRepack.sol:StorageRepackV1', 'StorageRepackV1');
    const v2 = await load('contracts/StorageRepack.sol:StorageRepackV2', 'StorageRepackV2');
    const report = v1.getStorageUpgradeReport(v2);
    expect(report.ok).to.equal(false);
  });
});
