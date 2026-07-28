// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Stateless ERC20-ish stand-in at BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS for the
/// bridge-in harness on a local Anvil. Serves two callers:
///   - the deposit screen's USDC balance read (getBalance/balanceOf), so the
///     amount screen renders instead of throwing on an empty "0x" eth_call;
///   - the Epoch SDK's deposit path: a MAX `allowance` makes the SDK skip the
///     `approve` (single-tx deposit), and approve/transferFrom succeed so the
///     Compact stub can pull funds. Always "funded" (constant balance) so no
///     setup/funding step is needed.
///
/// Deployed (runtime) bytecode is embedded in ../evm-doubles.ts and placed via
/// `anvil_setCode`. Regenerate after editing:
/// `forge inspect MockUsdc deployedBytecode` (optimizer on, 200 runs).
contract MockUsdc {
    function getBalance(address) external pure returns (uint256) {
        return 1_000_000_000_000;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 1_000_000_000_000;
    }

    function allowance(address, address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true;
    }

    function decimals() external pure returns (uint8) {
        return 6;
    }
}
