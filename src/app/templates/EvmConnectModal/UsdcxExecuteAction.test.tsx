import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { NativeSessionChainNotApprovedError } from 'lib/walletconnect/native';

import { UsdcxExecuteAction } from './UsdcxExecuteAction';

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));

const execute = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (values ? `${key}:${Object.values(values).join(',')}` : key)
  })
}));
jest.mock('./useCctpExecute', () => ({ useCctpExecute: () => execute }));
jest.mock('lib/mobile/haptics', () => ({ hapticMedium: jest.fn() }));
jest.mock('components/Button', () => ({
  Button: ({ title, onClick, disabled }: { title: string; onClick: () => void; disabled?: boolean }) => (
    <button data-testid="usdcx-execute-button" onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary' }
}));

const BASE_SEPOLIA = 84532;
const LEG = { sourceDomain: 6, message: '0x1234', attestation: '0xabcd' };

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue(`0x${'9'.repeat(64)}`);
});

describe('UsdcxExecuteAction', () => {
  it('renders nothing for a direct xReserve deposit or a settled row', () => {
    const { container, rerender } = render(
      <UsdcxExecuteAction txId="row" sourceChainId={5042002} phase="delivering" cctp={LEG} />
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<UsdcxExecuteAction txId="row" sourceChainId={BASE_SEPOLIA} phase="ready" cctp={LEG} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<UsdcxExecuteAction txId="row" sourceChainId={BASE_SEPOLIA} phase="delivering" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says it is waiting for Circle until the burn is attested', () => {
    render(
      <UsdcxExecuteAction txId="row" sourceChainId={BASE_SEPOLIA} phase="delivering" cctp={{ sourceDomain: 6 }} />
    );
    expect(screen.getByTestId('usdcx-execute-waiting')).toHaveTextContent('usdcxCctpAwaitingAttestation:Arc Testnet');
  });

  it('says Circle is executing a forwarded burn and offers no button', () => {
    render(
      <UsdcxExecuteAction
        txId="row"
        sourceChainId={BASE_SEPOLIA}
        phase="delivering"
        cctp={{ sourceDomain: 6, forwarded: true, forwardState: 'PENDING' }}
      />
    );
    expect(screen.getByTestId('usdcx-execute-forwarding')).toHaveTextContent('usdcxForwardingPending:Arc Testnet');
    expect(screen.queryByTestId('usdcx-execute-button')).not.toBeInTheDocument();
  });

  it('offers the execute once attested and runs it for the row', async () => {
    render(<UsdcxExecuteAction txId="row" sourceChainId={BASE_SEPOLIA} phase="delivering" cctp={LEG} />);
    expect(screen.getByTestId('usdcx-execute-ready')).toHaveTextContent('usdcxExecuteNeeded:Arc Testnet');

    await act(async () => {
      fireEvent.click(screen.getByTestId('usdcx-execute-button'));
    });

    expect(execute).toHaveBeenCalledWith('row', BASE_SEPOLIA, LEG);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the failure and lets the user try again', async () => {
    execute.mockRejectedValueOnce(new Error('User rejected'));
    render(<UsdcxExecuteAction txId="row" sourceChainId={BASE_SEPOLIA} phase="delivering" cctp={LEG} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('usdcx-execute-button'));
    });

    expect(screen.getByRole('alert')).toHaveTextContent('User rejected');
    expect(screen.getByTestId('usdcx-execute-button')).not.toBeDisabled();
  });

  // #1469: on the deposit status screen this sits in a centred column, which `break-words` cannot narrow.
  it('wraps a failure carrying an unbreakable token', async () => {
    execute.mockRejectedValueOnce(new Error(`execution reverted: 0x${'ab'.repeat(100)}`));
    render(<UsdcxExecuteAction txId="row" sourceChainId={BASE_SEPOLIA} phase="delivering" cctp={LEG} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('usdcx-execute-button'));
    });

    expect(screen.getByRole('alert')).toHaveClass('wrap-anywhere', 'select-text');
  });

  it('shows the localized reconnect message when the session did not approve the chain', async () => {
    execute.mockRejectedValueOnce(new NativeSessionChainNotApprovedError(5042002, 'Arc Testnet'));
    render(<UsdcxExecuteAction txId="row" sourceChainId={BASE_SEPOLIA} phase="delivering" cctp={LEG} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('usdcx-execute-button'));
    });

    expect(screen.getByRole('alert')).toHaveTextContent('evmChainNotApproved:Arc Testnet');
  });

  it('reports the executed transfer while Circle attests the deposit', () => {
    render(
      <UsdcxExecuteAction
        txId="row"
        sourceChainId={BASE_SEPOLIA}
        phase="delivering"
        cctp={{ ...LEG, executeTxHash: `0x${'9'.repeat(64)}` }}
      />
    );
    expect(screen.getByTestId('usdcx-execute-submitted')).toHaveTextContent('usdcxExecuteSubmitted:Arc Testnet');
  });
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

describe('user-visible USDCx execution errors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    execute.mockResolvedValue('synthetic-hash');
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    [
      'raw rejection',
      new Error('private execute 42 https://synthetic.invalid/0xabc'),
      'private execute 42 https://synthetic.invalid/0xabc',
      'raw_usdcx_execute_failed'
    ],
    [
      'wrapped session refusal',
      new Error('private wrapper', { cause: new NativeSessionChainNotApprovedError(5042002, 'Arc Testnet') }),
      'evmChainNotApproved:Arc Testnet',
      'evmChainNotApproved'
    ]
  ])('reports the %s by its producer identity once', async (_label, cause, copy, id) => {
    execute.mockRejectedValueOnce(cause);
    render(<UsdcxExecuteAction txId="private-row" sourceChainId={BASE_SEPOLIA} phase="delivering" cctp={LEG} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('usdcx-execute-button'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(String(copy));
    await expectErrorAfterDwell(String(id), 'inline');
  });

  it('clears a failed episode while the retry is pending and after success', async () => {
    execute.mockRejectedValueOnce(new Error('temporary execute failure'));
    const view = render(<UsdcxExecuteAction txId="row" sourceChainId={BASE_SEPOLIA} phase="delivering" cctp={LEG} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('usdcx-execute-button'));
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(999);
    });
    let finish: (hash: string) => void = () => undefined;
    execute.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          finish = resolve;
        })
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('usdcx-execute-button'));
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('usdcx-execute-button')).toBeDisabled();
    await act(async () => {
      jest.advanceTimersByTime(2000);
      finish('synthetic-hash');
    });
    view.rerender(<UsdcxExecuteAction txId="row" sourceChainId={BASE_SEPOLIA} phase="ready" cctp={LEG} />);
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });

  it.each(['settled', 'row change', 'unmount'])('cancels an execution failure on %s before dwell', async action => {
    execute.mockRejectedValueOnce(new Error('old execution failure'));
    const view = render(
      <UsdcxExecuteAction txId="old-row" sourceChainId={BASE_SEPOLIA} phase="delivering" cctp={LEG} />
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('usdcx-execute-button'));
    });
    await act(async () => {
      jest.advanceTimersByTime(999);
    });
    if (action === 'unmount') view.unmount();
    else
      view.rerender(
        <UsdcxExecuteAction
          txId={action === 'row change' ? 'new-row' : 'old-row'}
          sourceChainId={BASE_SEPOLIA}
          phase={action === 'settled' ? 'ready' : 'delivering'}
          cctp={LEG}
        />
      );
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });

  it('ignores a late execution rejection belonging to the previously selected row', async () => {
    let refuse: (cause: Error) => void = () => undefined;
    execute.mockImplementationOnce(
      () =>
        new Promise<string>((_resolve, reject) => {
          refuse = reject;
        })
    );
    const view = render(
      <UsdcxExecuteAction txId="old-row" sourceChainId={BASE_SEPOLIA} phase="delivering" cctp={LEG} />
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('usdcx-execute-button'));
    });
    expect(screen.getByTestId('usdcx-execute-button')).toBeDisabled();
    view.rerender(<UsdcxExecuteAction txId="new-row" sourceChainId={BASE_SEPOLIA} phase="delivering" cctp={LEG} />);
    await act(async () => {
      refuse(new Error('previous row execution failed'));
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });

  it('keeps waiting, forwarding, submitted and manual execute guidance quiet', async () => {
    const view = render(
      <UsdcxExecuteAction txId="row" sourceChainId={BASE_SEPOLIA} phase="delivering" cctp={{ sourceDomain: 6 }} />
    );
    expect(screen.getByTestId('usdcx-execute-waiting')).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    view.rerender(
      <UsdcxExecuteAction
        txId="row"
        sourceChainId={BASE_SEPOLIA}
        phase="delivering"
        cctp={{ sourceDomain: 6, forwarded: true }}
      />
    );
    expect(screen.getByTestId('usdcx-execute-forwarding')).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    view.rerender(<UsdcxExecuteAction txId="row" sourceChainId={BASE_SEPOLIA} phase="delivering" cctp={LEG} />);
    expect(screen.getByTestId('usdcx-execute-ready')).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    view.rerender(
      <UsdcxExecuteAction
        txId="row"
        sourceChainId={BASE_SEPOLIA}
        phase="delivering"
        cctp={{ ...LEG, executeTxHash: 'synthetic-hash' }}
      />
    );
    expect(screen.getByTestId('usdcx-execute-submitted')).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });
});
