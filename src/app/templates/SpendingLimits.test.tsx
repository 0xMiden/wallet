import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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
  useTranslation: () => ({
    t: (key: string, options?: { amount?: string }) =>
      options?.amount === undefined ? key : `${key}:${options.amount}`
  })
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

  it('lays the disclosures out as the three "how limits work" facts, each under its own title', async () => {
    renderScreen();

    await screen.findByLabelText('spendingLimitUsdCap');
    expect(screen.getByRole('heading', { name: 'spendingLimitHowItWorks' })).toBeInTheDocument();
    const facts: ReadonlyArray<readonly [string, string]> = [
      ['spendingLimitStoredOnDevice', 'spendingLimitLocalDisclosure'],
      ['spendingLimitLocalSafetyCheck', 'spendingLimitNotOnChain'],
      ['spendingLimitPricedAssetsOnly', 'spendingLimitCoverage']
    ];
    for (const [title, description] of facts) {
      expect(screen.getByText(title)).toBeInTheDocument();
      expect(screen.getByText(description)).toBeInTheDocument();
    }
  });

  it('shows the saved limit in a pill, or that none is set', async () => {
    mockReadSpendingLimit.mockResolvedValue(configuration());
    const { unmount } = renderScreen();

    expect(await screen.findByText('spendingLimitCurrent:$20')).toBeInTheDocument();
    expect(screen.queryByText('spendingLimitNone')).not.toBeInTheDocument();
    unmount();

    mockReadSpendingLimit.mockResolvedValue(undefined);
    renderScreen();

    expect(await screen.findByText('spendingLimitNone')).toBeInTheDocument();
  });

  it('shows a fractional saved limit with its cents (#1279)', async () => {
    mockReadSpendingLimit.mockResolvedValue(configuration({ limit: 20_500_000n }));
    renderScreen();

    expect(await screen.findByText('spendingLimitCurrent:$20.50')).toBeInTheDocument();
  });

  it('offers whole-dollar presets that fill the field, and none is selected for a typed amount', async () => {
    mockReadSpendingLimit.mockResolvedValue(configuration());
    renderScreen();

    const field = await screen.findByLabelText('spendingLimitUsdCap');
    const presets = screen.getByRole('radiogroup', { name: 'spendingLimitPresets' });
    const choices = within(presets).getAllByRole('radio');
    expect(choices.map(choice => choice.textContent)).toEqual(['$100', '$500', '$1,000', '$5,000']);
    // The saved $20 is not a preset, so nothing reads as chosen.
    expect(choices.every(choice => choice.getAttribute('aria-checked') !== 'true')).toBe(true);

    fireEvent.click(within(presets).getByRole('radio', { name: '$500' }));

    expect(field).toHaveValue('500');
    expect(within(presets).getByRole('radio', { name: '$500' })).toHaveAttribute('aria-checked', 'true');
  });

  it('saves a preset like a typed amount: raising the cap still asks for authentication', async () => {
    mockReadSpendingLimit.mockResolvedValue(configuration());
    renderScreen();

    await screen.findByLabelText('spendingLimitUsdCap');
    fireEvent.click(screen.getByRole('radio', { name: '$1,000' }));
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));

    expect(await screen.findByTestId('strict-authentication')).toBeInTheDocument();
    // The presets give way to the authentication prompt while it is up.
    expect(screen.queryByRole('radiogroup', { name: 'spendingLimitPresets' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));

    await waitFor(() =>
      expect(mockSaveSpendingLimit).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'account-a', limit: 1_000_000_000n }),
        'revision-1',
        true
      )
    );
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

  it('keeps the amount read-only while strict authentication is open (#1279)', async () => {
    mockReadSpendingLimit.mockResolvedValue(configuration());
    renderScreen();

    const field = await screen.findByLabelText('spendingLimitUsdCap');
    fireEvent.change(field, { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));

    await screen.findByTestId('strict-authentication');
    // Authentication saves the draft captured at Save, so the field must not show another amount.
    expect(screen.getByLabelText('spendingLimitUsdCap')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));

    await waitFor(() =>
      expect(mockSaveSpendingLimit).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 25_000_000n }),
        'revision-1',
        true
      )
    );
    await waitFor(() => expect(screen.getByLabelText('spendingLimitUsdCap')).toBeEnabled());
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

  it('keeps the presets read-only while a save is in flight (#1279)', async () => {
    mockReadSpendingLimit.mockResolvedValue(configuration());
    let resolveSave!: (value: SpendingLimitConfiguration) => void;
    mockSaveSpendingLimit.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveSave = resolve;
        })
    );
    renderScreen();

    fireEvent.change(await screen.findByLabelText('spendingLimitUsdCap'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));

    const presets = screen.getByRole('radiogroup', { name: 'spendingLimitPresets' });
    await waitFor(() => expect(mockSaveSpendingLimit).toHaveBeenCalledTimes(1));
    for (const radio of within(presets).getAllByRole('radio')) expect(radio).toBeDisabled();
    fireEvent.click(within(presets).getByRole('radio', { name: '$500' }));
    expect(screen.getByLabelText('spendingLimitUsdCap')).toHaveValue('10');

    resolveSave(configuration({ limit: 10_000_000n, revision: 'saved-revision' }));
    await waitFor(() => {
      for (const radio of within(presets).getAllByRole('radio')) expect(radio).toBeEnabled();
    });
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

  it('persists nothing and hides the authentication UI when authentication is cancelled', async () => {
    mockReadSpendingLimit.mockResolvedValue(configuration());
    renderScreen();

    fireEvent.change(await screen.findByLabelText('spendingLimitUsdCap'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'spendingLimitSave' }));
    await screen.findByTestId('strict-authentication');

    fireEvent.click(screen.getByRole('button', { name: 'cancel-authentication' }));

    expect(mockSaveSpendingLimit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('strict-authentication')).not.toBeInTheDocument();
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

  it('discards a load that resolves after a newer load has already started', async () => {
    let resolveFirst!: (value: SpendingLimitConfiguration | undefined) => void;
    mockReadSpendingLimit.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFirst = resolve;
        })
    );
    const view = renderScreen();
    expect(screen.getByRole('status')).toHaveTextContent('loading');

    mockWalletState.currentAccount = { publicKey: 'account-b' };
    mockReadSpendingLimit.mockResolvedValue(
      configuration({ accountId: 'account-b', limit: 5_000_000n, revision: 'revision-b' })
    );
    view.rerender(<SpendingLimits />);
    expect(await screen.findByLabelText('spendingLimitUsdCap')).toHaveValue('5');

    // The abandoned first read for account-a finally settles. Its result must not clobber the
    // field that already reflects the account the user is now looking at. Flushed explicitly,
    // rather than through `waitFor` - `waitFor`'s first (synchronous) poll would pass trivially
    // before the stale `.then` has even had a chance to run, proving nothing about the guard.
    await act(async () => {
      resolveFirst(configuration({ limit: 20_000_000n, revision: 'revision-1' }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByLabelText('spendingLimitUsdCap')).toHaveValue('5');
  });

  it('discards a load failure that arrives after a newer load has already started', async () => {
    let rejectFirst!: (error: Error) => void;
    mockReadSpendingLimit.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectFirst = reject;
        })
    );
    const view = renderScreen();
    expect(screen.getByRole('status')).toHaveTextContent('loading');

    mockWalletState.currentAccount = { publicKey: 'account-b' };
    mockReadSpendingLimit.mockResolvedValue(
      configuration({ accountId: 'account-b', limit: 5_000_000n, revision: 'revision-b' })
    );
    view.rerender(<SpendingLimits />);
    expect(await screen.findByLabelText('spendingLimitUsdCap')).toHaveValue('5');

    // The abandoned first read fails late. It must not retroactively mark the now-loaded screen
    // as failed. Flushed explicitly for the same reason as the sibling success case above.
    await act(async () => {
      rejectFirst(new Error('stale storage failure'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('spendingLimitUsdCap')).toHaveValue('5');
  });

  it('ignores a second save while the first is still writing', async () => {
    mockReadSpendingLimit.mockResolvedValue(configuration());
    let resolveSave!: (value: SpendingLimitConfiguration) => void;
    mockSaveSpendingLimit.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveSave = resolve;
        })
    );
    renderScreen();

    fireEvent.change(await screen.findByLabelText('spendingLimitUsdCap'), { target: { value: '10' } });
    const saveButton = screen.getByRole('button', { name: 'spendingLimitSave' });
    // Both clicks inside one `act` so the first click's `saving` update has not yet re-rendered
    // (and disabled the button) by the time the second is dispatched - the actual race a fast
    // double-tap produces, not one artificially spaced out by an intervening flush.
    act(() => {
      fireEvent.click(saveButton);
      fireEvent.click(saveButton);
    });

    resolveSave(configuration({ limit: 10_000_000n }));
    await waitFor(() => expect(mockSaveSpendingLimit).toHaveBeenCalledTimes(1));
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
