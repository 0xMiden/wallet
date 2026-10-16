import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { useAccount, useMidenContext } from 'lib/miden/front';
import { useRetryableSWR } from 'lib/swr';
import { captureCrash } from 'lib/telemetry/crash';
import { Provider as WoozieProvider } from 'lib/woozie';

import ConfirmPage from './ConfirmPage';
import { ConfirmPageSelectors } from './ConfirmPage.selectors';

// The router and the error boundary stay real: the reported crash is the form re-rendering under a location
// that lost its request id, caught and reported by the boundary.
jest.mock('lib/telemetry/crash', () => ({ captureCrash: jest.fn() }));

// A stable `t`, as in production, so only a location change can re-run the form's id memo.
jest.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

jest.mock('lib/miden/front', () => ({
  useMidenContext: jest.fn(),
  useAccount: jest.fn(),
  MIDEN_METADATA: { decimals: 6, symbol: 'MIDEN', name: 'Miden' }
}));

// The payload is served synchronously, so the test waits on nothing but the approval itself.
jest.mock('lib/swr', () => ({ useRetryableSWR: jest.fn() }));

// The window is unlocked here, so its unlock screen and lockout bookkeeping are off this path.
jest.mock('app/pages/Unlock', () => ({
  __esModule: true,
  default: () => null,
  useRetireLockoutOnReady: () => undefined
}));

const mockCaptureCrash = captureCrash as jest.Mock;
const confirmDAppTransaction = jest.fn();

const base = {
  origin: 'https://dapp.example.com',
  networkRpc: 'https://rpc.testnet.miden.io',
  appMeta: { name: 'DApp', description: 'x', iconUri: '' },
  sourcePublicKey: 'src_key'
};

const payloads: Record<string, object> = {
  'req-tx': {
    type: 'transaction',
    ...base,
    preview: {},
    transactionMessages: ['Sending funds', 'to a recipient', 'Amount, -1.5']
  },
  'req-consume': {
    type: 'consume',
    ...base,
    noteId: '0xnoteidlong1234567890',
    transactionMessages: ['Consuming note', 'Amount, 7.25']
  }
};

let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  confirmDAppTransaction.mockResolvedValue(undefined);
  (useMidenContext as jest.Mock).mockReturnValue({ ready: true, confirmDAppTransaction });
  (useRetryableSWR as jest.Mock).mockImplementation(([id]: [string]) => ({ data: payloads[id] }));
  (useAccount as jest.Mock).mockReturnValue({ name: 'Main', publicKey: 'mtst1account_ABCDpub', isPublic: true });
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('ConfirmPage after an approved transaction', () => {
  it.each([
    ['transaction', 'req-tx', ConfirmPageSelectors.TransactionAction_AcceptButton],
    ['consume', 'req-consume', ConfirmPageSelectors.ConsumeAction_AcceptButton]
  ])('keeps the %s approval window on its request until the background closes it', async (_type, id, acceptId) => {
    // The background opens the approval window at confirm.html#?id=<request id>.
    window.history.replaceState(null, '', `/confirm.html#?id=${id}`);
    render(
      <WoozieProvider>
        <ConfirmPage />
      </WoozieProvider>
    );

    const accept = screen.getByTestId(acceptId);
    await act(async () => {
      fireEvent.click(accept);
    });

    expect(confirmDAppTransaction).toHaveBeenCalledWith(id, true, expect.any(Boolean));
    // Settled once the button leaves its loading state; a page that crashed never gets there.
    await waitFor(() => {
      expect(mockCaptureCrash).not.toHaveBeenCalled();
      expect(window.location.hash).toBe(`#?id=${id}`);
      expect(screen.getByTestId(acceptId)).not.toHaveAttribute('aria-busy');
    });
    expect(screen.queryByText('oops')).not.toBeInTheDocument();
  });
});
