import React from 'react';

import { act, cleanup, render, screen } from '@testing-library/react';

import { ITransactionStatus, type IOneClickTrackingData, type ITransaction } from 'lib/miden/db/types';
import type { OneClickAsset } from 'lib/one-click/types';

import { NearIntentsDepositPage } from './NearIntentsDepositPage';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key)
  })
}));
jest.mock('lib/telemetry/use-user-visible-error', () => ({ useUserVisibleError: jest.fn() }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { write: jest.fn().mockResolvedValue(undefined) } }));

const mockQRCodeProps = jest.fn();
jest.mock('components/QRCode', () => ({
  QRCode: (props: Record<string, unknown>) => {
    mockQRCodeProps(props);
    return <div data-testid="qr-code" />;
  }
}));

const mockBack = jest.fn();
jest.mock('app/hooks/useBackWithFallback', () => ({ useBackWithFallback: () => mockBack }));

jest.mock('lib/woozie', () => ({
  ...jest.requireActual('lib/woozie'),
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect">{to}</div>
}));

let mockRowState: { row?: ITransaction; loaded: boolean } = { loaded: false };
jest.mock('screens/generating-transaction/useTransactionRow', () => ({
  useTransactionRow: () => mockRowState
}));

const NOW = Date.parse('2026-11-10T14:27:08Z');
const DEADLINE = '2026-11-10T14:32:00Z';

const usdc: OneClickAsset = { assetId: 'nep141:eth-usdc', blockchain: 'eth', symbol: 'USDC', decimals: 6 };
const usdcx: OneClickAsset = {
  assetId: 'miden:usdcx',
  blockchain: 'miden',
  symbol: 'USDCx',
  decimals: 6,
  faucetId: 'mm1faucet'
};

function tracking(overrides: Partial<IOneClickTrackingData> = {}): IOneClickTrackingData {
  return {
    direction: 'evm-to-miden',
    request: {
      amount: '46000000',
      originAsset: usdc,
      destinationAsset: usdcx,
      refundTo: '0x91b2000000000000000000000000000000007f0a',
      recipient: 'mm1account',
      deadline: DEADLINE,
      slippageTolerance: 100
    },
    quote: {
      correlationId: 'c',
      timestamp: '2026-11-10T14:27:00Z',
      signature: 's',
      quoteRequest: {
        dry: false,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: usdc.assetId,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: usdcx.assetId,
        amount: '46000000',
        refundTo: '0x91b2000000000000000000000000000000007f0a',
        refundType: 'ORIGIN_CHAIN',
        recipient: 'mm1account',
        recipientType: 'DESTINATION_CHAIN',
        deadline: DEADLINE
      },
      quote: {
        depositAddress: '0x7a3f09d1000000000000000000000000c91e2b4a',
        amountIn: '46000000',
        amountInFormatted: '46',
        amountInUsd: '45.99',
        minAmountIn: '46000000',
        amountOut: '45910000',
        amountOutFormatted: '45.91',
        amountOutUsd: '45.91',
        minAmountOut: '45000000',
        deadline: DEADLINE,
        timeEstimate: 120
      }
    },
    fundingDeadline: DEADLINE,
    config: {
      serviceUrl: 'https://1click.example',
      midenAssets: [],
      chains: [{ id: 'eth', name: 'Ethereum', addressKind: 'evm', tokens: [] }]
    },
    network: 'mainnet',
    accountId: 'mm1account',
    accountAddress: 'mm1account',
    originAsset: usdc,
    destinationAsset: usdcx,
    faucetId: 'mm1faucet',
    amount: '45910000',
    phase: 'depositing',
    depositAddress: '0x7a3f09d1000000000000000000000000c91e2b4a',
    ...overrides
  };
}

function rowWith(oneClick: IOneClickTrackingData | undefined): ITransaction {
  return {
    id: 'row-1',
    type: 'bridged-receive',
    accountId: 'mm1account',
    status: ITransactionStatus.Queued,
    initiatedAt: NOW,
    displayIcon: 'RECEIVE',
    extraInputs: oneClick ? { oneClick } : {}
  };
}

const renderPage = () => render(<NearIntentsDepositPage rowId="row-1" />);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  mockQRCodeProps.mockReset();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe('NearIntentsDepositPage', () => {
  it('shows the code, the address, the facts and the waiting status while the deposit can arrive', () => {
    mockRowState = { loaded: true, row: rowWith(tracking()) };
    renderPage();

    expect(screen.getByTestId('near-intents-deposit-amount')).toHaveTextContent('46 USDC');
    expect(screen.getByTestId('near-intents-deposit-chain')).toHaveTextContent(
      'nearIntentsOnChain:{"chain":"Ethereum"}'
    );
    expect(screen.getByTestId('qr-code')).toBeInTheDocument();
    expect(mockQRCodeProps).toHaveBeenCalledWith(
      expect.objectContaining({ address: '0x7a3f09d1000000000000000000000000c91e2b4a', payload: 'plain' })
    );
    expect(screen.getByTestId('near-intents-deposit-address-full')).toHaveTextContent(
      '0x7a3f09d1000000000000000000000000c91e2b4a'
    );
    expect(screen.getByTestId('near-intents-fact-receive')).toHaveTextContent(
      'nearIntentsReceiveValue:{"amount":"45.91","symbol":"USDCx"}'
    );
    expect(screen.getByTestId('near-intents-fact-deadline')).toHaveTextContent('"countdown":"4:52"');
    expect(screen.getByTestId('near-intents-deposit-status')).toHaveTextContent('nearIntentsStatusWaiting');
    expect(screen.queryByTestId('near-intents-deposit-memo')).not.toBeInTheDocument();
  });

  it('counts the time down each second', () => {
    mockRowState = { loaded: true, row: rowWith(tracking()) };
    renderPage();
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('near-intents-fact-deadline')).toHaveTextContent('"countdown":"4:50"');
  });

  it('shows the memo as a second copyable field with a warning', () => {
    mockRowState = { loaded: true, row: rowWith(tracking({ depositMemo: '123456' })) };
    renderPage();
    expect(screen.getByTestId('near-intents-copy-memo')).toHaveTextContent('123456');
    expect(screen.getByTestId('near-intents-memo-warning')).toHaveTextContent('nearIntentsMemoWarning');
  });

  it('hides the code and the address once the deadline passes while the row still waits', () => {
    mockRowState = { loaded: true, row: rowWith(tracking()) };
    renderPage();
    act(() => {
      jest.advanceTimersByTime(5 * 60_000);
    });
    expect(screen.queryByTestId('qr-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('near-intents-copy-address')).not.toBeInTheDocument();
    expect(screen.getByTestId('near-intents-expired-notice')).toBeInTheDocument();
    expect(screen.getByTestId('near-intents-deposit-status')).toHaveTextContent('nearIntentsStatusExpired');
  });

  it('shows the expired notice for a row the tracker marked expired', () => {
    mockRowState = { loaded: true, row: rowWith(tracking({ phase: 'expired' })) };
    renderPage();
    expect(screen.getByTestId('near-intents-expired-notice')).toBeInTheDocument();
    expect(screen.queryByTestId('qr-code')).not.toBeInTheDocument();
  });

  it.each([
    ['known-deposit-tx', 'nearIntentsStatusProcessing'],
    ['processing', 'nearIntentsStatusProcessing'],
    ['arriving', 'nearIntentsStatusArriving'],
    ['delivered', 'nearIntentsStatusReceived'],
    ['refunded', 'nearIntentsStatusRefunded'],
    ['failed', 'nearIntentsStatusFailed']
  ] as const)('maps the %s phase to its status and stops showing the address', (phase, label) => {
    mockRowState = { loaded: true, row: rowWith(tracking({ phase })) };
    renderPage();
    expect(screen.getByTestId('near-intents-deposit-status')).toHaveTextContent(label);
    expect(screen.queryByTestId('qr-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('near-intents-expired-notice')).not.toBeInTheDocument();
  });

  it('goes back to Receive for an unknown row', () => {
    mockRowState = { loaded: true, row: undefined };
    renderPage();
    expect(screen.getByTestId('redirect')).toHaveTextContent('/receive');
  });

  it('goes back to Receive for a row with no NEAR Intents tracking', () => {
    mockRowState = { loaded: true, row: rowWith(undefined) };
    renderPage();
    expect(screen.getByTestId('redirect')).toHaveTextContent('/receive');
  });

  it('waits for the first read before it decides', () => {
    mockRowState = { loaded: false };
    renderPage();
    expect(screen.queryByTestId('redirect')).not.toBeInTheDocument();
    expect(screen.queryByTestId('near-intents-deposit-page')).not.toBeInTheDocument();
  });
});
