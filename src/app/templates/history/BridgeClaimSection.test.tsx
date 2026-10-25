import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { AgglayerRecoveryConfig } from 'lib/remote-config/schema';
import { NativeSessionChainNotApprovedError } from 'lib/walletconnect/native';
import { NO_EXPLORER_CHAIN } from 'lib/walletconnect/testing/chains';

import { BridgeClaimSection } from './BridgeClaimSection';
import { IHistoryEntry } from './IHistoryEntry';

let mockFeeCopy = 'worker-fee-copy';
jest.mock('lib/i18n', () => ({
  ...jest.requireActual('lib/i18n'),
  getMessage: (key: string) => (key === 'insufficientFeeAsset' ? mockFeeCopy : key)
}));
// t(key) echoes `t:<key>` so we can assert which label branch rendered.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { amount?: string }) =>
      key === 'insufficientFeeAsset' ? mockFeeCopy : options?.amount ? `t:${key}|${options.amount}` : `t:${key}`
  })
}));

// Only ITransactionStatus (the enum) is used at runtime.
jest.mock('lib/miden/db/types', () => ({
  ITransactionStatus: { Queued: 0, GeneratingTransaction: 1, Completed: 2, Failed: 3 }
}));

const mockGetCurrentMidenBlock = jest.fn(async () => 0);
const mockPollEpochIntentFill = jest.fn(
  async (..._a: unknown[]): Promise<{ status: string; fillTxHash?: string; fillChainId?: number }> => ({
    status: 'pending'
  })
);
jest.mock('lib/epoch', () => ({
  getCurrentMidenBlock: () => mockGetCurrentMidenBlock(),
  pollEpochIntentFill: (...a: unknown[]) => mockPollEpochIntentFill(...a)
}));

const mockInitiateConsumeFromId = jest.fn(async (..._a: unknown[]) => 'reclaim-tx-1');
// What the Reclaim button passes after the note id: delegate, manualRetry, no dApp origin, and what queued the row.
const RECLAIMS = [false, true, undefined, 'bridge_reclaim'] as const;
const mockRequestSWProcessing = jest.fn();
const mockUpdateBridgeClaimStatus = jest.fn(async (..._a: unknown[]) => undefined);
const mockPinAgglayerDeposit = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('lib/miden/activity', () => ({
  initiateConsumeTransactionFromId: (...a: unknown[]) => mockInitiateConsumeFromId(...a),
  pinAgglayerDeposit: (...a: unknown[]) => mockPinAgglayerDeposit(...a),
  requestSWTransactionProcessing: () => mockRequestSWProcessing(),
  updateBridgeClaimStatus: (...a: unknown[]) => mockUpdateBridgeClaimStatus(...a)
}));

const mockFindExitDeposit = jest.fn(async (..._a: unknown[]): Promise<unknown> => null);
const mockTrackerActive = jest.fn((_active: boolean) => undefined);
const mockClaimAgglayer = jest.fn(async (..._a: unknown[]) => ({ wait: async () => undefined, hash: '0xclaimhash' }));
// What each tracker poll resolved to: `true` stops the tracker, `false` keeps it polling.
const mockTrackerPolls: Promise<boolean>[] = [];
// The `poll` the panel last rendered, which the real tracker's ref calls on every later tick.
let mockLatestTrackerPoll: (() => Promise<boolean>) | undefined;
jest.mock('lib/agglayer', () => {
  const react = require('react');
  // The real deposit classifiers, so a fixture deposit is read exactly as the indexer's answer would be.
  const status = jest.requireActual('lib/agglayer/status');
  return {
    agglayerClaimedFields: status.agglayerClaimedFields,
    claimAgglayerDeposit: (...a: unknown[]) => mockClaimAgglayer(...a),
    findAgglayerExitDeposit: (...a: unknown[]) => mockFindExitDeposit(...a),
    isAgglayerDepositClaimed: status.isAgglayerDepositClaimed,
    isAgglayerDepositReady: status.isAgglayerDepositReady,
    // Drive the poll once so tests can surface a claimable deposit.
    useBridgeTracker: ({ active, poll }: { active: boolean; poll: () => Promise<boolean> }) => {
      mockTrackerActive(active);
      mockLatestTrackerPoll = poll;
      react.useEffect(() => {
        if (active) mockTrackerPolls.push(poll());
      }, [active]);
    }
  };
});

jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: 'acct-1' })
}));

let mockEvm = {
  provider: null as unknown,
  address: undefined as string | undefined,
  isConnected: false,
  connect: jest.fn()
};
jest.mock('lib/walletconnect/useEvmWalletProvider', () => ({
  useEvmWalletProvider: () => mockEvm
}));

const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({ navigate: (...a: unknown[]) => mockNavigate(...a) }));

jest.mock('lib/platform', () => ({ isExtension: () => false }));
jest.mock('lib/settings/helpers', () => ({ isDelegateProofEnabled: () => false }));
jest.mock('lib/mobile/haptics', () => ({ hapticMedium: jest.fn() }));
jest.mock('./transactionUtils', () => jest.requireActual('./transactionUtils'));

jest.mock('components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
    disabled
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}));
jest.mock('../HashChip', () => ({ __esModule: true, default: () => <span /> }));
jest.mock('components/ui/DetailCard', () => ({
  DetailRow: ({ label, children }: { label?: React.ReactNode; children?: React.ReactNode }) => (
    <div>
      {label}
      {children}
    </div>
  )
}));
jest.mock('./DetailSection', () => ({
  DetailSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));
jest.mock('./TransactionStatus', () => ({
  ExternalLinkValue: ({ href }: { href?: string }) => <a href={href}>explorer</a>
}));

// The registry's chains, plus one the wallet knows no explorer for.
jest.mock('lib/walletconnect/config', () => {
  const chains = jest.requireActual<typeof import('lib/walletconnect/testing/chains')>(
    'lib/walletconnect/testing/chains'
  );
  return chains.walletConnectConfigMock([chains.NO_EXPLORER_CHAIN]);
});

const FAILED = 3;
const UNCONFIRMED = 4;

function entry(overrides: Partial<IHistoryEntry> = {}): IHistoryEntry {
  return {
    txId: 'tx-1',
    bridgeProvider: 'epoch',
    bridgeDestinationAddress: '0xdead',
    status: FAILED,
    bridgeEpochStatus: 'failed',
    bridgeReclaimHeight: 1000,
    outputNoteIds: ['note-1'],
    ...overrides
  } as IHistoryEntry;
}

/**
 * Renders with `restoredFromBackup` defaulted to false.
 *
 * The prop is REQUIRED in production for a reason: its previous form read the
 * flag off `entry`, and the only production producer never set it, so every
 * guard in this panel read `undefined` and did nothing. Keep this helper as the
 * only place the default is written, so a restored-row case has to opt in
 * explicitly rather than inherit a fixture's silence.
 */
const renderSection = (props: { entry: IHistoryEntry; restoredFromBackup?: boolean; sentAmount?: bigint }) =>
  render(
    <BridgeClaimSection
      entry={props.entry}
      restoredFromBackup={props.restoredFromBackup ?? false}
      sentAmount={props.sentAmount}
    />
  );

const agglayer = (o: Partial<IHistoryEntry> = {}) =>
  entry({
    bridgeProvider: 'agglayer',
    status: 2,
    bridgeEpochStatus: undefined,
    bridgeClaimStatus: 'pending',
    bridgeAgglayerExitTxHash: '0xexit',
    ...o
  });

// This row's own exit deposit, ready on L1 and not yet claimed.
const READY = { id: 'deposit-1', tx_hash: '0xexit', deposit_cnt: 5, ready_for_claim: true };

describe('BridgeClaimSection', () => {
  beforeEach(() => {
    mockFeeCopy = 'worker-fee-copy';
    jest.clearAllMocks();
    // clearAllMocks keeps a queued *Once, so a block read a test never reaches would leak into the next.
    mockGetCurrentMidenBlock.mockReset().mockImplementation(async () => 0);
    mockEvm = { provider: null, address: undefined, isConnected: false, connect: jest.fn() };
    mockFindExitDeposit.mockReset().mockImplementation(async () => null);
    mockTrackerPolls.splice(0);
  });

  it('uses a saved route for lookup and reconnect after the remote route is removed', async () => {
    const route: AgglayerRecoveryConfig = {
      chainId: 84532,
      contractAddress: '0x00000000000000000000000000000000000000b3',
      midenBridgeId: '0x187cabbc404359d16be94954ca9879',
      indexerUrl: 'https://saved-indexer.example/api',
      rollupId: 73,
      evmNetworkId: 6
    };
    renderSection({ entry: agglayer({ bridgeAgglayerRoute: route }) });
    await waitFor(() => expect(mockFindExitDeposit).toHaveBeenCalledWith('0xdead', '0xexit', undefined, route));
    fireEvent.click(screen.getByText('t:connectEvmWallet'));
    expect(mockEvm.connect).toHaveBeenCalledWith(84532);
  });

  describe('failed Epoch bridge-out reclaim', () => {
    it('shows "reclaimable after block N" until the reclaim height is reached', async () => {
      mockGetCurrentMidenBlock.mockResolvedValueOnce(500); // below 1000
      renderSection({ entry: entry() });
      await waitFor(() => expect(mockGetCurrentMidenBlock).toHaveBeenCalled());
      expect(await screen.findByText(/t:reclaimableAfterBlock/)).toBeInTheDocument();
      expect(screen.queryByText('t:reclaimFunds')).not.toBeInTheDocument();
    });

    it('shows a Reclaim button once the height passes and consumes the note on click', async () => {
      mockGetCurrentMidenBlock.mockResolvedValueOnce(1200); // >= 1000
      renderSection({ entry: entry() });
      const btn = await screen.findByText('t:reclaimFunds');
      fireEvent.click(btn);
      // 4th arg = manualRetry. The button only exists behind an explicit tap, so
      // auto-consume's exponential backoff must not swallow it and answer with a
      // previously-failed reclaim's row id.
      await waitFor(() => expect(mockInitiateConsumeFromId).toHaveBeenCalledWith('acct-1', 'note-1', ...RECLAIMS));
      expect(mockRequestSWProcessing).not.toHaveBeenCalled(); // isExtension() mocked false
      expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction-full/reclaim-tx-1');
    });

    it('does not fetch the block or show reclaim UI for a non-failed epoch row', async () => {
      renderSection({ entry: entry({ status: 2, bridgeEpochStatus: 'pending' }) });
      expect(mockGetCurrentMidenBlock).not.toHaveBeenCalled();
      expect(screen.queryByText('t:reclaimFunds')).not.toBeInTheDocument();
      expect(screen.queryByText(/t:reclaimableAfterBlock/)).not.toBeInTheDocument();
    });

    it('surfaces an error when the reclaim consume fails', async () => {
      mockGetCurrentMidenBlock.mockResolvedValueOnce(1200);
      mockInitiateConsumeFromId.mockRejectedValueOnce(new Error('reclaim boom'));
      renderSection({ entry: entry() });
      fireEvent.click(await screen.findByText('t:reclaimFunds'));
      expect(await screen.findByText('reclaim boom')).toBeInTheDocument();
    });

    it('fee refusal uses localized fee copy and leaves the current view open', async () => {
      const { ClaimFeeRefusedError } = jest.requireActual<typeof import('lib/miden/transaction/initiate')>(
        'lib/miden/transaction/initiate'
      );
      const refusal = new ClaimFeeRefusedError();
      mockFeeCopy = 'localized-fee-copy';
      mockGetCurrentMidenBlock.mockResolvedValueOnce(1200);
      mockInitiateConsumeFromId.mockRejectedValueOnce(refusal);
      const log = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        renderSection({ entry: entry() });
        fireEvent.click(await screen.findByText('t:reclaimFunds'));

        expect(await screen.findByText('localized-fee-copy')).toBeInTheDocument();
        expect(screen.queryByText(refusal.message)).not.toBeInTheDocument();
        expect(mockNavigate).not.toHaveBeenCalled();
        expect(mockRequestSWProcessing).not.toHaveBeenCalled();
        expect(screen.getByText('t:reclaimFunds')).not.toBeDisabled();
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    });

    it('offers Reclaim for an unconfirmed failed row from its stamped height and note id (#1250)', async () => {
      mockGetCurrentMidenBlock.mockResolvedValueOnce(1200); // >= 1000
      renderSection({
        entry: entry({
          isUnconfirmed: true,
          bridgeEpochStatus: undefined,
          outputNoteIds: undefined,
          bridgeReclaimNoteId: 'note-stamped',
          bridgeSubmitClaimed: true
        })
      });
      fireEvent.click(await screen.findByText('t:reclaimFunds'));
      await waitFor(() =>
        expect(mockInitiateConsumeFromId).toHaveBeenCalledWith('acct-1', 'note-stamped', ...RECLAIMS)
      );
    });

    it('offers no Reclaim for an unconfirmed row whose submit was never claimed (#1250)', async () => {
      mockGetCurrentMidenBlock.mockResolvedValueOnce(1200); // >= 1000
      renderSection({
        entry: entry({
          isUnconfirmed: true,
          bridgeEpochStatus: undefined,
          outputNoteIds: undefined,
          bridgeReclaimNoteId: 'note-stamped'
        })
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(mockGetCurrentMidenBlock).not.toHaveBeenCalled();
      expect(screen.queryByText('t:reclaimFunds')).not.toBeInTheDocument();
      expect(screen.queryByText(/t:reclaimableAfterBlock/)).not.toBeInTheDocument();
    });

    it('offers no Reclaim for a failure before the note was sent, even with the stamped fields (#1250)', () => {
      renderSection({
        entry: entry({ bridgeEpochStatus: undefined, outputNoteIds: undefined, bridgeReclaimNoteId: 'note-stamped' })
      });
      expect(mockGetCurrentMidenBlock).not.toHaveBeenCalled();
      expect(screen.queryByText('t:reclaimFunds')).not.toBeInTheDocument();
      expect(screen.queryByText(/t:reclaimableAfterBlock/)).not.toBeInTheDocument();
    });

    it('offers no Reclaim for a definite failure whose note committed (#1250)', () => {
      renderSection({ entry: entry({ bridgeEpochStatus: undefined }) });
      expect(mockGetCurrentMidenBlock).not.toHaveBeenCalled();
      expect(screen.queryByText('t:reclaimFunds')).not.toBeInTheDocument();
      expect(screen.queryByText(/t:reclaimableAfterBlock/)).not.toBeInTheDocument();
    });

    it('offers no Reclaim for a route-failed row whose note never committed (#1250)', () => {
      // A row markBridgedSendFailed demoted before its pipeline claimed the submit never sent its
      // note, so without bridgeSubmitClaimed the stamped id is not read.
      renderSection({
        entry: entry({ bridgeEpochStatus: 'failed', outputNoteIds: undefined, bridgeReclaimNoteId: 'note-stamped' })
      });
      expect(mockGetCurrentMidenBlock).not.toHaveBeenCalled();
      expect(screen.queryByText('t:reclaimFunds')).not.toBeInTheDocument();
      expect(screen.queryByText(/t:reclaimableAfterBlock/)).not.toBeInTheDocument();
    });

    it('offers Reclaim for a row demoted after its pipeline claimed the submit, consuming its stamped note (#1250)', async () => {
      mockGetCurrentMidenBlock.mockResolvedValueOnce(1200); // >= 1000
      renderSection({
        entry: entry({
          bridgeEpochStatus: 'failed',
          outputNoteIds: undefined,
          bridgeReclaimNoteId: 'note-stamped',
          bridgeSubmitClaimed: true
        })
      });
      fireEvent.click(await screen.findByText('t:reclaimFunds'));
      await waitFor(() =>
        expect(mockInitiateConsumeFromId).toHaveBeenCalledWith('acct-1', 'note-stamped', ...RECLAIMS)
      );
    });

    it('offers no Reclaim for a definite failure whose pipeline had claimed its submit (#1250)', async () => {
      mockGetCurrentMidenBlock.mockResolvedValueOnce(1200); // >= 1000
      renderSection({
        entry: entry({
          bridgeEpochStatus: undefined,
          outputNoteIds: undefined,
          bridgeReclaimNoteId: 'note-stamped',
          bridgeSubmitClaimed: true
        })
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(mockGetCurrentMidenBlock).not.toHaveBeenCalled();
      expect(screen.queryByText('t:reclaimFunds')).not.toBeInTheDocument();
      expect(screen.queryByText(/t:reclaimableAfterBlock/)).not.toBeInTheDocument();
    });

    it('still offers Reclaim for an allocator-rejected row, consuming its committed note (#1250)', async () => {
      mockGetCurrentMidenBlock.mockResolvedValueOnce(1200); // >= 1000
      renderSection({ entry: entry({ bridgeReclaimNoteId: 'note-stamped' }) });
      fireEvent.click(await screen.findByText('t:reclaimFunds'));
      await waitFor(() => expect(mockInitiateConsumeFromId).toHaveBeenCalledWith('acct-1', 'note-1', ...RECLAIMS));
    });

    describe('a completed bridge-out', () => {
      // Its note committed; whether its intent was ever submitted is told by the intent fields alone.
      const completed = (o: Partial<IHistoryEntry> = {}) =>
        entry({ status: 2, bridgeEpochStatus: undefined, bridgeIntentNonce: undefined, ...o });
      const settle = () => act(async () => await new Promise(resolve => setTimeout(resolve, 0)));

      it('offers Reclaim for a completed bridge-out whose intent was never recorded, once its height passes (#1250)', async () => {
        mockGetCurrentMidenBlock.mockResolvedValueOnce(1200); // >= 1000
        renderSection({ entry: completed() });
        fireEvent.click(await screen.findByText('t:reclaimFunds'));
        await waitFor(() => expect(mockInitiateConsumeFromId).toHaveBeenCalledWith('acct-1', 'note-1', ...RECLAIMS));
      });

      it('shows no countdown for a completed bridge-out whose intent is not recorded yet (#1250)', async () => {
        mockGetCurrentMidenBlock.mockResolvedValueOnce(900); // below 1000
        renderSection({ entry: completed() });
        await settle();
        expect(screen.queryByText('t:reclaimFunds')).not.toBeInTheDocument();
        expect(screen.queryByText(/t:reclaimableAfterBlock/)).not.toBeInTheDocument();
      });

      it('offers nothing for a completed bridge-out with its intent recorded (#1250)', async () => {
        mockGetCurrentMidenBlock.mockResolvedValueOnce(1200); // >= 1000
        renderSection({ entry: completed({ bridgeIntentNonce: 'user:1', bridgeEpochStatus: 'pending' }) });
        await settle();
        expect(screen.queryByText('t:reclaimFunds')).not.toBeInTheDocument();
      });

      it('offers Reclaim for a completed bridge-out whose fill failed, once its height passes (#1250)', async () => {
        mockGetCurrentMidenBlock.mockResolvedValueOnce(1200); // >= 1000
        renderSection({ entry: completed({ bridgeIntentNonce: 'user:1', bridgeEpochStatus: 'failed' }) });
        fireEvent.click(await screen.findByText('t:reclaimFunds'));
        await waitFor(() => expect(mockInitiateConsumeFromId).toHaveBeenCalledWith('acct-1', 'note-1', ...RECLAIMS));
      });

      it('shows the countdown for a completed bridge-out whose fill failed (#1250)', async () => {
        mockGetCurrentMidenBlock.mockResolvedValueOnce(900); // below 1000
        renderSection({ entry: completed({ bridgeIntentNonce: 'user:1', bridgeEpochStatus: 'failed' }) });
        expect(await screen.findByText(/t:reclaimableAfterBlock/)).toBeInTheDocument();
        expect(screen.queryByText('t:reclaimFunds')).not.toBeInTheDocument();
      });

      it('offers nothing for a completed bridge-out whose fill is still pending (#1250)', async () => {
        mockGetCurrentMidenBlock.mockResolvedValueOnce(1200); // >= 1000
        renderSection({ entry: completed({ bridgeIntentNonce: 'user:1', bridgeEpochStatus: 'pending' }) });
        await settle();
        expect(screen.queryByText('t:reclaimFunds')).not.toBeInTheDocument();
        expect(screen.queryByText(/t:reclaimableAfterBlock/)).not.toBeInTheDocument();
      });

      it('offers nothing for a completed bridge-out whose recorded intent carries no nonce (#1250)', async () => {
        mockGetCurrentMidenBlock.mockResolvedValueOnce(1200); // >= 1000
        renderSection({ entry: completed({ bridgeEpochStatus: 'pending' }) });
        await settle();
        expect(screen.queryByText('t:reclaimFunds')).not.toBeInTheDocument();
      });

      it('offers nothing for a restored completed bridge-out without its intent (#1250)', async () => {
        mockGetCurrentMidenBlock.mockResolvedValueOnce(1200); // >= 1000
        renderSection({ entry: completed(), restoredFromBackup: true });
        await settle();
        expect(screen.queryByText('t:reclaimFunds')).not.toBeInTheDocument();
        expect(mockGetCurrentMidenBlock).not.toHaveBeenCalled();
      });
    });

    it('shows Not confirmed while unconfirmed and pending, then the live fill once it reports confirmed', async () => {
      mockPollEpochIntentFill.mockResolvedValueOnce({ status: 'confirmed' });
      renderSection({
        entry: entry({ isUnconfirmed: true, bridgeEpochStatus: 'pending', bridgeIntentNonce: 'nonce-1' })
      });
      expect(screen.getByText(/t:notConfirmed/)).toBeInTheDocument();
      expect(await screen.findByText(/t:confirmed/)).toBeInTheDocument();
    });
  });

  it.each([
    [5042002, 'Arc Testnet', 'https://explorer.testnet.arc.io'],
    [11155111, 'Sepolia', 'https://sepolia.etherscan.io'],
    [undefined, 'Sepolia', 'https://sepolia.etherscan.io']
  ])('uses destination network %s for the name and recipient link', (network, name, explorer) => {
    renderSection({ entry: entry({ bridgeProvider: 'usdcx', bridgeDestinationNetwork: network }) });

    expect(screen.getByText(`t:destinationNetwork${name}`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'explorer' })).toHaveAttribute('href', `${explorer}/address/0xdead`);
  });

  it.each([
    [5042002, 'https://explorer.testnet.arc.io'],
    [5042, 'https://explorer.arc.io']
  ])('links the destination transaction on %s to the destination explorer', (network, explorer) => {
    const hash = `0x${'a'.repeat(64)}`;
    render(
      <BridgeClaimSection
        entry={entry({ bridgeProvider: 'usdcx', bridgeDestinationNetwork: network })}
        restoredFromBackup={false}
        destinationTxHash={hash}
      />
    );
    expect(screen.getAllByRole('link', { name: 'explorer' }).map(link => link.getAttribute('href'))).toContain(
      `${explorer}/tx/${hash}`
    );
  });

  it('shows the recipient and the receiving transaction unlinked on a chain with no explorer', () => {
    render(
      <BridgeClaimSection
        entry={entry({ bridgeProvider: 'usdcx', bridgeDestinationNetwork: NO_EXPLORER_CHAIN.id })}
        restoredFromBackup={false}
        destinationTxHash={`0x${'a'.repeat(64)}`}
      />
    );

    expect(screen.getByText('t:destinationNetworkNo Explorer')).toBeInTheDocument();
    expect(screen.getByText('t:to')).toHaveTextContent('explorer');
    expect(screen.getByText('t:receivingTx')).toHaveTextContent('explorer');
    expect(screen.queryAllByRole('link', { name: 'explorer' })).toEqual([]);
  });

  describe('USDCx faucet consumption', () => {
    it('shows burn confirmation without claim, reclaim, or destination settlement actions', () => {
      renderSection({
        entry: entry({
          txType: 'bridged-send',
          bridgeProvider: 'usdcx',
          status: 2,
          usdcxBurn: { noteId: 'burn-note', destinationDomain: 0, phase: 'confirmed' }
        })
      });
      expect(screen.getByText('t:usdcxBurnConfirmed')).toBeInTheDocument();
      expect(screen.getByText('t:usdcxWithdrawalNotice')).toBeInTheDocument();
      expect(screen.queryByText('t:claimAsset')).not.toBeInTheDocument();
      expect(screen.queryByText('t:connectEvmWallet')).not.toBeInTheDocument();
      expect(screen.queryByText('t:reclaimFunds')).not.toBeInTheDocument();
      expect(mockGetCurrentMidenBlock).not.toHaveBeenCalled();
    });

    it('shows Confirmed after the balance check and keeps the burn result in the details', () => {
      renderSection({
        entry: entry({
          txType: 'bridged-send',
          bridgeProvider: 'usdcx',
          status: 2,
          usdcxBurn: {
            noteId: 'burn-note',
            destinationDomain: 26,
            phase: 'confirmed',
            destinationBalanceConfirmed: { balance: '1000000', blockNumber: '101' }
          }
        })
      });
      expect(screen.getByText('t:confirmed')).toBeInTheDocument();
      expect(screen.getByText('t:usdcxBurnTitlet:usdcxBurnConfirmed')).toBeInTheDocument();
    });

    describe('payout proof', () => {
      const payout = { transactionHash: `0x${'b'.repeat(64)}`, blockNumber: '120', value: '2436500' } as const;
      const burnRow = (burn: Partial<NonNullable<IHistoryEntry['usdcxBurn']>>, extra: Partial<IHistoryEntry> = {}) =>
        entry({
          txType: 'bridged-send',
          bridgeProvider: 'usdcx',
          bridgeDestinationNetwork: 5042002,
          status: 2,
          usdcxBurn: { noteId: 'burn-note', destinationDomain: 26, phase: 'confirmed', ...burn },
          ...extra
        });

      it('shows Received and Circle fee from the recorded payout', () => {
        renderSection({ entry: burnRow({ payout }), sentAmount: 5_000_000n });
        expect(screen.getByText('t:usdcxPayoutReceivedt:usdcxPayoutAmount|2.4365')).toBeInTheDocument();
        expect(screen.getByText('t:usdcxCircleFeet:usdcxPayoutAmount|2.5635')).toBeInTheDocument();
      });

      it('shows neither row for a legacy balance-confirmed row', () => {
        renderSection({
          entry: burnRow({ destinationBalanceConfirmed: { balance: '1000000', blockNumber: '101' } }),
          sentAmount: 5_000_000n
        });
        expect(screen.queryByText(/usdcxPayoutReceived/)).not.toBeInTheDocument();
        expect(screen.queryByText(/usdcxCircleFee/)).not.toBeInTheDocument();
        expect(screen.getByText('t:confirmed')).toBeInTheDocument();
      });

      it('shows no fee row when the paid amount is not below the sent amount', () => {
        renderSection({ entry: burnRow({ payout }), sentAmount: 2_436_500n });
        expect(screen.getByText('t:usdcxPayoutReceivedt:usdcxPayoutAmount|2.4365')).toBeInTheDocument();
        expect(screen.queryByText(/usdcxCircleFee/)).not.toBeInTheDocument();
      });

      it('links the recorded payout transaction', () => {
        render(
          <BridgeClaimSection
            entry={burnRow({ payout })}
            restoredFromBackup={false}
            sentAmount={5_000_000n}
            destinationTxHash={payout.transactionHash}
          />
        );
        expect(screen.getAllByRole('link', { name: 'explorer' }).map(link => link.getAttribute('href'))).toContain(
          `https://explorer.testnet.arc.io/tx/${payout.transactionHash}`
        );
        expect(screen.getByText('t:receivingTx')).toBeInTheDocument();
      });

      it('shows the delayed notice on a delayed row', () => {
        const settled = Date.now() - 3 * 3_600_000;
        renderSection({ entry: burnRow({ confirmedAt: settled }, { bridgeSettledAt: settled }) });
        expect(screen.getByText('t:usdcxPayoutDelayed')).toBeInTheDocument();
        expect(screen.getByText('t:usdcxPayoutDelayedNotice')).toBeInTheDocument();
        expect(screen.getByText('t:usdcxWithdrawalNotice')).toBeInTheDocument();
      });

      it('shows no delayed notice before 2 hours or on a paid row', () => {
        const recent = Date.now() - 60_000;
        const { unmount } = render(
          <BridgeClaimSection
            entry={burnRow({ confirmedAt: recent }, { bridgeSettledAt: recent })}
            restoredFromBackup={false}
          />
        );
        expect(screen.queryByText('t:usdcxPayoutDelayedNotice')).not.toBeInTheDocument();
        unmount();
        const old = Date.now() - 30 * 3_600_000;
        renderSection({
          entry: burnRow({ confirmedAt: old, payout }, { bridgeSettledAt: old }),
          sentAmount: 5_000_000n
        });
        expect(screen.queryByText('t:usdcxPayoutDelayedNotice')).not.toBeInTheDocument();
      });
    });

    it('keeps a sender-completed row pending until the faucet consumes its note', () => {
      renderSection({
        entry: entry({
          txType: 'bridged-send',
          bridgeProvider: 'usdcx',
          status: 2,
          usdcxBurn: { noteId: 'burn-note', destinationDomain: 0, phase: 'pending' }
        })
      });
      expect(screen.getByText('t:usdcxBurnPending')).toBeInTheDocument();
      expect(screen.queryByText('t:usdcxBurnConfirmed')).not.toBeInTheDocument();
    });

    it.each([
      { phase: 'consuming' as const, shown: true },
      { phase: 'confirmed' as const, shown: false }
    ])('shows the last processing error of a $phase burn: $shown', ({ phase, shown }) => {
      renderSection({
        entry: entry({
          txType: 'bridged-send',
          bridgeProvider: 'usdcx',
          status: 2,
          usdcxBurn: { noteId: 'burn-note', destinationDomain: 6, phase, attemptCount: 1, lastError: 'tx expired' }
        })
      });
      expect(screen.queryAllByText('tx expired')).toHaveLength(shown ? 1 : 0);
    });
  });

  describe('Agglayer (Slow) claim', () => {
    it('prompts to connect an EVM wallet when disconnected', () => {
      renderSection({ entry: agglayer() });
      expect(screen.getByText('t:connectEvmWallet')).toBeInTheDocument();
      // Epoch-only reclaim UI must not appear on an Agglayer row.
      expect(screen.queryByText('t:reclaimFunds')).not.toBeInTheDocument();
    });

    it('asks to connect the destination wallet when the connected address differs', () => {
      mockEvm = { provider: {}, address: '0xother', isConnected: true, connect: jest.fn() };
      renderSection({ entry: agglayer() });
      expect(screen.getByText('t:connectDestinationWalletToClaim')).toBeInTheDocument();
    });

    it('claims the deposit when connected to the destination wallet', async () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      mockFindExitDeposit.mockResolvedValueOnce(READY);
      renderSection({ entry: agglayer() });
      const claimBtn = await screen.findByText('t:claimAsset');
      fireEvent.click(claimBtn);
      await waitFor(() => expect(mockClaimAgglayer).toHaveBeenCalled());
    });

    // Route evidence has to name the deposit it is bound to, so `updateBridgeClaimStatus` can
    // tell this row's own claim apart from a sibling's (#1250).
    it("passes the found deposit's tx hash and pin as the tracker's ready write", async () => {
      mockFindExitDeposit.mockResolvedValueOnce({ ...READY, tx_hash: '0xdeposit-hash' });
      renderSection({ entry: agglayer({ bridgeClaimStatus: 'pending' }) });
      await waitFor(() =>
        expect(mockUpdateBridgeClaimStatus).toHaveBeenCalledWith(
          'tx-1',
          'ready',
          { depositReady: true, agglayerDepositCnt: 5 },
          '0xdeposit-hash'
        )
      );
    });

    it("passes the claimable deposit's tx hash and pin on handleClaim's claiming and claimed writes", async () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      mockFindExitDeposit.mockResolvedValueOnce({ ...READY, tx_hash: '0xdeposit-hash' });
      renderSection({ entry: agglayer() });
      fireEvent.click(await screen.findByText('t:claimAsset'));
      await waitFor(() =>
        expect(mockUpdateBridgeClaimStatus).toHaveBeenCalledWith(
          'tx-1',
          'claiming',
          { agglayerDepositCnt: 5 },
          '0xdeposit-hash'
        )
      );
      await waitFor(() =>
        expect(mockUpdateBridgeClaimStatus).toHaveBeenCalledWith(
          'tx-1',
          'claimed',
          { agglayerDepositCnt: 5, claimTxHash: '0xclaimhash' },
          '0xdeposit-hash'
        )
      );
    });

    it("looks the deposit up by THIS row's exit hash and pin, never its Miden transaction id", async () => {
      // Several bridge-outs can share one L1 destination. The claim the user
      // makes here is stamped onto this row, so the lookup has to be bound to
      // this row's own exit rather than the destination alone (#1325).
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      mockFindExitDeposit.mockImplementation(async (_dest: unknown, exitTxHash: unknown) =>
        exitTxHash === '0xrow-a-exit' ? { ...READY, id: 'deposit-a', tx_hash: '0xrow-a-exit', deposit_cnt: 41 } : null
      );
      renderSection({
        entry: agglayer({
          externalTxId: '0xmiden',
          bridgeAgglayerExitTxHash: '0xrow-a-exit',
          bridgeAgglayerDepositCnt: 41
        })
      });

      await waitFor(() => expect(mockFindExitDeposit).toHaveBeenCalledWith('0xdead', '0xrow-a-exit', 41, undefined));
      fireEvent.click(await screen.findByText('t:claimAsset'));
      await waitFor(() =>
        expect(mockClaimAgglayer).toHaveBeenCalledWith(
          expect.objectContaining({ deposit: expect.objectContaining({ id: 'deposit-a' }) })
        )
      );
    });

    it('stays on Claim Pending when no deposit belongs to this row', async () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      mockFindExitDeposit.mockImplementation(async (_dest: unknown, exitTxHash: unknown) =>
        exitTxHash === '0xrow-a-exit' ? { ...READY, id: 'deposit-a', tx_hash: '0xrow-a-exit' } : null
      );
      renderSection({ entry: agglayer({ bridgeAgglayerExitTxHash: '0xrow-b-exit' }) });

      await waitFor(() =>
        expect(mockFindExitDeposit).toHaveBeenCalledWith('0xdead', '0xrow-b-exit', undefined, undefined)
      );
      // The claim button stays disabled on "Claim Pending" (the same label also
      // renders in the status row) and never offers row A's deposit.
      expect(screen.getByRole('button', { name: 't:claimPending' })).toBeDisabled();
      expect(screen.queryByText('t:claimAsset')).not.toBeInTheDocument();
    });

    // The extension popup closes whenever focus moves to the EVM wallet, so a claim can die with its page and leave
    // the row `claiming` with nothing in flight. The deposit is still unclaimed, so it stays claimable.
    it('offers Claim on a row a closed page left claiming once its deposit is ready and unclaimed', async () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      mockFindExitDeposit.mockResolvedValueOnce(READY);
      renderSection({ entry: agglayer({ bridgeClaimStatus: 'claiming' }) });

      expect(await screen.findByRole('button', { name: 't:claimAsset' })).toBeEnabled();
    });

    it('ignores a second tap while its own claim is in flight', async () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      mockFindExitDeposit.mockResolvedValueOnce(READY);
      let finishClaim: (() => void) | undefined;
      mockClaimAgglayer.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishClaim = () => resolve({ wait: async () => undefined, hash: '0xclaimhash' });
          })
      );
      renderSection({ entry: agglayer() });
      fireEvent.click(await screen.findByText('t:claimAsset'));
      await waitFor(() => expect(mockClaimAgglayer).toHaveBeenCalledTimes(1));

      const inFlight = screen.getByRole('button', { name: 't:claiming' });
      expect(inFlight).toBeDisabled();
      fireEvent.click(inFlight);
      expect(mockClaimAgglayer).toHaveBeenCalledTimes(1);

      await act(async () => finishClaim?.());
      expect(await screen.findByText('t:claimAssetSubmitted')).toBeInTheDocument();
    });

    it('surfaces an error when the claim fails and the deposit is still unclaimed', async () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      mockFindExitDeposit.mockResolvedValueOnce(READY).mockResolvedValueOnce(READY);
      mockClaimAgglayer.mockRejectedValueOnce(new Error('claim boom'));
      renderSection({ entry: agglayer() });
      fireEvent.click(await screen.findByText('t:claimAsset'));
      expect(await screen.findByText('claim boom')).toBeInTheDocument();
      expect(mockUpdateBridgeClaimStatus).toHaveBeenCalledWith('tx-1', 'failed');
    });

    it('shows the localized reconnect message when the session error is wrapped as a cause', async () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      mockFindExitDeposit.mockResolvedValueOnce(READY).mockResolvedValueOnce(READY);
      mockClaimAgglayer.mockRejectedValueOnce(
        new Error('claim wrapper', { cause: new NativeSessionChainNotApprovedError(11155111, 'Sepolia') })
      );
      renderSection({ entry: agglayer() });
      fireEvent.click(await screen.findByText('t:claimAsset'));
      expect(await screen.findByText('t:evmChainNotApproved')).toBeInTheDocument();
    });

    it('offers Claim again once its own claim has failed', async () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      mockFindExitDeposit.mockResolvedValueOnce(READY).mockResolvedValueOnce(READY);
      mockClaimAgglayer.mockRejectedValueOnce(new Error('claim boom'));
      renderSection({ entry: agglayer() });
      fireEvent.click(await screen.findByText('t:claimAsset'));
      expect(await screen.findByText('claim boom')).toBeInTheDocument();

      expect(screen.getByRole('button', { name: 't:claimAsset' })).toBeEnabled();
    });

    it('surfaces the claim error when the re-check cannot reach the indexer', async () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      mockFindExitDeposit.mockResolvedValueOnce(READY).mockRejectedValueOnce(new Error('indexer down'));
      mockClaimAgglayer.mockRejectedValueOnce(new Error('claim boom'));
      renderSection({ entry: agglayer() });
      fireEvent.click(await screen.findByText('t:claimAsset'));
      expect(await screen.findByText('claim boom')).toBeInTheDocument();
      expect(mockUpdateBridgeClaimStatus).toHaveBeenCalledWith('tx-1', 'failed');
    });

    // The bridge's auto-claimer claims every exit minutes after it is ready, so the user's claim can
    // lose that race and revert. The deposit is claimed either way (#1325).
    it('settles the row instead of failing when the claim lost the race to another claim', async () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      mockFindExitDeposit.mockResolvedValueOnce(READY).mockResolvedValueOnce({ ...READY, claim_tx_hash: '0xauto' });
      mockClaimAgglayer.mockRejectedValueOnce(new Error('AlreadyClaimed'));
      renderSection({ entry: agglayer() });
      fireEvent.click(await screen.findByText('t:claimAsset'));

      expect(await screen.findByText('t:claimAssetSubmitted')).toBeInTheDocument();
      expect(mockFindExitDeposit).toHaveBeenLastCalledWith('0xdead', '0xexit', 5, undefined);
      expect(mockUpdateBridgeClaimStatus).toHaveBeenCalledWith(
        'tx-1',
        'claimed',
        { claimTxHash: '0xauto', agglayerDepositCnt: 5 },
        '0xexit'
      );
      expect(mockUpdateBridgeClaimStatus).not.toHaveBeenCalledWith('tx-1', 'failed');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('settles a row whose deposit someone else claimed, and stops polling', async () => {
      mockFindExitDeposit.mockResolvedValueOnce({ ...READY, claim_tx_hash: '0xauto' });
      renderSection({ entry: agglayer() });

      expect(await screen.findByText('t:claimAssetSubmitted')).toBeInTheDocument();
      expect(mockUpdateBridgeClaimStatus).toHaveBeenCalledWith(
        'tx-1',
        'claimed',
        { claimTxHash: '0xauto', agglayerDepositCnt: 5 },
        '0xexit'
      );
      await expect(mockTrackerPolls[0]).resolves.toBe(true);
    });

    it('keeps polling once the deposit is ready, so a later claim by anyone settles the row', async () => {
      mockFindExitDeposit.mockResolvedValueOnce(READY);
      renderSection({ entry: agglayer() });

      await expect(mockTrackerPolls[0]).resolves.toBe(false);
    });

    it('pins a deposit the indexer has filed but not readied, and keeps polling', async () => {
      mockFindExitDeposit.mockResolvedValueOnce({ ...READY, deposit_cnt: 9, ready_for_claim: false });
      renderSection({ entry: agglayer() });

      await expect(mockTrackerPolls[0]).resolves.toBe(false);
      expect(mockPinAgglayerDeposit).toHaveBeenCalledWith('tx-1', 9);
      expect(mockUpdateBridgeClaimStatus).not.toHaveBeenCalled();
    });

    // A reset indexer can leave a pin that names another exit, while the address page still finds this one. The next
    // tick has to go to the deposit found, or every tick pays a failed GET and a warning (#1325).
    describe('a pin the address page contradicts', () => {
      const elsewhere = { ...READY, deposit_cnt: 16 };
      const nextTick = () =>
        act(async () => {
          await mockLatestTrackerPoll?.();
        });

      it('is re-pinned on a ready row, and the next tick looks the deposit up there', async () => {
        mockFindExitDeposit.mockResolvedValue(elsewhere);
        renderSection({ entry: agglayer({ bridgeClaimStatus: 'ready', bridgeAgglayerDepositCnt: 5 }) });
        await act(async () => {
          await mockTrackerPolls[0];
        });
        expect(mockPinAgglayerDeposit).toHaveBeenCalledWith('tx-1', 16);

        await nextTick();

        expect(mockFindExitDeposit.mock.calls.map(call => call[2])).toEqual([5, 16]);
      });

      it('moves with the ready write of a pending row, and the next tick looks the deposit up there', async () => {
        mockFindExitDeposit.mockResolvedValue(elsewhere);
        renderSection({ entry: agglayer({ bridgeClaimStatus: 'pending', bridgeAgglayerDepositCnt: 5 }) });
        await act(async () => {
          await mockTrackerPolls[0];
        });
        expect(mockUpdateBridgeClaimStatus).toHaveBeenCalledWith(
          'tx-1',
          'ready',
          { depositReady: true, agglayerDepositCnt: 16 },
          '0xexit'
        );

        await nextTick();

        expect(mockFindExitDeposit.mock.calls.map(call => call[2])).toEqual([5, 16]);
        expect(mockPinAgglayerDeposit).not.toHaveBeenCalled();
      });
    });

    it('looks nothing up and offers no claim for a row with no exit hash', () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      renderSection({ entry: agglayer({ externalTxId: '0xmiden', bridgeAgglayerExitTxHash: undefined }) });

      expect(mockFindExitDeposit).not.toHaveBeenCalled();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.getByText(/t:claimPending/)).toBeInTheDocument();
    });

    // Filed under the indexer's old network id, which it no longer serves, so no lookup can find it (#1325).
    it('looks nothing up and offers no claim for a row no lookup can find, even with an exit hash', () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      renderSection({ entry: agglayer({ bridgeAgglayerExitUnfindable: true }) });

      expect(mockFindExitDeposit).not.toHaveBeenCalled();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.getByText(/t:claimPending/)).toBeInTheDocument();
    });

    it('leaves the tracker inactive for an Unconfirmed row with no exit hash, so no unbound lookup runs (#1081)', async () => {
      renderSection({
        entry: agglayer({
          status: UNCONFIRMED,
          isUnconfirmed: true,
          externalTxId: '0xmiden',
          bridgeAgglayerExitTxHash: undefined
        })
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(mockTrackerActive).toHaveBeenCalled();
      expect(mockTrackerActive.mock.calls.every(([active]) => active === false)).toBe(true);
      expect(mockFindExitDeposit).not.toHaveBeenCalled();
    });

    it('polls an Unconfirmed row by its exit hash, with no transaction id (#1081)', async () => {
      renderSection({ entry: agglayer({ status: UNCONFIRMED, isUnconfirmed: true, externalTxId: undefined }) });
      expect(mockTrackerActive).toHaveBeenLastCalledWith(true);
      await waitFor(() => expect(mockFindExitDeposit).toHaveBeenCalledWith('0xdead', '0xexit', undefined, undefined));
    });

    it('never polls a restored Unconfirmed row, though it has an exit hash (#1081)', async () => {
      mockFindExitDeposit.mockResolvedValue(READY);
      renderSection({ entry: agglayer({ status: UNCONFIRMED, isUnconfirmed: true }), restoredFromBackup: true });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(mockTrackerActive.mock.calls.every(([active]) => active === false)).toBe(true);
      expect(mockFindExitDeposit).not.toHaveBeenCalled();
    });

    it('shows the submitted state once the deposit is claimed', () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      renderSection({ entry: agglayer({ bridgeClaimStatus: 'claimed' }) });
      expect(screen.getByText('t:claimAssetSubmitted')).toBeInTheDocument();
    });

    // A Failed agglayer row can still be unconfirmed: the not-confirmed rule wins over
    // bridgeFailed, and live evidence (a found deposit, a claim, a lookup with no id) wins
    // over Not confirmed in turn (#1250).
    describe('an unconfirmed row', () => {
      it('reads Not confirmed and keeps the claim UI open while no deposit has been found', async () => {
        const row = agglayer({ status: FAILED, isUnconfirmed: true, bridgeAgglayerExitTxHash: '0xrow-exit' });
        renderSection({ entry: row });
        await waitFor(() =>
          expect(mockFindExitDeposit).toHaveBeenCalledWith('0xdead', '0xrow-exit', undefined, undefined)
        );
        expect(screen.getByText(/t:notConfirmed/)).toBeInTheDocument();
        expect(screen.queryByText(/t:bridgeFailed/)).not.toBeInTheDocument();
        expect(screen.getByText('t:connectEvmWallet')).toBeInTheDocument();
      });

      it('reads Claimable over Not confirmed once the tracker finds a deposit', async () => {
        mockFindExitDeposit.mockResolvedValueOnce(READY);
        renderSection({ entry: agglayer({ status: FAILED, isUnconfirmed: true }) });
        expect(await screen.findByText(/t:claimable/)).toBeInTheDocument();
      });

      it('reads Claimed over Not confirmed once bridgeClaimStatus is claimed', () => {
        renderSection({
          entry: agglayer({ status: FAILED, isUnconfirmed: true, bridgeClaimStatus: 'claimed' })
        });
        expect(screen.getByText(/t:claimed/)).toBeInTheDocument();
      });

      // The exit hash binds the lookup, so a row whose Miden transaction id was never read still polls.
      it('looks up a row with an exit hash and no transaction id', async () => {
        renderSection({ entry: agglayer({ status: FAILED, isUnconfirmed: true, externalTxId: undefined }) });
        await waitFor(() => expect(mockFindExitDeposit).toHaveBeenCalledWith('0xdead', '0xexit', undefined, undefined));
      });

      it('reads Not confirmed with no lookup and no claim UI when the row has no exit hash', () => {
        renderSection({
          entry: agglayer({
            status: FAILED,
            isUnconfirmed: true,
            externalTxId: '0xmiden',
            bridgeAgglayerExitTxHash: undefined
          })
        });
        expect(screen.getByText(/t:notConfirmed/)).toBeInTheDocument();
        expect(mockFindExitDeposit).not.toHaveBeenCalled();
        expect(screen.queryByText('t:connectEvmWallet')).not.toBeInTheDocument();
        expect(screen.queryByText('t:claimPending')).not.toBeInTheDocument();
      });

      it('keeps the confirmed-failed reading, with no lookup or claim UI, when the row never reports unconfirmed', () => {
        renderSection({ entry: agglayer({ status: FAILED }) });
        expect(screen.getByText(/t:bridgeFailed/)).toBeInTheDocument();
        expect(mockFindExitDeposit).not.toHaveBeenCalled();
        expect(screen.queryByText('t:connectEvmWallet')).not.toBeInTheDocument();
      });
    });
  });

  // Every affordance in this panel, asserted from ONE restored row. The guards
  // existed before this suite did and were all inert in production, because the
  // only producer of `entry` never set the flag — nothing here could have caught
  // that while the value came from the fixture. Driving them together off a
  // single prop is the point.
  describe('a row restored from a backup', () => {
    it('polls nothing and offers no affordance, whatever the row records', async () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      mockFindExitDeposit.mockResolvedValue(READY);
      mockPollEpochIntentFill.mockResolvedValue({ status: 'confirmed', fillTxHash: '0xfill', fillChainId: 11155111 });

      renderSection({
        entry: agglayer({ bridgeClaimStatus: 'pending', bridgeIntentNonce: 'nonce-1' }),
        restoredFromBackup: true
      });

      // Nothing is polled: no AggLayer deposit lookup, no Epoch fill poll, and
      // no Miden block read (which only the reclaim gate triggers).
      await waitFor(() => expect(screen.queryByText('t:claimAsset')).not.toBeInTheDocument());
      expect(mockFindExitDeposit).not.toHaveBeenCalled();
      expect(mockPollEpochIntentFill).not.toHaveBeenCalled();
      expect(mockGetCurrentMidenBlock).not.toHaveBeenCalled();
    });

    it('does not poll the Epoch fill for a restored pending row', async () => {
      mockPollEpochIntentFill.mockResolvedValue({ status: 'confirmed', fillTxHash: '0xfill', fillChainId: 11155111 });

      renderSection({
        entry: entry({
          status: 2,
          bridgeEpochStatus: 'pending',
          bridgeIntentNonce: 'nonce-1',
          bridgeReclaimHeight: undefined,
          outputNoteIds: undefined
        }),
        restoredFromBackup: true
      });

      // Give the effect the same window the non-restored case needs to fire in.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(mockPollEpochIntentFill).not.toHaveBeenCalled();
    });

    it('withholds the reclaim button on a failed Epoch row past its reclaim height', async () => {
      mockGetCurrentMidenBlock.mockResolvedValue(5000); // well past 1000

      renderSection({ entry: entry(), restoredFromBackup: true });

      await waitFor(() => expect(screen.queryByText('t:reclaimFunds')).not.toBeInTheDocument());
      expect(mockGetCurrentMidenBlock).not.toHaveBeenCalled();
    });

    it('still polls and offers the claim when the row is NOT restored', async () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      mockFindExitDeposit.mockResolvedValue(READY);

      renderSection({ entry: agglayer({ bridgeClaimStatus: 'pending' }) });

      await waitFor(() => expect(mockFindExitDeposit).toHaveBeenCalled());
    });
  });

  describe('Epoch (Fast) fill', () => {
    it('polls the fill and persists the confirmed status', async () => {
      mockPollEpochIntentFill.mockResolvedValue({ status: 'confirmed', fillTxHash: '0xfill', fillChainId: 11155111 });
      renderSection({
        entry: entry({
          status: 2,
          bridgeEpochStatus: 'pending',
          bridgeIntentNonce: 'nonce-1',
          bridgeReclaimHeight: undefined,
          outputNoteIds: undefined
        })
      });
      await waitFor(() => expect(mockPollEpochIntentFill).toHaveBeenCalled());
      await waitFor(() =>
        expect(mockUpdateBridgeClaimStatus).toHaveBeenCalledWith('tx-1', 'not-applicable', {
          epochStatus: 'confirmed',
          fillTxHash: '0xfill',
          fillChainId: 11155111
        })
      );
    });

    it('renders the receiving-tx link once the fill is confirmed', () => {
      renderSection({
        entry: entry({
          status: 2,
          bridgeEpochStatus: 'confirmed',
          bridgeFillTxHash: '0xfillhash',
          bridgeReclaimHeight: undefined,
          outputNoteIds: undefined
        })
      });
      expect(screen.getByText('t:receivingTx')).toBeInTheDocument();
    });
  });
});

const mockReportUserVisibleError = jest.fn();
jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: (...args: unknown[]) => mockReportUserVisibleError(...args)
}));

const expectErrorAfterDwell = async (id: string, surface: string) => {
  await act(async () => {
    jest.advanceTimersByTime(999);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([[id, surface]]);
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([[id, surface]]);
};

describe('user-visible bridge action errors', () => {
  const settle = () =>
    act(async () => {
      for (let tick = 0; tick < 30; tick++) {
        await Promise.resolve();
      }
    });
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    mockGetCurrentMidenBlock.mockReset().mockResolvedValue(1200);
    mockFindExitDeposit.mockReset().mockResolvedValue(READY);
    mockClaimAgglayer.mockReset().mockResolvedValue({ wait: async () => undefined, hash: 'synthetic-claim' });
    mockInitiateConsumeFromId.mockReset().mockResolvedValue('synthetic-reclaim');
    mockTrackerPolls.length = 0;
    mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
    mockFeeCopy = 'Visible claim fee refusal';
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports a live claim raw producer as raw_bridge_claim_failed', async () => {
    mockClaimAgglayer.mockRejectedValueOnce(new Error('private claim 42 at https://synthetic.invalid'));
    renderSection({ entry: agglayer() });
    await settle();
    fireEvent.click(screen.getByText('t:claimAsset'));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('private claim 42 at https://synthetic.invalid');
    await expectErrorAfterDwell('raw_bridge_claim_failed', 'inline');
  });

  it('reports the actual translated session refusal as evmChainNotApproved', async () => {
    mockClaimAgglayer.mockRejectedValueOnce(
      new Error('private wrapper', { cause: new NativeSessionChainNotApprovedError(11155111, 'Synthetic') })
    );
    renderSection({ entry: agglayer() });
    await settle();
    fireEvent.click(screen.getByText('t:claimAsset'));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('t:evmChainNotApproved');
    await expectErrorAfterDwell('evmChainNotApproved', 'inline');
  });

  it('reports a live reclaim raw producer as raw_bridge_reclaim_failed', async () => {
    mockInitiateConsumeFromId.mockRejectedValueOnce(new Error('private reclaim amount 42'));
    renderSection({ entry: entry() });
    await settle();
    fireEvent.click(screen.getByText('t:reclaimFunds'));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('private reclaim amount 42');
    await expectErrorAfterDwell('raw_bridge_reclaim_failed', 'inline');
  });

  it('reports the actual reclaim fee refusal as insufficientFeeAsset', async () => {
    const { ClaimFeeRefusedError } = jest.requireActual<typeof import('lib/miden/transaction/claim-fee')>(
      'lib/miden/transaction/claim-fee'
    );
    mockInitiateConsumeFromId.mockRejectedValueOnce(new ClaimFeeRefusedError());
    renderSection({ entry: entry() });
    await settle();
    fireEvent.click(screen.getByText('t:reclaimFunds'));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Visible claim fee refusal');
    await expectErrorAfterDwell('insufficientFeeAsset', 'inline');
  });

  it.each(['retry', 'unmount'])('cancels a live claim error on %s before dwell', async control => {
    mockClaimAgglayer.mockRejectedValueOnce(new Error('short claim failure'));
    const view = renderSection({ entry: agglayer() });
    await settle();
    fireEvent.click(screen.getByText('t:claimAsset'));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('short claim failure');
    await act(async () => {
      jest.advanceTimersByTime(999);
    });
    if (control === 'retry') {
      fireEvent.click(screen.getByText('t:claimAsset'));
      await settle();
    } else view.unmount();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });

  it('keeps the destination-wallet mismatch caution silent', async () => {
    mockEvm.address = '0xother';
    renderSection({ entry: agglayer() });
    await settle();
    expect(screen.getByText('t:connectDestinationWalletToClaim')).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });

  it('keeps a raced but successfully recovered claim silent', async () => {
    mockClaimAgglayer.mockRejectedValueOnce(new Error('private already claimed'));
    mockFindExitDeposit
      .mockResolvedValueOnce(READY)
      .mockResolvedValueOnce({ ...READY, claim_tx_hash: 'synthetic-recovered' });
    renderSection({ entry: agglayer() });
    await settle();
    fireEvent.click(screen.getByText('t:claimAsset'));
    await settle();
    expect(screen.getByText('t:claimAssetSubmitted')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });

  it('keeps a persisted failed bridge status and reclaim-height helper silent', async () => {
    mockGetCurrentMidenBlock.mockResolvedValue(500);
    renderSection({ entry: entry() });
    await settle();
    expect(screen.getByText(/t:bridgeFailed/)).toBeInTheDocument();
    expect(screen.getByText(/t:reclaimableAfterBlock/)).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });
});
