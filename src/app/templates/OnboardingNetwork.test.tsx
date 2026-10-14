import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { EndpointOverride } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { WalletStatus } from 'lib/shared/types';
import { WelcomeScreen } from 'screens/onboarding/common/Welcome';

import { OnboardingNetwork } from './OnboardingNetwork';

let mockRequired = true;
let mockStatus = WalletStatus.Idle;
let mockExtension = true;
let mockNetwork = MIDEN_NETWORK_NAME.TESTNET;
const mockApply = jest.fn<Promise<void>, [EndpointOverride]>(async () => {});
const mockRequest = jest.fn(async () => {});
const mockResetClient = jest.fn(async () => {});
const mockFollow = jest.fn();

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => ({}) }));
jest.mock('lib/remote-config/values', () => ({ selectInviteOnlyOnboarding: () => mockRequired }));
jest.mock('lib/remote-config/runtime', () => ({ followEffectiveNetwork: () => mockFollow() }));
jest.mock('lib/store', () => ({
  useWalletStore: (select: (state: { status: WalletStatus }) => WalletStatus) => select({ status: mockStatus })
}));
jest.mock('lib/platform', () => ({ isExtension: () => mockExtension }));
jest.mock('lib/miden/front', () => ({ request: () => mockRequest() }));
jest.mock('lib/miden/sdk/miden-client', () => ({ resetMidenClient: () => mockResetClient() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => mockNetwork,
  applyEndpointOverride: (override: EndpointOverride) => mockApply(override)
}));

// The network choice alone: every endpoint getter falls back to the build's mainnet defaults.
const MAINNET_CHOICE: EndpointOverride = {
  rpcUrl: '',
  proverUrl: '',
  noteTransportUrl: '',
  faucetUrl: '',
  faucetApiUrl: '',
  explorerUrl: '',
  guardianUrl: '',
  allowNoGuardian: false,
  networkName: MIDEN_NETWORK_NAME.MAINNET,
  presetName: MIDEN_NETWORK_NAME.MAINNET
};
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary' },
  Button: ({ title, onClick }: { title: string; onClick: () => void }) => <button onClick={onClick}>{title}</button>
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));
jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));
jest.mock('screens/onboarding/common/NoCodeSheet', () => ({ NoCodeSheet: () => null }));
jest.mock('components/ui/SubPageLayout', () => ({
  SubPageLayout: ({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  )
}));

const content = (inviteOnly: boolean) => <div data-testid="flow">{String(inviteOnly)}</div>;
const page = () => <OnboardingNetwork>{content}</OnboardingNetwork>;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequired = true;
  mockStatus = WalletStatus.Idle;
  mockExtension = true;
  mockNetwork = MIDEN_NETWORK_NAME.TESTNET;
  mockApply.mockResolvedValue(undefined);
  mockRequest.mockResolvedValue(undefined);
});

it('prepares mainnet and the service worker before onboarding', async () => {
  render(page());
  expect(screen.queryByTestId('flow')).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId('flow')).toHaveTextContent('true'));
  expect(mockApply).toHaveBeenCalledWith(MAINNET_CHOICE);
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockFollow).toHaveBeenCalledTimes(1);
});

it.each([WalletStatus.Locked, WalletStatus.Ready])('keeps an existing wallet on its network (%s)', status => {
  mockStatus = status;
  render(page());
  expect(screen.getByTestId('flow')).toBeInTheDocument();
  expect(mockApply).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
});

it('keeps general onboarding when invite-only mode is off', () => {
  mockRequired = false;
  render(page());
  expect(screen.getByTestId('flow')).toHaveTextContent('false');
  expect(mockApply).not.toHaveBeenCalled();
});

it('resets the shared client on mobile and desktop', async () => {
  mockExtension = false;
  render(page());
  await screen.findByTestId('flow');
  expect(mockResetClient).toHaveBeenCalledTimes(1);
  expect(mockRequest).not.toHaveBeenCalled();
});

it('keeps the code requirement when the network config changes', async () => {
  const view = render(page());
  await screen.findByTestId('flow');
  mockRequired = false;
  view.rerender(page());
  expect(screen.getByTestId('flow')).toHaveTextContent('true');
  expect(mockApply).toHaveBeenCalledTimes(1);
});

it('blocks onboarding when the worker update fails and allows a retry', async () => {
  mockRequest.mockRejectedValueOnce(new Error('Worker unavailable'));
  render(page());
  await screen.findByRole('alert');
  expect(screen.queryByTestId('flow')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'retry' }));
  await screen.findByTestId('flow');
  expect(mockApply).toHaveBeenCalledTimes(2);
});

it('applies the mainnet override when seven logo taps unlock the invite-only Welcome, before the code step', async () => {
  mockRequired = false;
  const onSubmit = jest.fn();
  render(
    <OnboardingNetwork>
      {(inviteOnly, onUnlockInviteOnly) => (
        <WelcomeScreen inviteOnly={inviteOnly} onUnlockInviteOnly={onUnlockInviteOnly} onSubmit={onSubmit} />
      )}
    </OnboardingNetwork>
  );
  const logo = screen.getByTestId('onboarding-bread-logo');
  for (let tap = 0; tap < 7; tap++) fireEvent.click(logo);
  fireEvent.click(await screen.findByRole('button', { name: 'iHaveACode' }));
  expect(mockApply).toHaveBeenCalledWith(MAINNET_CHOICE);
  expect(mockApply.mock.invocationCallOrder[0]).toBeLessThan(onSubmit.mock.invocationCallOrder[0]!);
  expect(onSubmit).toHaveBeenCalledWith('mainnet-access');
});

it('stores the switch from testnet as the network choice alone, with no endpoint pinned', async () => {
  render(page());
  await screen.findByTestId('flow');
  const [stored] = mockApply.mock.calls[0]!;
  expect(stored.rpcUrl).toBe('');
  expect(stored).toEqual(MAINNET_CHOICE);
});

it('writes nothing when the effective network is already mainnet', async () => {
  mockNetwork = MIDEN_NETWORK_NAME.MAINNET;
  render(page());
  await screen.findByTestId('flow');
  expect(mockApply).not.toHaveBeenCalled();
});

it('keeps a stored custom mainnet override through a Welcome mount', async () => {
  // A stored override names the effective network, so a custom mainnet one reads as mainnet here.
  mockNetwork = MIDEN_NETWORK_NAME.MAINNET;
  mockRequired = false;
  const view = render(page());
  await screen.findByTestId('flow');
  view.unmount();
  render(page());
  await screen.findByTestId('flow');
  expect(mockApply).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
});
