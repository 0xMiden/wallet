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
  PendingTab: () => <div data-testid="pending-tab" />
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
