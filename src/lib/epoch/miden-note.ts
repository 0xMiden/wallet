import { AccountId, NetworkId, AccountInterface } from '@miden-sdk/miden-sdk';

import {
  initiateSendTransaction,
  requestSWTransactionProcessing,
  startBackgroundTransactionProcessing,
  waitForTransactionCompletion
} from 'lib/miden/activity';
import type { GuardianAccountProvider } from 'lib/miden/front/guardian-manager';
import * as Repo from 'lib/miden/repo';
import { NoteTypeEnum } from 'lib/miden/types';
import { isExtension } from 'lib/platform';

import { MIDEN_MIN_RECLAIM_BLOCKS } from './chain';

export interface BridgeNoteDeps {
  /**
   * `signTransaction` action from `useMidenContext()` — needed by the
   * background processor on mobile/desktop where there's no service worker.
   */
  signTransaction: (publicKey: string, signingInputs: string) => Promise<Uint8Array>;
  /** Guardian provider from `lib/miden/front/guardian-sync`. */
  guardianProvider: GuardianAccountProvider;
}

function ifHextoBech32(addr: string) {
  if (addr.startsWith('0x')) {
    return AccountId.fromHex(addr).toBech32(NetworkId.testnet(), AccountInterface.BasicWallet);
  }
  return addr;
}
/**
 * Bridge-side P2IDE note creator. Wired to the Epoch SDK's
 * `createMidenP2IDNote` callback for Miden→EVM intents:
 *
 * - SDK passes the faucet, amount, and the allocator's Miden account id.
 * - We queue a wallet send transaction with `recallBlocks =
 *   MIDEN_MIN_RECLAIM_BLOCKS` so the resulting note is a recallable P2IDE
 *   (the Miden SDK uses presence of `reclaimAfter` to choose P2IDE over
 *   P2ID).
 * - Service worker (extension) or in-page background processor
 *   (mobile/desktop) prove + submit the tx.
 * - We wait via Dexie liveQuery, then read the committed `outputNoteIds[0]`
 *   off the tx record and hand it back to the SDK.
 */
export async function createBridgeP2IDNote(
  senderAccountId: string,
  faucetId: string,
  amount: string,
  allocatorId: string,
  deps: BridgeNoteDeps
): Promise<{ success: boolean; noteId?: string }> {
  try {
    console.log('[epoch] creating bridge note with', { senderAccountId, faucetId, amount, allocatorId });
    const txId = await initiateSendTransaction(
      ifHextoBech32(senderAccountId),
      ifHextoBech32(allocatorId),
      ifHextoBech32(faucetId),
      NoteTypeEnum.Public,
      BigInt(amount),
      MIDEN_MIN_RECLAIM_BLOCKS,
      // Delegate to the remote prover. Local proving this Guardian P2IDE note
      // OOMs the service worker / WebView and restarts the wallet mid-submit.
      true
    );

    if (isExtension()) {
      requestSWTransactionProcessing();
    } else {
      startBackgroundTransactionProcessing(deps.signTransaction, false, deps.guardianProvider);
    }

    const result = await waitForTransactionCompletion(txId);
    if ('errorMessage' in result) {
      console.error('[epoch] bridge note tx failed', result.errorMessage);
      return { success: false };
    }

    const tx = await Repo.transactions.where({ id: txId }).first();
    const noteId = tx?.outputNoteIds?.[0];
    if (!noteId) {
      console.error('[epoch] bridge note tx completed but no outputNoteIds');
      return { success: false };
    }
    console.log('[epoch] bridge note created', { noteId, txHash: result.txHash });
    return { success: true, noteId };
  } catch (err) {
    console.error('[epoch] createBridgeP2IDNote threw', err);
    return { success: false };
  }
}
