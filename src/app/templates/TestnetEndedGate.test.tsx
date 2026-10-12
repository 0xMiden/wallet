import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { markOnboardingFinishing } from 'app/onboarding-finish';
import { WalletStatus } from 'lib/shared/types';

import { TestnetEndedGate } from './TestnetEndedGate';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${Object.values(params).join(',')}` : key)
  })
}));

let storeState: { status: WalletStatus } = { status: WalletStatus.Ready };
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (s: unknown) => unknown) => selector(storeState)
}));

let mockInviteOnly: boolean | null = true;
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => ({}) }));
jest.mock('lib/remote-config/values', () => ({ selectInviteOnlyOnboarding: () => mockInviteOnly }));

let mockNetworkKey: 'testnet' | 'devnet' | 'localnet' | null = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getTestNetworkNameKey: () => mockNetworkKey
}));

// The marker: what the gate reads, and what its effect writes.
let mockSetUpUnderInvite = false;
const mockPut = jest.fn(async (_key: string, _value: unknown) => {});
jest.mock('lib/miden/front/storage', () => ({
  useStorage: () => [mockSetUpUnderInvite, jest.fn()],
  putToStorage: (key: string, value: unknown) => mockPut(key, value)
}));

const mockReset = jest.fn<Promise<void>, [(error: unknown) => Promise<void>]>();
jest.mock('lib/miden/reset-and-reload', () => ({
  resetWalletAndReload: (onWipeError: (error: unknown) => Promise<void>) => mockReset(onWipeError)
}));

const mockBackHandler = jest.fn();
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (...args: unknown[]) => mockBackHandler(...args)
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

describe('TestnetEndedGate', () => {
  beforeEach(() => {
    storeState = { status: WalletStatus.Ready };
    mockInviteOnly = true;
    mockNetworkKey = 'testnet';
    mockSetUpUnderInvite = false;
    mockPut.mockClear();
    mockReset.mockReset();
    mockReset.mockResolvedValue(undefined);
    mockBackHandler.mockClear();
  });

  it('covers a test-network wallet once the config is invite-only, and swallows back', () => {
    render(<TestnetEndedGate />);

    const gate = screen.getByTestId('testnet-ended-gate');
    expect(gate).toHaveAttribute('role', 'dialog');
    expect(gate).toHaveTextContent('testnetEndedTitle:testnet');
    expect(gate).toHaveTextContent('testnetEndedBody:testnet');
    expect(mockBackHandler).toHaveBeenCalledWith(expect.any(Function), [], { overlay: true });
    expect(mockBackHandler.mock.calls[0]?.[0]()).toBe(true);
  });

  it('covers a locked wallet too', () => {
    storeState = { status: WalletStatus.Locked };

    render(<TestnetEndedGate />);

    expect(screen.getByTestId('testnet-ended-gate')).toBeInTheDocument();
  });

  it.each([
    ['no wallet exists', () => (storeState = { status: WalletStatus.Idle })],
    ['the config is not invite-only', () => (mockInviteOnly = false)],
    ['no document sets the variant', () => (mockInviteOnly = null)],
    ['the wallet is on mainnet', () => (mockNetworkKey = null)],
    ['the wallet was set up under the invite-only config', () => (mockSetUpUnderInvite = true)]
  ])('renders nothing while %s', (_name, arrange) => {
    arrange();

    const { container } = render(<TestnetEndedGate />);

    expect(container).toBeEmptyDOMElement();
    expect(mockBackHandler).not.toHaveBeenCalled();
  });

  it('stays down while onboarding finishes, and records the invite-only setup', async () => {
    const mark = markOnboardingFinishing();
    try {
      const { container } = render(<TestnetEndedGate />);

      expect(container).toBeEmptyDOMElement();
      await waitFor(() => expect(mockPut).toHaveBeenCalledWith('invite_onboarding_setup_v1', true));
    } finally {
      act(() => mark.release());
    }
  });

  it('records no setup under a config that is not invite-only', () => {
    mockInviteOnly = false;
    const mark = markOnboardingFinishing();
    try {
      render(<TestnetEndedGate />);

      expect(mockPut).not.toHaveBeenCalled();
    } finally {
      act(() => mark.release());
    }
  });

  it('resets and reloads from its one action', async () => {
    render(<TestnetEndedGate />);

    fireEvent.click(screen.getByTestId('testnet-ended-reset'));

    await waitFor(() => expect(mockReset).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('testnet-ended-error')).not.toBeInTheDocument();
  });

  it('reports a wipe that rejected', async () => {
    mockReset.mockImplementationOnce(async onWipeError => {
      await onWipeError(new Error('wipe'));
    });
    render(<TestnetEndedGate />);

    fireEvent.click(screen.getByTestId('testnet-ended-reset'));

    await waitFor(() => expect(screen.getByTestId('testnet-ended-error')).toHaveTextContent('resetDidNotFinish'));
  });

  it('reports a reset that did not finish, and offers it again', async () => {
    mockReset.mockRejectedValueOnce(new Error('reload'));
    render(<TestnetEndedGate />);

    fireEvent.click(screen.getByTestId('testnet-ended-reset'));

    await waitFor(() => expect(screen.getByTestId('testnet-ended-error')).toHaveTextContent('resetDidNotFinish'));
    await waitFor(() => expect(screen.getByTestId('testnet-ended-reset')).toBeEnabled());
  });
});
