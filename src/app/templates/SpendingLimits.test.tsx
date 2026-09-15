import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { SpendingLimitConfiguration } from 'lib/miden/spending-limits/types';

import SpendingLimits, {
  MAX_SPENDING_LIMIT,
  formatSpendingLimitInput,
  parseSpendingLimitInput
} from './SpendingLimits';

const mockListSpendingLimits = jest.fn();
const mockSaveSpendingLimit = jest.fn();
let mockStrictResult: ((result: 'authenticated' | 'cancelled') => void) | undefined;

const mockWalletState: any = {
  currentAccount: { publicKey: 'account-a' },
  balances: {
    'account-a': [
      {
        tokenId: 'faucet-miden',
        tokenSlug: 'MIDEN',
        metadata: { symbol: 'MIDEN', name: 'Miden', decimals: 6 },
        balance: 10
      }
    ]
  },
  balancesLoading: { 'account-a': false },
  listSpendingLimits: mockListSpendingLimits,
  saveSpendingLimit: mockSaveSpendingLimit
};

jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: typeof mockWalletState) => unknown) => selector(mockWalletState)
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('components/Button', () => ({
  Button: ({ title, disabled, onClick }: { title: string; disabled?: boolean; onClick?: () => void }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {title}
    </button>
  )
}));

jest.mock('components/StrictActionAuthentication', () => ({
  StrictActionAuthentication: ({
    reason,
    onResult
  }: {
    reason: string;
    onResult: (result: 'authenticated' | 'cancelled') => void;
  }) => {
    mockStrictResult = onResult;
    return (
      <div data-testid="strict-authentication">
        <span>{reason}</span>
        <button type="button" onClick={() => onResult('authenticated')}>
          authenticate
        </button>
        <button type="button" onClick={() => onResult('cancelled')}>
          cancel-authentication
        </button>
      </div>
    );
  }
}));

const configured = (
  faucetId = 'faucet-miden',
  overrides: Partial<SpendingLimitConfiguration> = {}
): SpendingLimitConfiguration => ({
  accountId: 'account-a',
  faucetId,
  dailyLimit: 20_000_000n,
  weeklyLimit: 100_000_000n,
  asset: { symbol: faucetId === 'faucet-miden' ? 'MIDEN' : 'ZERO', decimals: 6, name: 'Asset' },
  revision: `revision-${faucetId}`,
  createdAt: 1,
  updatedAt: 2,
  ...overrides
});

describe('parseSpendingLimitInput', () => {
  it('converts exact decimal strings to base units without Number precision loss', () => {
    expect(parseSpendingLimitInput('9007199254.740993', 6)).toBe(9_007_199_254_740_993n);
    expect(parseSpendingLimitInput('0.000001', 6)).toBe(1n);
    expect(parseSpendingLimitInput('', 6)).toBeUndefined();
  });

  it.each(['0', '-1', '1.0000001', '1e2', '1,000', '.', 'NaN'])(
    'rejects an invalid or unrepresentable amount: %s',
    value => {
      expect(() => parseSpendingLimitInput(value, 6)).toThrow();
    }
  );

  it('rejects values above the representable fungible-asset range', () => {
    expect(parseSpendingLimitInput(MAX_SPENDING_LIMIT.toString(), 0)).toBe(MAX_SPENDING_LIMIT);
    expect(() => parseSpendingLimitInput((MAX_SPENDING_LIMIT + 1n).toString(), 0)).toThrow();
  });
});

describe('formatSpendingLimitInput', () => {
  it('formats base units without precision loss and trims insignificant zeros', () => {
    expect(formatSpendingLimitInput(20_000_000n, 6)).toBe('20');
    expect(formatSpendingLimitInput(1n, 6)).toBe('0.000001');
    expect(formatSpendingLimitInput(MAX_SPENDING_LIMIT, 0)).toBe(MAX_SPENDING_LIMIT.toString());
  });

  it.each([
    [-1n, 6],
    [1n, -1],
    [1n, 256]
  ] as const)('rejects an invalid value or decimal scale', (value, decimals) => {
    expect(() => formatSpendingLimitInput(value, decimals)).toThrow();
  });
});

describe('SpendingLimits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStrictResult = undefined;
    mockWalletState.currentAccount = { publicKey: 'account-a' };
    mockWalletState.balances = {
      'account-a': [
        {
          tokenId: 'faucet-miden',
          tokenSlug: 'MIDEN',
          metadata: { symbol: 'MIDEN', name: 'Miden', decimals: 6 },
          balance: 10
        }
      ]
    };
    mockWalletState.balancesLoading = { 'account-a': false };
    mockListSpendingLimits.mockResolvedValue([]);
    mockSaveSpendingLimit.mockImplementation(async (draft: any) => ({
      ...draft,
      revision: 'saved-revision',
      createdAt: 1,
      updatedAt: 3
    }));
  });

  it('shows current-balance assets and configured zero-balance assets', async () => {
    mockListSpendingLimits.mockResolvedValue([configured('faucet-zero')]);

    render(<SpendingLimits />);

    expect(await screen.findByRole('heading', { name: 'MIDEN' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ZERO' })).toBeInTheDocument();
    expect(screen.getByLabelText('ZERO spendingLimitDaily')).toHaveValue('20');
    expect(screen.getByLabelText('ZERO spendingLimitWeekly')).toHaveValue('100');
  });

  it('merges equivalent stored and live faucet identities into one editable row', async () => {
    mockWalletState.balances['account-a'][0].tokenId = 'faucet-miden_route';
    mockListSpendingLimits.mockResolvedValue([configured('faucet-miden')]);

    render(<SpendingLimits />);

    expect(await screen.findAllByRole('heading', { name: 'MIDEN' })).toHaveLength(1);
  });

  it('shows loading and fails closed when configurations cannot be read', async () => {
    let reject!: (error: Error) => void;
    mockListSpendingLimits.mockReturnValue(
      new Promise((_, rejectPromise) => {
        reject = rejectPromise;
      })
    );

    render(<SpendingLimits />);

    expect(screen.getByRole('status')).toHaveTextContent('loading');
    reject(new Error('raw storage failure'));
    expect(await screen.findByRole('alert')).toHaveTextContent('spendingLimitLoadFailed');
    expect(screen.queryByText('raw storage failure')).not.toBeInTheDocument();
  });

  it('does not allow configuration while an asset decimal scale is unresolved', async () => {
    mockWalletState.balances['account-a'][0].metadata = {
      symbol: 'Unknown',
      name: 'Unknown',
      decimals: 6,
      scaleIsUnknown: true
    };

    render(<SpendingLimits />);

    const daily = await screen.findByLabelText('Unknown spendingLimitDaily');
    expect(daily).toBeDisabled();
    expect(screen.getByText('spendingLimitUnknownDecimals')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'spendingLimitSave' })).toBeDisabled();
  });

  it('keeps the screen loading until current balances are ready', async () => {
    mockWalletState.balancesLoading['account-a'] = true;
    const view = render(<SpendingLimits />);

    expect(screen.getByRole('status')).toHaveTextContent('loading');
    await waitFor(() => expect(mockListSpendingLimits).toHaveBeenCalledWith('account-a'));

    mockWalletState.balancesLoading['account-a'] = false;
    view.rerender(<SpendingLimits />);
    expect(await screen.findByRole('heading', { name: 'MIDEN' })).toBeInTheDocument();
  });

  it('saves a pure lowering directly without strict authentication', async () => {
    mockListSpendingLimits.mockResolvedValue([configured()]);
    render(<SpendingLimits />);

    fireEvent.change(await screen.findByLabelText('MIDEN spendingLimitDaily'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));

    await waitFor(() =>
      expect(mockSaveSpendingLimit).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'account-a', faucetId: 'faucet-miden', dailyLimit: 10_000_000n }),
        'revision-faucet-miden',
        false
      )
    );
    expect(screen.queryByTestId('strict-authentication')).not.toBeInTheDocument();
  });

  it('authenticates before creating, raising, removing, or disabling a limit', async () => {
    mockListSpendingLimits.mockResolvedValue([configured()]);
    render(<SpendingLimits />);

    const daily = await screen.findByLabelText('MIDEN spendingLimitDaily');
    const weekly = screen.getByLabelText('MIDEN spendingLimitWeekly');
    fireEvent.change(daily, { target: { value: '21' } });
    fireEvent.change(weekly, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));

    expect(await screen.findByTestId('strict-authentication')).toBeInTheDocument();
    expect(mockSaveSpendingLimit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));

    await waitFor(() =>
      expect(mockSaveSpendingLimit).toHaveBeenCalledWith(
        expect.objectContaining({ dailyLimit: 21_000_000n, weeklyLimit: undefined }),
        'revision-faucet-miden',
        true
      )
    );
  });

  it('authenticates before creating the first limit for an asset', async () => {
    render(<SpendingLimits />);

    fireEvent.change(await screen.findByLabelText('MIDEN spendingLimitDaily'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));

    expect(await screen.findByTestId('strict-authentication')).toBeInTheDocument();
    expect(mockSaveSpendingLimit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));

    await waitFor(() =>
      expect(mockSaveSpendingLimit).toHaveBeenCalledWith(
        expect.objectContaining({ dailyLimit: 5_000_000n, weeklyLimit: undefined }),
        undefined,
        true
      )
    );
  });

  it('treats empty inputs as disabled periods and persists nothing after cancellation', async () => {
    mockListSpendingLimits.mockResolvedValue([configured()]);
    render(<SpendingLimits />);

    fireEvent.change(await screen.findByLabelText('MIDEN spendingLimitDaily'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('MIDEN spendingLimitWeekly'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));
    fireEvent.click(await screen.findByRole('button', { name: 'cancel-authentication' }));

    expect(mockSaveSpendingLimit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('strict-authentication')).not.toBeInTheDocument();
  });

  it('validates the whole row before authentication or persistence', async () => {
    mockListSpendingLimits.mockResolvedValue([configured()]);
    render(<SpendingLimits />);

    fireEvent.change(await screen.findByLabelText('MIDEN spendingLimitDaily'), { target: { value: '1.0000001' } });
    fireEvent.change(screen.getByLabelText('MIDEN spendingLimitWeekly'), { target: { value: '101' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('spendingLimitInvalidAmount');
    expect(screen.queryByTestId('strict-authentication')).not.toBeInTheDocument();
    expect(mockSaveSpendingLimit).not.toHaveBeenCalled();
  });

  it('does not persist an authenticated draft after the account changes', async () => {
    mockListSpendingLimits.mockResolvedValue([configured()]);
    const view = render(<SpendingLimits />);

    fireEvent.change(await screen.findByLabelText('MIDEN spendingLimitDaily'), { target: { value: '21' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));
    await screen.findByTestId('strict-authentication');

    const staleResult = mockStrictResult;
    mockWalletState.currentAccount = { publicKey: 'account-b' };
    mockWalletState.balances['account-b'] = [];
    mockWalletState.balancesLoading['account-b'] = false;
    view.rerender(<SpendingLimits />);
    staleResult?.('authenticated');

    await waitFor(() => expect(mockListSpendingLimits).toHaveBeenCalledWith('account-b'));
    expect(mockSaveSpendingLimit).not.toHaveBeenCalled();
  });

  it('shows a safe error and leaves the draft available when persistence fails', async () => {
    mockListSpendingLimits.mockResolvedValue([configured()]);
    mockSaveSpendingLimit.mockRejectedValue(new Error('raw backend detail'));
    render(<SpendingLimits />);

    fireEvent.change(await screen.findByLabelText('MIDEN spendingLimitDaily'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('spendingLimitSaveFailed');
    expect(screen.queryByText('raw backend detail')).not.toBeInTheDocument();
    expect(screen.getByLabelText('MIDEN spendingLimitDaily')).toHaveValue('10');
  });

  it('keeps the local-only and non-enforcement disclosure permanently visible', async () => {
    render(<SpendingLimits />);

    await screen.findByRole('heading', { name: 'MIDEN' });
    expect(screen.getByText('spendingLimitLocalDisclosure')).toBeInTheDocument();
    expect(screen.getByText('spendingLimitNotOnChain')).toBeInTheDocument();
  });
});
