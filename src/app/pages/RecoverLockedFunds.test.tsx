import React from 'react';

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { requestLockRescan } from 'lib/epoch/lock-scan-refresh';

import RecoverLockedFunds from './RecoverLockedFunds';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key)
  })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));
jest.mock('lib/woozie', () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} data-testid={Reflect.get(props, 'data-testid')}>
      {children}
    </a>
  )
}));

const SPONSOR = '0x00000000000000000000000000000000000000AA';
const CONNECTED = '0x00000000000000000000000000000000000000bb';

const mockConnection: { address: string | undefined; connected: boolean } = { address: undefined, connected: false };
jest.mock('lib/walletconnect/useEvmWalletConnection', () => ({ useEvmWalletConnection: () => mockConnection }));
const mockOpenPicker = jest.fn();
jest.mock('lib/walletconnect/useEvmWalletPicker', () => ({
  useEvmWalletPicker: () => ({ openWalletPicker: mockOpenPicker, error: undefined })
}));
jest.mock('lib/walletconnect/config', () => ({
  getChain: (id: number) => ({ name: id === 8453 ? 'Base' : 'Sepolia' })
}));

const mockCollect = jest.fn();
const mockScan = jest.fn();
jest.mock('lib/epoch/bridge-in-lock-scan', () => ({
  collectBridgeInSponsors: () => mockCollect(),
  scanLockedBridgeFunds: (...args: unknown[]) => mockScan(...args),
  lockScanAddresses: (connected: string | undefined, sponsors: string[]) => [
    ...(connected === undefined ? [] : [connected]),
    ...sponsors.filter(sponsor => sponsor !== connected)
  ]
}));

const USDC = {
  key: 'USDC',
  address: '0x0000000000000000000000000000000000000002',
  chainId: 11155111,
  symbol: 'USDC',
  decimals: 6
};
const ETH = {
  key: 'ETH',
  address: '0x0000000000000000000000000000000000000000',
  chainId: 8453,
  symbol: 'ETH',
  decimals: 18
};

async function renderPage() {
  render(<RecoverLockedFunds />);
  await act(async () => undefined);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConnection.address = undefined;
  mockConnection.connected = false;
  mockCollect.mockResolvedValue([SPONSOR]);
  mockScan.mockImplementation(async (addresses: string[]) =>
    addresses.map(address => ({
      address,
      entries: [
        { chainId: 11155111, token: USDC, lockId: '42', read: { state: 'ok', balance: 2_500_000n } },
        { chainId: 8453, token: ETH, lockId: '43', read: { state: 'ok', balance: 0n } }
      ]
    }))
  );
});

describe('RecoverLockedFunds', () => {
  it('shows a skeleton until the scan lands, then one line per lock that holds funds', async () => {
    let finish: (value: unknown) => void = () => undefined;
    mockScan.mockReturnValueOnce(new Promise(resolve => (finish = resolve)));
    render(<RecoverLockedFunds />);
    await act(async () => undefined);
    expect(screen.getByTestId('recover-funds-loading')).toBeInTheDocument();

    await act(async () =>
      finish([
        {
          address: SPONSOR,
          entries: [{ chainId: 11155111, token: USDC, lockId: '42', read: { state: 'ok', balance: 2_500_000n } }]
        }
      ])
    );

    expect(screen.queryByTestId('recover-funds-loading')).not.toBeInTheDocument();
    const rows = screen.getAllByTestId('recover-funds-lock');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('2.5 USDC');
    expect(rows[0]).toHaveTextContent('Sepolia');
    expect(rows[0]).toHaveAttribute('href', `/settings/recover-funds/11155111/42?address=${SPONSOR}`);
  });

  it('says when an address holds nothing, and never shows a failed read as zero', async () => {
    mockScan.mockResolvedValue([
      {
        address: SPONSOR,
        entries: [{ chainId: 11155111, token: USDC, lockId: '42', read: { state: 'ok', balance: 0n } }]
      },
      {
        address: CONNECTED,
        entries: [
          { chainId: 11155111, token: USDC, lockId: '42', read: { state: 'failed' } },
          { chainId: 11155111, token: ETH, read: { state: 'failed' } }
        ]
      }
    ]);
    await renderPage();

    const empty = screen.getByTestId(`recover-funds-address-${SPONSOR}`);
    expect(within(empty).getByText('recoverFundsNothingLocked')).toBeInTheDocument();
    const failed = screen.getByTestId(`recover-funds-address-${CONNECTED}`);
    expect(within(failed).queryByText('recoverFundsNothingLocked')).not.toBeInTheDocument();
    expect(within(failed).getByTestId('recover-funds-unknown')).toHaveTextContent(
      'recoverFundsCouldNotCheck:{"network":"Sepolia","tokens":"USDC, ETH"}'
    );
    expect(screen.queryByTestId('recover-funds-lock')).not.toBeInTheDocument();
  });

  it('scans the connected wallet first, and again when the wallet changes or an action asks for it', async () => {
    const view = render(<RecoverLockedFunds />);
    await act(async () => undefined);
    expect(mockScan).toHaveBeenLastCalledWith([SPONSOR]);
    expect(screen.getByTestId('recover-funds-connect')).toHaveTextContent('connectEvmWallet');

    mockConnection.address = CONNECTED;
    mockConnection.connected = true;
    view.rerender(<RecoverLockedFunds />);
    await act(async () => undefined);
    expect(mockScan).toHaveBeenLastCalledWith([CONNECTED, SPONSOR]);
    expect(screen.getByTestId(`recover-funds-address-${CONNECTED}`)).toHaveTextContent('recoverFundsConnectedWallet');
    expect(screen.getByTestId('recover-funds-connect')).toHaveTextContent('recoverFundsConnectAnother');

    await act(async () => requestLockRescan());
    expect(mockScan).toHaveBeenCalledTimes(3);
  });

  it('opens the wallet picker to add another address', async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId('recover-funds-connect'));
    expect(mockOpenPicker).toHaveBeenCalled();
  });

  it('shows an empty state when there is no address to scan', async () => {
    mockCollect.mockResolvedValue([]);
    await renderPage();
    expect(screen.getByTestId('recover-funds-empty')).toBeInTheDocument();
  });
});
