// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal stand-in for the AggLayer (PolygonZkEVM) unified bridge, used ONLY by
/// the wallet's bridge-in e2e harness on a local Anvil. Implements the real
/// `bridgeAsset` selector (0xcd586579) + signature and the native-ETH
/// `msg.value == amount` invariant, so a wrong-value / wrong-calldata deposit
/// REVERTS on-chain (the app then marks the row failed) instead of passing green
/// against dead code. Emits a BridgeEvent mirroring the real contract for
/// optional log assertions.
///
/// The deployed (runtime) bytecode is embedded in ../evm-doubles.ts and placed
/// at AGGLAYER_CONTRACT_ADDRESS('sepolia') via `anvil_setCode`. To regenerate
/// after editing: `forge inspect MockAggLayerBridge deployedBytecode`
/// (optimizer on, 200 runs).
contract MockAggLayerBridge {
    event BridgeEvent(
        uint8 leafType,
        uint32 originNetwork,
        address originTokenAddress,
        uint32 destinationNetwork,
        address destinationAddress,
        uint256 amount,
        bytes metadata,
        uint32 depositCount
    );

    uint32 public depositCount;

    function bridgeAsset(
        uint32 destinationNetwork,
        address destinationAddress,
        uint256 amount,
        address token,
        bool,
        bytes calldata
    ) external payable {
        if (token == address(0)) {
            require(msg.value == amount, "MockAggLayerBridge: value != amount");
        }
        emit BridgeEvent(0, 0, token, destinationNetwork, destinationAddress, amount, "", depositCount);
        depositCount += 1;
    }
}
