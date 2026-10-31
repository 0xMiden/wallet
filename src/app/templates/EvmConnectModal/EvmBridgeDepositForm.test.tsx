import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { evmQuote } from 'lib/prices/evm';

import { EvmBridgeDepositForm } from './EvmBridgeDepositForm';
import { BRIDGE_SOURCE_NETWORK_JS } from '../../../../playwright/e2e/helpers/send-flow-scripts';

let mockRawTranslationTrap = false;
const mockTranslate = jest.fn((key: string) =>
  key === 'amountMustBeLessThanBalance'
    ? 'Visible balance limit'
    : key === 'invalidAmount'
      ? 'Visible invalid amount'
      : mockRawTranslationTrap
        ? 'Unexpected translated raw balance'
        : key
);
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: mockTranslate }) }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getTestNetworkNameKey: () => 'testnet',
  getEffectiveNetworkName: () => 'testnet'
}));
jest.mock('lib/prices/evm', () => ({ evmQuote: jest.fn(() => undefined) }));
jest.mock('components/TokenLogo', () => ({ TokenLogo: () => null }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));

const props = {
  token: { id: 'usdc', name: 'USDC', decimals: 6, balance: 100, fiatPrice: 1, scaleIsKnown: true },
  tokenLabel: 'Circle USDC',
  arrivingName: 'USDCx',
  network: { id: 'arc-testnet', name: 'Arc Testnet', chainId: 5042002 },
  amount: '10',
  isValidAmount: true,
  evmAddress: '0x1234567890123456789012345678901234567890',
  onAmountChange: jest.fn(),
  onSelectToken: jest.fn(),
  onSelectNetwork: jest.fn(),
  onSwitch: jest.fn(),
  onContinue: jest.fn()
};

beforeEach(() => jest.clearAllMocks());

it('resolves the configured native ETH selection as the zero-address asset, not a ticker quote', () => {
  render(<EvmBridgeDepositForm {...props} token={{ ...props.token, id: 'ETH', name: 'ETH', decimals: 18 }} />);
  expect(evmQuote).toHaveBeenCalledWith(
    expect.anything(),
    props.network.chainId,
    '0x0000000000000000000000000000000000000000'
  );
});

it('names the source network and Miden output before continuing', () => {
  render(<EvmBridgeDepositForm {...props} />);
  expect(screen.getByTestId('bridge-source-network')).toHaveTextContent('Arc Testnet');
  expect(screen.getByTestId('bridge-destination')).toHaveTextContent('miden');
  expect(screen.getByTestId('bridge-destination')).toHaveTextContent('USDCx');
  fireEvent.click(screen.getByTestId('bridge-source-network'));
  expect(props.onSelectNetwork).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId('send-amount-confirm'));
  expect(props.onContinue).toHaveBeenCalledTimes(1);
});

// The iOS E2E reads the From row with this body to prove the source chain before the amount: "Sepolia" is part of
// "Base Sepolia", so it must read the name alone, not the label or another row.
it("gives the E2E From row read the network's name alone", () => {
  render(
    <div data-page-layer="/bridge/deposit">
      <EvmBridgeDepositForm {...props} network={{ id: 'base-sepolia', name: 'Base Sepolia', chainId: 84532 }} />
    </div>
  );
  // eslint-disable-next-line no-new-func -- runs the driver's script body in this document, as cdp.eval does
  expect(new Function(BRIDGE_SOURCE_NETWORK_JS)()).toBe('Base Sepolia');
});

it('shows the available balance and retains the test-funds warning', () => {
  render(<EvmBridgeDepositForm {...props} />);
  expect(screen.getByTestId('send-token-selector')).toHaveTextContent('available 100');
  expect(screen.getByTestId('bridge-test-funds-warning')).toHaveAttribute('role', 'note');
});

it('labels an unreadable balance unavailable', () => {
  const unreadableProps = {
    ...props,
    token: { ...props.token, balance: 0 },
    balanceUnreadable: true
  } as React.ComponentProps<typeof EvmBridgeDepositForm> & { balanceUnreadable: boolean };
  const view = render(<EvmBridgeDepositForm {...unreadableProps} />);

  expect(screen.getByTestId('send-token-selector')).toHaveTextContent('unavailable');
  expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();

  view.rerender(<EvmBridgeDepositForm {...props} token={{ ...props.token, balance: 0 }} />);
  expect(screen.getByTestId('send-token-selector')).toHaveTextContent('available 0');
  expect(screen.getByTestId('send-amount-confirm')).toBeEnabled();
});

it.each([
  { token: { ...props.token, scaleIsKnown: false } },
  { network: undefined },
  { isValidAmount: false },
  { token: { ...props.token, balance: null } }
])('refuses to continue without a valid amount, known scale, network and balance: %j', override => {
  render(<EvmBridgeDepositForm {...props} {...override} />);
  expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
});

const mockReportUserVisibleError = jest.fn();
jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: (...args: unknown[]) => mockReportUserVisibleError(...args)
}));

const expectErrorAfterDwell = async (id: string, surface: string) => {
  await act(async () => {
    jest.advanceTimersByTime(999);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([[id, surface]]);
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([[id, surface]]);
};

describe('user-visible bridge amount errors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRawTranslationTrap = false;
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('forwards owned balance evidence only while that balance failure is displayed', async () => {
    const errorDiagnostics: {
      kind: 'bridge_balance_read';
      bridgeBalanceBranch: 'circle_usdc';
      bridgeBalanceStage: 'request';
    } = {
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'circle_usdc',
      bridgeBalanceStage: 'request'
    };
    const evidenceProps = { errorDiagnostics };
    const view = render(<EvmBridgeDepositForm {...props} {...evidenceProps} error="private balance failure" />);
    expect(screen.getByText('private balance failure')).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([['raw_bridge_balance_failed', 'field', errorDiagnostics]]);
    mockReportUserVisibleError.mockClear();
    view.rerender(<EvmBridgeDepositForm {...props} {...evidenceProps} error="amountMustBeLessThanBalance" />);
    expect(screen.getByText('Visible balance limit')).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([['amountMustBeLessThanBalance', 'field']]);
  });

  it('renders the raw balance-read text even when translation would replace it', () => {
    const raw = 'private balance 42 at https://synthetic.invalid/0xabc';
    mockRawTranslationTrap = true;
    render(<EvmBridgeDepositForm {...props} error={raw} />);
    expect(screen.getByText(raw)).toBeInTheDocument();
    expect(mockTranslate.mock.calls.filter(([key]) => key === raw)).toEqual([]);
  });

  it.each([
    [
      'raw balance read',
      'private balance 42 at https://synthetic.invalid/0xabc',
      'private balance 42 at https://synthetic.invalid/0xabc',
      'raw_bridge_balance_failed'
    ],
    ['known balance limit', 'amountMustBeLessThanBalance', 'Visible balance limit', 'amountMustBeLessThanBalance']
  ])('reports the %s field identity after its displayed dwell', async (_label, error, copy, id) => {
    const view = render(<EvmBridgeDepositForm {...props} error={error} />);
    expect(screen.getByText(copy!)).toBeInTheDocument();
    view.rerender(<EvmBridgeDepositForm {...props} amount="10.5" error={error} />);
    await expectErrorAfterDwell(id!, 'field');
  });

  it('retains the unused invalid-amount rendering branch without inventing a reporting producer', async () => {
    render(<EvmBridgeDepositForm {...props} error="invalidAmount" />);
    expect(screen.getByText('Visible invalid amount')).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });

  it('keeps an empty amount, loading balance and test-funds caution quiet', async () => {
    const view = render(<EvmBridgeDepositForm {...props} amount="" error="invalidAmount" />);
    expect(screen.queryByText('invalidAmount')).not.toBeInTheDocument();
    expect(screen.getByTestId('bridge-test-funds-warning')).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    view.rerender(<EvmBridgeDepositForm {...props} token={{ ...props.token, balance: null }} />);
    expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });

  it.each(['clear', 'unmount'])('cancels the field episode on %s before dwell', async action => {
    const view = render(<EvmBridgeDepositForm {...props} error="private balance read failed" />);
    await act(async () => {
      jest.advanceTimersByTime(999);
    });
    if (action === 'clear') view.rerender(<EvmBridgeDepositForm {...props} />);
    else view.unmount();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.queryByText('private balance read failed')).not.toBeInTheDocument();
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });
});
