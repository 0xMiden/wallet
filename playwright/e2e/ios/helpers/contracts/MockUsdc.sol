// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal ERC20-ish stand-in for the bridge-in deposit screen's USDC balance
/// read on a local Anvil. The screen calls `getBalance(address)` (falling back
/// to `balanceOf(address)`) via eth_call; against a bare address that returns
/// "0x" and viem's decodeFunctionResult throws, breaking the amount screen. This
/// answers both with a valid uint256 (0 by default; anvil_setCode leaves storage
/// empty) so the screen renders. `setBalance` allows funding if ever needed.
///
/// Deployed (runtime) bytecode is embedded in ../evm-doubles.ts and placed at
/// BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS via `anvil_setCode`. Regenerate after
/// editing: `forge inspect MockUsdc deployedBytecode` (optimizer on, 200 runs).
contract MockUsdc {
    mapping(address => uint256) private balances;

    function getBalance(address account) external view returns (uint256) {
        return balances[account];
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function setBalance(address account, uint256 value) external {
        balances[account] = value;
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }
}
