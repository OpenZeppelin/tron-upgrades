import hre from 'hardhat';
import { expect } from 'chai';

const { ethers, upgrades } = hre;

// A transparent proxy can be governed by a v4-style ProxyAdmin — one that
// predates UPGRADE_INTERFACE_VERSION and exposes upgrade + upgradeAndCall,
// where a plain upgrade must use `upgrade` because v4's upgradeAndCall
// force-calls the implementation. The plugin probes the admin's version and
// dispatches accordingly (v5 → upgradeAndCall, v4 → upgrade/upgradeAndCall),
// so a forceImport-then-upgrade flow works on both.
async function deployV4Governed(deployer: any, initValue: bigint) {
  const adminV4 = await ethers.deployContract('TestProxyAdminV4', [deployer.address]);
  await adminV4.waitForDeployment();

  const logic = await ethers.deployContract('TestBoxV1');
  await logic.waitForDeployment();

  const initData = new ethers.Interface(
    (await hre.artifacts.readArtifact('TestBoxV1')).abi,
  ).encodeFunctionData('initialize', [deployer.address, initValue]);

  const proxy = await ethers.deployContract('TestTransparentProxyV4', [
    await logic.getAddress(),
    await adminV4.getAddress(),
    initData,
  ]);
  await proxy.waitForDeployment();

  return await proxy.getAddress();
}

describe('Transparent v4 ProxyAdmin dispatch', function () {
  this.timeout(240_000);

  it('upgrades a proxy governed by a v4-style ProxyAdmin (no version getter)', async () => {
    const [deployer] = await ethers.getSigners();
    const proxyAddress = await deployV4Governed(deployer, 41n);

    await upgrades.forceImport(proxyAddress, 'TestBoxV1', { kind: 'transparent' });
    expect(await (await ethers.getContractAt('TestBoxV1', proxyAddress)).value()).to.equal(41n);

    // No call data → v4 dispatch must use upgrade(proxy, impl).
    await upgrades.upgradeProxy(proxyAddress, 'TestBoxV2');

    const box2 = await ethers.getContractAt('TestBoxV2', proxyAddress);
    expect(await box2.version()).to.equal('v2');
    expect(await box2.value()).to.equal(41n); // state preserved across the v4 upgrade
  });

  it('upgrades a v4-governed proxy with a post-upgrade call (v4 upgradeAndCall path)', async () => {
    const [deployer] = await ethers.getSigners();
    const proxyAddress = await deployV4Governed(deployer, 5n);

    await upgrades.forceImport(proxyAddress, 'TestBoxV1', { kind: 'transparent' });

    // Call data → v4 dispatch must use upgradeAndCall(proxy, impl, data).
    await upgrades.upgradeProxy(proxyAddress, 'TestBoxV2', { call: { fn: 'increment', args: [] } });

    const box2 = await ethers.getContractAt('TestBoxV2', proxyAddress);
    expect(await box2.version()).to.equal('v2');
    expect(await box2.value()).to.equal(6n); // increment ran during upgradeAndCall
  });
});
