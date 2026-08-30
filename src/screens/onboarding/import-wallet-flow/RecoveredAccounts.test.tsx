import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import type { WalletAccount } from 'lib/shared/types';

import { RecoveredAccountsScreen } from './RecoveredAccounts';
import { WalletType } from '../types';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
  Button: ({ title, onClick, disabled, className, variant, 'data-testid': testId }: any) => (
    <button data-testid={testId} data-variant={variant} onClick={onClick} disabled={disabled} className={className}>
      {title}
    </button>
  )
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/ui/badge', () => ({
  Badge: ({ children }: any) => <span data-testid="type-badge">{children}</span>
}));

const account = (over: Partial<WalletAccount>): WalletAccount => ({
  publicKey: 'mt1qpub0000000000000000000000000000',
  name: 'Account 1',
  isPublic: true,
  type: WalletType.OnChain,
  hdIndex: 0,
  ...over
});

const ACCOUNTS: WalletAccount[] = [
  account({ publicKey: 'mt1qpubaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Account 1' }),
  account({
    publicKey: 'mt1qguardianbbbbbbbbbbbbbbbbbbbbbbbb',
    name: 'Account 2',
    isPublic: false,
    type: WalletType.Guardian,
    hdIndex: 0
  })
];

const renderScreen = (overrides: Partial<React.ComponentProps<typeof RecoveredAccountsScreen>> = {}) => {
  const onScanMore = jest.fn();
  const onContinue = jest.fn();
  const utils = render(
    <RecoveredAccountsScreen accounts={ACCOUNTS} onScanMore={onScanMore} onContinue={onContinue} {...overrides} />
  );
  return { onScanMore, onContinue, ...utils };
};

describe('RecoveredAccountsScreen', () => {
  it('lists every recovered account with its name and type badge', () => {
    renderScreen();

    const rows = screen.getAllByTestId('recovered-account-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('Account 1')).toBeInTheDocument();
    expect(screen.getByText('Account 2')).toBeInTheDocument();

    const badges = screen.getAllByTestId('type-badge');
    expect(badges[0]).toHaveTextContent('accountBadgePublic');
    expect(badges[1]).toHaveTextContent('accountBadgeGuardian');
  });

  it('continues via the footer button', () => {
    const { onContinue } = renderScreen();
    fireEvent.click(screen.getByTestId('recovered-accounts-continue'));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('asks how many more accounts to search for, clamped to 1–20', () => {
    const { onScanMore } = renderScreen();

    // The count input is behind the "I have more accounts" disclosure.
    expect(screen.queryByTestId('scan-more-count')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('recovered-accounts-scan-more'));

    const input = screen.getByTestId('scan-more-count') as HTMLInputElement;
    expect(input).toHaveValue('5');

    // Out-of-bounds counts disable the search.
    fireEvent.change(input, { target: { value: '0' } });
    expect(screen.getByTestId('scan-more-submit')).toBeDisabled();
    fireEvent.change(input, { target: { value: '21' } });
    expect(screen.getByTestId('scan-more-submit')).toBeDisabled();
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(screen.getByTestId('scan-more-submit')).toBeDisabled();

    fireEvent.change(input, { target: { value: '7' } });
    expect(screen.getByTestId('scan-more-submit')).toBeEnabled();
    fireEvent.click(screen.getByTestId('scan-more-submit'));
    expect(onScanMore).toHaveBeenCalledWith(7);
  });

  it('shows the scanning state and disables both actions while a scan runs', () => {
    renderScreen({ isScanning: true });

    expect(screen.getByTestId('recovered-accounts-scanning')).toBeInTheDocument();
    expect(screen.getByText('scanningForAccounts')).toBeInTheDocument();
    expect(screen.getByTestId('recovered-accounts-continue')).toBeDisabled();
    expect(screen.getByTestId('recovered-accounts-scan-more')).toBeDisabled();
  });

  it('reports an empty extension scan and surfaces scan errors', () => {
    const { rerender, onScanMore, onContinue } = renderScreen({ lastScanFoundNone: true });
    expect(screen.getByText('noAdditionalAccountsFound')).toBeInTheDocument();

    rerender(
      <RecoveredAccountsScreen
        accounts={ACCOUNTS}
        scanError="operator down"
        onScanMore={onScanMore}
        onContinue={onContinue}
      />
    );
    expect(screen.getByText('operator down')).toBeInTheDocument();
  });
});
