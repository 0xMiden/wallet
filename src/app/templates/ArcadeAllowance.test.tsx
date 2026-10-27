import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SpendingLimitChallenge, type SpendingLimitChallengeProps } from 'components/SpendingLimitChallenge';
import type { GcSale } from 'lib/miden/arcade/gc-sale';
import { tagBalanceSnapshot } from 'lib/miden/balance-snapshot';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import {
  SpendingLimitAuthorizationRequiredError,
  SpendingLimitPriceUnavailableError,
  type SpendingLimitAuthorization
} from 'lib/miden/spending-limits/types';
import { initiateGcPurchaseTransaction } from 'lib/miden/transaction/initiate';
import { navigate } from 'lib/woozie';

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
  canonicalWalletAccountId: (id: string) => id.split('_')[0] ?? id,
  sameWalletAccountId: (a: string, b: string) => a.split('_')[0] === b.split('_')[0]
}));
let mockPurchase: { sale: GcSale | null; state: 'unavailable' | 'checking' | 'ready'; refresh: () => Promise<null> } = {
  sale: null,
  state: 'unavailable',
  refresh: async () => null
};
jest.mock('./arcade/useGcPurchaseQuote', () => ({ useGcPurchaseQuote: () => mockPurchase }));
jest.mock('./arcade/ArcadeGcPurchaseDrawer', () => ({
  ArcadeGcPurchaseDrawer: ({
    open,
    onConfirm,
    error
  }: {
    open: boolean;
    onConfirm: (quote: typeof mockQuote) => void;
    error: string | null;
  }) => (
    <>
      {open && <button onClick={() => onConfirm(mockQuote)}>confirm purchase</button>}
      {error && <div role="alert">{error}</div>}
    </>
  )
}));
jest.mock('components/SpendingLimitChallenge', () => ({
  SpendingLimitChallenge: jest.fn(({ onResult }: SpendingLimitChallengeProps) => (
    <div data-testid="spending-limit-challenge">
      <button onClick={() => onResult(mockChallengeAuthorization)}>authorize purchase</button>
      <button onClick={() => onResult(undefined)}>cancel authorization</button>
    </div>
  ))
}));
const mockReadLimit = jest.fn();
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: { readSpendingLimit: typeof mockReadLimit }) => unknown) =>
    selector({ readSpendingLimit: mockReadLimit })
}));
jest.mock('lib/miden/activity', () => ({ requestSWTransactionProcessing: jest.fn() }));
jest.mock('lib/miden/transaction/initiate', () => ({ initiateGcPurchaseTransaction: jest.fn() }));
jest.mock('lib/platform', () => ({ isExtension: () => false, isMobile: () => false }));
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
  jest.clearAllMocks();
  jest.mocked(initiateGcPurchaseTransaction).mockReset();
  mockChallengeAuthorization = mockAuthorization;
  mockReadLimit.mockResolvedValue({ accountId: 'account-a', revision: 'gc-policy-1', limit: 50_000_000n });
  mockPurchase = { sale: null, state: 'unavailable', refresh: async () => null };
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

const mockQuote = {
  saleNoteId: 'public-sale',
  sellerAccountId: 'seller',
  payFaucetId: 'native-faucet',
  fillAmount: 60_000_000n,
  gcFaucetId: gc,
  expectedAmount: 60_000_000_000n
};
const mockAuthorization: SpendingLimitAuthorization = {
  kind: 'usd',
  id: 'authorized-purchase',
  accountId: 'account-a',
  revision: 'gc-policy-1',
  usdAmount: 60_000_000n,
  spendsDigest: 'native-faucet:60000000',
  issuedAt: 1,
  expiresAt: 61
};
let mockChallengeAuthorization: SpendingLimitAuthorization;
const enablePurchase = () => {
  mockPurchase = {
    sale: {
      saleNoteId: mockQuote.saleNoteId,
      sellerAccountId: mockQuote.sellerAccountId,
      payFaucetId: mockQuote.payFaucetId,
      gcFaucetId: gc,
      offeredAmount: 100_000_000_000n,
      requestedAmount: 100_000_000n,
      fillFloor: 0n
    },
    state: 'ready',
    refresh: async () => null
  };
  mockRows = [row(gc, 10), { ...row('native-faucet', 100), balanceBaseUnits: '100000000' }];
  tagBalanceSnapshot(mockRows, { network: 'testnet', accountNonce: '12' });
  const view = render(<ArcadeAllowance />);
  fireEvent.click(screen.getByRole('button', { name: 'arcadeBuyMoreGc' }));
  fireEvent.click(screen.getByRole('button', { name: 'confirm purchase' }));
  return view;
};

it('redeems an exact pay-leg authorization after a purchase exceeds the cap', async () => {
  jest
    .mocked(initiateGcPurchaseTransaction)
    .mockRejectedValueOnce(
      new SpendingLimitAuthorizationRequiredError({
        accountId: 'account-a',
        usdAmount: 60_000_000n,
        revision: 'gc-policy-1',
        assessedAt: 1,
        breach: { spent: 0n, proposedTotal: 60_000_000n, limit: 50_000_000n, overBy: 10_000_000n, resetAt: null }
      })
    )
    .mockResolvedValueOnce('authorized-transaction');
  enablePurchase();
  await screen.findByRole('button', { name: 'authorize purchase' });
  expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
  expect(jest.mocked(SpendingLimitChallenge).mock.calls.at(-1)?.[0]).toMatchObject({
    spends: [{ faucetId: 'native-faucet', amount: 60_000_000n }]
  });
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'authorize purchase' }));
  await waitFor(() => expect(initiateGcPurchaseTransaction).toHaveBeenCalledTimes(2));
  expect(initiateGcPurchaseTransaction).toHaveBeenLastCalledWith('account-a', mockQuote, false, mockAuthorization);
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith('/generating-transaction/authorized-transaction', 'replace')
  );
});

it('offers an unpriced challenge bound to the purchase pay leg and current policy revision', async () => {
  jest.mocked(initiateGcPurchaseTransaction).mockRejectedValueOnce(new SpendingLimitPriceUnavailableError('USDCx'));
  enablePurchase();
  await screen.findByRole('button', { name: 'authorize purchase' });
  expect(jest.mocked(SpendingLimitChallenge).mock.calls.at(-1)?.[0]).toMatchObject({
    unpriced: {
      accountId: 'account-a',
      spends: [{ faucetId: 'native-faucet', amount: 60_000_000n }],
      revision: 'gc-policy-1'
    }
  });
  expect(navigate).not.toHaveBeenCalled();
});

it('closes a stale purchase authorization challenge when the account changes', async () => {
  jest.mocked(initiateGcPurchaseTransaction).mockRejectedValueOnce(
    new SpendingLimitAuthorizationRequiredError({
      accountId: 'account-a',
      usdAmount: 60_000_000n,
      revision: 'gc-policy-1',
      assessedAt: 1,
      breach: { spent: 0n, proposedTotal: 60_000_000n, limit: 50_000_000n, overBy: 10_000_000n, resetAt: null }
    })
  );
  const view = enablePurchase();
  await screen.findByRole('button', { name: 'authorize purchase' });
  mockAccount = 'account-b';
  view.rerender(<ArcadeAllowance />);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'authorize purchase' })).toBeNull());
  expect(initiateGcPurchaseTransaction).toHaveBeenCalledTimes(1);
  expect(navigate).not.toHaveBeenCalled();
});

it('keeps the purchase review open when authorization is cancelled', async () => {
  jest.mocked(initiateGcPurchaseTransaction).mockRejectedValueOnce(new SpendingLimitPriceUnavailableError('USDCx'));
  enablePurchase();
  await screen.findByTestId('spending-limit-challenge');
  fireEvent.click(screen.getByRole('button', { name: 'cancel authorization' }));
  expect(screen.queryByTestId('spending-limit-challenge')).toBeNull();
  expect(screen.getByRole('button', { name: 'confirm purchase' })).toBeInTheDocument();
  expect(initiateGcPurchaseTransaction).toHaveBeenCalledTimes(1);
  expect(navigate).not.toHaveBeenCalled();
});

it('retries the same quote with an unpriced authorization', async () => {
  mockChallengeAuthorization = {
    kind: 'unpriced',
    id: 'unpriced-purchase',
    accountId: 'account-a',
    spendsDigest: 'native-faucet:60000000',
    revision: 'gc-policy-1',
    issuedAt: 1,
    expiresAt: 61
  };
  jest
    .mocked(initiateGcPurchaseTransaction)
    .mockRejectedValueOnce(new SpendingLimitPriceUnavailableError('USDCx'))
    .mockResolvedValueOnce('unpriced-transaction');
  enablePurchase();
  await screen.findByTestId('spending-limit-challenge');
  fireEvent.click(screen.getByRole('button', { name: 'authorize purchase' }));
  await waitFor(() => expect(initiateGcPurchaseTransaction).toHaveBeenCalledTimes(2));
  expect(initiateGcPurchaseTransaction).toHaveBeenLastCalledWith(
    'account-a',
    mockQuote,
    false,
    mockChallengeAuthorization
  );
});

it('authorizes an equivalent routed account identity without dropping the challenge', async () => {
  mockAccount = 'account-a_routing';
  jest
    .mocked(initiateGcPurchaseTransaction)
    .mockRejectedValueOnce(
      new SpendingLimitAuthorizationRequiredError({
        accountId: 'account-a',
        usdAmount: 60_000_000n,
        revision: 'gc-policy-1',
        assessedAt: 1,
        breach: { spent: 0n, proposedTotal: 60_000_000n, limit: 50_000_000n, overBy: 10_000_000n, resetAt: null }
      })
    )
    .mockResolvedValueOnce('routed-transaction');
  enablePurchase();
  await screen.findByRole('button', { name: 'authorize purchase' });
  fireEvent.click(screen.getByRole('button', { name: 'authorize purchase' }));
  await waitFor(() => expect(initiateGcPurchaseTransaction).toHaveBeenCalledTimes(2));
  expect(initiateGcPurchaseTransaction).toHaveBeenLastCalledWith(
    'account-a_routing',
    mockQuote,
    false,
    mockAuthorization
  );
});
