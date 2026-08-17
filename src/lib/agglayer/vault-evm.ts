import { http, type Hash, type PublicClient, type WalletClient, createPublicClient } from 'viem';
import { sepolia } from 'viem/chains';

import { buildVaultEvmWalletClient } from 'lib/epoch/evm-account';

import { AGGLAYER_BRIDGE_ABI, AGGLAYER_CONTRACT_ADDRESS, MIDEN_CHAIN_ID, SEPOLIA_RPC_URL } from './constant';
import { midenAddrToEvmAddr } from './contract';

/**
 * Vault-signed AggLayer + ERC-20 operations on Sepolia, built on
 * `buildVaultEvmWalletClient` (no external wallet, no WalletConnect). Used by
 * the fiat-ramp automation: the buy watcher approves + `bridgeAsset`s the
 * MoonPay-delivered USDC to Miden. The WalletConnect-based `contract.ts`
 * siblings stay for the user-driven bridge screens.
 * (Restored from the pre-Onramper fiat-ramp integration, minus the off-ramp
 * claim path.)
 */

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }]
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

function isHexAddress(value: string): value is `0x${string}` {
  return value.startsWith('0x');
}

export function getAgglayerBridgeAddress(): `0x${string}` {
  const address = AGGLAYER_CONTRACT_ADDRESS.get('sepolia');
  if (!address || !isHexAddress(address)) {
    throw new Error('AggLayer bridge address is not configured for sepolia');
  }
  return address;
}

// Same E2E override rule as `buildVaultEvmWalletClient`: reads must hit the
// hermetic Anvil node when the e2e build bakes E2E_EVM_RPC_URL; inert otherwise.
function sepoliaRpcUrl(): string {
  const e2eRpc = process.env.MIDEN_E2E_TEST === 'true' ? (process.env.E2E_EVM_RPC_URL ?? '').trim() : '';
  return e2eRpc || SEPOLIA_RPC_URL;
}

let cachedPublicClient: PublicClient | undefined;

export function getSepoliaPublicClient(): PublicClient {
  if (!cachedPublicClient) {
    cachedPublicClient = createPublicClient({ chain: sepolia, transport: http(sepoliaRpcUrl()) });
  }
  return cachedPublicClient;
}

export async function readEthBalance(owner: `0x${string}`): Promise<bigint> {
  return getSepoliaPublicClient().getBalance({ address: owner });
}

export async function readErc20Balance(token: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
  return getSepoliaPublicClient().readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [owner]
  });
}

export async function readErc20Decimals(token: `0x${string}`): Promise<number> {
  return getSepoliaPublicClient().readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' });
}

export async function readErc20Allowance(
  token: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`
): Promise<bigint> {
  return getSepoliaPublicClient().readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner, spender]
  });
}

export async function waitForReceiptSuccess(hash: Hash): Promise<void> {
  const receipt = await getSepoliaPublicClient().waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error(`Sepolia transaction ${hash} reverted`);
}

function requireAccount(walletClient: WalletClient): NonNullable<WalletClient['account']> {
  if (!walletClient.account) throw new Error('Vault EVM wallet client has no account');
  return walletClient.account;
}

/** Vault-signed viem client for the account's derived EVM identity. */
export function getVaultWalletClient(midenAccountPublicKey: string, evmAddress: `0x${string}`): WalletClient {
  return buildVaultEvmWalletClient(midenAccountPublicKey, evmAddress);
}

/** `approve(spender, amount)` — returns once broadcast. */
export async function approveErc20(args: {
  walletClient: WalletClient;
  token: `0x${string}`;
  spender: `0x${string}`;
  amount: bigint;
}): Promise<Hash> {
  return args.walletClient.writeContract({
    chain: sepolia,
    account: requireAccount(args.walletClient),
    address: args.token,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [args.spender, args.amount]
  });
}

/**
 * `bridgeAsset` of an ERC-20 to the Miden AggLayer network (chain id 78),
 * addressed to the Miden account packed into EVM-address form. The token must
 * already be approved to the bridge. Returns once broadcast; delivery is
 * tracked via the bridge indexer + note auto-consume.
 */
export async function bridgeErc20ToMiden(args: {
  walletClient: WalletClient;
  toMidenAddress: string; // bech32
  token: `0x${string}`;
  amount: bigint;
}): Promise<Hash> {
  return args.walletClient.writeContract({
    chain: sepolia,
    account: requireAccount(args.walletClient),
    address: getAgglayerBridgeAddress(),
    abi: AGGLAYER_BRIDGE_ABI,
    functionName: 'bridgeAsset',
    args: [MIDEN_CHAIN_ID, midenAddrToEvmAddr(args.toMidenAddress), args.amount, args.token, true, '0x']
  });
}
