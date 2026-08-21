import React from 'react';

import { act, render, screen } from '@testing-library/react';

import { BridgeDeposit } from './BridgeDeposit';

// BridgeDeposit is the funding surface: a connect prompt that hands over to the
// bridge-deposit screen once an EVM wallet is connected. The heavy collaborators
// (AppKit, the deposit screen) are stubbed; what is under test is the `fund`
// flow's lifecycle and that the deposit screen is given the reporter.

type ReportDeposit = <T>(attempt: () => Promise<T>) => Promise<T>;

let connection = {
  address: '0xevm-wallet',
  connected: true,
  status: 'connected',
  nativeReown: { present: jest.fn(), disconnect: jest.fn(), error: null },
  useNativeReownWallet: false
};

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('@reown/appkit/react', () => ({
  useAppKit: () => ({ open: jest.fn() }),
  useDisconnect: () => ({ disconnect: jest.fn() })
}));

jest.mock('lib/walletconnect/useEvmWalletConnection', () => ({
  useEvmWalletConnection: () => connection
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticMedium: jest.fn()
}));

jest.mock('lib/store', () => ({
  useWalletStore: (selector: (s: { currentAccount: unknown }) => unknown) =>
    selector({ currentAccount: { publicKey: 'mtst1account' } })
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

jest.mock('components/ScreenHeader', () => ({
  ScreenHeader: () => <div data-testid="screen-header" />
}));

jest.mock('lib/ui/button', () => ({
  Button: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  )
}));

let depositProps: { reportDeposit?: ReportDeposit } = {};

jest.mock('app/templates/EvmConnectModal/EvmBridgeDepositScreen', () => ({
  EvmBridgeDepositScreen: (props: { reportDeposit?: ReportDeposit }) => {
    depositProps = props;
    return <div data-testid="deposit-screen" />;
  }
}));

type TelemetryHandle = { complete: jest.Mock; cancel: jest.Mock; fail: jest.Mock };
const telemetryHandles: TelemetryHandle[] = [];
const beginFlowMock = jest.fn((_flow: string) => {
  const handle: TelemetryHandle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() };
  telemetryHandles.push(handle);
  return handle;
});
const classifyErrorMock = jest.fn((_error: unknown) => 'rpc');

jest.mock('lib/telemetry', () => ({
  beginFlow: (flow: string) => beginFlowMock(flow),
  classifyError: (error: unknown) => classifyErrorMock(error)
}));

/** Throwing accessor so a missing handle names how many flows were begun. */
const handleAt = (index: number): TelemetryHandle => {
  const handle = telemetryHandles[index];
  if (!handle) throw new Error(`no flow was begun at index ${index} (begun: ${telemetryHandles.length})`);
  return handle;
};

/** Everything a test handed to telemetry, for the privacy assertions. */
const telemetryPayload = () =>
  JSON.stringify({
    begun: beginFlowMock.mock.calls,
    classified: classifyErrorMock.mock.calls,
    settled: telemetryHandles.map(handle => [
      handle.complete.mock.calls,
      handle.cancel.mock.calls,
      handle.fail.mock.calls
    ])
  });

/** The reporter the page handed to the deposit screen. */
const reporter = (): ReportDeposit => {
  const { reportDeposit } = depositProps;
  if (!reportDeposit) throw new Error('the page did not give the deposit screen a reporter');
  return reportDeposit;
};

describe('BridgeDeposit - fund telemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    telemetryHandles.length = 0;
    depositProps = {};
    connection = {
      address: '0xevm-wallet',
      connected: true,
      status: 'connected',
      nativeReown: { present: jest.fn(), disconnect: jest.fn(), error: null },
      useNativeReownWallet: false
    };
  });

  it('begins one fund flow on entry, before a wallet is even connected', () => {
    connection = { ...connection, address: '', connected: false, status: 'disconnected' };

    render(<BridgeDeposit />);

    expect(screen.queryByTestId('deposit-screen')).toBeNull();
    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    expect(beginFlowMock).toHaveBeenCalledWith('fund');
  });

  it('does not begin a second flow when the wallet connects mid-visit', () => {
    connection = { ...connection, address: '', connected: false, status: 'connecting' };
    const { rerender } = render(<BridgeDeposit />);

    connection = { ...connection, address: '0xevm-wallet', connected: true, status: 'connected' };
    rerender(<BridgeDeposit />);

    expect(screen.getByTestId('deposit-screen')).toBeInTheDocument();
    expect(beginFlowMock).toHaveBeenCalledTimes(1);
  });

  it('cancels the flow when the user leaves without depositing', () => {
    const { unmount } = render(<BridgeDeposit />);

    unmount();

    expect(handleAt(0).cancel).toHaveBeenCalledTimes(1);
  });

  it('completes the flow when the deposit is accepted', async () => {
    render(<BridgeDeposit />);

    await act(async () => {
      await reporter()(() => Promise.resolve('bridge-tx'));
    });

    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    expect(beginFlowMock).toHaveBeenCalledTimes(1);
  });

  it('reports a broad error kind when the deposit fails', async () => {
    render(<BridgeDeposit />);

    const failure = new Error('bridge row failed');
    await act(async () => {
      await expect(reporter()(() => Promise.reject(failure))).rejects.toThrow('bridge row failed');
    });

    expect(classifyErrorMock).toHaveBeenCalledWith(failure);
    expect(handleAt(0).fail).toHaveBeenCalledWith('rpc');
  });

  it('never passes the EVM address or the amount to telemetry', async () => {
    render(<BridgeDeposit />);

    await act(async () => {
      await reporter()(() => Promise.resolve({ amount: '4200', sourceAddress: '0xevm-wallet' }));
    });

    expect(beginFlowMock.mock.calls.length).toBeGreaterThan(0);
    expect(telemetryPayload()).not.toContain('0xevm-wallet');
    expect(telemetryPayload()).not.toContain('4200');
    expect(telemetryPayload()).not.toContain('mtst1account');
  });
});
