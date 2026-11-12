import React from 'react';

import { act, render, screen } from '@testing-library/react';

import { backgroundLockPending } from 'lib/lock-up/background-lock';

import { BackgroundLockCover } from './BackgroundLockCover';

const mockMiden = { ready: true };
jest.mock('lib/miden/front', () => ({ useMidenContext: () => mockMiden }));
jest.mock('app/a11y/RootSuspenseFallback', () => ({
  __esModule: true,
  default: ({ 'data-testid': testId }: { 'data-testid'?: string }) => <div data-testid={testId} />
}));


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

  it('makes a sheet appended to body after the cover rose inert, and releases it with the cover', async () => {
    renderWithSheet();
    act(() => backgroundLockPending.set(true));
    const late = document.createElement('div');
    late.setAttribute('data-testid', 'late-sheet');
    await act(async () => {
      document.body.appendChild(late);
    });
    expect(late.hasAttribute('inert')).toBe(true);

    act(() => backgroundLockPending.set(false));
    expect(late.hasAttribute('inert')).toBe(false);
    late.remove();
  });

  it('keeps an element that was inert before the cover rose inert after it drops', () => {
    const before = document.createElement('div');
    before.setAttribute('inert', '');
    document.body.appendChild(before);
    renderWithSheet();
    act(() => backgroundLockPending.set(true));
    act(() => backgroundLockPending.set(false));
    expect(before.hasAttribute('inert')).toBe(true);
    before.remove();
  });

  it('captures pointer input even while body has pointer-events none', () => {
    document.body.style.pointerEvents = 'none';
    renderWithSheet();
    act(() => backgroundLockPending.set(true));
    const layer = screen.getByTestId('wallet-locking').parentElement;
    expect(layer).toHaveClass('pointer-events-auto');
    document.body.style.pointerEvents = '';
  });
});
