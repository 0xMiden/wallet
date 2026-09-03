import {
  AccountId,
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
import { accountIdStringToSdk, getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { assertWasmHoldCurrent, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { resolveBuildTimeFeeAuth } from 'lib/miden/transaction/guardian-fee-auth';
import { isExtension } from 'lib/platform';

import { MIDEN_BRIDGE_ID, getAgglayerFaucetId } from './constant';

export async function createB2AggNote(
  amount: bigint,
  destinationAddress: `0x${string}`,
  senderAddress: string,
  destinationNetwork: number
) {
  const asset = new FungibleAsset(AccountId.fromHex(getAgglayerFaucetId()), amount);
  // The callback flag is intrinsic to the issuing faucet's account id (not a per-asset value):
  // the real bridge faucet id encodes Enabled-callback assets; the plain CLI test faucet (E2E
  // override) id encodes Disabled ones. Since getAgglayerFaucetId() already returns the
  // override id under E2E, the asset carries the correct flag automatically — no explicit
  // per-asset flag needed.
  return Note.createB2AggNote(
    accountIdStringToSdk(senderAddress),
    AccountId.fromHex(MIDEN_BRIDGE_ID),
    new NoteAssets([asset]),
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
  //
  // The faucet id is converted to bech32 in the same block, because the
  // conversion needs the SDK loaded too. `getAgglayerFaucetId()` is a HEX
  // account id (that is the form `AccountId.fromHex` above needs), but every
  // other producer of a transaction row writes the BECH32 id and every consumer
  // matches on it: `getTokenMetadata` looks the row's `faucetId` up in a cache
  // keyed by the bech32 ids `fetchBalances` produces, and `matchesTokenId`
  // compares it verbatim against the bech32 id of the token whose history is
  // open. Storing hex here made the row render as "Unknown" with the 6-decimal
  // metadata fallback and dropped it out of that token's history entirely.
  // Resolved BEFORE the client lock: on a cache miss this drives its own RpcClient
  // through the WASM module, and re-entering it under the lock traps.
  const feeAuth = await resolveBuildTimeFeeAuth();
  const { requestBytes, faucetBech32 } = await withWasmClientLock(async hold => {
    const note = await createB2AggNote(amount, destinationAddress, senderPublicKey, destinationNetwork);
    // The awaited note build parks (the lazy SDK load can be the long one), and
    // an eviction during it hands the mutex to a successor without stopping this
    // callback — everything below is WASM work that would then run alongside the
    // successor's, unmutexed. Everything in this hold is write PREP: the request
    // is only built and serialized here, submission happens later in the
    // transaction pipeline, so aborting is always safe — and it must happen
    // BEFORE `initiateBridgedSendTransaction` queues a row, since a queued row
    // would hand the abandoned request to the processor as a fresh write.
    assertWasmHoldCurrent(hold, 'before the bridge request build');
    // Attached at BUILD time: the SDK exposes no auth-arg setter on a finished
    // `TransactionRequest`, only on the builder. See `resolveBuildTimeFeeAuth`.
    let builder = new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([note]));
    if (feeAuth !== undefined) {
      builder = builder.withAuthArg(feeAuth.authArg);
      if (feeAuth.adviceMap !== undefined) {
        builder = builder.extendAdviceMap(feeAuth.adviceMap);
      }
    }
    const request = builder.build();
    const serialisedReq = request.serialize();
    console.log('Got the serialised transaction request', serialisedReq);
    try {
      TransactionRequest.deserialize(serialisedReq);
      console.log('Deserialisation test passes');
    } catch (err) {
      console.log('Basic deser ser failed', err);
      throw err;
    }
    return {
      requestBytes: serialisedReq,
      faucetBech32: getBech32AddressFromAccountId(AccountId.fromHex(getAgglayerFaucetId()))
    };
  });

  // Delegate to the remote prover (mobile always delegates anyway) to avoid
  // OOMing the SW / WebView while proving the bridge note.
  return initiateBridgedSendTransaction(
    senderPublicKey,
    amount,
    faucetBech32,
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
