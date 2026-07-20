import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { EARN_DATA } from './data';

// `lib/woozie` reaches for browser history state on import; stub `navigate`
// so we can assert the deposit-review push without running the real router.
jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

// `./components` transitively pulls in the `app/icons/v2` SVG barrel plus the
// `CircleButton`/`TokenLogo` widgets. Stub `EarnFlowHeader` to a probe that
// surfaces which vault the page resolved (`data-vault-id`) so we can prove the
// found-vault vs. default-vault branch without rendering the real header.
jest.mock('./components', () => ({
  EarnFlowHeader: ({ vault }: { vault: { id: string; protocol: string; asset: string; network: string } }) => (
    <div
      data-testid="earn-flow-header"
      data-vault-id={vault.id}
      data-protocol={vault.protocol}
      data-asset={vault.asset}
      data-network={vault.network}
    />
  )
}));

// `screens/send-flow/SelectAmount` renders the full amount-input chrome (haptics,
// AmountInput, i18n Button). Stub it to a probe that mirrors every prop the page
// wires through as data-attributes and exposes controls to drive the callbacks
// (`onAmountChange`, `onConfirm`, `onSelectToken`).
jest.mock('screens/send-flow/SelectAmount', () => ({
  SelectAmount: (props: {
    token?: { id: string; name: string; decimals: number; balance: number; fiatPrice: number };
    amount: string;
    isValidAmount: boolean;
    label?: React.ReactNode;
    confirmTitle?: string;
    showNetworkPill?: boolean;
    showBalanceHelper?: boolean;
    footerClassName?: string;
    onAmountChange: (amount: string) => void;
    onSelectToken: () => void;
    onConfirm?: () => void;
  }) => (
    <div
      data-testid="select-amount"
      data-amount={props.amount}
      data-valid={String(props.isValidAmount)}
      data-label={String(props.label)}
      data-confirm-title={props.confirmTitle}
      data-show-network-pill={String(props.showNetworkPill)}
      data-show-balance-helper={String(props.showBalanceHelper)}
      data-footer={props.footerClassName}
      data-token-id={props.token?.id}
      data-token-name={props.token?.name}
      data-token-decimals={String(props.token?.decimals)}
      data-token-balance={String(props.token?.balance)}
      data-token-fiat={String(props.token?.fiatPrice)}
    >
      <input data-testid="amount-input" onChange={e => props.onAmountChange(e.target.value)} />
      <button data-testid="confirm" onClick={() => props.onConfirm?.()} />
      <button data-testid="select-token" onClick={() => props.onSelectToken()} />
    </div>
  )
}));

import { navigate } from 'lib/woozie';

import EarnDepositAmount from './EarnDepositAmount';

const mockNavigate = navigate as jest.Mock;

const FOUND_VAULT = EARN_DATA.vaults[1]!; // 'aave-usdc-ethereum-2'
const DEFAULT_VAULT = EARN_DATA.vaults[0]!; // 'aave-usdc-ethereum-1'

const setAmount = (value: string) => fireEvent.change(screen.getByTestId('amount-input'), { target: { value } });

beforeEach(() => {
  mockNavigate.mockClear();
});

describe('EarnDepositAmount', () => {
  it('renders the page shell and resolves the vault matching vaultId', () => {
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    expect(screen.getByTestId('earn-deposit-amount-page')).toBeInTheDocument();

    const header = screen.getByTestId('earn-flow-header');
    // `find` returns the matching vault, so the `?? DEFAULT_VAULT` fallback is not taken.
    expect(header).toHaveAttribute('data-vault-id', FOUND_VAULT.id);
    expect(header).toHaveAttribute('data-protocol', FOUND_VAULT.protocol);
    expect(header).toHaveAttribute('data-asset', FOUND_VAULT.asset);
    expect(header).toHaveAttribute('data-network', FOUND_VAULT.network);
  });

  it('derives the deposit token from the resolved vault asset', () => {
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    const select = screen.getByTestId('select-amount');
    expect(select).toHaveAttribute('data-token-id', FOUND_VAULT.asset.toLowerCase());
    expect(select).toHaveAttribute('data-token-name', FOUND_VAULT.asset);
    expect(select).toHaveAttribute('data-token-decimals', '6');
    expect(select).toHaveAttribute('data-token-balance', '200');
    expect(select).toHaveAttribute('data-token-fiat', '1');
  });

  it('forwards the static SelectAmount presentation props', () => {
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    const select = screen.getByTestId('select-amount');
    expect(select).toHaveAttribute('data-label', 'Deposit Amount');
    expect(select).toHaveAttribute('data-confirm-title', 'Confirm');
    expect(select).toHaveAttribute('data-show-network-pill', 'false');
    expect(select).toHaveAttribute('data-footer', 'pt-4 pb-6');
  });

  it('falls back to the default vault when vaultId matches nothing', () => {
    render(<EarnDepositAmount vaultId="no-such-vault" />);

    // `find` returns undefined, so `?? DEFAULT_VAULT` supplies the first vault.
    expect(screen.getByTestId('earn-flow-header')).toHaveAttribute('data-vault-id', DEFAULT_VAULT.id);
  });

  it('shows the balance helper and blocks confirm while the amount is empty', () => {
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    const select = screen.getByTestId('select-amount');
    // Empty amount => hasAmount false => isValidAmount short-circuits false, helper shown.
    expect(select).toHaveAttribute('data-amount', '');
    expect(select).toHaveAttribute('data-valid', 'false');
    expect(select).toHaveAttribute('data-show-balance-helper', 'true');

    fireEvent.click(screen.getByTestId('confirm'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('treats non-numeric input as zero (parseAmount `|| 0` branch)', () => {
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    setAmount('abc');

    const select = screen.getByTestId('select-amount');
    expect(select).toHaveAttribute('data-amount', 'abc');
    expect(select).toHaveAttribute('data-valid', 'false');
    expect(select).toHaveAttribute('data-show-balance-helper', 'true');

    fireEvent.click(screen.getByTestId('confirm'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('accepts a comma-formatted amount within balance and navigates on confirm', () => {
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    // "1,50" -> strip commas -> 150 (<= balance 200) => valid; helper hidden.
    setAmount('1,50');

    const select = screen.getByTestId('select-amount');
    expect(select).toHaveAttribute('data-amount', '1,50');
    expect(select).toHaveAttribute('data-valid', 'true');
    expect(select).toHaveAttribute('data-show-balance-helper', 'false');

    fireEvent.click(screen.getByTestId('confirm'));
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    // amount is URL-encoded, so the comma becomes %2C.
    expect(mockNavigate).toHaveBeenCalledWith(`/earn/vaults/${FOUND_VAULT.id}/deposit/review?amount=1%2C50`);
  });

  it('rejects an amount above the balance and does not navigate', () => {
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    // 250 > balance 200 => hasAmount true but `amountValue <= balance` false.
    setAmount('250');

    const select = screen.getByTestId('select-amount');
    expect(select).toHaveAttribute('data-valid', 'false');
    // hasAmount is true, so the balance helper is hidden even though it's invalid.
    expect(select).toHaveAttribute('data-show-balance-helper', 'false');

    fireEvent.click(screen.getByTestId('confirm'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('wires onSelectToken as a no-op that does not throw or navigate', () => {
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    expect(() => fireEvent.click(screen.getByTestId('select-token'))).not.toThrow();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
