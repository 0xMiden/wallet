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
}
