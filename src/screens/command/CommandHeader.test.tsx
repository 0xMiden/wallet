import React from 'react';

import * as Dialog from '@radix-ui/react-dialog';
import { act, render, screen, within } from '@testing-library/react';

import type { AccountScope } from 'lib/miden-chain/account-scope';
import { WalletStatus, type WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import { CommandHeader } from './CommandHeader';

const personal: WalletAccount = {
  publicKey: 'wallet-account-a-private-identity',
  name: 'Personal savings',
  isPublic: false,
  type: WalletType.OnChain,
  hdIndex: 0,
  authScheme: 'ecdsa'
};
const work: WalletAccount = { ...personal, publicKey: 'wallet-account-b-private-identity', name: 'Work wallet' };
const personalScope: AccountScope = {
  accountId: personal.publicKey,
  network: 'testnet',
  rpcUrl: 'https://test.rpc.private'
};
const workScope: AccountScope = { accountId: work.publicKey, network: 'devnet', rpcUrl: 'https://dev.rpc.private' };
const networks = [
  { id: 'testnet', name: 'Testnet', rpcBaseURL: 'https://test.rpc.private', autoSync: true },
  { id: 'devnet', name: 'Devnet', rpcBaseURL: 'https://dev.rpc.private', autoSync: true }
];
let effectiveNetwork = 'testnet';
let effectiveRpc = 'https://test.rpc.private';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => effectiveNetwork,
  getEffectiveRpcUrl: () => effectiveRpc
}));
jest.mock('lib/miden/front/storage', () => ({
  usePassiveStorage: (_key: string, defaultValue: string) => [defaultValue, jest.fn()]
}));
const mockBridgeConfigListeners = new Set<() => void>();
jest.mock('lib/remote-config/runtime', () => ({
  subscribeBridgeConfig: (listener: () => void) => {
    mockBridgeConfigListeners.add(listener);
    return () => {
      mockBridgeConfigListeners.delete(listener);
    };
  }
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));

beforeEach(() => {
  effectiveNetwork = 'testnet';
  effectiveRpc = 'https://test.rpc.private';
  mockBridgeConfigListeners.clear();
  useWalletStore.setState({
    status: WalletStatus.Ready,
    currentAccount: personal,
    networks,
    selectedNetworkId: 'testnet'
  });
});

afterEach(() => {
  useWalletStore.setState({ currentAccount: null, networks: [], selectedNetworkId: null });
});

it('names the current wallet account and effective network in the pinned header without exposing addresses or endpoints', () => {
  render(
    <Dialog.Root>
      <CommandHeader scope={personalScope} />
    </Dialog.Root>
  );
  const header = screen.getByRole('banner');
  expect(within(header).getByText('Personal savings')).toBeVisible();
  expect(within(header).getByText('Testnet')).toBeVisible();
  expect(header.outerHTML).not.toContain(personal.publicKey);
  expect(header.outerHTML).not.toContain(effectiveRpc);
});

it('replaces the old account and stale stored network when the effective scope changes', () => {
  const view = render(
    <Dialog.Root>
      <CommandHeader scope={personalScope} />
    </Dialog.Root>
  );
  expect(within(screen.getByRole('banner')).getByText('Personal savings')).toBeVisible();
  act(() => {
    effectiveNetwork = 'devnet';
    effectiveRpc = 'https://dev.rpc.private';
    useWalletStore.setState({ currentAccount: work });
  });
  const header = screen.getByRole('banner');
  expect(header.outerHTML).not.toContain(personal.name);
  expect(header.outerHTML).not.toContain('Testnet');
  expect(within(header).queryByText('Work wallet')).not.toBeInTheDocument();
  view.rerender(
    <Dialog.Root>
      <CommandHeader scope={workScope} />
    </Dialog.Root>
  );
  expect(within(header).getByText('Work wallet')).toBeVisible();
  expect(within(header).getByText('Devnet')).toBeVisible();
  expect(header.outerHTML).not.toContain(personal.name);
  expect(header.outerHTML).not.toContain('Testnet');
  expect(header.outerHTML).not.toContain(work.publicKey);
  expect(header.outerHTML).not.toContain(effectiveRpc);
});

it('withholds account and network labels when the effective RPC changes within the same network', () => {
  render(
    <Dialog.Root>
      <CommandHeader scope={personalScope} />
    </Dialog.Root>
  );
  expect(within(screen.getByRole('banner')).getByText('Personal savings')).toBeVisible();
  act(() => {
    effectiveRpc = 'https://other.rpc.private';
    mockBridgeConfigListeners.forEach(listener => listener());
  });
  const header = screen.getByRole('banner');
  expect(header.outerHTML).not.toContain(personal.name);
  expect(header.outerHTML).not.toContain('Testnet');
  expect(header.outerHTML).not.toContain(effectiveRpc);
});

it('withholds the previous identity while the wallet is no longer ready', () => {
  render(
    <Dialog.Root>
      <CommandHeader scope={personalScope} />
    </Dialog.Root>
  );
  expect(within(screen.getByRole('banner')).getByText('Personal savings')).toBeVisible();
  act(() => useWalletStore.setState({ status: WalletStatus.Locked }));
  const header = screen.getByRole('banner');
  expect(header.outerHTML).not.toContain(personal.name);
  expect(header.outerHTML).not.toContain('Testnet');
});
