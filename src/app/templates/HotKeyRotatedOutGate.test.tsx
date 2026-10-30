import React from 'react';

import { render, screen } from '@testing-library/react';

import type { HotKeyRotatedOutVerdict } from 'lib/shared/types';

import { HotKeyRotatedOutGate } from './HotKeyRotatedOutGate';

const mockMark = jest.fn(async () => undefined);
const mockReadReceipt = jest.fn<string | undefined, []>(() => '0xrevocation');
const mockAccount: {
  publicKey: string;
  hotPublicKey: string;
  coldPublicKey: string;
  hotKeyRotatedOut?: HotKeyRotatedOutVerdict;
} = { publicKey: 'account', hotPublicKey: 'hot', coldPublicKey: 'cold' };
const mockState = {
  currentAccount: mockAccount,
  markHotKeyRotatedOut: mockMark,
  retireRotatedOutHotKey: jest.fn()
};
jest.mock('app/icons/v2', () => ({ Icon: () => null, IconName: {} }));
jest.mock('lib/store', () => ({
  useWalletStore: <T,>(selector: (state: typeof mockState) => T) => selector(mockState)
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/miden/front/useDeviceRevocation', () => ({ useDeviceRevocation: () => mockReadReceipt() }));
jest.mock('lib/miden-chain/constants', () => ({ getExplorerTxUrl: (id: string) => `https://explorer.test/tx/${id}` }));
jest.mock('lib/ui/dialog', () => ({ useAlert: () => jest.fn(), useConfirm: () => jest.fn() }));
jest.mock('lib/miden/reset-and-reload', () => ({ resetWalletAndReload: jest.fn() }));
jest.mock('components/ui/AlertSheet', () => ({
  AlertSheet: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  )
}));
jest.mock('lib/woozie', () => ({ Link: () => null }));

beforeEach(() => {
  jest.clearAllMocks();
  delete mockAccount.hotKeyRotatedOut;
  mockReadReceipt.mockReturnValue('0xrevocation');
});

it('does not read receipts or mark a device revoked before a Guardian verdict', () => {
  render(<HotKeyRotatedOutGate />);
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  expect(mockReadReceipt).not.toHaveBeenCalled();
  expect(mockMark).not.toHaveBeenCalled();
});

it('shows the transaction link after the Guardian confirms this key was revoked', () => {
  mockAccount.hotKeyRotatedOut = { hotPublicKey: 'hot', onChainHotCommitment: 'other', detectedAt: 1 };
  render(<HotKeyRotatedOutGate />);
  expect(screen.getByRole('heading', { name: 'thisDeviceRevoked' })).toBeInTheDocument();
  expect(screen.getByRole('link')).toHaveAttribute('href', 'https://explorer.test/tx/0xrevocation');
  expect(mockMark).not.toHaveBeenCalled();
});

it('shows the Guardian verdict even when no receipt is available', () => {
  mockAccount.hotKeyRotatedOut = { hotPublicKey: 'hot', onChainHotCommitment: 'other', detectedAt: 1 };
  mockReadReceipt.mockReturnValue(undefined);
  render(<HotKeyRotatedOutGate />);
  expect(screen.getByRole('heading', { name: 'thisDeviceRevoked' })).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

it('ignores a verdict for a key this device no longer uses', () => {
  mockAccount.hotKeyRotatedOut = { hotPublicKey: 'old-hot', onChainHotCommitment: 'other', detectedAt: 1 };
  render(<HotKeyRotatedOutGate />);
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  expect(mockReadReceipt).not.toHaveBeenCalled();
});
