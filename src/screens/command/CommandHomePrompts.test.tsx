import React from 'react';

import { render, screen } from '@testing-library/react';

import { CommandHomePrompts } from './CommandHomePrompts';

const mockRawNotes = [{ id: 'unfiltered-note' }];
const mockManualNotes = [{ id: 'manual-note' }];
const mockBalances = [{ tokenId: 'known-token' }];
const mockPrices = { knownToken: { price: 5 } };
const mockExcludeAutoManagedNotes = jest.fn(
  (_notes: unknown, _fee: string, _enabled: boolean, _floor: number) => mockManualNotes
);
let mockCached = false;

jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => 'native-fee-token' }));
jest.mock('app/hooks/useVerificationBaseFee', () => ({ useClaimFloorBaseFee: () => 5 }));
jest.mock('app/templates/HomePrompts', () => ({
  __esModule: true,
  default: ({
    account,
    balances,
    balancesLoading,
    claimableNotes,
    fundingNotes,
    tokenPrices,
    maskMonetaryValues,
    requireReadableHiddenNotes
  }: {
    account: { publicKey: string };
    balances: unknown[];
    balancesLoading: boolean;
    claimableNotes: unknown[];
    fundingNotes?: unknown[];
    tokenPrices: unknown;
    maskMonetaryValues: boolean;
    requireReadableHiddenNotes: boolean;
  }) => (
    <div
      data-testid="home-prompts-inputs"
      data-address={account.publicKey}
      data-balances={balances === mockBalances ? 'current' : 'wrong'}
      data-loading={String(balancesLoading)}
      data-attention={claimableNotes === mockManualNotes ? 'filtered' : 'wrong'}
      data-funding={fundingNotes === undefined ? 'unloaded' : fundingNotes === mockRawNotes ? 'unfiltered' : 'wrong'}
      data-prices={tokenPrices === mockPrices ? 'current' : 'wrong'}
      data-masked={String(maskMonetaryValues)}
      data-require-readable-hidden-notes={String(requireReadableHiddenNotes)}
    />
  )
}));
jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: 'current-account' }),
  useAllTokensBaseMetadata: () => [],
  useAllBalances: () => ({ data: mockBalances, isLoading: false })
}));
jest.mock('lib/miden/front/claimable-notes', () => ({
  useClaimableNotes: () => ({ data: mockRawNotes, isFallback: mockCached })
}));
jest.mock('lib/miden/front/auto-managed-notes', () => ({
  excludeAutoManagedNotes: (...args: [unknown, string, boolean, number]) => mockExcludeAutoManagedNotes(...args)
}));
jest.mock('lib/settings/helpers', () => ({ isAutoConsumeEnabled: () => true }));
jest.mock('./useCommandPrivacy', () => ({ useCommandPrivacy: () => [true, jest.fn()] }));
jest.mock('lib/store', () => ({
  useWalletStore: (pick: (state: { tokenPrices: typeof mockPrices }) => unknown) => pick({ tokenPrices: mockPrices })
}));

afterEach(() => {
  mockCached = false;
  mockExcludeAutoManagedNotes.mockClear();
});

it('hands the existing notice controller current account, balances, prices and distinct filtered/unfiltered note lists', () => {
  const view = render(<CommandHomePrompts />);
  const prompts = screen.getByTestId('home-prompts-inputs');
  expect(prompts).toHaveAttribute('data-address', 'current-account');
  expect(prompts).toHaveAttribute('data-balances', 'current');
  expect(prompts).toHaveAttribute('data-loading', 'false');
  expect(prompts).toHaveAttribute('data-attention', 'filtered');
  expect(prompts).toHaveAttribute('data-funding', 'unfiltered');
  expect(prompts).toHaveAttribute('data-prices', 'current');
  expect(prompts).toHaveAttribute('data-masked', 'true');
  expect(prompts).toHaveAttribute('data-require-readable-hidden-notes', 'true');
  expect(mockExcludeAutoManagedNotes).toHaveBeenCalledWith(mockRawNotes, 'native-fee-token', true, 5);
  mockCached = true;
  view.rerender(<CommandHomePrompts />);
  expect(prompts).toHaveAttribute('data-funding', 'unloaded');
});
