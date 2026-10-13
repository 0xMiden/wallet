import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { WalletStatus } from 'lib/shared/types';

import { OnboardingNetwork } from './OnboardingNetwork';

let mockRequired = true;
let mockStatus = WalletStatus.Idle;
let mockExtension = true;
let mockNetwork = MIDEN_NETWORK_NAME.TESTNET;
const mockApply = jest.fn<Promise<void>, [{ networkName: string }]>(async () => {});
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
  getEffectiveNetworkName: () => mockNetwork,
  buildDefaultOverrideFor: (networkName: string) => ({ networkName }),
  applyEndpointOverride: (override: { networkName: string }) => mockApply(override)
}));
jest.mock('components/Button', () => ({
  Button: ({ title, onClick }: { title: string; onClick: () => void }) => <button onClick={onClick}>{title}</button>
}));
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
  expect(mockApply).toHaveBeenCalledWith({ networkName: MIDEN_NETWORK_NAME.MAINNET });
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
