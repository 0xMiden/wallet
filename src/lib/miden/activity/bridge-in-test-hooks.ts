import * as Repo from 'lib/miden/repo';
import { ensureBridgeConfig } from 'lib/remote-config/runtime';

import { setAgglayerSenderForE2E } from './bridge-in';
import { startBridgeReceiveSubmission } from './bridge-receive';
import { IBridgedReceiveExtraInputs, IBridgeProvider, ITransactionStatus, IUsdcxCctpLeg } from '../db/types';
import { updateBridgedReceivePhase } from '../transaction/complete';
import { initiateBridgedReceiveTransaction } from '../transaction/initiate';

/**
 * E2E-only hooks for the bridge-IN harnesses, installed ONLY under `MIDEN_E2E_TEST` (the extension's service worker
 * from `back/main.ts`, the mobile app from `intercom/mobile-adapter.ts`), so this whole module (and the globals it
 * defines) is dead-stripped from production builds.
 *
 * Every iOS bridge-in row comes from the real deposit screen. These hooks supply what a spec cannot reach through the
 * UI: a `usdcx` tracking row for the Chrome USDCx suites, which sign their deposit in Node because the extension cannot
 * pair with Reown under its cross-origin isolation; the AggLayer sender-match pointed at a runtime-created solver
 * account; the Reown pairing URI and state; and reads of a row's state.
 */

interface CreateUsdcxBridgeReceiveArgs {
  accountId: string;
  amount: string; // base units (bigint as string across the evaluate boundary)
  faucetId: string;
  /** Stored on the row, which reads its USDCx route and Miden domain for this chain. */
  sourceChainId: number;
  sourceAddress: string;
  sourceAmount: string;
  sourceSymbol: string;
  /** The deposit's EVM hash; the row is moved to `delivering` with it, as the deposit screen does after its EVM tx. */
  evmTxHash: string;
  /**
   * An executor-route deposit signed outside the deposit screen: what runUsdcxExecutorDeposit (usdcx/executor.ts) wrote on
   * its `submitting` step. Without the forwarded CCTP leg the reconciler never asks Circle about the burn.
   */
  usdcxRemoteRecipient?: string;
  cctp?: Pick<IUsdcxCctpLeg, 'sourceDomain' | 'forwarded' | 'forwardFee'>;
}

/** The deposit facts a spec checks a bridged-receive row against. */
interface BridgeReceiveDepositFields {
  evmTxHash?: string;
  error?: string;
  midenNoteId?: string;
  sourceChainId?: number;
  usdcxRemoteRecipient?: string;
  /** Unix seconds the row first reached `ready`. */
  readyAt?: number;
  /** The Arc transaction the row took as its execute: Circle's forward, or the wallet's own execute. */
  usdcxExecuteTxHash?: string;
  /** Whether the burn paid Circle's forward fee: what an executor-route deposit writes on its `submitting` step. */
  cctpForwarded?: boolean;
  /** The quoted fee that burn paid on top of the amount, in source USDC base units. */
  cctpForwardFee?: string;
}

interface BridgeReceiveState extends BridgeReceiveDepositFields {
  found: boolean;
  phase?: IBridgedReceiveExtraInputs['phase'];
  displayMessage?: string;
  status?: ITransactionStatus;
  amount?: string;
  faucetId?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __TEST_CREATE_BRIDGE_RECEIVE__: (args: CreateUsdcxBridgeReceiveArgs) => Promise<string>;
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

interface LatestBridgeReceive extends BridgeReceiveDepositFields {
  id: string;
  amount?: string;
  faucetId: string;
  phase?: IBridgedReceiveExtraInputs['phase'];
  displayMessage?: string;
}

function depositFields(inputs: IBridgedReceiveExtraInputs | undefined): BridgeReceiveDepositFields {
  return {
    evmTxHash: inputs?.evmTxHash,
    error: inputs?.error,
    midenNoteId: inputs?.midenNoteId,
    sourceChainId: inputs?.sourceChainId,
    usdcxRemoteRecipient: inputs?.usdcxRemoteRecipient,
    readyAt: inputs?.readyAt,
    usdcxExecuteTxHash: inputs?.cctp?.executeTxHash,
    cctpForwarded: inputs?.cctp?.forwarded,
    cctpForwardFee: inputs?.cctp?.forwardFee
  };
}

export function installBridgeInTestHooks(): void {
  // Created and advanced inside the submission lock, as the deposit screen does: a `submitting` row with no hash and
  // no live submission is failed as an orphan by the app-root reconciler.
  globalThis.__TEST_CREATE_BRIDGE_RECEIVE__ = async ({
    evmTxHash,
    usdcxRemoteRecipient,
    cctp,
    ...args
  }: CreateUsdcxBridgeReceiveArgs) => {
    // The row reads the document's source route and Miden domain. A profile that never stored a document has nothing
    // to hydrate, and initBridgeConfig never waits for the network, so this waits for the first document.
    await ensureBridgeConfig();
    let advanced: Promise<void> | undefined;
    const txId = await startBridgeReceiveSubmission(
      // A USDCx row whatever the caller sends: every other provider's row comes from the deposit screen alone.
      () => initiateBridgedReceiveTransaction({ ...args, provider: 'usdcx', amount: BigInt(args.amount) }),
      id => {
        advanced = updateBridgedReceivePhase(id, 'delivering', {
          evmTxHash,
          ...(usdcxRemoteRecipient === undefined ? {} : { usdcxRemoteRecipient }),
          ...(cctp === undefined ? {} : { cctp })
        });
        return advanced;
      }
    );
    await advanced;
    return txId;
  };

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
      faucetId: row.faucetId,
      ...depositFields(inputs)
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
  // created - it doesn't hand the txId back to the DOM - and then mint the
  // scaled delivery for the AggLayer reconcile.
  globalThis.__TEST_LATEST_BRIDGE_RECEIVE__ = async (
    provider?: IBridgeProvider
  ): Promise<LatestBridgeReceive | null> => {
    const rows = await Repo.transactions.where('type').equals('bridged-receive').toArray();
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
      displayMessage: row.displayMessage,
      ...depositFields(inputs)
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
