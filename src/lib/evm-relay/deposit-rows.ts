/** The `bridged-receive` rows of relay jobs, as the deposit engine (`deposit.ts`) reads and writes them. */
import type { IBridgedReceiveExtraInputs, IBridgedReceivePhase, IBridgedReceiveRelay } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { initiateBridgedReceiveTransaction } from 'lib/miden/transaction/initiate';

import type { RelayRowDraft } from './deposit-store';

/** A row of a relay job, as the engine reads it. */
export interface RelayRowRef {
  id: string;
  phase: IBridgedReceivePhase;
  /** Unix seconds. */
  initiatedAt: number;
  evmTxHash?: string;
  relay: IBridgedReceiveRelay;
}

/**
 * The local rows of relay jobs of `accountId` on `chainId` that the Agglayer tracking still follows (`submitting` or
 * `delivering`), newest first. A row restored from a backup is never one of them.
 */
export async function readOpenRelayRows(accountId: string, chainId: number): Promise<RelayRowRef[]> {
  const rows = await Repo.transactions.where('type').equals('bridged-receive').toArray();
  const open: RelayRowRef[] = [];
  for (const row of rows) {
    const inputs: IBridgedReceiveExtraInputs | undefined = row.extraInputs;
    const relay = inputs?.relay;
    if (row.restoredFromBackup || row.recovered || !inputs || !relay || relay.chainId !== chainId) continue;
    if (inputs.phase !== 'submitting' && inputs.phase !== 'delivering') continue;
    if (!sameWalletAccountId(row.accountId, accountId)) continue;
    open.push({ id: row.id, phase: inputs.phase, initiatedAt: row.initiatedAt, evmTxHash: inputs.evmTxHash, relay });
  }
  return open.sort((a, b) => b.initiatedAt - a.initiatedAt);
}

/**
 * Writes the row of a relay job once: when a local row already holds the job, it returns that row's id. The read and
 * the write are one database transaction, so a resumed tick cannot write a second row. The row has the shape of a
 * WalletConnect Agglayer row with its source hash (phase `submitting`, `evmTxHash`), so the existing tracking takes it.
 */
export async function createRelayRow(draft: RelayRowDraft, relay: IBridgedReceiveRelay): Promise<string> {
  const jobId = relay.jobId.toLowerCase();
  return Repo.db.transaction('rw', Repo.transactions, async () => {
    const existing = await Repo.transactions
      .where('type')
      .equals('bridged-receive')
      .filter(row => !row.restoredFromBackup && row.extraInputs?.relay?.jobId?.toLowerCase() === jobId)
      .first();
    if (existing) return existing.id;
    return initiateBridgedReceiveTransaction({
      accountId: draft.accountId,
      amount: BigInt(draft.amount),
      // As the WalletConnect Agglayer row: the delivery faucet is on `agglayerDelivery` or `agglayerRoute`.
      faucetId: '',
      provider: 'agglayer',
      sourceAddress: draft.sourceAddress,
      sourceChainId: draft.chainId,
      agglayerRoute: draft.agglayerRoute,
      agglayerDelivery: draft.agglayerDelivery,
      sourceAmount: draft.sourceAmount,
      sourceSymbol: draft.sourceSymbol,
      outputAmount: draft.outputAmount,
      outputSymbol: draft.outputSymbol,
      evmTxHash: relay.txHash,
      relay
    });
  });
}
