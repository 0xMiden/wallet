import { encodeFunctionData, parseAbi, type Address } from 'viem';

import type { BatchCall } from './calibur.js';
import { ERC20_ABI } from './erc20.js';
import { MIDEN_ACCOUNT_HEX_PATTERN } from '../miden-account.js';

/**
 * The Agglayer bridge from Sepolia to Miden testnet. This is testnet code only: mainnet does not bridge through
 * Agglayer. The wallet twin of the calls is in `src/lib/onramp/buy-batch.ts`.
 */

// The Agglayer bridge on Sepolia and the Agglayer network ID of Miden testnet (not an EVM chain ID).
export const AGGLAYER_BRIDGE_ADDRESS: Address = '0x1348947e282138d8f377b467f7d9c2eb0f335d1f';
export const MIDEN_AGGLAYER_NETWORK_ID = 86;

export const BRIDGE_ASSET_ABI = parseAbi([
  'function bridgeAsset(uint32 destinationNetwork, address destinationAddress, uint256 amount, address token, bool forceUpdateGlobalExitRoot, bytes permitData) payable'
]);

/**
 * The Agglayer destination address of a Miden account:
 * 4 zero bytes, the 15-byte account ID, 1 zero byte. Lower case.
 */
export function midenAccountHexToEvmAddress(midenAccountHex: string): Address {
  if (!MIDEN_ACCOUNT_HEX_PATTERN.test(midenAccountHex)) {
    throw new Error('midenAccountHex is not a 15-byte hex account ID');
  }
  return `0x${'00'.repeat(4)}${midenAccountHex.slice(2).toLowerCase()}00`;
}

/** Approve the Agglayer bridge, then bridge the token to the Miden account. */
export function agglayerBridgeCalls(token: Address, amount: bigint, midenAccountHex: string): BatchCall[] {
  return [
    {
      to: token,
      value: 0n,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [AGGLAYER_BRIDGE_ADDRESS, amount]
      })
    },
    {
      to: AGGLAYER_BRIDGE_ADDRESS,
      value: 0n,
      data: encodeFunctionData({
        abi: BRIDGE_ASSET_ABI,
        functionName: 'bridgeAsset',
        args: [MIDEN_AGGLAYER_NETWORK_ID, midenAccountHexToEvmAddress(midenAccountHex), amount, token, true, '0x']
      })
    }
  ];
}
