import {
  FeltArray,
  FungibleAsset,
  NetworkAccountTarget,
  Note,
  NoteArray,
  NoteAssets,
  NoteAttachment,
  NoteAttachmentScheme,
  NoteExecutionHint,
  NoteMetadata,
  NoteRecipient,
  NoteScript,
  NoteStorage,
  NoteTag,
  NoteType,
  TransactionRequestBuilder,
  Word
} from '@miden-sdk/miden-sdk/lazy';

import { assertReviewedBridge } from 'lib/bridge/core/review';
import { configKey } from 'lib/bridge/core/routes';
import type { SubmissionChecks } from 'lib/bridge/core/submission';
import { quoteXReserveWithdrawal } from 'lib/bridge/providers/xreserve/withdrawal-quote';
import { captureBridgeWalletScope, findAdmittedBridgeOperation, type BridgeOperationInput } from 'lib/bridge/operation';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { parseUnits } from 'viem';

import { accountRefToSdk, getBech32AddressFromAccountId, randomFeeSalt, sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { soleOwnOutputNoteId } from 'lib/miden/sdk/own-output-request';
import type { SpendingLimitAuthorization } from 'lib/miden/spending-limits/types';
import { initiateBridgedSendTransaction } from 'lib/miden/transaction/initiate';
import { getNativeAssetId } from 'lib/miden-chain/native-asset';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';

import {
  getUsdcxDestination,
  USDCX_BURN_TAG,
  USDCX_BURN_WITHDRAWAL_ATTACHMENT_SCHEME,
  USDCX_MIN_BURN,
  USDCX_MIN_BURN_SLOT
} from './constant';
import { readUsdcxDestinationSnapshot } from './destination-status';
import { readWithOwnRpcClient } from './rpc-client';
import { encodeBurnWithdrawal, requireUsdcxFaucetId, UsdcxBurnError, validateUsdcxWithdrawal } from './withdrawal';

/**
 * The minimum burn: the faucet's `min_burn_amount` when it is larger than `USDCX_MIN_BURN`, else `USDCX_MIN_BURN`.
 * The read asks for an account proof, not the full account: the faucet's nonce map has grown past what the node
 * serves through `getAccountDetails`. A failed read gives `USDCX_MIN_BURN`, so it never blocks a burn.
 */
export async function readUsdcxMinimumBurn(): Promise<bigint> {
  try {
    const proof = await withRpcTimeout(
      () => readWithOwnRpcClient(rpc => rpc.getAccountProof(accountRefToSdk(requireUsdcxFaucetId()))),
      'usdcx minimum burn'
    );
    const onChain = proof.getStorageSlotValue(USDCX_MIN_BURN_SLOT)?.toFelts()[0]?.asInt();
    return onChain !== undefined && onChain > USDCX_MIN_BURN ? onChain : USDCX_MIN_BURN;
  } catch (error) {
    console.warn('USDCx minimum burn read failed, using the wallet minimum', error);
    return USDCX_MIN_BURN;
  }
}

/** Build a burn request from local SDK objects, following the `XReserveBurnNote` factory of miden-usdcx 0.17.1. */
export function buildUsdcxBurnRequest(
  sender: string,
  amount: bigint,
  destinationAddress: string,
  destinationDomain: number
) {
  if (amount <= 0n) throw new UsdcxBurnError('usdcxInvalidAmount');
  const asset = new FungibleAsset(accountRefToSdk(requireUsdcxFaucetId()), amount);
  const storage = new NoteStorage(new FeltArray([...asset.vaultKey().toFelts(), ...asset.intoWord().toFelts()]));
  const recipient = NoteRecipient.fromScript(NoteScript.burn(), storage);
  const metadata = new NoteMetadata(accountRefToSdk(sender), NoteType.Public, new NoteTag(USDCX_BURN_TAG));
  const payload = encodeBurnWithdrawal(destinationAddress, destinationDomain);
  const words = [0, 4, 8].map(i => new Word(new BigUint64Array(payload.slice(i, i + 4))));
  const withdrawal = NoteAttachment.fromWords(new NoteAttachmentScheme(USDCX_BURN_WITHDRAWAL_ATTACHMENT_SCHEME), words);
  // The factory routes with the `Always` hint; the note id commits to the attachment.
  const routing = new NetworkAccountTarget(
    accountRefToSdk(requireUsdcxFaucetId()),
    NoteExecutionHint.always()
  ).toAttachment();
  const note = Note.withAttachments(new NoteAssets([asset]), metadata, recipient, [routing, withdrawal]);
  const request = new TransactionRequestBuilder()
    .withOwnOutputNotes(new NoteArray([note]))
    .withFeeConversionSalt(randomFeeSalt())
    .build();
  // The burn is tracked by this id and signing may create only this note, so both read it from the request itself.
  return { burnNoteId: soleOwnOutputNoteId(request), requestBytes: request.serialize() };
}

export async function initiateUsdcxBurn(args: {
  senderPublicKey: string;
  faucetId: string;
  amount: bigint;
  destinationAddress: string;
  destinationChainId: number;
  spendingLimitAuthorization?: SpendingLimitAuthorization;
  operation?: BridgeOperationInput;
  checks?: Pick<SubmissionChecks, 'readCurrent' | 'now'>;
}): Promise<string> {
  const { senderPublicKey, faucetId, amount, destinationAddress, destinationChainId, spendingLimitAuthorization } =
    args;
  const operation = args.operation && structuredClone(args.operation);
  const originalScope = captureBridgeWalletScope();
  if (operation) {
    const existing = await findAdmittedBridgeOperation(operation);
    if (existing) return existing.id;
  }
  const assertCurrent = async () => {
    if (!operation) return;
    if (!args.checks) throw new Error('Circle live review unavailable');
    const live = await args.checks.readCurrent();
    const { route } = operation.review;
    const current = getBridgeConfigSnapshot();
    const chain = route.recovery.config.supportedEvmChains[route.destination.network];
    if (route.provider !== 'xreserve' || route.mode !== 'send' || route.source.kind !== 'miden' ||
        chain?.chainId !== destinationChainId || parseUnits(operation.review.amount, route.source.decimals) !== amount ||
        !sameWalletAccountId(route.source.faucetId, faucetId) ||
        !sameWalletAccountId(operation.review.accounts.midenAccount, senderPublicKey) ||
        operation.review.accounts.evmAddress.toLowerCase() !== destinationAddress.toLowerCase() ||
        configKey(originalScope) !== configKey(captureBridgeWalletScope()) || current.status !== 'ready' ||
        configKey([current.network, current.config, current.derived]) !==
          configKey([route.recovery.network, route.recovery.config, route.recovery.derived]))
      throw new Error('Circle burn review changed');
    assertReviewedBridge(operation.review, live, args.checks.now());
  };
  await assertCurrent();
  const destination = getUsdcxDestination(destinationChainId);
  // Resolve the native asset so the checks below read a known faucet id.
  await getNativeAssetId();
  validateUsdcxWithdrawal(faucetId, destinationChainId, amount, await readUsdcxMinimumBurn());
  await assertCurrent();
  const { domain } = destination;
  const built = {
    ...buildUsdcxBurnRequest(senderPublicKey, amount, destinationAddress, domain),
    destinationDomain: domain,
    faucetBech32: getBech32AddressFromAccountId(accountRefToSdk(requireUsdcxFaucetId()))
  };
  const destinationBalanceBefore = await readUsdcxDestinationSnapshot(
    destinationChainId,
    destinationAddress,
    undefined,
    destination.usdc
  );
  if (operation) {
    const { review } = operation;
    const fresh = await quoteXReserveWithdrawal({ route: review.route, amount: review.amount, ...review.accounts });
    if (!review.quote || fresh.received !== review.quote.received || fresh.fee !== review.quote.fee)
      throw new Error('Circle withdrawal estimate changed');
  }
  await assertCurrent();
  return initiateBridgedSendTransaction(
    senderPublicKey,
    amount,
    built.faucetBech32,
    destinationAddress,
    destinationChainId,
    'usdcx',
    built.burnNoteId,
    built.requestBytes,
    true,
    undefined,
    spendingLimitAuthorization,
    undefined,
    {
      noteId: built.burnNoteId,
      destinationDomain: built.destinationDomain,
      phase: 'pending',
      destinationBalanceBefore,
      destinationUsdc: destination.usdc,
      payoutFeeAllowance: destination.payoutFeeAllowance.toString()
    },
    undefined,
    undefined,
    operation
  );
}
