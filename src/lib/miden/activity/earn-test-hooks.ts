import { setEarnCollateralFaucetForTest } from 'lib/epoch/earn';
import {
  gaslessEarnWithdrawalToMiden,
  type GaslessEarnWithdrawalArgs,
  type GaslessEarnWithdrawalResult
} from 'lib/epoch/earn-withdraw';
import {
  IEarnDepositExtraInputs,
  IEarnWithdrawExtraInputs,
  ITransaction,
  ITransactionStatus
} from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

/**
 * E2E-only service-worker hooks for the Epoch "Earn" localnet harness. Installed
 * from `back/main.ts` ONLY under `MIDEN_E2E_TEST`, so this whole module (and the
 * globals it defines) is dead-stripped from production builds.
 *
 * Mirrors `bridge-in-test-hooks.ts`: the harness drives the REAL earn deposit /
 * withdraw paths and these hooks only expose read access to the tracking rows the
 * DOM never hands back, plus the two runtime injections the pure-Miden localnet
 * path can't otherwise get: the CLI-minted collateral faucet id, and a way to kick
 * off a withdrawal without the positions UI.
 */

interface LatestEarnDeposit {
  id: string;
  status: ITransactionStatus;
  epochStatus?: IEarnDepositExtraInputs['epochStatus'];
  displayMessage?: string;
}

interface LatestEarnWithdraw {
  id: string;
  phase?: IEarnWithdrawExtraInputs['phase'];
  displayMessage?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __TEST_LATEST_EARN_DEPOSIT__: () => Promise<LatestEarnDeposit | null>;
  // eslint-disable-next-line no-var
  var __TEST_EARN_DEPOSIT_STATE__: (txId: string) => Promise<LatestEarnDeposit | null>;
  // eslint-disable-next-line no-var
  var __TEST_LATEST_EARN_WITHDRAW__: () => Promise<LatestEarnWithdraw | null>;
  // eslint-disable-next-line no-var
  var __TEST_EARN_WITHDRAW_STATE__: (txId: string) => Promise<LatestEarnWithdraw | null>;
  // eslint-disable-next-line no-var
  var __TEST_SET_EARN_FAUCET__: (faucetHex: string) => void;
  // eslint-disable-next-line no-var
  var __TEST_GASLESS_EARN_WITHDRAW__: (
    args: GaslessEarnWithdrawalArgs
  ) => Promise<GaslessEarnWithdrawalResult | { error: string }>;
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

function toWithdrawView(row: ITransaction): LatestEarnWithdraw {
  const inputs: IEarnWithdrawExtraInputs | undefined = row.extraInputs;
  return {
    id: row.id,
    phase: inputs?.phase,
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

  globalThis.__TEST_LATEST_EARN_WITHDRAW__ = async (): Promise<LatestEarnWithdraw | null> => {
    const rows = await Repo.transactions.filter(tx => tx.type === 'earn-withdraw').toArray();
    rows.sort((a, b) => b.initiatedAt - a.initiatedAt);
    const row = rows[0];
    return row ? toWithdrawView(row) : null;
  };

  globalThis.__TEST_EARN_WITHDRAW_STATE__ = async (txId: string): Promise<LatestEarnWithdraw | null> => {
    const row = await Repo.transactions.where({ id: txId }).first();
    return row ? toWithdrawView(row) : null;
  };

  // Inject the CLI-minted collateral faucet id (the fixed testnet id can't exist
  // on the localnet node) — mirrors `__TEST_SET_AGGLAYER_SENDER__`.
  globalThis.__TEST_SET_EARN_FAUCET__ = (faucetHex: string): void => {
    setEarnCollateralFaucetForTest(faucetHex);
  };

  // Drive a Smart Withdraw without the positions UI.
  globalThis.__TEST_GASLESS_EARN_WITHDRAW__ = async (
    args: GaslessEarnWithdrawalArgs
  ): Promise<GaslessEarnWithdrawalResult | { error: string }> => {
    try {
      return await gaslessEarnWithdrawalToMiden(args);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
}
