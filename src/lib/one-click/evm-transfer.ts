import { encodeFunctionData, toHex } from 'viem';
import type { Address } from 'viem';

import { ONE_CLICK_EVM_CHAIN_IDS } from './client';
import type { OneClickQuoteRequest } from './types';

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  }
] as const;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function buildEvmOneClickTransaction(
  asset: OneClickQuoteRequest['originAsset'],
  depositAddress: string,
  amountIn: string,
  account: string
): Record<string, string> {
  const chainId = ONE_CLICK_EVM_CHAIN_IDS[asset.blockchain];
  if (!chainId || asset.chainId !== chainId || !isEvmAddress(depositAddress) || !isEvmAddress(account)) {
    throw new Error('Unsupported EVM deposit route');
  }
  if (!/^[0-9]{1,78}$/.test(amountIn) || BigInt(amountIn) <= 0n) throw new Error('Invalid quoted deposit amount');
  const amount = BigInt(amountIn);
  if (asset.contractAddress === 'native')
    return { from: account, to: depositAddress, value: toHex(amount), chainId: toHex(chainId) };
  if (!isEvmAddress(asset.contractAddress)) {
    throw new Error('The origin asset has no verified transfer method');
  }
  return {
    from: account,
    to: asset.contractAddress,
    chainId: toHex(chainId),
    data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [depositAddress, amount] })
  };
}

function isEvmAddress(value: unknown): value is Address {
  return typeof value === 'string' && EVM_ADDRESS.test(value);
}
