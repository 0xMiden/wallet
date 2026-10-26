import React, { StrictMode, useEffect, useState } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import type { GeoLookup } from 'lib/remote-config/geo';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { WalletAccessGate } from './WalletAccessGate';

const mockLoadEndpoints = jest.fn<Promise<void>, []>();
const mockInitEligibility = jest.fn<Promise<GeoLookup>, []>();

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ loadEndpointOverrides: () => mockLoadEndpoints() }));
jest.mock('lib/remote-config/runtime', () => ({ initFeatureEligibility: () => mockInitEligibility() }));
jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: jest.fn()
}));
jest.mock('components/ui/Spinner', () => ({ Spinner: () => <div /> }));
jest.mock('components/ui/Button', () => ({
  ButtonVariant: { Secondary: 'secondary' },
  Button: ({
    children,
    onClick,
    'data-testid': testId
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { 'data-testid'?: string }) => (
    <button onClick={onClick} data-testid={testId}>
      {children}
    </button>
  )
}));

function deferred<T>() {
  let finish: (value: T) => void = () => {};
  const promise = new Promise<T>(resolve => {
    finish = resolve;
  });
  return { promise, finish };
}

const allowed: GeoLookup = {
  state: 'ready',
  network: 'testnet',
  version: 13,
  allowed: { wallet: true, earn: false, swap: true }
};

function RecoveryForm({ completion, onMount }: { completion: Promise<void>; onMount: () => void }) {
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => onMount(), [onMount]);
  return (
    <section data-testid="recovery-state">
      <label>
        Recovery progress
        <input value={progress} onChange={event => setProgress(event.target.value)} />
      </label>
      <button onClick={() => void completion.then(() => setError('Recovery request failed'))}>Recover</button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

beforeEach(() => {
  mockLoadEndpoints.mockReset().mockResolvedValue(undefined);
  mockInitEligibility.mockReset().mockResolvedValue(allowed);
});

const deniedCases: Array<{ decision: GeoLookup; status: string }> = [
  {
    decision: { state: 'ready', network: 'testnet', version: 13, allowed: { wallet: false, earn: false, swap: false } },
    status: 'restricted'
  },
  { decision: { state: 'failed' }, status: 'unavailable' }
];

describe('WalletAccessGate startup only', () => {
  it('waits for endpoint loading and the startup decision before mounting the wallet', async () => {
    const endpoints = deferred<void>();
    const decision = deferred<GeoLookup>();
    mockLoadEndpoints.mockReturnValue(endpoints.promise);
    mockInitEligibility.mockReturnValue(decision.promise);
    render(
      <WalletAccessGate>
        <p>Private wallet</p>
      </WalletAccessGate>
    );
    expect(screen.getByTestId('wallet-access-gate')).toHaveAttribute('data-access-state', 'loading');
    expect(screen.queryByText('Private wallet')).toBeNull();
    expect(mockInitEligibility).not.toHaveBeenCalled();
    await act(async () => {
      endpoints.finish();
      await endpoints.promise;
    });
    expect(mockInitEligibility).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Private wallet')).toBeNull();
    await act(async () => {
      decision.finish(allowed);
      await decision.promise;
    });
    expect(screen.getByText('Private wallet')).toBeVisible();
    expect(screen.queryByTestId('wallet-access-gate')).toBeNull();
  });

  it.each(deniedCases)('keeps the wallet unmounted after a $status startup result', async ({ decision, status }) => {
    mockInitEligibility.mockResolvedValue(decision);
    render(
      <WalletAccessGate>
        <p>Private wallet</p>
      </WalletAccessGate>
    );
    await act(async () => {});
    expect(screen.getByTestId('wallet-access-gate')).toHaveAttribute('data-access-state', status);
    expect(screen.queryByText('Private wallet')).toBeNull();
    expect(screen.getByTestId('wallet-access-retry')).toBeVisible();
    expect(mockInitEligibility).toHaveBeenCalledTimes(1);
  });

  it('shows startup unavailability when endpoint bootstrap fails', async () => {
    mockLoadEndpoints.mockRejectedValueOnce(new Error('storage unavailable'));
    render(
      <WalletAccessGate>
        <p>Private wallet</p>
      </WalletAccessGate>
    );
    await act(async () => {});
    expect(screen.getByTestId('wallet-access-gate')).toHaveAttribute('data-access-state', 'unavailable');
    expect(screen.queryByText('Private wallet')).toBeNull();
    expect(mockInitEligibility).not.toHaveBeenCalled();
  });

  it('handles StrictMode effect replay without changing the startup decision', async () => {
    render(
      <StrictMode>
        <WalletAccessGate>
          <p>Private wallet</p>
        </WalletAccessGate>
      </StrictMode>
    );
    await act(async () => {});
    expect(screen.getByText('Private wallet')).toBeVisible();
    expect(mockInitEligibility).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('wallet-access-gate')).toBeNull();
  });

  it('keeps recovery input, mount and pending completion stable through time, foreground and rerenders', async () => {
    jest.useFakeTimers();
    const completion = deferred<void>();
    const onMount = jest.fn();
    const content = <RecoveryForm completion={completion.promise} onMount={onMount} />;
    const { rerender } = render(<WalletAccessGate>{content}</WalletAccessGate>);
    try {
      await act(async () => {});
      const input = screen.getByRole('textbox', { name: 'Recovery progress' });
      fireEvent.change(input, { target: { value: 'saved recovery progress' } });
      fireEvent.click(screen.getByRole('button', { name: 'Recover' }));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(7_200_000);
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('storage'));
      });
      rerender(<WalletAccessGate>{content}</WalletAccessGate>);
      await act(async () => {
        completion.finish();
        await completion.promise;
      });
      expect(screen.getByRole('textbox', { name: 'Recovery progress' })).toBe(input);
      expect(input).toHaveValue('saved recovery progress');
      expect(screen.getByRole('alert')).toHaveTextContent('Recovery request failed');
      expect(screen.queryByTestId('wallet-access-gate')).toBeNull();
      expect(onMount).toHaveBeenCalledTimes(1);
      expect(mockInitEligibility).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('startup eligibility failure reporting', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
  });
  afterEach(() => jest.useRealTimers());

  it.each(['decision', 'endpoint bootstrap'])('reports a visible %s failure after a full dwell', async source => {
    if (source === 'decision') mockInitEligibility.mockResolvedValue({ state: 'failed' });
    else mockLoadEndpoints.mockRejectedValue(new Error('private bootstrap failure'));
    render(<WalletAccessGate>Private wallet</WalletAccessGate>);
    await act(async () => {});
    expect(screen.getByTestId('wallet-access-gate')).toHaveAttribute('data-access-state', 'unavailable');
    expect(screen.getByText('walletAccessUnavailableBody')).toBeVisible();
    expect(screen.queryByText('Private wallet')).toBeNull();
    act(() => jest.advanceTimersByTime(999));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([
      source === 'endpoint bootstrap'
        ? [
            'walletAccessUnavailableBody',
            'startup',
            {
              startupEligibilityStage: 'endpoint_overrides',
              startupEligibilityReason: 'override_load_failed',
              startupEligibilityRetry: 'not_attempted'
            }
          ]
        : ['walletAccessUnavailableBody', 'startup']
    ]);
    act(() => jest.advanceTimersByTime(5000));
    expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
  });

  it.each(['loading', 'restricted'])('keeps a %s startup result quiet', async status => {
    if (status === 'loading') mockInitEligibility.mockReturnValue(new Promise(() => {}));
    if (status === 'restricted')
      mockInitEligibility.mockResolvedValue({ ...allowed, allowed: { ...allowed.allowed, wallet: false } });
    render(<WalletAccessGate>Private wallet</WalletAccessGate>);
    await act(async () => {});
    expect(screen.getByTestId('wallet-access-gate')).toHaveAttribute('data-access-state', status);
    act(() => jest.advanceTimersByTime(5000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('keeps a allowed startup result quiet', async () => {
    render(<WalletAccessGate>Private wallet</WalletAccessGate>);
    await act(async () => {});
    expect(screen.getByText('Private wallet')).toBeVisible();
    act(() => jest.advanceTimersByTime(5000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('drops a startup failure removed before its dwell completes', async () => {
    mockInitEligibility.mockResolvedValue({ state: 'failed' });
    const view = render(<WalletAccessGate>Private wallet</WalletAccessGate>);
    await act(async () => {});
    expect(screen.getByText('walletAccessUnavailableBody')).toBeVisible();
    act(() => jest.advanceTimersByTime(999));
    view.unmount();
    act(() => jest.advanceTimersByTime(5000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });
});

test('endpoint prerequisite failure keeps the gate closed and names only its startup branch', async () => {
  jest.useFakeTimers();
  jest.mocked(reportUserVisibleError).mockClear();
  mockLoadEndpoints.mockRejectedValueOnce(new Error('private account=0x123 https://private.example'));
  try {
    render(
      <WalletAccessGate>
        <span>Private wallet</span>
      </WalletAccessGate>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId('wallet-access-gate')).toHaveAttribute('data-access-state', 'unavailable');
    expect(screen.queryByText('Private wallet')).toBeNull();
    expect(mockInitEligibility).not.toHaveBeenCalled();
    expect(reportUserVisibleError).toHaveBeenCalledWith('walletAccessUnavailableBody', 'startup', {
      startupEligibilityStage: 'endpoint_overrides',
      startupEligibilityReason: 'override_load_failed',
      startupEligibilityRetry: 'not_attempted'
    });
  } finally {
    jest.useRealTimers();
  }
});

test('a rejected eligibility initializer is not mislabeled as endpoint override failure', async () => {
  jest.useFakeTimers();
  jest.mocked(reportUserVisibleError).mockClear();
  mockInitEligibility.mockRejectedValueOnce(new Error('private failure'));
  try {
    render(
      <WalletAccessGate>
        <span>Private wallet</span>
      </WalletAccessGate>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(reportUserVisibleError).toHaveBeenCalledWith('walletAccessUnavailableBody', 'startup', {
      startupEligibilityStage: 'config_initialization',
      startupEligibilityReason: 'config_initialization_failed',
      startupEligibilityRetry: 'not_attempted'
    });
    expect(screen.queryByText('Private wallet')).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});
