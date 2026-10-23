import { toHex } from 'viem';
import type { EIP1193Provider } from 'viem';

import { assertOneClickQuoteBinding } from './client';
import { assertOneClickFundingDeadline } from './deadline';
import { assertOneClickEvmDepositFunded } from './evm-balance';
import { buildEvmOneClickTransaction } from './evm-transfer';
import { assertOneClickAssetIdentity, ONE_CLICK_EVM_CHAIN_IDS, parseOneClickEvmAssets } from './identity';
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
  onAttempting?: () => Promise<void>;
  assertCurrentWallet?: () => void;
  onSubmitted?: (transactionHash: string) => Promise<void>;
}

export class OneClickDepositPreflightError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'The EVM deposit failed before the wallet request began');
    this.name = 'OneClickDepositPreflightError';
    this.cause = cause;
  }
}

export class OneClickDepositAmbiguousError extends Error {
  readonly outcome = 'ambiguous';
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('The EVM wallet request began, but its transaction outcome is unknown');
    this.name = 'OneClickDepositAmbiguousError';
    this.cause = cause;
  }
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
  onAttempting,
  assertCurrentWallet,
  onSubmitted
}: EvmOneClickDepositInput): Promise<string> {
  const asset = request.originAsset;
  const chainId = ONE_CLICK_EVM_CHAIN_IDS[asset.blockchain];
  const depositAddress = quote.quote.depositAddress;
  let transaction: ReturnType<typeof buildEvmOneClickTransaction>;
  try {
    assertOneClickAssetIdentity(asset, parseOneClickEvmAssets(config.evmAssets));
    assertOneClickQuoteBinding(request, quote, false, config);
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
    assertNotExpired(request, quote);
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
    assertNotExpired(request, quote);
    transaction = buildEvmOneClickTransaction(asset, depositAddress, quote.quote.amountIn, account);
    await assertOneClickEvmDepositFunded({ asset, account, depositAddress, amountIn: quote.quote.amountIn });
    if (onAttempting) await onAttempting();
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
    assertNotExpired(request, quote);
    assertCurrentWallet?.();
  } catch (error) {
    throw new OneClickDepositPreflightError(error);
  }

  let hash: string;
  try {
    const result = await provider.request({ method: 'eth_sendTransaction', params: [transaction] });
    if (typeof result !== 'string' || !TX_HASH.test(result))
      throw new Error('EVM wallet returned an invalid transaction hash');
    hash = result;
  } catch (error) {
    throw new OneClickDepositAmbiguousError(error);
  }
  try {
    if (onSubmitted) await onSubmitted(hash);
    assertNotExpired(request, quote);
  } catch (error) {
    throw new OneClickDepositBroadcastError(hash, error);
  }
  return hash;
}

function assertNotExpired(request: OneClickQuoteRequest, quote: OneClickQuoteResponse): void {
  assertOneClickFundingDeadline(request.deadline, quote.quote.deadline);
}

function parseChainId(value: unknown): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value > 0) return value;
    throw new Error('EVM wallet returned an invalid chain id');
  }
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error('EVM wallet returned an invalid chain id');
  }
  const chainId = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(chainId)) throw new Error('EVM wallet returned an invalid chain id');
  return chainId;
}
