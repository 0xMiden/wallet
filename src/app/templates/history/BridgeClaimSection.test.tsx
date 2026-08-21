import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { BridgeClaimSection } from './BridgeClaimSection';
import { IHistoryEntry } from './IHistoryEntry';

// t(key) echoes `t:<key>` so we can assert which label branch rendered.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => `t:${key}` })
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
const mockRequestSWProcessing = jest.fn();
jest.mock('lib/miden/activity', () => ({
  initiateConsumeTransactionFromId: (...a: unknown[]) => mockInitiateConsumeFromId(...a),
  requestSWTransactionProcessing: () => mockRequestSWProcessing(),
  updateBridgeClaimStatus: jest.fn(async () => undefined)
}));

const mockFindClaimable = jest.fn(async (..._a: unknown[]) => null as unknown);
const mockClaimAgglayer = jest.fn(async (..._a: unknown[]) => ({ wait: async () => undefined, hash: '0xclaimhash' }));
jest.mock('lib/agglayer', () => {
  const react = require('react');
  return {
    claimAgglayerDeposit: (...a: unknown[]) => mockClaimAgglayer(...a),
    findClaimableMidenToEvmDeposit: (...a: unknown[]) => mockFindClaimable(...a),
    // Drive the poll once so tests can surface a claimable deposit.
    useBridgeTracker: ({ active, poll }: { active: boolean; poll: () => Promise<boolean> }) => {
      react.useEffect(() => {
        if (active) void poll();
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
jest.mock('./transactionUtils', () => ({}));

jest.mock('lib/ui/button', () => ({
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
jest.mock('./DetailCard', () => ({
  DetailCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DetailRow: ({
    label,
    children,
    value
  }: {
    label?: React.ReactNode;
    children?: React.ReactNode;
    value?: React.ReactNode;
  }) => (
    <div>
      {label}
      {children ?? value}
    </div>
  ),
  ExternalLinkValue: () => <span />
}));

const FAILED = 3;

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
const renderSection = (props: { entry: IHistoryEntry; restoredFromBackup?: boolean; onUpdated?: () => void }) =>
  render(
    <BridgeClaimSection
      entry={props.entry}
      restoredFromBackup={props.restoredFromBackup ?? false}
      onUpdated={props.onUpdated ?? jest.fn()}
    />
  );

const agglayer = (o: Partial<IHistoryEntry> = {}) =>
  entry({
    bridgeProvider: 'agglayer',
    status: 2,
    bridgeEpochStatus: undefined,
    bridgeClaimStatus: 'pending',
    ...o
  });

describe('BridgeClaimSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEvm = { provider: null, address: undefined, isConnected: false, connect: jest.fn() };
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
      await waitFor(() => expect(mockInitiateConsumeFromId).toHaveBeenCalledWith('acct-1', 'note-1', false));
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
      mockFindClaimable.mockResolvedValueOnce({ id: 'deposit-1' });
      renderSection({ entry: agglayer() });
      const claimBtn = await screen.findByText('t:claimAsset');
      fireEvent.click(claimBtn);
      await waitFor(() => expect(mockClaimAgglayer).toHaveBeenCalled());
    });

    it('surfaces an error when the claim fails', async () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      mockFindClaimable.mockResolvedValueOnce({ id: 'deposit-1' });
      mockClaimAgglayer.mockRejectedValueOnce(new Error('claim boom'));
      renderSection({ entry: agglayer() });
      fireEvent.click(await screen.findByText('t:claimAsset'));
      expect(await screen.findByText('claim boom')).toBeInTheDocument();
    });

    it('shows the submitted state once the deposit is claimed', () => {
      mockEvm = { provider: {}, address: '0xdead', isConnected: true, connect: jest.fn() };
      renderSection({ entry: agglayer({ bridgeClaimStatus: 'claimed' }) });
      expect(screen.getByText('t:claimAssetSubmitted')).toBeInTheDocument();
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
      mockFindClaimable.mockResolvedValue({ deposit: true });
      mockPollEpochIntentFill.mockResolvedValue({ status: 'confirmed', fillTxHash: '0xfill', fillChainId: 11155111 });

      renderSection({
        entry: agglayer({ bridgeClaimStatus: 'pending', bridgeIntentNonce: 'nonce-1' }),
        restoredFromBackup: true
      });

      // Nothing is polled: no AggLayer deposit lookup, no Epoch fill poll, and
      // no Miden block read (which only the reclaim gate triggers).
      await waitFor(() => expect(screen.queryByText('t:claimAsset')).not.toBeInTheDocument());
      expect(mockFindClaimable).not.toHaveBeenCalled();
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
      mockFindClaimable.mockResolvedValue({ deposit: true });

      renderSection({ entry: agglayer({ bridgeClaimStatus: 'pending' }) });

      await waitFor(() => expect(mockFindClaimable).toHaveBeenCalled());
    });
  });

  describe('Epoch (Fast) fill', () => {
    it('polls the fill and persists the confirmed status', async () => {
      mockPollEpochIntentFill.mockResolvedValue({ status: 'confirmed', fillTxHash: '0xfill', fillChainId: 11155111 });
      const onUpdated = jest.fn();
      renderSection({
        entry: entry({
          status: 2,
          bridgeEpochStatus: 'pending',
          bridgeIntentNonce: 'nonce-1',
          bridgeReclaimHeight: undefined,
          outputNoteIds: undefined
        }),
        onUpdated
      });
      await waitFor(() => expect(mockPollEpochIntentFill).toHaveBeenCalled());
      await waitFor(() => expect(onUpdated).toHaveBeenCalled());
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
