import { EpochIntentSDK, TaskType, EVM_TO_MIDEN_EXTRA_TYPESTRING } from '@epoch-protocol/epoch-intents-sdk';

import { cacheScope, getNativeAssetId, getNativeAssetMetadata } from 'lib/miden-chain/native-asset';
import { getEarnMarket, getEpochAllocatorUrl } from 'lib/remote-config/values';

import { normalizeMidenIdToHex } from './bridge';
import { buildEpochReadOnlyWalletClient } from './client';
import { MIDEN_DESTINATION_CHAIN_ID } from './config';
import { isEvmAddress } from './evm-address';
import { fetchEarnPositions } from './positions';
import { withdrawalAmount, withdrawalAmountError } from './withdraw-amount';

export interface WithdrawalPosition {
  owner: string;
  marketUid: string;
  underlyingAddress: string;
  decimals: number;
  withdrawable: string;
}

/** An unsigned review snapshot, valid for at most one minute. Never persisted as execution authority. */
export interface EarnWithdrawalQuote {
  position: WithdrawalPosition;
  accountId: string;
  amount: string;
  amountAtomic: string;
  availableAtomic: string;
  scope: string;
  allocatorUrl: string;
  destinationFaucetId: string;
  destinationSymbol: string;
  destinationDecimals: number;
  expectedAtomic: string;
  minimumAtomic: string;
  expiresAt: number;
}

export async function quoteEarnWithdrawal(
  args: { position: WithdrawalPosition; amount: string; accountId: string },
  sdkOverride?: Pick<EpochIntentSDK, 'getTaskData' | 'getIntentQuote'>
): Promise<EarnWithdrawalQuote> {
  const { position, amount, accountId } = args;
  const error = withdrawalAmountError(amount, position.withdrawable, position.decimals);
  if (error) throw new Error(error);
  if (!isEvmAddress(position.owner) || !isEvmAddress(position.underlyingAddress))
    throw new Error('earnWithdrawRefresh');
  const scope = cacheScope();
  const allocatorUrl = getEpochAllocatorUrl();
  const destinationFaucetId = await getNativeAssetId();
  const metadata = await getNativeAssetMetadata();
  if (
    !metadata ||
    metadata.scaleIsUnknown ||
    !metadata.symbol ||
    !Number.isInteger(metadata.decimals) ||
    metadata.decimals < 0 ||
    metadata.decimals > 12
  )
    throw new Error('earnWithdrawQuoteUnavailable');
  const amountAtomic = withdrawalAmount(amount, position.decimals);
  const availableAtomic = withdrawalAmount(position.withdrawable, position.decimals);
  if (amountAtomic === null || availableAtomic === null) throw new Error('earnWithdrawRefresh');
  const chainId = Number(position.marketUid.split(':')[1]);
  const sdk =
    sdkOverride ??
    new EpochIntentSDK({
      apiBaseUrl: allocatorUrl,
      walletClient: buildEpochReadOnlyWalletClient(position.owner, { chainOverride: chainId })
    });
  const task = await sdk.getTaskData({
    taskType: TaskType.GetTokenOut,
    intentData: {
      isNative: false,
      depositTokenAddress: position.underlyingAddress,
      tokenInAmount: amountAtomic.toString(),
      outputTokenAddress: '0x0000000000000000000000000000000000000000',
      minTokenOut: '0',
      destinationChainId: String(MIDEN_DESTINATION_CHAIN_ID),
      protocolHashIdentifier: `0x${'0'.repeat(64)}`,
      recipient: position.owner
    },
    extraDataTypestring: EVM_TO_MIDEN_EXTRA_TYPESTRING,
    extraData: {
      midenRecipientAccount: normalizeMidenIdToHex(accountId),
      midenFaucetId: normalizeMidenIdToHex(destinationFaucetId)
    }
  });
  const quote = await sdk.getIntentQuote({ sponsorAddress: position.owner, ...task, isNative: false });
  if (
    !quote.success ||
    !quote.tokenOut ||
    !/^\d+$/.test(quote.tokenOut) ||
    (quote.tokenIn !== undefined && quote.tokenIn !== amountAtomic.toString()) ||
    (quote.tokenInDecimals !== undefined && quote.tokenInDecimals !== position.decimals)
  )
    throw new Error('earnWithdrawQuoteUnavailable');
  // Same 1% floor as Epoch 1.0.39's withdraw helper. Tiny routes with a zero floor cannot be authorized.
  const minimum = (BigInt(quote.tokenOut) * 99n) / 100n;
  if (minimum <= 0n || scope !== cacheScope()) throw new Error('earnWithdrawQuoteUnavailable');
  return {
    position: { ...position },
    accountId,
    amount,
    amountAtomic: amountAtomic.toString(),
    availableAtomic: availableAtomic.toString(),
    scope,
    allocatorUrl,
    destinationFaucetId,
    destinationSymbol: metadata.symbol,
    destinationDecimals: metadata.decimals,
    expectedAtomic: quote.tokenOut,
    minimumAtomic: minimum.toString(),
    expiresAt: Date.now() + 60_000
  };
}

/** Fresh read before any signing; a changed balance requires another review even when still sufficient. */
export async function assertWithdrawalReviewCurrent(quote: EarnWithdrawalQuote): Promise<void> {
  const fail = () => {
    throw new Error('earnWithdrawRefresh');
  };
  if (
    Date.now() >= quote.expiresAt ||
    quote.scope !== cacheScope() ||
    quote.allocatorUrl !== getEpochAllocatorUrl() ||
    quote.position.marketUid.toLowerCase() !== getEarnMarket().marketUid.toLowerCase()
  )
    fail();
  if (normalizeMidenIdToHex(await getNativeAssetId()) !== normalizeMidenIdToHex(quote.destinationFaucetId)) fail();
  const fresh = await fetchEarnPositions({ accountId: quote.accountId, owners: [quote.position.owner] });
  const position = fresh.positions.find(
    p =>
      p.owner.toLowerCase() === quote.position.owner.toLowerCase() &&
      p.marketUid.toLowerCase() === quote.position.marketUid.toLowerCase()
  );
  if (
    fresh.errors.length ||
    !position ||
    position.decimals !== quote.position.decimals ||
    position.underlyingAddress.toLowerCase() !== quote.position.underlyingAddress.toLowerCase() ||
    withdrawalAmount(position.withdrawable, position.decimals)?.toString() !== quote.availableAtomic ||
    Date.now() >= quote.expiresAt ||
    quote.scope !== cacheScope() ||
    quote.allocatorUrl !== getEpochAllocatorUrl() ||
    quote.position.marketUid.toLowerCase() !== getEarnMarket().marketUid.toLowerCase()
  )
    fail();
}

/** The execution helper requotes. Refuse any different input or worse floor instead of silently changing review. */
export function assertWithdrawalDelivery(
  quote: EarnWithdrawalQuote,
  mandate: { tokenIn: string; tokenInAmount: string; minTokenOut: string }
): void {
  if (
    mandate.tokenIn.toLowerCase() !== quote.position.underlyingAddress.toLowerCase() ||
    mandate.tokenInAmount !== quote.amountAtomic ||
    !/^\d+$/.test(mandate.minTokenOut) ||
    BigInt(mandate.minTokenOut) < BigInt(quote.minimumAtomic)
  )
    throw new Error('earnWithdrawRefresh');
}
