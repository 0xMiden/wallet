import * as Repo from 'lib/miden/repo';

import { setAgglayerSenderForE2E } from './bridge-in';
import { IBridgedReceiveExtraInputs, IBridgeProvider, ITransactionStatus } from '../db/types';
import { initiateBridgedReceiveTransaction } from '../transaction/initiate';

/**
 * E2E-only service-worker hooks for the bridge-IN localnet harness. Installed
 * from `back/main.ts` ONLY under `MIDEN_E2E_TEST`, so this whole module (and the
 * globals it defines) is dead-stripped from production builds.
 *
 * The harness exercises the REAL Miden receipt path: a real note is delivered to
 * the wallet's account on the localnet (via the miden-client CLI acting as the
 * bridge "solver"), the wallet's real sync + consume runs, and the real
 * reconciliation tags it "Bridged from EVM". These hooks only supply the two
 * pieces the pure-Miden path can't otherwise get without the EVM leg:
 *   - a `bridged-receive` tracking row to match against, and
 *   - pointing the AggLayer sender-match at the runtime-created solver account.
 */

interface CreateBridgeReceiveArgs {
  accountId: string;
  amount: string; // base units (bigint as string across the evaluate boundary)
  faucetId: string;
  provider: IBridgeProvider;
  sourceAddress: string;
  sourceAmount: string;
  sourceSymbol: string;
  outputAmount?: string;
  outputSymbol?: string;
}

interface BridgeReceiveState {
  found: boolean;
  phase?: IBridgedReceiveExtraInputs['phase'];
  displayMessage?: string;
  status?: ITransactionStatus;
  amount?: string;
  faucetId?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __TEST_CREATE_BRIDGE_RECEIVE__: (args: CreateBridgeReceiveArgs) => Promise<string>;
  // eslint-disable-next-line no-var
  var __TEST_SET_AGGLAYER_SENDER__: (senderAccountId: string) => void;
  // eslint-disable-next-line no-var
  var __TEST_BRIDGE_RECEIVE_STATE__: (txId: string) => Promise<BridgeReceiveState>;
}

export function installBridgeInTestHooks(): void {
  globalThis.__TEST_CREATE_BRIDGE_RECEIVE__ = async (args: CreateBridgeReceiveArgs) =>
    initiateBridgedReceiveTransaction({ ...args, amount: BigInt(args.amount) });

  globalThis.__TEST_SET_AGGLAYER_SENDER__ = (senderAccountId: string) => {
    setAgglayerSenderForE2E(senderAccountId);
  };

  globalThis.__TEST_BRIDGE_RECEIVE_STATE__ = async (txId: string): Promise<BridgeReceiveState> => {
    const row = await Repo.transactions.where({ id: txId }).first();
    if (!row) return { found: false };
    const inputs = row.extraInputs as IBridgedReceiveExtraInputs | undefined;
    return {
      found: true,
      phase: inputs?.phase,
      displayMessage: row.displayMessage,
      status: row.status,
      amount: row.amount != null ? row.amount.toString() : undefined,
      faucetId: row.faucetId
    };
  };
}
