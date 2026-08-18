import { AccountId, NetworkId, AccountInterface } from '@miden-sdk/miden-sdk';

import {
  initiateBridgedSendTransaction,
  requestSWTransactionProcessing,
  startBackgroundTransactionProcessing,
  waitForTransactionCompletion
} from 'lib/miden/activity';
import type { GuardianAccountProvider } from 'lib/miden/front/guardian-manager';
import * as Repo from 'lib/miden/repo';
import { NoteTypeEnum } from 'lib/miden/types';
import { isExtension } from 'lib/platform';

import { buildEpochCollateralRequestBytes } from './collateral-note';

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
export interface CreateBridgeP2IDENoteArgs {
  senderAccountId: string;
  faucetId: string;
  amount: string;
  allocatorId: string;
  /** SDK-supplied RELATIVE reclaim window — used exactly as provided (never hardcoded). */
  recallBlocks: number;
  /** SDK-supplied mandate-binding felts — written verbatim as the note attachment. */
  bindingAttachmentFelts: bigint[];
  /** 0x EVM recipient — recorded on the bridge row (the note goes to the allocator). */
  destinationAddress: string;
  /** EVM destination chain id (Epoch). */
  destinationNetwork: number;
  deps: BridgeNoteDeps;
  /**
   * Fired the instant the `bridged-send` row is created (before proving/submit).
   * The send flow uses this to navigate to the generating-transaction screen
   * WITH the txId — like a normal send — so the screen tracks the real row
   * instead of racing an empty queue. Not provided by callers that drive their
   * own progress UI (e.g. the EvmConnectModal).
   */
  onRowCreated?: (txId: string) => void;
}

/**
 * Bridge-side P2IDE note creator. Wired to the Epoch SDK's
 * `createMidenP2IDENote` callback for Miden→EVM intents:
 *
 * - SDK passes the faucet, amount, the allocator's Miden account id, the reclaim
 *   window (`recallBlocks`, allocator minimum + SDK drift buffer — used exactly
 *   as provided), and the mandate-binding attachment felts (smallocator PR #38 —
 *   the allocator rejects notes whose attachment doesn't commit to the mandate).
 * - The public P2IDE note (with the binding attachment) is built HERE via
 *   `buildEpochCollateralRequestBytes` and persisted on the row as
 *   `requestBytes`, so both the standard pipeline (`newTransaction`) and the
 *   guardian custom-proposal path submit the exact same note. This row IS the
 *   bridge — the send pipeline proves + submits it and
 *   `completeBridgedSendTransaction` marks it "Bridged to EVM". There is no
 *   separate outer row.
 * - Service worker (extension) or in-page background processor
 *   (mobile/desktop) prove + submit the tx.
 * - We wait via Dexie liveQuery, then read the committed `outputNoteIds[0]`
 *   off the tx record and hand it back to the SDK.
 */
export async function createBridgeP2IDENote(
  args: CreateBridgeP2IDENoteArgs
): Promise<{ success: boolean; noteId?: string; txId?: string }> {
  const {
    senderAccountId,
    faucetId,
    amount,
    allocatorId,
    recallBlocks,
    bindingAttachmentFelts,
    destinationAddress,
    destinationNetwork,
    deps,
    onRowCreated
  } = args;
  try {
    console.log('[epoch] creating bridge note with', { senderAccountId, faucetId, amount, allocatorId, recallBlocks });
    const requestBytes = await buildEpochCollateralRequestBytes({
      senderAccountId,
      allocatorId,
      faucetId,
      amount: BigInt(amount),
      recallBlocks,
      bindingAttachmentFelts
    });
    const txId = await initiateBridgedSendTransaction(
      ifHextoBech32(senderAccountId),
      BigInt(amount),
      ifHextoBech32(faucetId),
      destinationAddress,
      destinationNetwork,
      'epoch',
      requestBytes,
      // Delegate to the remote prover. Local proving this Guardian P2IDE note
      // OOMs the service worker / WebView and restarts the wallet mid-submit.
      true,
      {
        recipientId: ifHextoBech32(allocatorId),
        noteType: NoteTypeEnum.Public,
        recallBlocks
      }
    );

    // Row exists now (Queued) — let the caller navigate to the progress screen
    // before we block on proving/submission below.
    onRowCreated?.(txId);

    if (isExtension()) {
      requestSWTransactionProcessing();
    } else {
      startBackgroundTransactionProcessing(deps.signTransaction, false, deps.guardianProvider);
    }

    const result = await waitForTransactionCompletion(txId);
    if ('errorMessage' in result) {
      console.error('[epoch] bridge note tx failed', result.errorMessage);
      return { success: false, txId };
    }

    const tx = await Repo.transactions.where({ id: txId }).first();
    const noteId = tx?.outputNoteIds?.[0];
    if (!noteId) {
      console.error('[epoch] bridge note tx completed but no outputNoteIds');
      return { success: false, txId };
    }
    console.log('[epoch] bridge note created', { noteId, txHash: result.txHash });
    return { success: true, noteId, txId };
  } catch (err) {
    console.error('[epoch] createBridgeP2IDENote threw', err);
    return { success: false };
  }
}
