import React from 'react';

import { render, screen } from '@testing-library/react';

import { SwapTransaction } from 'lib/miden/db/types';
import { TEST_SWAP_TOKENS, TEST_TOKEN_IETH, TEST_TOKEN_IMIDEN } from 'lib/miden/swap/testing/registry';
import { _setSwapTokensForTest } from 'lib/miden/swap/tokens';

import { SwapSuccess } from './SwapSuccess';

// The testnet document's swap registry, in place of the one the wallet used to compile in.
beforeAll(() => _setSwapTokensForTest(TEST_SWAP_TOKENS));
afterAll(() => _setSwapTokensForTest(undefined));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { amount?: string }) => (opts?.amount ? `${key}:${opts.amount}` : key)
  })
}));

jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' }
}));
jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));
jest.mock('lib/shared/format', () => ({ formatAmount: (amount: bigint) => String(amount) }));
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: { assetsMetadata: unknown }) => unknown) => selector({ assetsMetadata: {} })
}));
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => null }));
// The testnet document, whose swap tokens name the iETH faucet the labels read.
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => jest.requireActual('lib/epoch/testing/bridge-config').TEST_BRIDGE_CONFIG_SNAPSHOT
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet'
}));

// The pill and the fee row have their own suites; this one reads the reserved-funds sentence.
jest.mock('../TransactionSummaryBadge', () => ({
  ...jest.requireActual('../TransactionSummaryBadge'),
  useTransactionSummaryBadgeContent: () => undefined
}));
jest.mock('./TransactionSuccessLayout', () => ({
  TransactionSuccessLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SuccessSummaryPill: () => null,
  ReceiptRows: () => null,
  useReceiptFeeText: () => undefined
}));

const swapTx = (faucetId: string): SwapTransaction =>
  ({
    id: 'tx-1',
    type: 'swap',
    faucetId,
    amount: 5n,
    extraInputs: { requestedFaucetId: TEST_TOKEN_IMIDEN.faucetId, requestedAmount: 3n }
  }) as unknown as SwapTransaction;

describe('SwapSuccess', () => {
  it('names the registry iETH "Test iETH" in the reserved-funds sentence when iETH is the offered side (#477)', () => {
    render(<SwapSuccess transaction={swapTx(TEST_TOKEN_IETH.faucetId)} onDoneClick={jest.fn()} />);

    expect(screen.getByText('swapOrderReservedNote:5 Test iETH')).toBeInTheDocument();
  });

  it('leaves another offered token on its symbol', () => {
    render(<SwapSuccess transaction={swapTx(TEST_TOKEN_IMIDEN.faucetId)} onDoneClick={jest.fn()} />);

    expect(screen.getByText('swapOrderReservedNote:5 IMIDEN')).toBeInTheDocument();
  });
});
