import React, { StrictMode, useEffect, useState } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const restricted: GeoLookup = {
  state: 'ready',
  network: 'testnet',
  version: 13,
  allowed: { wallet: false, earn: false, swap: false }
};

const overrideLoadFailed = {
  startupEligibilityStage: 'endpoint_overrides',
  startupEligibilityReason: 'override_load_failed',
  startupEligibilityRetry: 'not_attempted'
};

const lookupFailed: GeoLookup = {
  state: 'failed',
  diagnostics: {
    startupEligibilityStage: 'eligibility_lookup',
    startupEligibilityReason: 'request_failed',
    startupEligibilityRetry: 'config_not_advanced'
  }
};

describe('WalletAccessGate startup only', () => {
  it('renders nothing until endpoints settle, then mounts the wallet without waiting for the decision', async () => {
    const endpoints = deferred<void>();
    const decision = deferred<GeoLookup>();
    mockLoadEndpoints.mockReturnValue(endpoints.promise);
    mockInitEligibility.mockReturnValue(decision.promise);
    const view = render(
      <WalletAccessGate>
        <p>Private wallet</p>
      </WalletAccessGate>
    );
    expect(view.container).toBeEmptyDOMElement();
    expect(mockInitEligibility).not.toHaveBeenCalled();
    await act(async () => {
      endpoints.finish();
      await endpoints.promise;
    });
    expect(screen.getByText('Private wallet')).toBeVisible();
    expect(screen.queryByTestId('wallet-access-gate')).toBeNull();
    expect(mockInitEligibility).toHaveBeenCalledTimes(1);
  });

  it('starts the startup decision before the wallet mounts', async () => {
    mockInitEligibility.mockReturnValue(new Promise(() => {}));
    const callsAtMount: number[] = [];
    function Wallet() {
      useEffect(() => {
        callsAtMount.push(mockInitEligibility.mock.calls.length);
      }, []);
      return <p>Private wallet</p>;
    }
    render(
      <WalletAccessGate>
        <Wallet />
      </WalletAccessGate>
    );
    await act(async () => {});
    expect(callsAtMount).toEqual([1]);
  });

  it('swaps the wallet for a sticky restricted lock screen when a wallet:false decision arrives', async () => {
    const decision = deferred<GeoLookup>();
    mockInitEligibility.mockReturnValue(decision.promise);
    const view = render(
      <WalletAccessGate>
        <p>Private wallet</p>
      </WalletAccessGate>
    );
    await act(async () => {});
    expect(screen.getByText('Private wallet')).toBeVisible();
    expect(screen.queryByTestId('wallet-access-gate')).toBeNull();
    await act(async () => {
      decision.finish(restricted);
      await decision.promise;
    });
    expect(screen.getByTestId('wallet-access-gate')).toHaveAttribute('data-access-state', 'restricted');
    expect(screen.getByText('walletAccessRestrictedTitle')).toBeVisible();
    expect(screen.getByText('walletAccessRestrictedBody')).toBeVisible();
    expect(screen.queryByText('Private wallet')).toBeNull();
    expect(screen.getByTestId('wallet-access-retry')).toBeVisible();
    view.rerender(
      <WalletAccessGate>
        <p>Private wallet</p>
      </WalletAccessGate>
    );
    await act(async () => {});
    expect(screen.getByTestId('wallet-access-gate')).toHaveAttribute('data-access-state', 'restricted');
    expect(screen.queryByText('Private wallet')).toBeNull();
    expect(mockInitEligibility).toHaveBeenCalledTimes(1);
  });

  it('keeps the same wallet tree when a wallet:true decision arrives after mount', async () => {
    const decision = deferred<GeoLookup>();
    mockInitEligibility.mockReturnValue(decision.promise);
    render(
      <WalletAccessGate>
        <p>Private wallet</p>
      </WalletAccessGate>
    );
    await act(async () => {});
    const wallet = screen.getByText('Private wallet');
    await act(async () => {
      decision.finish(allowed);
      await decision.promise;
    });
    expect(screen.getByText('Private wallet')).toBe(wallet);
    expect(screen.queryByTestId('wallet-access-gate')).toBeNull();
  });

  it.each<[string, GeoLookup]>([
    ['without diagnostics', { state: 'failed' }],
    ['with diagnostics', lookupFailed]
  ])('mounts the wallet when the startup lookup fails %s', async (_label, decision) => {
    mockInitEligibility.mockResolvedValue(decision);
    render(
      <WalletAccessGate>
        <p>Private wallet</p>
      </WalletAccessGate>
    );
    await act(async () => {});
    expect(screen.getByText('Private wallet')).toBeVisible();
    expect(screen.queryByTestId('wallet-access-gate')).toBeNull();
  });

  it('still runs the lookup and mounts the wallet when endpoint bootstrap fails', async () => {
    mockLoadEndpoints.mockRejectedValueOnce(new Error('storage unavailable'));
    render(
      <WalletAccessGate>
        <p>Private wallet</p>
      </WalletAccessGate>
    );
    await act(async () => {});
    expect(screen.getByText('Private wallet')).toBeVisible();
    expect(screen.queryByTestId('wallet-access-gate')).toBeNull();
    expect(mockInitEligibility).toHaveBeenCalledTimes(1);
  });

  it('still applies a restriction decided after endpoint bootstrap fails', async () => {
    mockLoadEndpoints.mockRejectedValueOnce(new Error('storage unavailable'));
    mockInitEligibility.mockResolvedValue(restricted);
    render(
      <WalletAccessGate>
        <p>Private wallet</p>
      </WalletAccessGate>
    );
    await act(async () => {});
    expect(screen.getByTestId('wallet-access-gate')).toHaveAttribute('data-access-state', 'restricted');
    expect(screen.queryByText('Private wallet')).toBeNull();
  });

  it('mounts the wallet when the eligibility initializer throws synchronously', async () => {
    mockInitEligibility.mockImplementation(() => {
      throw new Error('private failure');
    });
    render(
      <WalletAccessGate>
        <p>Private wallet</p>
      </WalletAccessGate>
    );
    await act(async () => {});
    expect(screen.getByText('Private wallet')).toBeVisible();
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

  it.each<[string, GeoLookup, unknown[]]>([
    ['a failed decision without diagnostics', { state: 'failed' }, ['walletAccessUnavailableBody', 'startup']],
    [
      'a failed decision with diagnostics',
      lookupFailed,
      [
        'walletAccessUnavailableBody',
        'startup',
        {
          startupEligibilityStage: 'eligibility_lookup',
          startupEligibilityReason: 'request_failed',
          startupEligibilityRetry: 'config_not_advanced'
        }
      ]
    ]
  ])('reports %s once after a full dwell while the wallet stays open', async (_label, decision, call) => {
    mockInitEligibility.mockResolvedValue(decision);
    render(<WalletAccessGate>Private wallet</WalletAccessGate>);
    await act(async () => {});
    expect(screen.getByText('Private wallet')).toBeVisible();
    act(() => jest.advanceTimersByTime(999));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([call]);
    act(() => jest.advanceTimersByTime(5000));
    expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
  });

  it('names the endpoint override failure when the decision then fails', async () => {
    mockLoadEndpoints.mockRejectedValue(new Error('private account=0x123 https://private.example'));
    mockInitEligibility.mockResolvedValue(lookupFailed);
    render(<WalletAccessGate>Private wallet</WalletAccessGate>);
    await act(async () => {});
    expect(screen.getByText('Private wallet')).toBeVisible();
    expect(mockInitEligibility).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([
      ['walletAccessUnavailableBody', 'startup', overrideLoadFailed]
    ]);
  });

  it.each<[string, GeoLookup]>([
    ['allowed', allowed],
    ['restricted', restricted]
  ])('reports nothing for an endpoint override failure followed by an %s decision', async (_label, decision) => {
    mockLoadEndpoints.mockRejectedValue(new Error('private bootstrap failure'));
    mockInitEligibility.mockResolvedValue(decision);
    render(<WalletAccessGate>Private wallet</WalletAccessGate>);
    await act(async () => {});
    act(() => jest.advanceTimersByTime(5000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('a rejected eligibility initializer is not mislabeled as endpoint override failure', async () => {
    mockInitEligibility.mockRejectedValueOnce(new Error('private failure'));
    render(<WalletAccessGate>Private wallet</WalletAccessGate>);
    await act(async () => {});
    expect(screen.getByText('Private wallet')).toBeVisible();
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([
      [
        'walletAccessUnavailableBody',
        'startup',
        {
          startupEligibilityStage: 'config_initialization',
          startupEligibilityReason: 'config_initialization_failed',
          startupEligibilityRetry: 'not_attempted'
        }
      ]
    ]);
  });

  it('keeps a pending startup decision quiet', async () => {
    mockInitEligibility.mockReturnValue(new Promise(() => {}));
    render(<WalletAccessGate>Private wallet</WalletAccessGate>);
    await act(async () => {});
    expect(screen.getByText('Private wallet')).toBeVisible();
    expect(screen.queryByTestId('wallet-access-gate')).toBeNull();
    act(() => jest.advanceTimersByTime(5000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('keeps a restricted startup result quiet', async () => {
    mockInitEligibility.mockResolvedValue(restricted);
    render(<WalletAccessGate>Private wallet</WalletAccessGate>);
    await act(async () => {});
    expect(screen.getByTestId('wallet-access-gate')).toHaveAttribute('data-access-state', 'restricted');
    act(() => jest.advanceTimersByTime(5000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('keeps an allowed startup result quiet', async () => {
    render(<WalletAccessGate>Private wallet</WalletAccessGate>);
    await act(async () => {});
    expect(screen.getByText('Private wallet')).toBeVisible();
    act(() => jest.advanceTimersByTime(5000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('drops a startup failure removed before its dwell completes', async () => {
    mockInitEligibility.mockResolvedValue(lookupFailed);
    const view = render(<WalletAccessGate>Private wallet</WalletAccessGate>);
    await act(async () => {});
    expect(screen.getByText('Private wallet')).toBeVisible();
    act(() => jest.advanceTimersByTime(999));
    view.unmount();
    act(() => jest.advanceTimersByTime(5000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });
});

describe('published disclosures of the startup check', () => {
  it.each(['docs/privacy/index.md', 'docs/tos/index.md', 'docs/compliance/index.md'])(
    '%s says a failed check opens the wallet with Earn and Swap unavailable',
    path => {
      const text = readFileSync(join(__dirname, '..', '..', path), 'utf8');
      expect(text).toContain(
        'Without a successful startup eligibility decision, the wallet opens with Earn and Swap unavailable.'
      );
      expect(text).not.toContain('a failed startup check keeps wallet access closed');
    }
  );
});
