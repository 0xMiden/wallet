import { AccountId, AccountInterface, NetworkId } from '@miden-sdk/miden-sdk';

import {
  initiateEarnDepositTransaction,
  requestSWTransactionProcessing,
  startBackgroundTransactionProcessing,
  waitForTransactionCompletion
} from 'lib/miden/activity';
import * as Repo from 'lib/miden/repo';
import { NoteTypeEnum } from 'lib/miden/types';
import { isExtension } from 'lib/platform';

import { MIDEN_MIN_RECLAIM_BLOCKS } from './chain';
import type { BridgeNoteDeps } from './miden-note';

function ifHextoBech32(addr: string) {
  console.log('converting address to bech32 from hex', addr);
  if (addr.startsWith('0x')) {
    return AccountId.fromHex(addr).toBech32(NetworkId.testnet(), AccountInterface.BasicWallet);
  }
  return addr;
}

export interface CreateEarnP2IDNoteArgs {
  senderAccountId: string;
  faucetId: string;
  /** Collateral amount in faucet base units (decimal string from the Epoch SDK callback). */
  amount: string;
  /** Epoch allocator account the P2IDE collateral note is sent to. */
  allocatorId: string;
  /** 0x EVM address that owns the resulting lending position — recorded on the row. */
  evmRecipient: string;
  /** Epoch market identifier (`PROTOCOL:chainId:token`) — recorded on the row. */
  marketUid: string;
  deps: BridgeNoteDeps;
  /** Fired the instant the `earn-deposit` row is created (before proving/submit). */
  onRowCreated?: (txId: string) => void;
}

/**
 * Earn-side P2IDE note creator. Wired to the Epoch SDK's `createMidenP2IDNote`
 * callback for the lending-deposit intent — the same mechanics as
 * `createBridgeP2IDNote`, but it queues a dedicated `earn-deposit` activity row
 * instead of a `bridged-send`:
 *
 * - SDK passes the faucet, collateral amount, and the allocator's Miden account id.
 * - We queue an `earn-deposit` tx with `recallBlocks = MIDEN_MIN_RECLAIM_BLOCKS` so
 *   the resulting note is a recallable P2IDE (the Miden SDK uses presence of
 *   `reclaimAfter` to choose P2IDE over P2ID).
 * - Service worker (extension) or in-page background processor (mobile/desktop)
 *   prove + submit the tx.
 * - We wait via Dexie liveQuery, then read the committed `outputNoteIds[0]` off the
 *   tx record and hand it back to the SDK.
 */
export async function createEarnP2IDNote(
  args: CreateEarnP2IDNoteArgs
): Promise<{ success: boolean; noteId?: string; txId?: string }> {
  const { senderAccountId, faucetId, amount, allocatorId, evmRecipient, marketUid, deps, onRowCreated } = args;
  try {
    console.log('[epoch] creating earn note with', { senderAccountId, faucetId, amount, allocatorId, marketUid });
    const txId = await initiateEarnDepositTransaction(
      ifHextoBech32(senderAccountId),
      BigInt(amount),
      evmRecipient,
      marketUid,
      ifHextoBech32(faucetId),
      {
        recipientId: ifHextoBech32(allocatorId),
        noteType: NoteTypeEnum.Public,
        recallBlocks: MIDEN_MIN_RECLAIM_BLOCKS
      },
      // Delegate to the remote prover — local proving this Guardian P2IDE note
      // OOMs the service worker / WebView and restarts the wallet mid-submit.
      true
    );

    // Row exists now (Queued) — let the caller navigate before we block on proving.
    onRowCreated?.(txId);

    if (isExtension()) {
      requestSWTransactionProcessing();
    } else {
      startBackgroundTransactionProcessing(deps.signTransaction, false, deps.guardianProvider);
    }

    const result = await waitForTransactionCompletion(txId);
    if ('errorMessage' in result) {
      console.error('[epoch] earn note tx failed', result.errorMessage);
      return { success: false, txId };
    }

    const tx = await Repo.transactions.where({ id: txId }).first();
    const noteId = tx?.outputNoteIds?.[0];
    if (!noteId) {
      console.error('[epoch] earn note tx completed but no outputNoteIds');
      return { success: false, txId };
    }
    console.log('[epoch] earn note created', { noteId, txHash: result.txHash });
    return { success: true, noteId, txId };
  } catch (err) {
    console.error('[epoch] createEarnP2IDNote threw', err);
    return { success: false };
  }
}
