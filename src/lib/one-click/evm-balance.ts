import { createPublicClient, http } from 'viem';
import type { Address, Chain } from 'viem';
import { publicActionsL2 } from 'viem/op-stack';

import { EVM_CHAIN_DEFINITIONS, getChain } from 'lib/walletconnect/config';

import { ONE_CLICK_EVM_CHAIN_IDS } from './client';
import { buildEvmOneClickTransaction } from './evm-transfer';
import type { OneClickAsset } from './types';

const RPC_TIMEOUT_MS = 8_000;
const RESERVE_MULTIPLIER = 2n;
const L2_CHAINS = new Set([8453, 10]);
const NATIVE_TRANSFER_GAS_FALLBACK = 21_000n;
const ERC20_TRANSFER_GAS_FALLBACK = 100_000n;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;

export interface OneClickEvmBalanceInput {
  asset: OneClickAsset;
  account: string;
  depositAddress?: string;
  amountIn?: string;
  transaction?: Record<string, string>;
}

export interface OneClickEvmBalanceSnapshot {
  chainId: number;
  account: string;
  assetId: string;
  tokenBalance: bigint;
  nativeBalance: bigint;
  gasReserve: bigint;
  spendableTokenBalance: bigint;
  spendableNativeBalance: bigint;
  requiredTokenAmount?: bigint;
  tokenSufficient: boolean;
  gasSufficient?: boolean;
  gasCheckComplete: boolean;
  canDeposit: boolean;
  estimatedGas: bigint;
  maxFeePerGas: bigint;
  updatedAt: number;
}

interface EvmReadClient {
  getBlockNumber(): Promise<bigint>;
  getBalance(input: { address: Address; blockNumber: bigint }): Promise<bigint>;
  readContract(input: {
    address: Address;
    abi: typeof ERC20_BALANCE_ABI;
    functionName: 'balanceOf';
    args: [Address];
    blockNumber: bigint;
  }): Promise<bigint>;
  estimateGas(input: {
    account: Address;
    to: Address;
    value?: bigint;
    data?: `0x${string}`;
    chainId: number;
  }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; gasPrice?: bigint }>;
  estimateL1Fee?(input: { account: Address; to: Address; value?: bigint; data?: `0x${string}` }): Promise<bigint>;
}

export interface OneClickEvmBalanceDependencies {
  getChain: typeof getChain;
  getEvmReadClient(chain: Chain, rpcUrl: string): EvmReadClient;
  now(): number;
}

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

const defaultDependencies: OneClickEvmBalanceDependencies = {
  getChain,
  getEvmReadClient: (chain, rpcUrl) =>
    createPublicClient({
      chain,
      transport: http(rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 0 })
    }).extend(publicActionsL2()),
  now: Date.now
};

export async function readOneClickEvmBalance(
  input: OneClickEvmBalanceInput,
  dependencies: OneClickEvmBalanceDependencies = defaultDependencies
): Promise<OneClickEvmBalanceSnapshot> {
  const chainId = ONE_CLICK_EVM_CHAIN_IDS[input.asset.blockchain];
  if (!chainId || input.asset.chainId !== chainId) throw new Error('Unsupported EVM network for this asset');
  if (!isEvmAddress(input.account)) throw new Error('Invalid connected EVM account address');
  if (
    !input.asset.assetId ||
    !Number.isInteger(input.asset.decimals) ||
    input.asset.decimals < 0 ||
    input.asset.decimals > 38
  ) {
    throw new Error('Invalid EVM asset identity');
  }
  const amountIn = input.amountIn;
  if (amountIn !== undefined && (!/^[0-9]{1,78}$/.test(amountIn) || BigInt(amountIn) <= 0n))
    throw new Error('Invalid quoted amount');
  const network = dependencies.getChain(chainId);
  const chain = EVM_CHAIN_DEFINITIONS.find(candidate => candidate.id === chainId);
  if (!network?.rpcUrl || !chain) throw new Error('Unsupported EVM network');

  const client = dependencies.getEvmReadClient(chain, network.rpcUrl);
  const account = input.account;
  const blockNumber = await client.getBlockNumber();
  const isNative = input.asset.contractAddress === 'native';
  const contractAddress = input.asset.contractAddress;
  let nativeBalance: bigint;
  let tokenBalance: bigint;
  if (isNative) {
    nativeBalance = await client.getBalance({ address: account, blockNumber });
    tokenBalance = nativeBalance;
  } else {
    if (!isEvmAddress(contractAddress)) throw new Error('EVM asset has no verified token contract');
    [nativeBalance, tokenBalance] = await Promise.all([
      client.getBalance({ address: account, blockNumber }),
      client.readContract({
        address: contractAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [account],
        blockNumber
      })
    ]);
  }

  let estimatedGas = 0n;
  let maxFeePerGas = 0n;
  let gasReserve = 0n;
  let gasSufficient: boolean | undefined;
  let gasCheckComplete = false;
  if (input.transaction) {
    const request = transactionForEstimate(input.transaction, chainId, account);
    const rawBalance = isNative ? nativeBalance : tokenBalance;
    const knownTokenShortfall = amountIn !== undefined && rawBalance < BigInt(amountIn);
    const gasFallback = isNative ? NATIVE_TRANSFER_GAS_FALLBACK : ERC20_TRANSFER_GAS_FALLBACK;
    const fees = await client.estimateFeesPerGas();
    maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    if (maxFeePerGas <= 0n) throw new Error('EVM network did not provide a gas fee estimate');
    let l1Fee = 0n;
    if (L2_CHAINS.has(chainId)) {
      if (!client.estimateL1Fee) throw new Error('EVM network did not provide an L1 fee estimator');
      l1Fee = await client.estimateL1Fee(request);
      if (l1Fee < 0n) throw new Error('EVM network returned an invalid L1 fee estimate');
    }
    const fallbackReserve = (gasFallback * maxFeePerGas + l1Fee) * RESERVE_MULTIPLIER;
    const knownGasShortfall = nativeBalance < fallbackReserve;
    const knownNativeTokenShortfall =
      isNative &&
      amountIn !== undefined &&
      (nativeBalance <= fallbackReserve || nativeBalance - fallbackReserve < BigInt(amountIn));
    if (knownTokenShortfall || knownGasShortfall || knownNativeTokenShortfall) {
      estimatedGas = gasFallback;
      gasReserve = fallbackReserve;
      gasSufficient = nativeBalance >= gasReserve;
      gasCheckComplete = true;
    } else {
      estimatedGas = await client.estimateGas(request);
      gasReserve = (estimatedGas * maxFeePerGas + l1Fee) * RESERVE_MULTIPLIER;
      gasSufficient = nativeBalance >= gasReserve;
      gasCheckComplete = true;
    }
  }

  const spendableNativeBalance = nativeBalance > gasReserve ? nativeBalance - gasReserve : 0n;
  const spendableTokenBalance = isNative ? spendableNativeBalance : tokenBalance;
  const requiredTokenAmount = amountIn === undefined ? undefined : BigInt(amountIn);
  const tokenSufficient = requiredTokenAmount === undefined || spendableTokenBalance >= requiredTokenAmount;
  const fullyFunded = requiredTokenAmount !== undefined && tokenSufficient && gasSufficient === true;
  return {
    chainId,
    account: account.toLowerCase(),
    assetId: input.asset.assetId,
    tokenBalance,
    nativeBalance,
    gasReserve,
    spendableTokenBalance,
    spendableNativeBalance,
    requiredTokenAmount,
    tokenSufficient,
    gasSufficient,
    gasCheckComplete,
    canDeposit: fullyFunded,
    estimatedGas,
    maxFeePerGas,
    updatedAt: dependencies.now()
  };
}

export async function assertOneClickEvmDepositFunded(input: {
  asset: OneClickAsset;
  account: string;
  depositAddress: string;
  amountIn: string;
}): Promise<OneClickEvmBalanceSnapshot> {
  const transaction = buildEvmOneClickTransaction(input.asset, input.depositAddress, input.amountIn, input.account);
  const snapshot = await readOneClickEvmBalance({ ...input, transaction });
  if (!snapshot.canDeposit) {
    const reason = snapshot.gasSufficient
      ? 'deposit token balance is insufficient'
      : 'native balance is insufficient for gas';
    throw new Error(`EVM deposit funding check failed: ${reason}`);
  }
  return snapshot;
}

function transactionForEstimate(transaction: Record<string, string>, chainId: number, account: Address) {
  if (
    transaction.chainId !== `0x${chainId.toString(16)}` ||
    transaction.from?.toLowerCase() !== account.toLowerCase() ||
    !isEvmAddress(transaction.to)
  )
    throw new Error('Invalid EVM deposit transaction');
  const value = transaction.value === undefined ? undefined : parseTransactionValue(transaction.value);
  const data = transaction.data;
  if (data !== undefined && !isHexData(data)) throw new Error('Invalid EVM deposit calldata');
  return {
    account,
    to: transaction.to,
    ...(value === undefined ? {} : { value }),
    ...(data ? { data } : {}),
    chainId
  };
}

function isEvmAddress(value: unknown): value is Address {
  return typeof value === 'string' && EVM_ADDRESS.test(value);
}

function isHexData(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && HEX_DATA.test(value);
}

function parseTransactionValue(value: string): bigint {
  if (!/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) throw new Error('Invalid EVM transaction value');
  return BigInt(value);
}
