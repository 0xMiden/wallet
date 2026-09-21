import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { SpendingLimitConfiguration } from 'lib/miden/spending-limits/types';

import SpendingLimits, { MAX_SPENDING_LIMIT, formatUsdLimitInput, parseUsdLimitInput } from './SpendingLimits';

const mockReadSpendingLimit = jest.fn();
const mockSaveSpendingLimit = jest.fn();
let mockStrictResult: ((result: 'authenticated' | 'cancelled') => void) | undefined;

const mockWalletState: any = {
  currentAccount: { publicKey: 'account-a' },
  readSpendingLimit: mockReadSpendingLimit,
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

const configuration = (overrides: Partial<SpendingLimitConfiguration> = {}): SpendingLimitConfiguration => ({
  accountId: 'account-a',
  limit: 20_000_000n,
  revision: 'revision-1',
  createdAt: 1,
  updatedAt: 2,
  ...overrides
});

const renderScreen = () => render(<SpendingLimits />);

describe('parseUsdLimitInput', () => {
  it('converts exact decimal strings to micro-dollars without Number precision loss', () => {
    expect(parseUsdLimitInput('9007199254.74')).toBe(9_007_199_254_740_000n);
    expect(parseUsdLimitInput('0.01')).toBe(10_000n);
    expect(parseUsdLimitInput('')).toBeUndefined();
  });

  it.each(['0', '-1', '1.001', '1e2', '1,000', '.', 'NaN'])(
    'rejects an invalid or unrepresentable amount: %s',
    value => {
      expect(() => parseUsdLimitInput(value)).toThrow();
    }
  );

  it('rejects an amount with more than two decimal places', () => {
    expect(() => parseUsdLimitInput('1.005')).toThrow(RangeError);
  });

  it('accepts a value at the top of the representable range and rejects one over it', () => {
    const maxDollars = MAX_SPENDING_LIMIT / 1_000_000n;
    expect(parseUsdLimitInput(maxDollars.toString())).toBe(maxDollars * 1_000_000n);
    expect(() => parseUsdLimitInput(MAX_SPENDING_LIMIT.toString())).toThrow();
  });
});

describe('formatUsdLimitInput', () => {
  it('formats micro-dollars as at most two decimal places, trimming insignificant zeros', () => {
    expect(formatUsdLimitInput(20_000_000n)).toBe('20');
    expect(formatUsdLimitInput(500_000n)).toBe('0.5');
    expect(formatUsdLimitInput(12_340_000n)).toBe('12.34');
  });

  it('rejects a negative value', () => {
    expect(() => formatUsdLimitInput(-1n)).toThrow();
  });
});

describe('SpendingLimits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStrictResult = undefined;
    mockWalletState.currentAccount = { publicKey: 'account-a' };
    mockReadSpendingLimit.mockResolvedValue(undefined);
    mockSaveSpendingLimit.mockImplementation(async (draft: any) => ({
      accountId: draft.accountId,
      limit: draft.limit,
      revision: 'saved-revision',
      createdAt: 1,
      updatedAt: 3
    }));
  });

  it('renders one dollar input, not a row per asset', async () => {
    renderScreen();

    expect(await screen.findByLabelText('spendingLimitUsdCap')).toBeInTheDocument();
    expect(screen.queryByText('ETH')).not.toBeInTheDocument();
  });

  it('states that unpriced assets are not covered', async () => {
    renderScreen();

    expect(await screen.findByText('spendingLimitCoverage')).toBeInTheDocument();
  });

  it('keeps the local-only and non-enforcement disclosures permanently visible alongside coverage', async () => {
    renderScreen();

    await screen.findByLabelText('spendingLimitUsdCap');
    expect(screen.getByText('spendingLimitLocalDisclosure')).toBeInTheDocument();
    expect(screen.getByText('spendingLimitNotOnChain')).toBeInTheDocument();
    expect(screen.getByText('spendingLimitCoverage')).toBeInTheDocument();
  });

  it('requires strict authentication to raise the cap', async () => {
    mockReadSpendingLimit.mockResolvedValue(configuration());
    renderScreen();

    fireEvent.change(await screen.findByLabelText('spendingLimitUsdCap'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));

    expect(await screen.findByTestId('strict-authentication')).toBeInTheDocument();
    expect(mockSaveSpendingLimit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));

    await waitFor(() =>
      expect(mockSaveSpendingLimit).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'account-a', limit: 25_000_000n }),
        'revision-1',
        true
      )
    );
  });

  it('saves a lowered cap without authentication', async () => {
    mockReadSpendingLimit.mockResolvedValue(configuration());
    renderScreen();

    fireEvent.change(await screen.findByLabelText('spendingLimitUsdCap'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));

    await waitFor(() =>
      expect(mockSaveSpendingLimit).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'account-a', limit: 10_000_000n }),
        'revision-1',
        false
      )
    );
    expect(screen.queryByTestId('strict-authentication')).not.toBeInTheDocument();
  });

  it('rejects an amount with more than two decimal places', async () => {
    mockReadSpendingLimit.mockResolvedValue(configuration());
    renderScreen();

    fireEvent.change(await screen.findByLabelText('spendingLimitUsdCap'), { target: { value: '10.123' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('spendingLimitInvalidAmount');
    expect(screen.queryByTestId('strict-authentication')).not.toBeInTheDocument();
    expect(mockSaveSpendingLimit).not.toHaveBeenCalled();
  });

  it('clears the cap when the field is emptied, behind authentication', async () => {
    mockReadSpendingLimit.mockResolvedValue(configuration());
    renderScreen();

    fireEvent.change(await screen.findByLabelText('spendingLimitUsdCap'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));

    expect(await screen.findByTestId('strict-authentication')).toBeInTheDocument();
    expect(mockSaveSpendingLimit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));

    await waitFor(() =>
      expect(mockSaveSpendingLimit).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'account-a', limit: undefined }),
        'revision-1',
        true
      )
    );
  });

  it('authenticates before creating the first cap when none exists yet', async () => {
    renderScreen();

    fireEvent.change(await screen.findByLabelText('spendingLimitUsdCap'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));

    expect(await screen.findByTestId('strict-authentication')).toBeInTheDocument();
    expect(mockSaveSpendingLimit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));

    await waitFor(() =>
      expect(mockSaveSpendingLimit).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'account-a', limit: 5_000_000n }),
        undefined,
        true
      )
    );
  });

  it('reports a load failure rather than an empty cap when there is no current account', async () => {
    // The whole screen keys off the account: with none there is nothing to read a cap for, and
    // rendering an empty field would read as "no cap set" rather than "this did not load".
    mockWalletState.currentAccount = null;

    renderScreen();

    expect(await screen.findByRole('alert')).toHaveTextContent('spendingLimitLoadFailed');
    expect(mockReadSpendingLimit).not.toHaveBeenCalled();
  });

  it('shows loading and fails closed when the cap cannot be read', async () => {
    let reject!: (error: Error) => void;
    mockReadSpendingLimit.mockReturnValue(
      new Promise((_, rejectPromise) => {
        reject = rejectPromise;
      })
    );

    renderScreen();

    expect(screen.getByRole('status')).toHaveTextContent('loading');
    reject(new Error('raw storage failure'));
    expect(await screen.findByRole('alert')).toHaveTextContent('spendingLimitLoadFailed');
    expect(screen.queryByText('raw storage failure')).not.toBeInTheDocument();
  });

  it('does not persist an authenticated draft after the account changes', async () => {
    mockReadSpendingLimit.mockResolvedValue(configuration());
    const view = renderScreen();

    fireEvent.change(await screen.findByLabelText('spendingLimitUsdCap'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));
    await screen.findByTestId('strict-authentication');

    const staleResult = mockStrictResult;
    mockWalletState.currentAccount = { publicKey: 'account-b' };
    mockReadSpendingLimit.mockResolvedValue(undefined);
    view.rerender(<SpendingLimits />);
    staleResult?.('authenticated');

    await waitFor(() => expect(mockReadSpendingLimit).toHaveBeenCalledWith('account-b'));
    expect(mockSaveSpendingLimit).not.toHaveBeenCalled();
  });

  it('shows a safe error and leaves the draft available when persistence fails', async () => {
    mockReadSpendingLimit.mockResolvedValue(configuration());
    mockSaveSpendingLimit.mockRejectedValue(new Error('raw backend detail'));
    renderScreen();

    fireEvent.change(await screen.findByLabelText('spendingLimitUsdCap'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('spendingLimitSaveFailed');
    expect(screen.queryByText('raw backend detail')).not.toBeInTheDocument();
    expect(screen.getByLabelText('spendingLimitUsdCap')).toHaveValue('10');
  });
});
