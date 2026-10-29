import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { EndpointOverride } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { WalletStatus } from 'lib/shared/types';
import { WelcomeScreen } from 'screens/onboarding/common/Welcome';

import { setOnboardingRegistrationActive } from './onboarding-registration';
import { OnboardingNetwork } from './OnboardingNetwork';

let mockRequired = true;
let mockStatus = WalletStatus.Idle;
let mockExtension = true;
let mockNetwork = MIDEN_NETWORK_NAME.TESTNET;
let mockDeveloperChoice = false;
const mockApply = jest.fn<Promise<void>, [EndpointOverride]>(async () => {});
const mockRequest = jest.fn(async () => {});
const mockResetClient = jest.fn(async () => {});
const mockFollow = jest.fn();

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => ({}) }));
jest.mock('lib/remote-config/use-mainnet-launch', () => ({
  ...jest.requireActual('lib/remote-config/use-mainnet-launch'),
  useMainnetLaunched: () => mockRequired
}));
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
  hasDeveloperNetworkChoice: () => mockDeveloperChoice,
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
  setOnboardingRegistrationActive(false);
  mockRequired = true;
  mockStatus = WalletStatus.Idle;
  mockExtension = true;
  mockNetwork = MIDEN_NETWORK_NAME.TESTNET;
  mockDeveloperChoice = false;
  mockApply.mockReset().mockResolvedValue(undefined);
  mockRequest.mockReset().mockResolvedValue(undefined);
});

it('prepares mainnet and the service worker before onboarding', async () => {
  render(page());
  expect(screen.queryByTestId('flow')).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId('flow')).toHaveTextContent('true'));
  expect(mockApply).toHaveBeenCalledWith(MAINNET_CHOICE);
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockFollow).toHaveBeenCalledTimes(1);
});

it('keeps an active Welcome state while launch preparation is pending', async () => {
  mockRequired = false;
  let finishApply!: () => void;
  mockApply.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finishApply = resolve;
      })
  );
  const StatefulFlow = ({ inviteOnly }: { inviteOnly: boolean }) => {
    const [value, setValue] = React.useState('');
    return (
      <div>
        <input aria-label="flow state" value={value} onChange={event => setValue(event.currentTarget.value)} />
        <span data-testid="invite-only">{String(inviteOnly)}</span>
      </div>
    );
  };
  const statefulPage = () => (
    <OnboardingNetwork>{inviteOnly => <StatefulFlow inviteOnly={inviteOnly} />}</OnboardingNetwork>
  );
  const view = render(statefulPage());

  fireEvent.change(screen.getByRole('textbox', { name: 'flow state' }), { target: { value: 'preserved state' } });
  mockRequired = true;
  view.rerender(statefulPage());
  await waitFor(() => expect(mockApply).toHaveBeenCalledWith(MAINNET_CHOICE));

  const flowState = view.container.querySelector<HTMLInputElement>('[aria-label="flow state"]');
  expect(flowState).toHaveValue('preserved state');
  expect(flowState?.parentElement?.parentElement).toHaveProperty('inert', true);
  expect(screen.getByTestId('invite-only')).toHaveTextContent('true');

  await act(async () => finishApply());
});

function mountHeldRegistration() {
  mockRequired = false;
  const StatefulFlow = ({ inviteOnly }: { inviteOnly: boolean }) => {
    const [value, setValue] = React.useState('');
    return (
      <div>
        <input aria-label="flow state" value={value} onChange={event => setValue(event.currentTarget.value)} />
        <span data-testid="invite-only">{String(inviteOnly)}</span>
      </div>
    );
  };
  const statefulPage = () => (
    <OnboardingNetwork>{inviteOnly => <StatefulFlow inviteOnly={inviteOnly} />}</OnboardingNetwork>
  );
  const view = render(statefulPage());
  fireEvent.change(screen.getByRole('textbox', { name: 'flow state' }), { target: { value: 'preserved state' } });
  act(() => {
    setOnboardingRegistrationActive(true);
  });
  mockRequired = true;
  view.rerender(statefulPage());
  return { view, statefulPage };
}

it('holds mainnet preparation while a registration attempt is in flight', () => {
  const { view } = mountHeldRegistration();
  const flowState = view.container.querySelector<HTMLInputElement>('[aria-label="flow state"]');

  expect(flowState).toHaveValue('preserved state');
  expect(mockApply).not.toHaveBeenCalled();
  expect(screen.getByTestId('invite-only')).toHaveTextContent('true');
  expect(flowState?.parentElement?.parentElement).toHaveProperty('inert', false);
});

it('rechecks registration after a child starts it in the same commit', () => {
  mockRequired = false;
  const LaunchRegistration = ({ inviteOnly }: { inviteOnly: boolean }) => {
    React.useEffect(() => {
      if (!inviteOnly) return;
      setOnboardingRegistrationActive(true);
      return () => setOnboardingRegistrationActive(false);
    }, [inviteOnly]);
    return <div data-testid="launch-registration">{String(inviteOnly)}</div>;
  };
  const statefulPage = () => (
    <OnboardingNetwork>{inviteOnly => <LaunchRegistration inviteOnly={inviteOnly} />}</OnboardingNetwork>
  );
  const view = render(statefulPage());

  mockRequired = true;
  view.rerender(statefulPage());

  expect(screen.getByTestId('launch-registration')).toHaveTextContent('true');
  expect(mockApply).not.toHaveBeenCalled();
});

it('prepares mainnet once a registration attempt ends with the wallet still idle', async () => {
  mountHeldRegistration();
  expect(mockApply).not.toHaveBeenCalled();

  act(() => {
    setOnboardingRegistrationActive(false);
  });

  await waitFor(() => expect(mockApply).toHaveBeenCalledWith(MAINNET_CHOICE));
  await waitFor(() => expect(mockFollow).toHaveBeenCalledTimes(1));
});

it('does not prepare when a registration attempt ends as the wallet leaves idle', async () => {
  const { view, statefulPage } = mountHeldRegistration();
  expect(mockApply).not.toHaveBeenCalled();
  expect(screen.getByTestId('invite-only')).toHaveTextContent('true');

  await act(async () => {
    mockStatus = WalletStatus.Ready;
    setOnboardingRegistrationActive(false);
    view.rerender(statefulPage());
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockApply).not.toHaveBeenCalled();
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

it('requires invite-only mode when the effective network is mainnet before launch', () => {
  mockRequired = false;
  mockStatus = WalletStatus.Ready;
  mockNetwork = MIDEN_NETWORK_NAME.MAINNET;
  render(page());
  expect(screen.getByTestId('flow')).toHaveTextContent('true');
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

it('blocks onboarding when the worker update fails, and a retry repeats it without rewriting the choice', async () => {
  // The stored choice takes effect at once, as the real cache does, so the retry finds mainnet already effective.
  mockApply.mockImplementation(async () => {
    mockNetwork = MIDEN_NETWORK_NAME.MAINNET;
  });
  let finishRefresh!: () => void;
  mockRequest
    .mockRejectedValueOnce(new Error('Worker unavailable'))
    .mockImplementationOnce(() => new Promise<void>(resolve => (finishRefresh = resolve)));
  render(page());
  await screen.findByRole('alert');
  expect(screen.queryByTestId('flow')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'retry' }));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
  expect(screen.queryByTestId('flow')).not.toBeInTheDocument();
  await act(async () => finishRefresh());

  await screen.findByTestId('flow');
  expect(mockApply).toHaveBeenCalledTimes(1);
  expect(mockFollow).toHaveBeenCalledTimes(1);
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

it('keeps general Testnet onboarding after launch when Developer Settings chose the network', async () => {
  mockDeveloperChoice = true;
  render(page());
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByTestId('flow')).toHaveTextContent('false');
  expect(mockApply).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
});

it('still prepares mainnet on the seven-tap unlock under a Developer Settings choice', async () => {
  mockDeveloperChoice = true;
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
  expect(onSubmit).toHaveBeenCalledWith('mainnet-access');
});

// Welcome mounts afresh after a Developer Settings save, which is what makes this choice reach the page.
it('leaves a fresh page on the saved network after an unmarked page prepared mainnet', async () => {
  const first = render(page());
  await waitFor(() => expect(screen.getByTestId('flow')).toHaveTextContent('true'));
  expect(mockApply).toHaveBeenCalledWith(MAINNET_CHOICE);
  first.unmount();

  mockDeveloperChoice = true;
  mockApply.mockClear();
  render(page());
  await act(async () => {});

  expect(screen.getByTestId('flow')).toHaveTextContent('false');
  expect(mockApply).not.toHaveBeenCalled();
});

it('shows the invite welcome during preparation and blocks later steps until mainnet is ready', async () => {
  mockRequired = false;
  let finishApply = () => {};
  mockApply.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finishApply = resolve;
      })
  );
  const view = render(
    <OnboardingNetwork requireInviteOnly showWhilePreparing>
      {content}
    </OnboardingNetwork>
  );
  expect(screen.getByTestId('flow')).toHaveTextContent('true');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();

  view.rerender(<OnboardingNetwork requireInviteOnly>{content}</OnboardingNetwork>);
  expect(screen.getByTestId('flow').parentElement).toHaveClass('pointer-events-none');
  expect(screen.getByRole('status')).toBeInTheDocument();

  await act(async () => finishApply());
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  expect(screen.getByTestId('flow').parentElement).not.toHaveClass('pointer-events-none');
});

it('covers hash-less Welcome after preparation fails and keeps it covered through Retry', async () => {
  let finishRetry!: () => void;
  mockApply.mockRejectedValueOnce(new Error('Storage unavailable')).mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finishRetry = resolve;
      })
  );
  render(<OnboardingNetwork showWhilePreparing>{content}</OnboardingNetwork>);

  expect(screen.getByTestId('flow')).toHaveTextContent('true');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));

  expect(await screen.findByRole('alert')).toHaveTextContent('devEndpointSaveFailed');
  const flow = screen.getByTestId('flow');
  expect(flow.parentElement).toHaveClass('pointer-events-none');
  expect(flow).toHaveAttribute('inert');

  fireEvent.click(screen.getByRole('button', { name: 'retry' }));
  await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('status')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(flow.parentElement).toHaveClass('pointer-events-none');
  expect(flow).toHaveAttribute('inert');

  await act(async () => finishRetry());
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  expect(flow.parentElement).not.toHaveClass('pointer-events-none');
  expect(flow).not.toHaveAttribute('inert');
});
