import { toHex } from 'viem';
import type { EIP1193Provider } from 'viem';

import { assertOneClickQuoteBinding, ONE_CLICK_EVM_CHAIN_IDS } from './client';
import { assertOneClickEvmDepositFunded } from './evm-balance';
import { buildEvmOneClickTransaction } from './evm-transfer';
import type { OneClickConfig, OneClickQuoteRequest, OneClickQuoteResponse } from './types';

export { buildEvmOneClickTransaction } from './evm-transfer';
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isEvmAddress = (value: unknown): value is `0x${string}` => typeof value === 'string' && EVM_ADDRESS.test(value);
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export interface EvmOneClickDepositInput {
  provider: EIP1193Provider;
  account: string;
  request: OneClickQuoteRequest;
  quote: OneClickQuoteResponse;
  config: OneClickConfig;
  onSubmitted?: (transactionHash: string) => Promise<void>;
}

export class OneClickDepositBroadcastError extends Error {
  readonly transactionHash: string;
  readonly cause: unknown;

  constructor(transactionHash: string, cause: unknown) {
    super('The EVM transaction was broadcast, but its submission could not be fully recorded');
    this.name = 'OneClickDepositBroadcastError';
    this.transactionHash = transactionHash;
    this.cause = cause;
  }
}

export async function submitEvmOneClickDeposit({
  provider,
  account,
  request,
  quote,
  config,
  onSubmitted
}: EvmOneClickDepositInput): Promise<string> {
  assertOneClickQuoteBinding(request, quote, false, config);
  const asset = request.originAsset;
  const chainId = ONE_CLICK_EVM_CHAIN_IDS[asset.blockchain];
  const depositAddress = quote.quote.depositAddress;
  if (
    !chainId ||
    asset.chainId !== chainId ||
    !EVM_ADDRESS.test(account) ||
    !depositAddress ||
    !EVM_ADDRESS.test(depositAddress)
  ) {
    throw new Error('Unsupported EVM deposit route');
  }
  if (
    !isEvmAddress(quote.quoteRequest.refundTo) ||
    account.toLowerCase() !== quote.quoteRequest.refundTo.toLowerCase()
  ) {
    throw new Error('The sending account must match the signed refund account');
  }
  if (asset.contractAddress !== 'native' && (!asset.contractAddress || !EVM_ADDRESS.test(asset.contractAddress))) {
    throw new Error('The origin asset has no verified transfer method');
  }
  assertNotExpired(quote);
  let currentChain = parseChainId(await provider.request({ method: 'eth_chainId' }));
  if (currentChain !== chainId) {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(chainId) }] });
    currentChain = parseChainId(await provider.request({ method: 'eth_chainId' }));
  }
  if (currentChain !== chainId) throw new Error('EVM wallet is on the wrong network');
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (
    !Array.isArray(accounts) ||
    !accounts.some(candidate => typeof candidate === 'string' && candidate.toLowerCase() === account.toLowerCase())
  ) {
    throw new Error('Connected EVM account changed');
  }
  assertNotExpired(quote);
  const transaction = buildEvmOneClickTransaction(asset, depositAddress, quote.quote.amountIn, account);
  await assertOneClickEvmDepositFunded({ asset, account, depositAddress, amountIn: quote.quote.amountIn });
  const confirmedChain = parseChainId(await provider.request({ method: 'eth_chainId' }));
  const confirmedAccounts = await provider.request({ method: 'eth_accounts' });
  if (
    confirmedChain !== chainId ||
    !Array.isArray(confirmedAccounts) ||
    !confirmedAccounts.some(
      candidate => typeof candidate === 'string' && candidate.toLowerCase() === account.toLowerCase()
    )
  ) {
    throw new Error('Connected EVM wallet changed during balance verification');
  }
  assertNotExpired(quote);
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [transaction] });
  if (typeof hash !== 'string' || !TX_HASH.test(hash))
    throw new Error('EVM wallet returned an invalid transaction hash');
  try {
    if (onSubmitted) await onSubmitted(hash);
    assertNotExpired(quote);
  } catch (error) {
    throw new OneClickDepositBroadcastError(hash, error);
  }
  return hash;
}

function assertNotExpired(quote: OneClickQuoteResponse): void {
  if (
    !quote.quote.deadline ||
    !Number.isFinite(Date.parse(quote.quote.deadline)) ||
    Date.parse(quote.quote.deadline) <= Date.now()
  ) {
    throw new Error('The 1Click deposit quote has expired');
  }
}

function parseChainId(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value))
    throw new Error('EVM wallet returned an invalid chain id');
  const chainId = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(chainId)) throw new Error('EVM wallet returned an invalid chain id');
  return chainId;
}
