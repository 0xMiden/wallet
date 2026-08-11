import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import PendingNotes from './PendingNotes';

// PendingNotes composes the claim hook + the PendingTab list; none of that is
// under test here. We only exercise the header's back affordance, which must
// stay usable when the page is opened cold in a fresh tab (e.g. via a
// received-note notification, which has no history to pop) — see #467.

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/woozie', () => ({
  goBack: (...args: unknown[]) => mockGoBack(...args),
  navigate: (...args: unknown[]) => mockNavigate(...args)
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
    claimingNoteIds: [],
    failedNoteIds: [],
    checkingNoteIds: [],
    handleClaimingStateChange: jest.fn(),
    handleClaimAll: jest.fn(),
    handleClaimGroup: jest.fn()
  })
}));

function setHistoryLength(length: number) {
  Object.defineProperty(window.history, 'length', { configurable: true, value: length });
}

describe('PendingNotes back affordance', () => {
  beforeEach(() => {
    mockGoBack.mockClear();
    mockNavigate.mockClear();
  });

  it('pops history when there is a previous screen to return to', () => {
    setHistoryLength(3);
    render(<PendingNotes />);

    fireEvent.click(screen.getByLabelText('back'));

    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('routes home instead of leaving a dead back button when opened cold (no history)', () => {
    // A received-note notification opens a fresh tab (history length 1), where
    // history.go(-1) is a no-op — so back must fall back to the home route.
    setHistoryLength(1);
    render(<PendingNotes />);

    fireEvent.click(screen.getByLabelText('back'));

    expect(mockNavigate).toHaveBeenCalledWith('/');
    expect(mockGoBack).not.toHaveBeenCalled();
  });
});
