import React, { useEffect, useState } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import Portal from 'lib/ui/Portal';
import {
  getWalletAccessGeneration,
  invalidateWalletAccess,
  publishWalletAccessDecision,
  registerWalletAccessRuntime
} from 'lib/remote-config/wallet-access';

import { WalletAccessGate } from './WalletAccessGate';

jest.unmock('lib/remote-config/wallet-access');
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ loadEndpointOverrides: async () => undefined }));
jest.mock('lib/remote-config/runtime', () => ({ initBridgeConfig: async () => undefined }));
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

const scope = () => `gate-regression:${getWalletAccessGeneration()}`;

function deferred() {
  let finish: () => void = () => undefined;
  const promise = new Promise<void>(resolve => {
    finish = resolve;
  });
  return { promise, finish };
}

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

function RecoveryDialog({ onMount }: { onMount: () => void }) {
  const [attempts, setAttempts] = useState(0);
  useEffect(() => onMount(), [onMount]);
  return (
    <Portal>
      <button onClick={() => setAttempts(value => value + 1)} aria-label="Recovery dialog action">
        Attempt {attempts}
      </button>
    </Portal>
  );
}

beforeEach(() => {
  registerWalletAccessRuntime({ scope, refresh: async () => undefined });
});

afterEach(() => {
  invalidateWalletAccess();
});

describe('WalletAccessGate recovery lifetime', () => {
  it('never mounts private content before the first allowed decision', async () => {
    const onMount = jest.fn();
    const completion = deferred();
    render(
      <WalletAccessGate>
        <RecoveryForm completion={completion.promise} onMount={onMount} />
      </WalletAccessGate>
    );

    await act(async () => undefined);

    expect(screen.getByTestId('wallet-access-gate')).toHaveAttribute('data-access-state', 'loading');
    expect(screen.queryByTestId('recovery-state')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Recovery progress' })).toBeNull();
    expect(onMount).not.toHaveBeenCalled();
  });

  it('preserves recovery state and its pending result across an inaccessible loading interval', async () => {
    publishWalletAccessDecision(scope(), true);
    const onMount = jest.fn();
    const completion = deferred();
    render(
      <WalletAccessGate>
        <RecoveryForm completion={completion.promise} onMount={onMount} />
      </WalletAccessGate>
    );
    const input = await screen.findByRole('textbox', { name: 'Recovery progress' });
    fireEvent.change(input, { target: { value: 'saved recovery progress' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recover' }));

    await act(async () => {
      invalidateWalletAccess();
    });

    expect(screen.getByTestId('wallet-access-gate')).toHaveAttribute('data-access-state', 'loading');
    expect(input).not.toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Recovery progress' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recover' })).toBeNull();

    await act(async () => {
      completion.finish();
      await completion.promise;
      publishWalletAccessDecision(scope(), true);
    });

    expect(await screen.findByRole('textbox', { name: 'Recovery progress' })).toHaveValue('saved recovery progress');
    expect(screen.getByRole('alert')).toHaveTextContent('Recovery request failed');
    expect(onMount).toHaveBeenCalledTimes(1);
  });

  it('keeps portal recovery actions mounted but inaccessible during a loading interval', async () => {
    publishWalletAccessDecision(scope(), true);
    const onMount = jest.fn();
    render(
      <WalletAccessGate>
        <RecoveryDialog onMount={onMount} />
      </WalletAccessGate>
    );
    const action = await screen.findByRole('button', { name: 'Recovery dialog action' });
    fireEvent.click(action);
    expect(action).toHaveTextContent('Attempt 1');

    await act(async () => {
      invalidateWalletAccess();
    });

    expect(screen.getByTestId('wallet-access-gate')).toHaveAttribute('data-access-state', 'loading');
    expect(action).toBeInTheDocument();
    expect(action).not.toBeVisible();
    expect(screen.queryByRole('button', { name: 'Recovery dialog action' })).toBeNull();

    await act(async () => {
      publishWalletAccessDecision(scope(), true);
    });

    expect(await screen.findByRole('button', { name: 'Recovery dialog action' })).toBe(action);
    expect(action).toHaveTextContent('Attempt 1');
    expect(onMount).toHaveBeenCalledTimes(1);
  });

  it.each([false, null])('removes private content when the authoritative decision is %s', async allowed => {
    publishWalletAccessDecision(scope(), true);
    const completion = deferred();
    render(
      <WalletAccessGate>
        <RecoveryForm completion={completion.promise} onMount={jest.fn()} />
      </WalletAccessGate>
    );
    await screen.findByRole('textbox', { name: 'Recovery progress' });

    await act(async () => {
      publishWalletAccessDecision(scope(), allowed);
    });

    expect(screen.getByTestId('wallet-access-gate')).toHaveAttribute(
      'data-access-state',
      allowed === false ? 'restricted' : 'unavailable'
    );
    expect(screen.queryByTestId('recovery-state')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Recovery progress' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recover' })).toBeNull();
  });
});
