import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { TEST_MIDEN_USDC } from 'lib/epoch/testing/bridge-config';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { navigate } from 'lib/woozie';

import { EARN_DATA } from './data';
import EarnDepositAmount from './EarnDepositAmount';

// `lib/woozie` reaches for browser history state on import; stub `navigate`
// so we can assert the deposit-review push without running the real router.
// A load that did not fully succeed is driven per test; the default is a clean load.
let mockLoadState: { isLoading: boolean; error?: string; loadError?: string } = { isLoading: false };
const mockRefetch = jest.fn();

// The bridged price entries the testnet config names (the manual mock beside the module).
jest.mock('lib/miden/swap/bridge-price-allowlist');
let mockBaseFee: number | null = 0;
jest.mock('app/hooks/useVerificationBaseFee', () => ({ __esModule: true, default: () => mockBaseFee }));
let mockLegacyFeeIdentity: string | undefined;
jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => mockLegacyFeeIdentity ?? 'MIDEN-ID'
}));
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => 'MIDEN-ID' }));
jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

// i18n: assert on keys, not English copy.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `./components` transitively pulls in the `app/icons/v2` SVG barrel plus the
// `IconButton`/`TokenLogo` widgets. Stub `EarnFlowHeader` to a probe that
// surfaces which vault the page resolved (`data-vault-id`) so we can prove the
// found-vault vs. default-vault branch without rendering the real header.
jest.mock('./components', () => ({
  EarnFlowHeader: ({ subject }: { subject?: { id: string; protocol: string; asset: string; network: string } }) => (
    <div
      data-testid="earn-flow-header"
      data-vault-id={subject?.id ?? 'none'}
      data-protocol={subject?.protocol ?? 'none'}
      data-asset={subject?.asset ?? 'none'}
      data-network={subject?.network ?? 'none'}
    />
  )
}));

// `screens/send-flow/SelectAmount` renders the full amount-input chrome (haptics,
// AmountInput, i18n Button). Stub it to a probe that mirrors every prop the page
// wires through as data-attributes and exposes controls to drive the callbacks
// (`onAmountChange`, `onConfirm`, `onSelectToken`).
jest.mock('screens/send-flow/SelectAmount', () => ({
  SelectAmount: (props: {
    accent?: string;
    token?: { id: string; name: string; decimals: number; balance: number; fiatPrice: number };
    amount: string;
    isValidAmount: boolean;
    label?: React.ReactNode;
    confirmTitle?: string;
    showNetworkPill?: boolean;
    showBalanceHelper?: boolean;
    onAmountChange: (amount: string) => void;
    onSelectToken: () => void;
    onConfirm?: () => void;
  }) => (
    <div
      data-testid="select-amount"
      data-accent={props.accent}
      data-amount={props.amount}
      data-valid={String(props.isValidAmount)}
      data-label={String(props.label)}
      data-confirm-title={props.confirmTitle}
      data-show-network-pill={String(props.showNetworkPill)}
      data-show-balance-helper={String(props.showBalanceHelper)}
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

// The page resolves its vault from live Epoch data via `useEarnPositions`
// (`useAccount` + SWR under the hood). Serve the static demo fixture instead.
jest.mock('./useEarnPositions', () => {
  const { EARN_DATA } = jest.requireActual<typeof import('./data')>('./data');
  return {
    ...jest.requireActual<typeof import('./useEarnPositions')>('./useEarnPositions'),
    useEarnPositions: () => ({
      summary: EARN_DATA.summary,
      positions: EARN_DATA.positions,
      vaults: EARN_DATA.vaults,
      ...mockLoadState,
      refetch: mockRefetch
    })
  };
});

// The deposit token comes from the account's USDC balance row. The row's stored fiatPrice is a
// capture from when balances were read (0 here: read before any quote), which the screen must not
// trust; its price comes from the live quote in the store.
const USDC_ROW = {
  tokenId: TEST_MIDEN_USDC.faucetId,
  balance: 200,
  fiatPrice: 0,
  metadata: { symbol: 'USDC', decimals: 6 }
};
let mockBalanceRows: unknown[] = [USDC_ROW];
jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: 'mm1testaccount', evmAddress: '0xabc' }),
  useAllTokensBaseMetadata: () => ({}),
  useAllBalances: () => ({ data: mockBalanceRows })
}));

const USDC_QUOTE = { USDC: { price: 1.0002, change24h: 0, percentageChange24h: 0 } };
let mockTokenPrices: Record<string, unknown> = USDC_QUOTE;
jest.mock('lib/store', () => ({
  useWalletStore: (select: (state: { tokenPrices: unknown }) => unknown) => select({ tokenPrices: mockTokenPrices })
}));

// `lib/epoch` is the Epoch SDK barrel (wasm + network clients). Only the id normalizer is used here.
jest.mock('lib/epoch', () => ({
  normalizeMidenIdToHex: (id: string) => id.toLowerCase()
}));

// The deposit collateral comes from the bridge config (an E2E run's injected faucet first).
let mockCollateral: { faucetId: string; symbol: string; decimals: number } | null = null;
let mockEarnDeposit: FeatureAvailability = { state: 'available' };
const mockFeatureAvailability = jest.fn(
  (feature: string, _options?: { hold?: boolean }): FeatureAvailability =>
    feature === 'earnDeposit' ? mockEarnDeposit : { state: 'loading' }
);
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => ({}),
  useFeatureAvailability: (feature: string, options?: { hold?: boolean }) => mockFeatureAvailability(feature, options)
}));
jest.mock('lib/remote-config/values', () => ({ selectMidenUsdc: () => mockCollateral }));

const mockNavigate = navigate as jest.Mock;

const FOUND_VAULT = EARN_DATA.vaults[1]!; // 'aave-usdc-ethereum-2'

const setAmount = (value: string) => fireEvent.change(screen.getByTestId('amount-input'), { target: { value } });

beforeEach(() => {
  mockNavigate.mockClear();
  mockBalanceRows = [USDC_ROW];
  mockTokenPrices = USDC_QUOTE;
  mockCollateral = TEST_MIDEN_USDC;
  mockEarnDeposit = { state: 'available' };
});

describe('EarnDepositAmount', () => {
  it.each([
    [1, 0, 'true'],
    [0, 1, 'false']
  ])('fee identity: gates a deposit using actual A=%s despite legacy B=%s', (actual, legacy, valid) => {
    mockLegacyFeeIdentity = 'legacy-B';
    mockBaseFee = 7;
    mockBalanceRows = [
      USDC_ROW,
      { ...USDC_ROW, tokenId: 'MIDEN-ID', balance: actual },
      { ...USDC_ROW, tokenId: 'legacy-B', balance: legacy }
    ];
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);
    setAmount('1');
    expect(screen.getByTestId('select-amount')).toHaveAttribute('data-valid', valid);
  });

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

  it('derives the deposit token from the account USDC balance row', () => {
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    const select = screen.getByTestId('select-amount');
    expect(select).toHaveAttribute('data-token-id', TEST_MIDEN_USDC.faucetId);
    expect(select).toHaveAttribute('data-token-name', 'USDC');
    expect(select).toHaveAttribute('data-token-decimals', '6');
    expect(select).toHaveAttribute('data-token-balance', '200');
    // The live USDC quote, not the 0 the row captured before prices landed.
    expect(select).toHaveAttribute('data-token-fiat', '1.0002');
  });

  it.each([
    ['a USDC row', [USDC_ROW]],
    ['no USDC row', []]
  ])('gives the deposit token no price without a USDC quote, with %s', (_label, rows) => {
    mockBalanceRows = rows;
    mockTokenPrices = {};
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    expect(screen.getByTestId('select-amount')).toHaveAttribute('data-token-fiat', '0');
  });

  it('takes up the quote when prices land after the screen opened', () => {
    mockTokenPrices = {};
    const { rerender } = render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);
    expect(screen.getByTestId('select-amount')).toHaveAttribute('data-token-fiat', '0');

    mockTokenPrices = USDC_QUOTE;
    rerender(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);
    expect(screen.getByTestId('select-amount')).toHaveAttribute('data-token-fiat', '1.0002');
  });

  it('prices the deposit token from the quote when the account holds no USDC yet', () => {
    mockBalanceRows = [];
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    expect(screen.getByTestId('select-amount')).toHaveAttribute('data-token-fiat', '1.0002');
  });

  it('forwards the static SelectAmount presentation props', () => {
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    const select = screen.getByTestId('select-amount');
    expect(select).toHaveAttribute('data-accent', 'earn');
    expect(select).toHaveAttribute('data-label', 'earnDepositAmountLabel');
    expect(select).toHaveAttribute('data-confirm-title', 'confirm');
    expect(select).toHaveAttribute('data-show-network-pill', 'false');
  });

  it('names no vault in the header when vaultId matches nothing', () => {
    render(<EarnDepositAmount vaultId="no-such-vault" />);

    // The header gets the vault it found, never the "—" placeholder.
    expect(screen.getByTestId('earn-flow-header')).toHaveAttribute('data-vault-id', 'none');
  });

  it('shows the balance helper and blocks confirm while the amount is empty', () => {
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    const select = screen.getByTestId('select-amount');
    // Empty amount => hasAmount false => isValidAmount short-circuits false, helper shown.
    expect(select).toHaveAttribute('data-amount', '');
    expect(select).toHaveAttribute('data-valid', 'false');
    expect(select).not.toHaveAttribute('data-show-balance-helper', 'false');

    fireEvent.click(screen.getByTestId('confirm'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('treats non-numeric input as zero (parseAmount `|| 0` branch)', () => {
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    setAmount('abc');

    const select = screen.getByTestId('select-amount');
    expect(select).toHaveAttribute('data-amount', 'abc');
    expect(select).toHaveAttribute('data-valid', 'false');
    expect(select).not.toHaveAttribute('data-show-balance-helper', 'false');

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
    // The available balance stays up while an amount is typed, as in the send flow.
    expect(select).not.toHaveAttribute('data-show-balance-helper', 'false');

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
    // The available balance stays up while an amount is typed, as in the send flow.
    expect(select).not.toHaveAttribute('data-show-balance-helper', 'false');

    fireEvent.click(screen.getByTestId('confirm'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('blocks Continue under the notice while Earn deposits are unavailable', () => {
    mockEarnDeposit = { state: 'unavailable', reason: 'not-deployed', detail: 'evmUsdc has no code' };
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);
    setAmount('150');

    expect(screen.getByTestId('select-amount')).toHaveAttribute('data-valid', 'false');
    expect(screen.getByTestId('feature-unavailable-notice')).toHaveTextContent('bridgeFeatureUnavailableBody');
    fireEvent.click(screen.getByTestId('confirm'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('wires onSelectToken as a no-op that does not throw or navigate', () => {
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    expect(() => fireEvent.click(screen.getByTestId('select-token'))).not.toThrow();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('EarnDepositAmount after a failed load', () => {
  afterEach(() => {
    mockLoadState = { isLoading: false };
  });

  it('says the load failed, with Retry, instead of taking an amount for a placeholder vault', () => {
    mockLoadState = { isLoading: false, error: 'boom', loadError: 'boom' };
    render(<EarnDepositAmount vaultId="no-such-vault" />);

    expect(screen.getByRole('alert')).toHaveTextContent('earnVaultLoadError');
    expect(screen.getByRole('alert')).not.toHaveTextContent('earnPositionsLoadError');
    expect(screen.queryByTestId('select-amount')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the failure said while a retry is out, with no vault in the header', () => {
    mockLoadState = { isLoading: false, error: 'boom', loadError: 'boom' };
    render(<EarnDepositAmount vaultId="no-such-vault" />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('earn-flow-header')).toHaveAttribute('data-vault-id', 'none');
  });

  it('draws nothing it has not loaded during a first load with no error', () => {
    mockLoadState = { isLoading: true };
    render(<EarnDepositAmount vaultId="no-such-vault" />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('select-amount')).toBeNull();
  });

  it("shows no notice over a found vault when only one owner's positions failed", () => {
    mockLoadState = { isLoading: false, error: 'owner unavailable' };
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('select-amount')).toBeInTheDocument();
  });

  it('keeps a vault it already has, under the notice', () => {
    mockLoadState = { isLoading: false, error: 'boom', loadError: 'boom' };
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    expect(screen.getByRole('alert')).toHaveTextContent('earnVaultLoadError');
    expect(screen.getByRole('alert')).not.toHaveTextContent('earnPositionsLoadError');
    expect(screen.getByTestId('select-amount')).toBeInTheDocument();
  });
});

// The fast poll is held only for a greyed-out Continue, which the pending and vault-less failed branches never draw.
describe('EarnDepositAmount fast-poll hold', () => {
  afterEach(() => {
    mockLoadState = { isLoading: false };
  });

  it.each<[string, string, { isLoading: boolean; error?: string; loadError?: string }, boolean]>([
    ['a loaded vault', FOUND_VAULT.id, { isLoading: false }, true],
    ['a vault kept over a failed load', FOUND_VAULT.id, { isLoading: false, error: 'boom', loadError: 'boom' }, true],
    ['a first load in flight', 'no-such-vault', { isLoading: true }, false],
    ['a failed load with no vault', 'no-such-vault', { isLoading: false, error: 'boom', loadError: 'boom' }, false]
  ])('asks for it only where it draws the notice: %s', (_state, vaultId, loadState, hold) => {
    mockLoadState = loadState;
    mockEarnDeposit = { state: 'unavailable', reason: 'not-deployed', detail: 'evmUsdc has no code' };
    render(<EarnDepositAmount vaultId={vaultId} />);

    expect(screen.queryByTestId('feature-unavailable-notice') !== null).toBe(hold);
    expect(mockFeatureAvailability).toHaveBeenLastCalledWith('earnDeposit', { hold });
  });
});

describe('EarnDepositAmount with no vault', () => {
  it('never continues a valid amount into a deposit for the placeholder vault', () => {
    render(<EarnDepositAmount vaultId="no-such-vault" />);
    setAmount('10');

    expect(screen.getByTestId('select-amount')).toHaveAttribute('data-valid', 'false');
    fireEvent.click(screen.getByTestId('confirm'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });
  it('offers the collateral the config names, an injected E2E faucet included', () => {
    const injected = { faucetId: '0x00000000000000000000000000e2e0', symbol: 'tUSDC', decimals: 2 };
    mockCollateral = injected;
    mockBalanceRows = [USDC_ROW, { tokenId: injected.faucetId, balance: 5, fiatPrice: 0, metadata: injected }];
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);

    const select = screen.getByTestId('select-amount');
    expect(select).toHaveAttribute('data-token-id', injected.faucetId);
    expect(select).toHaveAttribute('data-token-name', 'tUSDC');
    expect(select).toHaveAttribute('data-token-decimals', '2');
    expect(select).toHaveAttribute('data-token-balance', '5');
  });

  it('offers no token, and no Continue, while the config names no collateral', () => {
    mockCollateral = null;
    render(<EarnDepositAmount vaultId={FOUND_VAULT.id} />);
    setAmount('1');

    const select = screen.getByTestId('select-amount');
    expect(select).toHaveAttribute('data-token-name', '');
    expect(select).toHaveAttribute('data-token-balance', '0');
    expect(select).toHaveAttribute('data-valid', 'false');
  });
});

beforeEach(() => {
  mockLegacyFeeIdentity = undefined;
});

beforeEach(() => {
  mockBaseFee = 0;
});
