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
  // eslint-disable-next-line no-var
  var __TEST_REOWN_CONNECT_URI__: () => Promise<string>;
  // eslint-disable-next-line no-var
  var __TEST_REOWN_STATE__: () => Promise<{ connected: boolean; address?: string; chainId?: number }>;
  // eslint-disable-next-line no-var
  var __TEST_LATEST_BRIDGE_RECEIVE__: (provider?: IBridgeProvider) => Promise<LatestBridgeReceive | null>;
}

interface LatestBridgeReceive {
  id: string;
  amount?: string;
  faucetId: string;
  phase?: IBridgedReceiveExtraInputs['phase'];
  displayMessage?: string;
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

  // Create a real WalletConnect pairing and return its `wc:` URI so a headless
  // test counterparty can pair — used instead of tapping the QR-modal "Open
  // Wallet" button. Ensures the native plugin is configured first (mirroring the
  // real UI's useNativeReown mount). The native imports are deferred to call time
  // so this is inert in the extension service-worker context (mobile-only).
  globalThis.__TEST_REOWN_CONNECT_URI__ = async (): Promise<string> => {
    console.log('[bridge-in-e2e] connectUri: configuring');
    const { configureNativeReown } = await import('lib/walletconnect/useNativeReown');
    await configureNativeReown();
    const { NativeReown } = await import('lib/walletconnect/native');
    // Sign.connect publishes the session proposal to the relay and hangs if the
    // relay socket isn't up yet — wait for it (best-effort; proceed after 20s).
    const deadline = Date.now() + 20_000;
    for (;;) {
      const st = await NativeReown.getState();
      console.log('[bridge-in-e2e] connectUri: socketStatus=', st.socketStatus, 'configured=', st.configured);
      if (st.socketStatus === 'connected') break;
      if (Date.now() > deadline) break;
      await new Promise(r => setTimeout(r, 750));
    }
    console.log('[bridge-in-e2e] connectUri: calling NativeReown.connectUri()');
    const { uri } = await NativeReown.connectUri();
    console.log('[bridge-in-e2e] connectUri: got uri len=', uri.length);
    return uri;
  };

  // Return the newest `bridged-receive` row (optionally filtered by provider),
  // so the deposit-UI harness can find the row that the REAL `handleConfirm`
  // created — it doesn't hand the txId back to the DOM — and then mint a
  // matching-amount note for the AggLayer reconcile.
  globalThis.__TEST_LATEST_BRIDGE_RECEIVE__ = async (
    provider?: IBridgeProvider
  ): Promise<LatestBridgeReceive | null> => {
    const rows = await Repo.transactions.filter(tx => tx.type === 'bridged-receive').toArray();
    const filtered = provider
      ? rows.filter(row => (row.extraInputs as IBridgedReceiveExtraInputs | undefined)?.provider === provider)
      : rows;
    filtered.sort((a, b) => b.initiatedAt - a.initiatedAt);
    const row = filtered[0];
    if (!row) return null;
    const inputs = row.extraInputs as IBridgedReceiveExtraInputs | undefined;
    return {
      id: row.id,
      amount: row.amount != null ? row.amount.toString() : undefined,
      faucetId: row.faucetId ?? '',
      phase: inputs?.phase,
      displayMessage: row.displayMessage
    };
  };

  // Read the native EVM (Reown) connection state, for asserting the pairing
  // settled (connected === true after the counterparty approves).
  globalThis.__TEST_REOWN_STATE__ = async (): Promise<{
    connected: boolean;
    address?: string;
    chainId?: number;
  }> => {
    const { NativeReown } = await import('lib/walletconnect/native');
    const state = await NativeReown.getState();
    return { connected: state.connected, address: state.address, chainId: state.chainId };
  };
}
