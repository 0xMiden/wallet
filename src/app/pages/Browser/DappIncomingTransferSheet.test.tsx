import React, { useState } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import type { PendingActivityItem } from 'app/templates/history/PendingActivityCard';
import type { ClaimableNoteWithMetadata } from 'lib/miden/front/claimable-notes';
import { resetActivityReadState } from 'lib/settings/activity-read';

import { DappIncomingTransferSheet } from './DappIncomingTransferSheet';

let mockClaimItems: PendingActivityItem[] = [];
let mockHiddenIds = new Set<string>();
const mockAccept = jest.fn();
const mockRetryHeld = jest.fn();
const mockHideForeground = jest.fn();
jest.mock('app/hooks/useActivityClaims', () => ({
  useActivityClaims: () => ({
    items: mockClaimItems,
    accept: (...args: unknown[]) => mockAccept(...args),
    acceptMany: jest.fn(),
    retryHeld: (...args: unknown[]) => mockRetryHeld(...args),
    cannotPayFee: [],
    account: { publicKey: 'account' },
    isLoadingNotes: false
  })
}));
jest.mock('app/hooks/useActivityHiddenNotes', () => ({
  useActivityHiddenNotes: () => ({
    ids: mockHiddenIds,
    loaded: true,
    hide: jest.fn(async () => true),
    restore: jest.fn(async () => true)
  })
}));
jest.mock('lib/ui/dialog', () => ({ useConfirm: () => jest.fn(async () => false) }));
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => undefined }));
jest.mock('lib/remote-config/token-labels', () => ({
  midenTokenLabel: (_snapshot: unknown, _faucet: string, symbol: string) => symbol
}));
jest.mock('app/providers/DappBrowserProvider', () => ({
  useHideForegroundDappWhileOpen: (open: boolean) => mockHideForeground(open)
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ children, onOpenChange }: { children: React.ReactNode; onOpenChange: (open: boolean) => void }) => (
    <div role="dialog">
      {children}
      <button onClick={() => onOpenChange(false)}>Dismiss sheet</button>
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}));
jest.mock('lib/animation', () => ({
  springs: { standard: {}, settle: {} },
  useMotion: () => ({ duration: 0 }),
  usePreset: () => ({ initial: {}, animate: {}, exit: {}, transition: {} }),
  reducedMotionTransition: { duration: 0 }
}));
jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
  IconName: { ArrowUpDown: 'ArrowUpDown', Receive: 'Receive', ChevronDown: 'ChevronDown' }
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));
jest.mock('lib/telemetry/user-visible-error-contract', () => ({}));
jest.mock('lib/i18n/numbers', () => ({ formatBigInt: () => '1', getAdaptiveDecimalPlaces: () => 3 }));
jest.mock('lib/i18n/amount-display', () => ({ formatAmountDisplay: () => '1.000' }));
jest.mock('lib/i18n/hold-deadline', () => ({ formatHoldDeadline: () => 'later' }));
jest.mock('lib/settings/activity-read', () => ({
  markActivityRead: jest.fn(),
  isActivityRead: () => false,
  useActivityReadState: () => ({}),
  resetActivityReadState: jest.fn()
}));

const note: ClaimableNoteWithMetadata = {
  id: 'note-1',
  faucetId: 'faucet',
  amount: '1000000',
  senderAddress: 'mtst1senderaddress0000',
  isBeingClaimed: false,
  type: 'unknown',
  metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
};
function item(
  status: PendingActivityItem['status'] = 'pending',
  over: Partial<PendingActivityItem> = {}
): PendingActivityItem {
  return { note, status, ...over };
}
function Harness({ onClose = jest.fn() }: { onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  return open ? (
    <DappIncomingTransferSheet
      onClose={() => {
        setOpen(false);
        onClose();
      }}
    />
  ) : null;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetActivityReadState();
  mockClaimItems = [item()];
  mockHiddenIds = new Set();
});

describe('DappIncomingTransferSheet', () => {
  it('renders production pending cards, and no click means no consume call', () => {
    render(<DappIncomingTransferSheet onClose={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'activityAcceptTransfer' })).toBeInTheDocument();
    expect(mockAccept).not.toHaveBeenCalled();
    expect(mockHideForeground).toHaveBeenCalledWith(true);
  });

  it.each([
    ['hidden pending', item('pending')],
    ['hidden failure', item('failed')]
  ])('withholds a %s card from the sensitive review list', (_name, claim) => {
    mockClaimItems = [claim];
    mockHiddenIds = new Set([note.id]);
    render(<DappIncomingTransferSheet onClose={jest.fn()} />);

    expect(screen.queryByRole('button', { name: 'activityAcceptTransfer' })).not.toBeInTheDocument();
    expect(screen.getByText('noOperationsFound')).toBeInTheDocument();
  });

  it.each([
    ['cached', item('pending', { note: { ...note, fromCache: true } })],
    ['fee-refused', item('pending', { cannotPayFee: true })]
  ])('does not offer acceptance for %s notes', (_name, claim) => {
    mockClaimItems = [claim];
    render(<DappIncomingTransferSheet onClose={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'activityAcceptTransfer' })).toBeDisabled();
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('retains the existing in-flight and held-card actions', () => {
    mockClaimItems = [item('claiming'), item('claiming', { note: { ...note, id: 'held' }, held: true })];
    render(<DappIncomingTransferSheet onClose={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'activityAcceptingTransfer' })).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(mockRetryHeld).toHaveBeenCalledWith(expect.objectContaining({ held: true }));
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('shows the existing empty state when the pending note disappears', () => {
    const { rerender } = render(<DappIncomingTransferSheet onClose={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'activityAcceptTransfer' })).toBeInTheDocument();
    mockClaimItems = [];
    rerender(<DappIncomingTransferSheet onClose={jest.fn()} />);
    expect(screen.queryByRole('button', { name: 'activityAcceptTransfer' })).not.toBeInTheDocument();
    expect(screen.getByText('noOperationsFound')).toBeInTheDocument();
  });

  it('does not cancel a pending accept when the sheet is dismissed during processing', async () => {
    let finish: (() => void) | undefined;
    let completed = false;
    mockAccept.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = () => {
            completed = true;
            resolve();
          };
        })
    );
    const onClose = jest.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'activityAcceptTransfer' }));
    expect(mockAccept).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss sheet' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    await act(async () => finish?.());
    expect(completed).toBe(true);
    expect(mockAccept).toHaveBeenCalledTimes(1);
  });
});
