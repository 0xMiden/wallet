import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import PendingNotes from './PendingNotes';

// PendingNotes composes the claim hook + the PendingTab list; none of that is
// under test here. We only exercise the header's back affordance, which must
// stay usable when the page is opened cold in a fresh tab (e.g. via a
// received-note notification, which has no history to pop) — see #467.

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
let mockHistoryPosition = 0;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/woozie', () => ({
  goBack: (...args: unknown[]) => mockGoBack(...args),
  navigate: (...args: unknown[]) => mockNavigate(...args),
  useLocation: () => ({ historyPosition: mockHistoryPosition }),
  HistoryAction: { Push: 'push', Replace: 'replace' }
}));

jest.mock('lib/platform', () => ({
  isMobile: () => false
}));

jest.mock('app/env', () => ({
  useAppEnv: () => ({ fullPage: true, sidePanel: false })
}));

jest.mock('app/pages/Receive/PendingTab', () => ({
  // Exposes the list <-> detail transition the real tab reports, so the page's
  // header behaviour can be driven without rendering the tab.
  PendingTab: ({ onSelectedGroupChange }: { onSelectedGroupChange?: (faucetId: string | null) => void }) => (
    <div data-testid="pending-tab">
      <button data-testid="enter-detail" onClick={() => onSelectedGroupChange?.('faucet-a')} />
      <button data-testid="leave-detail" onClick={() => onSelectedGroupChange?.(null)} />
    </div>
  )
}));

let mockSpamNotes: Array<{ id: string }> = [];
jest.mock('lib/miden/front/claimable-notes', () => ({
  useClaimableNotesWithSpam: () => ({ visible: [], spam: mockSpamNotes, isLoading: false, mutate: jest.fn() })
}));

jest.mock('app/hooks/useClaimNotes', () => ({
  useClaimNotes: () => ({
    safeClaimableNotes: [],
    unclaimedNotes: [],
    account: { publicKey: 'mtst1account' },
    isDelegatedProvingEnabled: false,
    claimingNoteIds: new Set(),
    retriableNoteIds: new Set(),
    invalidNoteIds: new Set(),
    checkingNoteIds: new Set(),
    handleClaimingStateChange: jest.fn(),
    handleClaimAll: jest.fn(),
    handleClaimGroup: jest.fn()
  })
}));

describe('PendingNotes back affordance', () => {
  beforeEach(() => {
    mockGoBack.mockClear();
    mockNavigate.mockClear();
    mockHistoryPosition = 0;
  });

  it('renders the spam-bin button with a count of the notes the spam list is hiding', () => {
    mockSpamNotes = [{ id: 'a' }, { id: 'b' }];
    render(<PendingNotes />);

    const bin = screen.getByTestId('spam-bin-button');
    expect(bin).toHaveAttribute('aria-label', 'spamBinAriaLabel');
    expect(screen.getByTestId('spam-bin-count')).toHaveTextContent('2');

    fireEvent.click(bin);
    expect(mockNavigate).toHaveBeenCalledWith('/pending-notes/spam');
    mockSpamNotes = [];
  });

  it("offers the spam bin on the asset list only, not inside one asset's detail view", () => {
    render(<PendingNotes />);
    expect(screen.getByTestId('spam-bin-button')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('enter-detail'));
    expect(screen.queryByTestId('spam-bin-button')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('leave-detail'));
    expect(screen.getByTestId('spam-bin-button')).toBeInTheDocument();
  });

  it('keeps the spam-bin button (without a count) when nothing is hidden', () => {
    render(<PendingNotes />);
    expect(screen.getByTestId('spam-bin-button')).toBeInTheDocument();
    expect(screen.queryByTestId('spam-bin-count')).not.toBeInTheDocument();
  });

  it('pops history when there is a previous screen to return to', () => {
    mockHistoryPosition = 2;
    render(<PendingNotes />);

    fireEvent.click(screen.getByLabelText('back'));

    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('routes home instead of leaving a dead back button when opened cold (no history)', () => {
    // A received-note notification opens a fresh tab at the first history entry,
    // where history.go(-1) is a no-op — so back must fall back to the home route,
    // replacing rather than pushing so forward does not return here.
    mockHistoryPosition = 0;
    render(<PendingNotes />);

    fireEvent.click(screen.getByLabelText('back'));

    expect(mockNavigate).toHaveBeenCalledWith('/', 'replace');
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('horizontally insets the header (px-4) so it lines up with the px-4 body (#460)', () => {
    // The PendingTab body is `px-4`; NavigationHeader carries its own `px-4`
    // inset, so the back arrow + title line up with every row below.
    render(<PendingNotes />);

    const header = screen.getByLabelText('back').closest('.px-4');
    expect(header).not.toBeNull();
  });
});
