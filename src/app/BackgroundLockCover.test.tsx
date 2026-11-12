import React from 'react';

import { act, render, screen } from '@testing-library/react';

import { backgroundLockPending } from 'lib/lock-up/background-lock';

const mockMiden = { ready: true };
jest.mock('lib/miden/front', () => ({ useMidenContext: () => mockMiden }));
jest.mock('app/a11y/RootSuspenseFallback', () => ({
  __esModule: true,
  default: ({ 'data-testid': testId }: { 'data-testid'?: string }) => <div data-testid={testId} />
}));

import { BackgroundLockCover } from './BackgroundLockCover';

const renderWithSheet = () =>
  render(
    <>
      <BackgroundLockCover />
      <div data-testid="open-sheet">
        <button>Approve</button>
      </div>
    </>
  );

beforeEach(() => {
  mockMiden.ready = true;
  act(() => backgroundLockPending.set(false));
});

afterEach(() => act(() => backgroundLockPending.set(false)));

describe('BackgroundLockCover', () => {
  it('renders nothing while no lock is pending', () => {
    renderWithSheet();
    expect(screen.queryByTestId('wallet-locking')).not.toBeInTheDocument();
    expect(screen.getByTestId('open-sheet').closest('[inert]')).toBeNull();
  });

  it('covers an open sheet and makes it inert while a lock is pending, then releases it', () => {
    renderWithSheet();
    act(() => backgroundLockPending.set(true));
    expect(screen.getAllByTestId('wallet-locking')).toHaveLength(1);
    expect(screen.getByTestId('open-sheet').closest('[inert]')).not.toBeNull();
    expect(screen.getByTestId('wallet-locking').closest('[inert]')).toBeNull();

    act(() => backgroundLockPending.set(false));
    expect(screen.queryByTestId('wallet-locking')).not.toBeInTheDocument();
    expect(screen.getByTestId('open-sheet').closest('[inert]')).toBeNull();
  });

  it('does not cover a wallet that is not ready', () => {
    mockMiden.ready = false;
    renderWithSheet();
    act(() => backgroundLockPending.set(true));
    expect(screen.queryByTestId('wallet-locking')).not.toBeInTheDocument();
    expect(screen.getByTestId('open-sheet').closest('[inert]')).toBeNull();
  });
});
