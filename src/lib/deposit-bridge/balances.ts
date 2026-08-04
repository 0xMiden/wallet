import { decodeFunctionResult, encodeFunctionData, formatUnits } from 'viem';

import { BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS } from 'lib/epoch/bridgeable-token';
import { DEFAULT_CHAIN_ID, getChain } from 'lib/walletconnect/config';

import type { DepositTokenId } from './tokens';

/**
 * Plain JSON-RPC balance reads for the derived deposit address. Transport is the
 * app's configured Sepolia endpoint, so the E2E Anvil override applies for free.
 * Shared by the WalletConnect deposit screen and the deposit-address watcher.
 */

const MOCK_USDC_GET_BALANCE_ABI = [
  {
    type: 'function',
    name: 'getBalance',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

interface RpcResponse {
  result?: unknown;
  error?: { message?: string };
}

function isHex(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && value.startsWith('0x');
}

function asHex(value: unknown, label: string): `0x${string}` {
  if (!isHex(value)) throw new Error(`${label} returned a non-hex result`);
  return value;
}

export async function rpcRequest(method: string, params: unknown[]): Promise<unknown> {
  const chain = getChain(DEFAULT_CHAIN_ID);
  if (!chain) {
    throw new Error('Sepolia RPC is not configured');
  }

  const response = await fetch(chain.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const payload: RpcResponse = await response.json();
  if (payload.error) {
    throw new Error(payload.error.message ?? `RPC ${method} failed`);
  }
  return payload.result;
}

export function formatBalance(value: bigint, decimals: number): string {
  const [whole = '0', rawFraction = ''] = formatUnits(value, decimals).split('.');
  const fraction = rawFraction.slice(0, 4).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * The Epoch mock-USDC faucet exposes `getBalance`; a real ERC-20 does not, so
 * the standard `balanceOf` is the fallback. Both are tried against the same
 * contract — do not drop either branch.
 */
export async function readMockUsdcBalance(evmAddress: string): Promise<bigint> {
  const account = asHex(evmAddress, 'Deposit address');
  const contract = asHex(BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS, 'USDC contract');

  try {
    const data = encodeFunctionData({
      abi: MOCK_USDC_GET_BALANCE_ABI,
      functionName: 'getBalance',
      args: [account]
    });
    const result = await rpcRequest('eth_call', [{ to: contract, data }, 'latest']);
    return decodeFunctionResult({
      abi: MOCK_USDC_GET_BALANCE_ABI,
      functionName: 'getBalance',
      data: asHex(result, 'eth_call')
    });
  } catch (err) {
    console.warn('[deposit-bridge] USDC getBalance failed, falling back to balanceOf', err);
    const data = encodeFunctionData({
      abi: ERC20_BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [account]
    });
    const result = await rpcRequest('eth_call', [{ to: contract, data }, 'latest']);
    return decodeFunctionResult({
      abi: ERC20_BALANCE_OF_ABI,
      functionName: 'balanceOf',
      data: asHex(result, 'eth_call')
    });
  }
}

export async function readEthBalance(evmAddress: string): Promise<bigint> {
  const result = await rpcRequest('eth_getBalance', [evmAddress, 'latest']);
  return BigInt(asHex(result, 'eth_getBalance'));
}

/** Latest deposit-address balances; `null` marks a token whose read failed this pass. */
export type DepositBalances = Record<DepositTokenId, bigint | null>;

export const EMPTY_DEPOSIT_BALANCES: DepositBalances = { ETH: null, USDC: null };

/**
 * Read both watched balances in one pass. A single failing token degrades to
 * `null` (the other is still usable); only a total RPC outage throws, so the
 * store can distinguish "no funds" from "cannot see funds".
 */
export async function readDepositBalances(address: string): Promise<DepositBalances> {
  const [eth, usdc] = await Promise.allSettled([readEthBalance(address), readMockUsdcBalance(address)]);
  if (eth.status === 'rejected' && usdc.status === 'rejected') {
    throw eth.reason instanceof Error ? eth.reason : new Error(String(eth.reason));
  }
  return {
    ETH: eth.status === 'fulfilled' ? eth.value : null,
    USDC: usdc.status === 'fulfilled' ? usdc.value : null
  };
}
