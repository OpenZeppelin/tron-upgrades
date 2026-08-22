// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Clones} from "@openzeppelin/tron-contracts/proxy/Clones.sol";

/// Exercises deterministic (CREATE2-based) clone deployment so tests can
/// compare the library's on-chain prediction, an off-chain computation, and
/// the address where the clone actually lands.
contract CloneFactory {
    event CloneDeployed(address clone);

    function predict(address implementation, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt);
    }

    function deployClone(address implementation, bytes32 salt) external returns (address clone) {
        clone = Clones.cloneDeterministic(implementation, salt);
        emit CloneDeployed(clone);
    }
}
