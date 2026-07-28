// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// Minimal stand-in for "The Compact" at 0x00..9788, for the Epoch USDC
/// bridge-in deposit on a local Anvil. Implements only what the Epoch SDK calls
/// on the resource-lock deposit path:
///   - getForcedWithdrawalStatus -> (0=Disabled, 0): solveIntent REQUIRES the
///     "Disabled" status (enum index 0) before it will deposit.
///   - depositERC20AndRegister: the real selector (0x3ddf7400) + signature. It
///     asserts the expected token (so a wrong-token deposit reverts, not
///     green-on-any-calldata), pulls the token via transferFrom, and counts the
///     deposit. The returned id is not read by the SDK's send path.
///
/// Deployed (runtime) bytecode is embedded in ../evm-doubles.ts and placed at
/// COMPACT_ADDRESS via `anvil_setCode`. Regenerate after editing:
/// `forge inspect MockCompact deployedBytecode` (optimizer on, 200 runs).
contract MockCompact {
    address constant EXPECTED_TOKEN = 0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69;

    uint256 public depositCount;
    event Deposited(address indexed token, uint256 amount, bytes12 lockTag);

    function getForcedWithdrawalStatus(address, uint256) external pure returns (uint8, uint256) {
        return (0, 0);
    }

    function depositERC20AndRegister(
        address token,
        bytes12 lockTag,
        uint256 amount,
        bytes32,
        bytes32
    ) external returns (uint256) {
        require(token == EXPECTED_TOKEN, "MockCompact: unexpected token");
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "MockCompact: transferFrom failed");
        emit Deposited(token, amount, lockTag);
        depositCount += 1;
        return depositCount;
    }
}
