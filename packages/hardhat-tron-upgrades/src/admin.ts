import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  ADMIN_SLOT,
  type AddressLike,
  FQN,
  type TransferProxyAdminOwnershipOptions,
  ZERO_ADDRESS,
  ethersOf,
  getSlot,
  resolveAddress,
  slotToAddress,
  txOverridesOf,
} from './utils';

export function makeTransferProxyAdminOwnership(hre: HardhatRuntimeEnvironment) {
  return async function transferProxyAdminOwnership(
    proxy: AddressLike,
    newOwner: string,
    opts: TransferProxyAdminOwnershipOptions = {},
  ): Promise<void> {
    const ethers = ethersOf(hre);
    const txOverrides = txOverridesOf(opts);
    const proxyAddress = await resolveAddress(proxy);
    const adminAddress = slotToAddress(await getSlot(hre, proxyAddress, ADMIN_SLOT));
    if (adminAddress === ZERO_ADDRESS) {
      throw new Error(`Proxy ${proxyAddress} has no admin slot and is not a transparent proxy`);
    }
    let admin = await ethers.getContractAt(FQN.proxyAdmin, ethers.getAddress(adminAddress));
    if (opts.owner) admin = admin.connect(opts.owner);
    await (txOverrides
      ? admin.transferOwnership(newOwner, txOverrides)
      : admin.transferOwnership(newOwner));
    const actualOwner = await admin.owner();
    if (actualOwner.toLowerCase() !== newOwner.toLowerCase()) {
      throw new Error(
        `ProxyAdmin ownership transfer succeeded but owner is ${actualOwner}, expected ${newOwner}`,
      );
    }
  };
}
