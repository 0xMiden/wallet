import type { TransactionRequest as SdkTransactionRequest } from '@miden-sdk/miden-sdk/lazy';

import { IEarnDepositExtraInputs, ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

/**
 * E2E-only service-worker hooks for the Epoch "Earn" localnet harness. Installed
 * from `back/main.ts` ONLY under `MIDEN_E2E_TEST`, so this whole module (and the
 * globals it defines) is dead-stripped from production builds.
 *
 * Mirrors `bridge-in-test-hooks.ts`, and — like it — keeps its TOP-LEVEL imports
 * LIGHT (only `Repo` + db types). These are strictly READ hooks over the tracking
 * rows the DOM never hands back. The ACTION hooks (the collateral-faucet override,
 * the withdraw driver) live in the PAGE realm (`src/lib/store/index.ts`), because
 * `openEarnPosition` / `gaslessEarnWithdrawalToMiden` run page-side AND because
 * importing `lib/epoch/*` here would pull the Epoch/EVM SDK (viem + the Coinbase/
 * Base wallet SDK) into the service-worker boot path — whose inline-script/COOP
 * init the extension CSP blocks, hanging SW WASM init and stopping the wallet from
 * ever loading.
 */

interface LatestEarnDeposit {
  id: string;
  status: ITransactionStatus;
  epochStatus?: IEarnDepositExtraInputs['epochStatus'];
  displayMessage?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __TEST_LATEST_EARN_DEPOSIT__: () => Promise<LatestEarnDeposit | null>;
  // eslint-disable-next-line no-var
  var __TEST_EARN_DEPOSIT_STATE__: (txId: string) => Promise<LatestEarnDeposit | null>;
  // eslint-disable-next-line no-var
  var __TEST_NOTE_ATTACHMENT_FELTS__: (noteId: string) => Promise<string[] | null>;
}

/** Strip an optional 0x prefix and lowercase, so hex note-id forms compare equal. */
function normalizeNoteId(id: string): string {
  return id.replace(/^0x/i, '').toLowerCase();
}

function toDepositView(row: ITransaction): LatestEarnDeposit {
  const inputs: IEarnDepositExtraInputs | undefined = row.extraInputs;
  return {
    id: row.id,
    status: row.status,
    epochStatus: inputs?.epochStatus,
    displayMessage: row.displayMessage
  };
}

export function installEarnTestHooks(): void {
  // Newest `earn-deposit` tracking row — the deposit UI doesn't hand the txId
  // back to the DOM, so the harness finds the row the REAL flow created here.
  globalThis.__TEST_LATEST_EARN_DEPOSIT__ = async (): Promise<LatestEarnDeposit | null> => {
    const rows = await Repo.transactions.filter(tx => tx.type === 'earn-deposit').toArray();
    rows.sort((a, b) => b.initiatedAt - a.initiatedAt);
    const row = rows[0];
    return row ? toDepositView(row) : null;
  };

  globalThis.__TEST_EARN_DEPOSIT_STATE__ = async (txId: string): Promise<LatestEarnDeposit | null> => {
    const row = await Repo.transactions.where({ id: txId }).first();
    return row ? toDepositView(row) : null;
  };

  // Attachment felts of the note `noteId` as SUBMITTED by the wallet — read from
  // the persisted `requestBytes` (the exact request the pipeline proves +
  // submits), so the FakeEpochAllocator can play smallocator PR #38 and reject
  // a collateral note whose attachment doesn't commit to the intent mandate.
  // Returns every felt of the note's first attachment (word padding included —
  // the real allocator ignores felts past the fixed binding count), `[]` when
  // the note has NO attachment, and `null` when no persisted request carries a
  // note with that id. The SDK import is dynamic so this test-only module adds
  // nothing to SW boot.
  globalThis.__TEST_NOTE_ATTACHMENT_FELTS__ = async (noteId: string): Promise<string[] | null> => {
    const { TransactionRequest } = await import('@miden-sdk/miden-sdk/lazy');
    const wanted = normalizeNoteId(noteId);
    const rows = await Repo.transactions.filter(tx => !!tx.requestBytes).toArray();
    for (const row of rows) {
      let request: SdkTransactionRequest;
      try {
        request = TransactionRequest.deserialize(row.requestBytes!);
      } catch {
        continue; // not every persisted request is a note request (e.g. custom scripts)
      }
      for (const note of request.expectedOutputOwnNotes()) {
        if (normalizeNoteId(note.id().toString()) !== wanted) continue;
        const attachment = note.attachments()[0];
        if (!attachment) return [];
        const felts: string[] = [];
        for (const word of attachment.toWords()) {
          for (const felt of word.toFelts()) {
            felts.push(felt.asInt().toString());
          }
        }
        return felts;
      }
    }
    return null;
  };
}
