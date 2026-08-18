import {
  AccountId,
  AssetCallbackFlag,
  EthAddress,
  FungibleAsset,
  Note,
  NoteArray,
  NoteAssets,
  TransactionRequest,
  TransactionRequestBuilder
} from '@miden-sdk/miden-sdk/lazy';

import {
  initiateBridgedSendTransaction,
  requestSWTransactionProcessing,
  startBackgroundTransactionProcessing,
  waitForTransactionCompletion
} from 'lib/miden/activity';
import type { GuardianAccountProvider } from 'lib/miden/front/guardian-manager';
import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';
import { withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { isExtension } from 'lib/platform';

import { MIDEN_BRIDGE_ID, getAgglayerFaucetId, hasAgglayerFaucetOverride } from './constant';

export async function createB2AggNote(
  amount: bigint,
  destinationAddress: `0x${string}`,
  senderAddress: string,
  destinationNetwork: number
) {
  const asset = new FungibleAsset(AccountId.fromHex(getAgglayerFaucetId()), amount);
  // The real bridge faucet issues Enabled-callback assets; a plain CLI test
  // faucet (E2E override) issues Disabled ones, which live in a different vault
  // slot — reference that slot so `createB2AggNote` finds the minted balance.
  const callbackFlag = hasAgglayerFaucetOverride() ? AssetCallbackFlag.Disabled : AssetCallbackFlag.Enabled;
  return Note.createB2AggNote(
    accountIdStringToSdk(senderAddress),
    AccountId.fromHex(MIDEN_BRIDGE_ID),
    new NoteAssets([asset.withCallbacks(callbackFlag)]),
    destinationNetwork,
    EthAddress.fromHex(destinationAddress)
  );
}

export interface B2AggBridgeDeps {
  /** `signTransaction` from `useMidenContext()` — used by the background processor (mobile/desktop). */
  signTransaction: (publicKey: string, signingInputs: string) => Promise<Uint8Array>;
  /** Guardian provider from `lib/miden/front/guardian-sync`. */
  guardianProvider: GuardianAccountProvider;
}

/**
 * Bridge Miden → EVM by creating the B2AGG note and queuing it as a dedicated
 * `bridge` transaction. The note + transaction request are built on the front
 * under the WASM lock, then handed to the normal transaction pipeline
 * (`initiateBridgedSendTransaction` → SW / background processor → `newTransaction` →
 * `completeBridgedSendTransaction`) so it proves + submits and shows up in the
 * activity list exactly like every other wallet transaction.
 *
 * Mirrors `createBridgeP2IDENote`: nudge the SW on extension, run the in-page
 * background processor on mobile/desktop, then wait for the queued tx to settle.
 *
 * Recorded as a `bridged-send` row with `provider: 'agglayer'` so the activity
 * detail can surface the EVM destination + L1 claim status.
 */
/**
 * Build the B2AGG note + request and queue it as a `bridged-send` (agglayer)
 * row, returning the txId WITHOUT proving/submitting or waiting. Mirrors a normal
 * send's `initiate*` step: the caller then nudges the processor and navigates to
 * the generating-transaction screen with this id, which drives proving/submission.
 */
export async function initiateB2AggBridge(args: {
  amount: bigint;
  destinationAddress: `0x${string}`;
  senderPublicKey: string;
  destinationNetwork: number;
}): Promise<string> {
  const { amount, destinationAddress, senderPublicKey, destinationNetwork } = args;

  // Build the note + TransactionRequest under the WASM lock; the queue stores
  // the serialized request and the processor submits it.
  const requestBytes = await withWasmClientLock(async () => {
    const note = await createB2AggNote(amount, destinationAddress, senderPublicKey, destinationNetwork);
    const request = new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([note])).build();
    const serialisedReq = request.serialize();
    console.log('Got the serialised transaction request', serialisedReq);
    try {
      TransactionRequest.deserialize(serialisedReq);
      console.log('Deserialisation test passes');
    } catch (err) {
      console.log('Basic deser ser failed', err);
      throw err;
    }
    return serialisedReq;
  });

  // Delegate to the remote prover (mobile always delegates anyway) to avoid
  // OOMing the SW / WebView while proving the bridge note.
  return initiateBridgedSendTransaction(
    senderPublicKey,
    amount,
    getAgglayerFaucetId(),
    destinationAddress,
    destinationNetwork,
    'agglayer',
    requestBytes,
    true
  );
}

export async function bridgeB2Agg(args: {
  amount: bigint;
  destinationAddress: `0x${string}`;
  senderPublicKey: string;
  destinationNetwork: number;
  deps: B2AggBridgeDeps;
}): Promise<{ txHash: string }> {
  const { deps, ...noteArgs } = args;
  const txId = await initiateB2AggBridge(noteArgs);

  if (isExtension()) {
    requestSWTransactionProcessing();
  } else {
    startBackgroundTransactionProcessing(deps.signTransaction, false, deps.guardianProvider);
  }

  const result = await waitForTransactionCompletion(txId);
  if ('errorMessage' in result) {
    throw new Error(result.errorMessage);
  }
  return { txHash: result.txHash };
}
