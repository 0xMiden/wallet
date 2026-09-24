import {
  FeltArray,
  FungibleAsset,
  NetworkAccountTarget,
  Note,
  NoteArray,
  NoteAssets,
  NoteAttachment,
  NoteAttachmentScheme,
  NoteMetadata,
  NoteRecipient,
  NoteScript,
  NoteStorage,
  NoteTag,
  NoteType,
  RpcClient,
  TransactionRequestBuilder,
  Word
} from '@miden-sdk/miden-sdk/lazy';

import { accountRefToSdk, getBech32AddressFromAccountId, randomFeeSalt } from 'lib/miden/sdk/helpers';
import { assertWasmHoldCurrent, WasmLockHold, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import type { SpendingLimitAuthorization } from 'lib/miden/spending-limits/types';
import { initiateBridgedSendTransaction } from 'lib/miden/transaction/initiate';
import { getRpcEndpoint } from 'lib/miden-chain/constants';

import {
  USDCX_BURN_SCRIPT_ROOT,
  USDCX_BURN_TAG,
  USDCX_FAUCET_ID_BECH32,
  USDCX_MIN_BURN_SLOT,
  USDCX_WITHDRAWAL_DESTINATION
} from './constant';
import { encodeBurnWithdrawal, UsdcxBurnError, validateUsdcxWithdrawal } from './withdrawal';

/** Caller owns the WASM lock. Returns plain data; no account/client objects escape the hold. */
export async function readUsdcxMinimumBurn(hold: WasmLockHold): Promise<bigint> {
  if (NoteScript.burn().root().toHex() !== USDCX_BURN_SCRIPT_ROOT) {
    throw new UsdcxBurnError('usdcxIncompatibleBurnScript');
  }
  const rpc = new RpcClient(getRpcEndpoint());
  try {
    const fetched = await rpc.getAccountDetails(accountRefToSdk(USDCX_FAUCET_ID_BECH32));
    assertWasmHoldCurrent(hold, 'before reading USDCx faucet storage');
    const storage = fetched.account()?.storage();
    const allowed = storage
      ?.getMapItem('miden::standards::auth::network_account::allowed_note_scripts', NoteScript.burn().root())
      ?.toFelts()[0]
      ?.asInt();
    if (allowed !== 1n) throw new UsdcxBurnError('usdcxIncompatibleBurnScript');
    const minimum = storage?.getItem(USDCX_MIN_BURN_SLOT)?.toFelts()[0]?.asInt();
    if (minimum === undefined) throw new UsdcxBurnError('usdcxFaucetUnavailable');
    return minimum;
  } finally {
    rpc.free();
  }
}

/** Caller owns the WASM lock. Mirrors miden-usdcx's XReserveBurnNote factory. */
export function buildUsdcxBurnRequest(sender: string, amount: bigint, destinationAddress: string) {
  if (NoteScript.burn().root().toHex() !== USDCX_BURN_SCRIPT_ROOT) {
    throw new UsdcxBurnError('usdcxIncompatibleBurnScript');
  }
  if (amount <= 0n) throw new UsdcxBurnError('usdcxInvalidAmount');
  const asset = new FungibleAsset(accountRefToSdk(USDCX_FAUCET_ID_BECH32), amount);
  const storage = new NoteStorage(new FeltArray([...asset.vaultKey().toFelts(), ...asset.intoWord().toFelts()]));
  const recipient = NoteRecipient.fromScript(NoteScript.burn(), storage);
  const metadata = new NoteMetadata(accountRefToSdk(sender), NoteType.Public, new NoteTag(USDCX_BURN_TAG));
  const payload = encodeBurnWithdrawal(destinationAddress, USDCX_WITHDRAWAL_DESTINATION.domain);
  const words = [0, 4, 8].map(i => new Word(new BigUint64Array(payload.slice(i, i + 4))));
  const withdrawal = NoteAttachment.fromWords(new NoteAttachmentScheme(6), words);
  const routing = new NetworkAccountTarget(accountRefToSdk(USDCX_FAUCET_ID_BECH32)).toAttachment();
  const note = Note.withAttachments(new NoteAssets([asset]), metadata, recipient, [routing, withdrawal]);
  // NoteArray takes ownership. Capture identity before transferring the note.
  const burnNoteId = note.id().toString();
  const request = new TransactionRequestBuilder()
    .withOwnOutputNotes(new NoteArray([note]))
    .withFeeConversionSalt(randomFeeSalt())
    .build();
  return { burnNoteId, requestBytes: request.serialize() };
}

export async function initiateUsdcxBurn(args: {
  senderPublicKey: string;
  faucetId: string;
  amount: bigint;
  destinationAddress: string;
  destinationChainId: number;
  spendingLimitAuthorization?: SpendingLimitAuthorization;
}): Promise<string> {
  const { senderPublicKey, faucetId, amount, destinationAddress, destinationChainId, spendingLimitAuthorization } =
    args;
  const built = await withWasmClientLock(async hold => {
    validateUsdcxWithdrawal(faucetId, destinationChainId, amount);
    const minimum = await readUsdcxMinimumBurn(hold);
    assertWasmHoldCurrent(hold, 'before building the USDCx burn');
    if (amount < minimum) throw new UsdcxBurnError('usdcxBelowMinimumBurn');
    return {
      ...buildUsdcxBurnRequest(senderPublicKey, amount, destinationAddress),
      faucetBech32: getBech32AddressFromAccountId(accountRefToSdk(USDCX_FAUCET_ID_BECH32))
    };
  });
  return initiateBridgedSendTransaction(
    senderPublicKey,
    amount,
    built.faucetBech32,
    destinationAddress,
    destinationChainId,
    'usdcx',
    built.requestBytes,
    true,
    undefined,
    spendingLimitAuthorization,
    {
      noteId: built.burnNoteId,
      destinationDomain: USDCX_WITHDRAWAL_DESTINATION.domain,
      phase: 'pending'
    }
  );
}
