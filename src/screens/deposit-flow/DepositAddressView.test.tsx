import React from 'react';

import { Clipboard } from '@capacitor/clipboard';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { addressLines, amountFontClass, DepositAddressView, type DepositAddressViewProps } from './DepositAddressView';

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key)
  })
}));
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { write: jest.fn(() => Promise.resolve()) } }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ faucetId }: { faucetId: string | undefined }) => <span data-testid={`logo-${faucetId}`} />
}));
jest.mock('components/QRCode', () => ({
  QRCode: ({ address, payload }: { address: string; payload?: string }) => (
    <span data-testid="qr" data-value={address} data-payload={payload} />
  )
}));

const ADDRESS = '0x8E2b41c07A5d39F1b6E4a2C8d0B73f5e169d41c7';

function props(overrides: Partial<DepositAddressViewProps> = {}): DepositAddressViewProps {
  return {
    layout: 'mobile',
    address: ADDRESS,
    amount: { amount: 70250000n, decimals: 6 },
    sourceToken: { symbol: 'USDC', logoFaucetId: 'usdc-logo' },
    network: { id: 'ethereum', name: 'Ethereum' },
    received: { amount: '70.04' },
    receivedToken: { symbol: 'USDCx', logoFaucetId: 'usdcx-logo' },
    bridgeFee: { kind: 'amount', value: { amount: '0.21' } },
    routeName: 'Epoch',
    arrivesIn: 'About 2 minutes',
    status: { kind: 'waiting' },
    onShowQr: jest.fn(),
    onOpenWallet: jest.fn(),
    onDepositReceived: jest.fn(),
    ...overrides
  };
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('addressLines', () => {
  it('breaks a 42-character address into two lines of 21', () => {
    expect(addressLines(ADDRESS)).toEqual([ADDRESS.slice(0, 21), ADDRESS.slice(21)]);
  });

  it('keeps a short address on one line and an empty one empty', () => {
    expect(addressLines('0xabc')).toEqual(['0xabc']);
    expect(addressLines('')).toEqual([]);
  });
});

describe('amountFontClass', () => {
  it('steps from 72px to 56px to 40px as the amount grows', () => {
    expect(amountFontClass('70.25')).toBe('text-[72px]');
    expect(amountFontClass('1234.567')).toBe('text-[56px]');
    expect(amountFontClass('1234.5678')).toBe('text-[40px]');
  });
});

describe('DepositAddressView on mobile', () => {
  it('shows the amount, the token, what arrives, the address in lines and the details', () => {
    render(<DepositAddressView {...props()} />);
    expect(screen.getByTestId('deposit-address-amount-label')).toHaveTextContent('depositFlowDepositAmount');
    expect(screen.getByTestId('deposit-address-amount')).toHaveTextContent('70.25');
    expect(screen.getByTestId('deposit-address-amount')).toHaveClass('text-[72px]');
    expect(screen.getByText('depositFlowTokenOnNetwork {"token":"USDC","network":"Ethereum"}')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-address-receive')).toHaveTextContent('70.04 USDCx');
    expect(screen.getByTestId('deposit-address-lines').children).toHaveLength(2);
    const facts = screen.getByTestId('deposit-address-facts');
    expect(facts).toHaveTextContent('0.21 USDC');
    expect(facts).toHaveTextContent('Epoch');
    expect(facts).toHaveTextContent('About 2 minutes');
    expect(screen.getByTestId('deposit-address-waiting')).toHaveTextContent('depositFlowWaitingTitle');
    expect(screen.getByTestId('deposit-address-waiting')).toHaveTextContent('depositFlowWaitingBody');
  });

  it('copies the exact amount and says so in the label', async () => {
    render(<DepositAddressView {...props({ amount: { amount: 1234500000n, decimals: 6 } })} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('deposit-address-amount'));
    });
    expect(Clipboard.write).toHaveBeenCalledWith({ string: '1234.5' });
    expect(hapticLight).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('deposit-address-amount-label')).toHaveTextContent('depositFlowAmountCopied')
    );
  });

  it('copies the full address from the block and from the Copy action', async () => {
    render(<DepositAddressView {...props()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('deposit-address-block'));
    });
    expect(Clipboard.write).toHaveBeenLastCalledWith({ string: ADDRESS });
    await waitFor(() => expect(screen.getByTestId('deposit-address-copy')).toHaveTextContent('copied'));
    jest.mocked(Clipboard.write).mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('deposit-address-copy'));
    });
    expect(Clipboard.write).toHaveBeenCalledWith({ string: ADDRESS });
  });

  it('opens the QR sheet and the wallet sheet', () => {
    const onShowQr = jest.fn();
    const onOpenWallet = jest.fn();
    render(<DepositAddressView {...props({ onShowQr, onOpenWallet })} />);
    fireEvent.click(screen.getByTestId('deposit-address-qr'));
    fireEvent.click(screen.getByTestId('deposit-address-open-wallet'));
    expect(onShowQr).toHaveBeenCalledTimes(1);
    expect(onOpenWallet).toHaveBeenCalledTimes(1);
  });

  it('leaves out Open wallet when there is no wallet link', () => {
    render(<DepositAddressView {...props({ onOpenWallet: undefined })} />);
    expect(screen.queryByTestId('deposit-address-open-wallet')).not.toBeInTheDocument();
  });

  it('offers to deposit a partial amount', () => {
    const onDepositReceived = jest.fn();
    render(
      <DepositAddressView {...props({ status: { kind: 'partial', received: { amount: '50' } }, onDepositReceived })} />
    );
    const notice = screen.getByTestId('deposit-address-partial');
    expect(notice).toHaveTextContent('depositFlowPartialTitle {"received":"50 USDC","expected":"70.25 USDC"}');
    fireEvent.click(screen.getByTestId('deposit-address-partial-action'));
    expect(onDepositReceived).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('deposit-address-waiting')).toBeInTheDocument();
  });

  it('shows a failed deposit with the default or the given reason and no waiting strip', () => {
    const { rerender } = render(<DepositAddressView {...props({ status: { kind: 'failed' } })} />);
    expect(screen.getByTestId('deposit-address-failed')).toHaveTextContent('depositFlowFailedTitle');
    expect(screen.getByTestId('deposit-address-failed')).toHaveTextContent('depositFlowFailedBody');
    expect(screen.queryByTestId('deposit-address-waiting')).not.toBeInTheDocument();
    rerender(<DepositAddressView {...props({ status: { kind: 'failed', reason: 'Wrong token' } })} />);
    expect(screen.getByTestId('deposit-address-failed')).toHaveTextContent('Wrong token');
  });

  it('reports a failure with its id, the default id when it names none', () => {
    jest.useFakeTimers();
    const { rerender } = render(<DepositAddressView {...props({ status: { kind: 'failed' } })} />);
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(reportUserVisibleError).toHaveBeenLastCalledWith('raw_bridge_deposit_failed', 'notice');

    rerender(
      <DepositAddressView
        {...props({
          status: {
            kind: 'failed',
            title: 'Did not start',
            reason: 'db closed',
            errorId: 'raw_bridge_deposit_submit_failed'
          }
        })}
      />
    );
    expect(screen.getByTestId('deposit-address-failed')).toHaveTextContent('Did not start');
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(reportUserVisibleError).toHaveBeenLastCalledWith('raw_bridge_deposit_submit_failed', 'notice');
    jest.useRealTimers();
  });

  it('disables every action while the bridge starts and says so in the strip', () => {
    render(<DepositAddressView {...props({ status: { kind: 'starting' } })} />);
    for (const id of [
      'deposit-address-amount',
      'deposit-address-block',
      'deposit-address-copy',
      'deposit-address-qr',
      'deposit-address-open-wallet'
    ]) {
      expect(screen.getByTestId(id)).toBeDisabled();
    }
    expect(screen.getByTestId('deposit-address-waiting')).toHaveTextContent('depositFlowStartingTitle');
    expect(screen.getByTestId('deposit-address-waiting')).toHaveTextContent('depositFlowStartingBody');
  });
});

describe('DepositAddressView in the extension', () => {
  it('shows the QR of the address, the network, the copy pill, the details and the waiting note', () => {
    render(<DepositAddressView {...props({ layout: 'extension' })} />);
    expect(screen.getByTestId('qr')).toHaveAttribute('data-value', ADDRESS);
    expect(screen.getByTestId('qr')).toHaveAttribute('data-payload', 'plain');
    expect(screen.getByTestId('deposit-address-network')).toHaveTextContent('Ethereum');
    expect(screen.getByTestId('deposit-address-copy-pill')).toHaveTextContent('0x8E2b41…9d41c7');
    const facts = screen.getByTestId('deposit-address-facts');
    expect(facts).toHaveTextContent('depositFlowYourEvmAddress');
    expect(facts).toHaveTextContent('70.04 USDCx');
    expect(facts).toHaveTextContent('70.25 USDC');
    expect(facts).toHaveTextContent('About 2 minutes');
    expect(screen.getByTestId('deposit-address-note')).toHaveTextContent('depositFlowWaitingNote');
    expect(screen.queryByTestId('deposit-address-mobile')).not.toBeInTheDocument();
  });

  it('carries a caller QR value and copies the full address', async () => {
    render(<DepositAddressView {...props({ layout: 'extension', qrValue: `ethereum:${ADDRESS}` })} />);
    expect(screen.getByTestId('qr')).toHaveAttribute('data-value', `ethereum:${ADDRESS}`);
    await act(async () => {
      fireEvent.click(screen.getByTestId('deposit-address-copy-pill'));
    });
    expect(Clipboard.write).toHaveBeenCalledWith({ string: ADDRESS });
  });

  it('follows each state in the note and the notices', () => {
    const { rerender } = render(
      <DepositAddressView {...props({ layout: 'extension', status: { kind: 'starting' } })} />
    );
    expect(screen.getByTestId('deposit-address-note')).toHaveTextContent('depositFlowStartingNote');
    expect(screen.getByTestId('deposit-address-copy-pill')).toBeDisabled();
    rerender(<DepositAddressView {...props({ layout: 'extension', status: { kind: 'failed' } })} />);
    expect(screen.getByTestId('deposit-address-note')).toHaveTextContent('');
    expect(screen.getByTestId('deposit-address-failed')).toBeInTheDocument();
    rerender(
      <DepositAddressView
        {...props({ layout: 'extension', status: { kind: 'partial', received: { amount: 1n, decimals: 6 } } })}
      />
    );
    expect(screen.getByTestId('deposit-address-partial')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-address-note')).toHaveTextContent('depositFlowWaitingNote');
  });
});

describe('DepositAddressView with an expiry (NEAR Intents)', () => {
  const NOW = Date.parse('2026-11-10T14:00:00Z');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps the relay layout without an expiry: no countdown, the own-address row', () => {
    render(<DepositAddressView {...props()} />);
    expect(screen.getByTestId('deposit-address-waiting-body')).toHaveTextContent('depositFlowWaitingBody');
    cleanup();
    render(<DepositAddressView {...props({ layout: 'extension' })} />);
    expect(screen.queryByTestId('deposit-address-expiry')).not.toBeInTheDocument();
    expect(screen.getByTestId('deposit-address-facts')).toHaveTextContent('depositFlowYourEvmAddress');
  });

  it('says in the mobile strip when the address expires, counts down and stops at zero', () => {
    render(<DepositAddressView {...props({ expiresAt: NOW + 1_200_000 })} />);
    const body = () => screen.getByTestId('deposit-address-waiting-body');
    expect(body()).toHaveTextContent('depositFlowExpiringBody {"countdown":"20:00"}');
    act(() => {
      jest.advanceTimersByTime(3_000);
    });
    expect(body()).toHaveTextContent('"countdown":"19:57"');
    act(() => {
      jest.advanceTimersByTime(1_300_000);
    });
    expect(body()).toHaveTextContent('"countdown":"0:00"');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the starting text in the strip while the bridge starts', () => {
    render(<DepositAddressView {...props({ expiresAt: NOW + 60_000, status: { kind: 'starting' } })} />);
    expect(screen.getByTestId('deposit-address-waiting-body')).toHaveTextContent('depositFlowStartingBody');
  });

  it('shows the "Address expires in" row in the extension and no own-address row for a provider address', () => {
    render(<DepositAddressView {...props({ layout: 'extension', expiresAt: NOW + 292_000, ownAddress: false })} />);
    const expiry = screen.getByTestId('deposit-address-expiry');
    expect(expiry).toHaveTextContent('depositFlowAddressExpiresIn');
    expect(expiry).toHaveTextContent('4:52');
    act(() => {
      jest.advanceTimersByTime(2_000);
    });
    expect(expiry).toHaveTextContent('4:50');
    expect(screen.getByTestId('deposit-address-facts')).not.toHaveTextContent('depositFlowYourEvmAddress');
  });

  it('shows a memo with its copy and warning in both layouts', async () => {
    jest.useRealTimers();
    render(<DepositAddressView {...props({ memo: '123456' })} />);
    expect(screen.getByTestId('deposit-address-memo')).toHaveTextContent('123456');
    expect(screen.getByTestId('deposit-address-memo-warning')).toHaveTextContent('nearIntentsMemoWarning');
    await act(async () => {
      fireEvent.click(screen.getByTestId('deposit-address-memo-copy'));
    });
    expect(Clipboard.write).toHaveBeenCalledWith({ string: '123456' });
    expect(hapticLight).toHaveBeenCalled();
    cleanup();
    render(<DepositAddressView {...props({ layout: 'extension', memo: '123456' })} />);
    expect(screen.getByTestId('deposit-address-memo')).toHaveTextContent('123456');
    expect(screen.getByTestId('deposit-address-memo-warning')).toBeInTheDocument();
  });

  it('hides the address, its QR code, its actions and the memo of an expired address, and reports nothing', () => {
    const status = { kind: 'failed', title: 'Expired', reason: 'Get a new address', errorId: null, hideAddress: true };
    render(<DepositAddressView {...props({ status: { ...status, kind: 'failed' }, memo: '123456' })} />);
    expect(screen.getByTestId('deposit-address-failed')).toHaveTextContent('Expired');
    for (const id of ['deposit-address-block', 'deposit-address-copy', 'deposit-address-qr', 'deposit-address-memo']) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
    expect(screen.getByTestId('deposit-address-amount')).toBeDisabled();
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    cleanup();
    render(<DepositAddressView {...props({ layout: 'extension', status: { ...status, kind: 'failed' } })} />);
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deposit-address-copy-pill')).not.toBeInTheDocument();
    expect(screen.getByTestId('deposit-address-network')).toHaveTextContent('Ethereum');
  });

  it('asks for the rest of a partial deposit when the route cannot deposit what arrived', () => {
    render(
      <DepositAddressView
        {...props({ status: { kind: 'partial', received: { amount: '50' } }, onDepositReceived: undefined })}
      />
    );
    expect(screen.getByTestId('deposit-address-partial')).toHaveTextContent('depositFlowPartialRestBody');
    expect(screen.queryByTestId('deposit-address-partial-action')).not.toBeInTheDocument();
  });

  it('names only the expected amount when the received amount is not known', () => {
    render(<DepositAddressView {...props({ status: { kind: 'partial' } })} />);
    const notice = screen.getByTestId('deposit-address-partial');
    expect(notice).toHaveTextContent('depositFlowPartialUnknownTitle {"expected":"70.25 USDC"}');
    expect(notice).toHaveTextContent('depositFlowPartialRestBody');
  });
});
