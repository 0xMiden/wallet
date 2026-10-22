import { EpochIntentSDK, TaskType, EVM_TO_MIDEN_EXTRA_TYPESTRING } from '@epoch-protocol/epoch-intents-sdk';

import {
  cacheScope,
  captureNativeAssetSnapshot,
  getNativeAssetId,
  getNativeAssetMetadata
} from 'lib/miden-chain/native-asset';
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
  nativeRevision: number;
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
  const nativeSnapshot = captureNativeAssetSnapshot();
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
  const currentNative = captureNativeAssetSnapshot();
  if (
    minimum <= 0n ||
    scope !== currentNative.scope ||
    nativeSnapshot.revision !== currentNative.revision ||
    allocatorUrl !== getEpochAllocatorUrl()
  )
    throw new Error('earnWithdrawQuoteUnavailable');
  return {
    position: { ...position },
    accountId,
    amount,
    amountAtomic: amountAtomic.toString(),
    availableAtomic: availableAtomic.toString(),
    scope,
    nativeRevision: nativeSnapshot.revision,
    allocatorUrl,
    destinationFaucetId,
    destinationSymbol: metadata.symbol,
    destinationDecimals: metadata.decimals,
    expectedAtomic: quote.tokenOut,
    minimumAtomic: minimum.toString(),
    expiresAt: Date.now() + 60_000
  };
}

/**
 * Synchronous guard used immediately before every vault signing request. The position can be in any catalogue vault,
 * so the guard checks only that its market uid names the Earn route's chain (the default market's chain).
 */
export function assertWithdrawalReviewContext(quote: EarnWithdrawalQuote): void {
  const currentNative = captureNativeAssetSnapshot();
  if (
    Date.now() >= quote.expiresAt ||
    quote.scope !== currentNative.scope ||
    quote.nativeRevision !== currentNative.revision ||
    quote.allocatorUrl !== getEpochAllocatorUrl() ||
    quote.position.marketUid.split(':')[1] !== String(getEarnMarket().chainId)
  )
    throw new Error('earnWithdrawRefresh');
}

/** Fresh read before any signing; the balance may have moved, as long as it still covers the reviewed amount. */
export async function assertWithdrawalReviewCurrent(quote: EarnWithdrawalQuote): Promise<void> {
  assertWithdrawalReviewContext(quote);
  if (normalizeMidenIdToHex(await getNativeAssetId()) !== normalizeMidenIdToHex(quote.destinationFaucetId))
    throw new Error('earnWithdrawRefresh');
  // No catalogue read: a withdrawal needs only the position, and a failed catalogue read must not stop it.
  const fresh = await fetchEarnPositions({
    accountId: quote.accountId,
    owners: [quote.position.owner],
    skipCatalog: true
  });
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
    !/^\d+$/.test(quote.amountAtomic) ||
    (withdrawalAmount(position.withdrawable, position.decimals) ?? -1n) < BigInt(quote.amountAtomic)
  )
    throw new Error('earnWithdrawRefresh');
  assertWithdrawalReviewContext(quote);
}

type AllocationMandate = { tokenIn: string; tokenInAmount: string; minTokenOut: string };

const spendsReviewedInput = (quote: EarnWithdrawalQuote, mandate: AllocationMandate): boolean =>
  mandate.tokenIn.toLowerCase() === quote.position.underlyingAddress.toLowerCase() &&
  mandate.tokenInAmount === quote.amountAtomic;

/** The execution helper requotes. Refuse any different input or worse floor instead of silently changing review. */
export function assertWithdrawalDelivery(quote: EarnWithdrawalQuote, mandate: AllocationMandate): void {
  if (
    !spendsReviewedInput(quote, mandate) ||
    !/^\d+$/.test(mandate.minTokenOut) ||
    BigInt(mandate.minTokenOut) < BigInt(quote.minimumAtomic)
  )
    throw new Error('earnWithdrawRefresh');
}

/** The allocator returns every leg, so each is bound to the review: exactly one withdraw leg and the delivery. */
export function assertWithdrawalAllocations(
  quote: EarnWithdrawalQuote,
  mandates: ReadonlyArray<AllocationMandate | undefined>,
  deliveryIndex: number
): void {
  const delivery = mandates[deliveryIndex];
  const withdraws = mandates.filter((_, index) => index !== deliveryIndex);
  const [withdraw] = withdraws;
  if (!delivery || withdraws.length !== 1 || !withdraw || !spendsReviewedInput(quote, withdraw))
    throw new Error('earnWithdrawRefresh');
  assertWithdrawalDelivery(quote, delivery);
}
