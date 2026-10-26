// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Stateless ERC20-ish stand-in for the Sepolia USDC the served config document
/// names, for the bridge and Earn harnesses on a local Anvil. Serves:
///   - the deposit screen's USDC balance read (getBalance/balanceOf), so the
///     amount screen renders instead of throwing on an empty "0x" eth_call;
///   - the Epoch SDK's deposit path: a MAX `allowance` makes the SDK skip the
///     `approve` (single-tx deposit), and approve/transferFrom succeed so the
///     Compact stub can pull funds. Always "funded" (constant balance) so no
///     setup/funding step is needed;
///   - the wallet's config derivation: `symbol()` and `decimals()` answer what
///     the Sepolia token at that address answers (USDC, 18).
///
/// Deployed (runtime) bytecode is embedded in ../evm-doubles.ts and placed via
/// `anvil_setCode`. To regenerate after editing, copy this file into an empty
/// directory and run there:
/// `forge inspect --root . --contracts . --use 0.8.35 --optimize --optimizer-runs 200 MockUsdc deployedBytecode`
contract MockUsdc {
    function getBalance(address) external pure returns (uint256) {
        return 1_000_000 ether;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 1_000_000 ether;
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

    function symbol() external pure returns (string memory) {
        return "USDC";
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }
}
