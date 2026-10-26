import React from 'react';

import { act, render, screen } from '@testing-library/react';

import { tagBalanceSnapshot } from 'lib/miden/balance-snapshot';
import type { TokenBalanceData } from 'lib/miden/front/balance';

import { ArcadeAllowance } from './ArcadeAllowance';

const gc = '0x97924b9a77ed54917ff6d6364ae661';
const mainnetGc = '0x34a3510213533f512ec4abe36baf84';
let mockAccount = 'account-a';
let mockNetwork = 'testnet';
let mockListener = () => {};
let mockLoading = false;
let mockRows: TokenBalanceData[] = [];
const mockRead = jest.fn();
jest.mock('lib/miden/front/client', () => ({
  useMidenContext: () => ({
    readGcWeeklyClaim: mockRead,
    prepareGcWeeklyClaim: jest.fn(),
    submitGcWeeklyClaim: jest.fn()
  })
}));
jest.mock('lib/miden/front/balance', () => ({ useAllBalances: () => ({ data: mockRows, isLoading: mockLoading }) }));
jest.mock('lib/miden/front/assets', () => ({
  useTokensMetadata: () => ({ allTokensBaseMetadataRef: { current: {} } })
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  canonicalWalletAccountId: (id: string) => id,
  sameWalletAccountId: (a: string, b: string) => a === b
}));
let mockPurchase: { sale: null; state: 'unavailable' | 'checking' | 'ready'; refresh: () => Promise<null> } = {
  sale: null,
  state: 'unavailable',
  refresh: async () => null
};
jest.mock('./arcade/useGcPurchaseQuote', () => ({ useGcPurchaseQuote: () => mockPurchase }));
jest.mock('./arcade/ArcadeGcPurchaseDrawer', () => ({ ArcadeGcPurchaseDrawer: () => null }));
jest.mock('lib/miden/activity', () => ({ requestSWTransactionProcessing: jest.fn() }));
jest.mock('lib/miden/transaction/initiate', () => ({ initiateGcPurchaseTransaction: jest.fn() }));
jest.mock('lib/platform', () => ({ isExtension: () => false }));
jest.mock('lib/settings/helpers', () => ({ isDelegateProofEnabled: () => false }));
jest.mock('lib/woozie', () => ({ navigate: jest.fn(), HistoryAction: { Replace: 'replace' } }));
jest.mock('lib/miden/front/ready', () => ({
  useAccount: () => ({ publicKey: mockAccount }),
  useAllNetworks: () => [
    { id: 'mainnet', name: 'Mainnet' },
    { id: 'testnet', name: 'Testnet' }
  ]
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetwork }));
jest.mock('lib/remote-config/runtime', () => ({
  subscribeBridgeConfig: (listener: () => void) => {
    mockListener = listener;
    return () => {};
  }
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { balance?: string }) => (values?.balance ? `${values.balance} GC` : key),
    i18n: { resolvedLanguage: 'en' }
  })
}));

const row = (tokenId: string, balance: number): TokenBalanceData => ({
  tokenId,
  tokenSlug: 'GC',
  balance,
  fiatPrice: 0,
  change24h: 0,
  metadata: { name: 'Game Coin', symbol: 'GC', decimals: 6 }
});
beforeEach(() => {
  mockNetwork = 'testnet';
  mockAccount = 'account-a';
  mockLoading = false;
  mockRows = [row(gc, 10), row('different-GC', 900)];
  tagBalanceSnapshot(mockRows, { network: 'testnet', accountNonce: '12' });
});

it('shows only the selected GC balance and a disabled purchase entry point without weekly controls', () => {
  render(<ArcadeAllowance />);
  expect(screen.getByText('10 GC')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'arcadeBuyMoreGc' })).toBeDisabled();
  expect(screen.getByText('arcadeGcPurchaseUnavailable')).toBeInTheDocument();
  expect(screen.queryByTestId('arcade-claim')).toBeNull();
  expect(screen.queryByText('arcadeWeeklyAllowance')).toBeNull();
  expect(screen.queryByText('arcadeWeeklyRules')).toBeNull();
  expect(screen.queryByTestId('gc-claim-review')).toBeNull();
});

it('keeps unread or wrong-network rows unknown instead of reporting zero or a stale balance', () => {
  mockRows = [row(gc, 10)];
  const view = render(<ArcadeAllowance />);
  expect(screen.getByText('arcadeBalanceUnknown')).toBeInTheDocument();
  tagBalanceSnapshot(mockRows, { network: 'mainnet', accountNonce: '1' });
  view.rerender(<ArcadeAllowance />);
  expect(screen.getByText('arcadeBalanceUnknown')).toBeInTheDocument();
});

it('shows zero only after a known-network empty vault and isolates a network switch', () => {
  mockRows = [];
  tagBalanceSnapshot(mockRows, { network: 'testnet', accountNonce: '12' });
  const view = render(<ArcadeAllowance />);
  expect(screen.getByText('0 GC')).toBeInTheDocument();
  act(() => {
    mockNetwork = 'mainnet';
    mockListener();
  });
  expect(screen.getByText('arcadeBalanceUnknown')).toBeInTheDocument();
  mockRows = [row(mainnetGc, 25)];
  tagBalanceSnapshot(mockRows, { network: 'mainnet', accountNonce: '15' });
  view.rerender(<ArcadeAllowance />);
  expect(screen.getByText('25 GC')).toBeInTheDocument();
});

it('does not substitute a grant or malformed token amount for an unread balance', () => {
  mockLoading = true;
  const view = render(<ArcadeAllowance />);
  expect(screen.getByText('arcadeBalanceUnknown')).toBeInTheDocument();
  mockLoading = false;
  mockRows = [row(gc, NaN)];
  tagBalanceSnapshot(mockRows, { network: 'testnet', accountNonce: '12' });
  view.rerender(<ArcadeAllowance />);
  expect(screen.getByText('arcadeBalanceUnknown')).toBeInTheDocument();
});

it('reads the wallet’s Bech32 faucet rows without requiring a frontend WASM parser', () => {
  mockRows = [row('mtst1azteyju6wlk4fytl7mtrvjhxvy08nme2_qr7qqq9wr6w', 7.5)];
  tagBalanceSnapshot(mockRows, { network: 'testnet', accountNonce: '12' });
  render(<ArcadeAllowance />);
  expect(screen.getByText('7.5 GC')).toBeInTheDocument();
});

it('offers only the fixed package and no amount or package selector', () => {
  render(<ArcadeAllowance />);
  expect(screen.getByText('arcadeGcPurchasePackage')).toBeInTheDocument();
  expect(screen.queryByRole('spinbutton')).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getByRole('button', { name: 'arcadeBuyMoreGc' })).toBeDisabled();
});
