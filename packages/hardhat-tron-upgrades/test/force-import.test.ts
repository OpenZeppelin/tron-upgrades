import hre from 'hardhat';
import { expect } from 'chai';
import { implEntry, proxyRecord, readManifest } from './_manifest-helper';

const { ethers, upgrades } = hre;

const PROXY_ROOT = '@openzeppelin/tron-contracts/proxy';
const FQN = {
  transparent: `${PROXY_ROOT}/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy`,
  trc1967: `${PROXY_ROOT}/TRC1967/TRC1967Proxy.sol:TRC1967Proxy`,
  beacon: `${PROXY_ROOT}/beacon/UpgradeableBeacon.sol:UpgradeableBeacon`,
  beaconProxy: `${PROXY_ROOT}/beacon/BeaconProxy.sol:BeaconProxy`,
};

describe('forceImport', function () {
  this.timeout(240_000);

  it('imports a raw transparent proxy and makes it upgradeable', async () => {
    const [owner] = await ethers.getSigners();
    const impl = await ethers.deployContract('TestBoxV1');
    const data = impl.interface.encodeFunctionData('initialize', [owner.address, 11n]);
    const proxy = await ethers.deployContract(FQN.transparent, [await impl.getAddress(), owner.address, data]);
    const address = await proxy.getAddress();

    const imported = await upgrades.forceImport(address, 'TestBoxV1');
    expect(await imported.value()).to.equal(11n);
    expect(proxyRecord(await readManifest(), address).kind).to.equal('transparent');

    const upgraded = await upgrades.upgradeProxy(imported, 'TestBoxV2');
    expect(await upgraded.version()).to.equal('v2');
    expect(await upgraded.value()).to.equal(11n);
  });

  it('imports a raw uups proxy by validation data, not the admin slot', async () => {
    const [owner] = await ethers.getSigners();
    const impl = await ethers.deployContract('TestBoxUUPSV1');
    const data = impl.interface.encodeFunctionData('initialize', [owner.address, 12n]);

    // TransparentUpgradeableProxy deliberately populates the admin slot. The
    // implementation signatures still make this a UUPS-managed proxy.
    const proxy = await ethers.deployContract(FQN.transparent, [await impl.getAddress(), owner.address, data]);
    const address = await proxy.getAddress();
    expect(await upgrades.erc1967.getAdminAddress(address)).to.not.equal(ethers.ZeroAddress);

    const imported = await upgrades.forceImport(address, 'TestBoxUUPSV1');
    expect(proxyRecord(await readManifest(), address).kind).to.equal('uups');
    const upgraded = await upgrades.upgradeProxy(imported, 'TestBoxUUPSV2');
    expect(await upgraded.version()).to.equal('v2');
    expect(await upgraded.value()).to.equal(12n);
  });

  it('rejects explicit transparent kind when the admin slot is empty', async () => {
    const [owner] = await ethers.getSigners();
    const impl = await ethers.deployContract('TestBoxV1');
    const data = impl.interface.encodeFunctionData('initialize', [owner.address, 13n]);
    const proxy = await ethers.deployContract(FQN.trc1967, [await impl.getAddress(), data]);

    await expect(
      upgrades.forceImport(await proxy.getAddress(), 'TestBoxV1', { kind: 'transparent' }),
    ).to.be.rejectedWith(/transparent proxy|admin.*empty/i);
  });

  it('imports a beacon proxy as beacon regardless of implementation inference', async () => {
    const [owner] = await ethers.getSigners();
    const impl = await ethers.deployContract('TestBoxV1');
    const beacon = await ethers.deployContract(FQN.beacon, [await impl.getAddress(), owner.address]);
    const data = impl.interface.encodeFunctionData('initialize', [owner.address, 14n]);
    const proxy = await ethers.deployContract(FQN.beaconProxy, [await beacon.getAddress(), data]);
    const address = await proxy.getAddress();

    const imported = await upgrades.forceImport(address, 'TestBoxV1');
    expect(await imported.value()).to.equal(14n);
    expect(proxyRecord(await readManifest(), address).kind).to.equal('beacon');
    expect(implEntry(await readManifest(), await impl.getAddress())).to.not.equal(undefined);
  });

  it('imports bare beacons and bare implementations', async () => {
    const [owner] = await ethers.getSigners();
    const impl = await ethers.deployContract('TestBoxV1');
    const beacon = await ethers.deployContract(FQN.beacon, [await impl.getAddress(), owner.address]);

    const importedImpl = await upgrades.forceImport(await impl.getAddress(), 'TestBoxV1');
    expect(await importedImpl.version()).to.equal('v1');
    const importedBeacon = await upgrades.forceImport(await beacon.getAddress(), 'TestBoxV1');
    expect(await importedBeacon.implementation()).to.equal(await impl.getAddress());
  });

  it('rejects an address with no contract code', async () => {
    await expect(upgrades.forceImport(ethers.Wallet.createRandom().address, 'TestBoxV1')).to.be.rejectedWith(
      /no contract|does not have any code/i,
    );
  });
});
