import {
  AccountId,
  FungibleAsset,
  Note,
  NoteArray,
  NoteAssets,
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

import { MIDEN_AGGLAYER_FAUCET_ID, MIDEN_BRIDGE_ID } from './constant';

export async function createB2AggNote(
  amount: bigint,
  destinationAddress: `0x${string}`,
  senderAddress: string,
  destinationNetwork: number
) {
  return Note.createB2AggNote(
    destinationNetwork,
    destinationAddress,
    new NoteAssets([new FungibleAsset(AccountId.fromHex(MIDEN_AGGLAYER_FAUCET_ID), amount)]),
    AccountId.fromHex(MIDEN_BRIDGE_ID),
    accountIdStringToSdk(senderAddress)
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
 * Mirrors `createBridgeP2IDNote`: nudge the SW on extension, run the in-page
 * background processor on mobile/desktop, then wait for the queued tx to settle.
 *
 * Recorded as a `bridged-send` row with `provider: 'agglayer'` so the activity
 * detail can surface the EVM destination + L1 claim status.
 */
export async function bridgeB2Agg(args: {
  amount: bigint;
  destinationAddress: `0x${string}`;
  senderPublicKey: string;
  destinationNetwork: number;
  deps: B2AggBridgeDeps;
}): Promise<{ txHash: string }> {
  const { amount, destinationAddress, senderPublicKey, destinationNetwork, deps } = args;

  // Build the note + TransactionRequest under the WASM lock; the queue stores
  // the serialized request and the background processor submits it.
  const requestBytes = await withWasmClientLock(async () => {
    const note = await createB2AggNote(amount, destinationAddress, senderPublicKey, destinationNetwork);
    const request = new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([note])).build();
    return request.serialize();
  });

  // Delegate to the remote prover (mobile always delegates anyway) to avoid
  // OOMing the SW / WebView while proving the bridge note.
  const txId = await initiateBridgedSendTransaction(
    senderPublicKey,
    amount,
    MIDEN_AGGLAYER_FAUCET_ID,
    destinationAddress,
    destinationNetwork,
    'agglayer',
    requestBytes,
    true
  );

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
