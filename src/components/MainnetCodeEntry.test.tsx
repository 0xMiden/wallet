import React from 'react';

import { Clipboard } from '@capacitor/clipboard';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { checkMainnetAccessCode, type MainnetAccessOutcome } from 'lib/mainnet-access';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { MainnetCodeEntryFields, useMainnetCodeEntry } from './MainnetCodeEntry';

jest.mock('@capacitor/clipboard', () => ({ Clipboard: { read: jest.fn() } }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
let mockMobile = true;
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: () => mockMobile
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => `Visible ${key}` }) }));
jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));
const mockReport = jest.mocked(reportUserVisibleError);
const mockCheck = jest.fn<Promise<MainnetAccessOutcome>, [string]>();
const mockGranted = jest.fn();
const mockSdkReady = jest.fn<Promise<void>, []>();
const mockInvitationCheck = jest.fn<Promise<boolean>, [string]>();
let mockEndpointFailure: unknown;
let mockRpcClientFailure: unknown;
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  MidenClient: { ready: () => mockSdkReady() },
  Endpoint: class {
    constructor(_url: string) {}
  },
  RpcClient: class {
    constructor(_endpoint: unknown) {
      if (mockRpcClientFailure !== undefined) throw mockRpcClientFailure;
    }
    isInvitationCodeValid(code: string) {
      return mockInvitationCheck(code);
    }
  }
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveRpcUrl: () => {
    if (mockEndpointFailure !== undefined) throw mockEndpointFailure;
    return 'https://node.example.invalid';
  }
}));

function Entry({ rejected = false }: { rejected?: boolean }) {
  const entry = useMainnetCodeEntry({ check: mockCheck, onGranted: mockGranted, rejected });
  return (
    <form aria-label="Mainnet entry" onSubmit={entry.submit}>
      <MainnetCodeEntryFields entry={entry} testIdPrefix="mainnet" />
      <button type="submit" disabled={!entry.complete || entry.submitting}>
        Check code
      </button>
    </form>
  );
}
const enterCode = () => fireEvent.change(screen.getByTestId('mainnet-code'), { target: { value: 'ABCDEF123456' } });
const submit = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check code' }));
  });
};
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockMobile = true;
  mockCheck.mockResolvedValue('granted');
  mockSdkReady.mockResolvedValue();
  mockInvitationCheck.mockResolvedValue(true);
  mockEndpointFailure = undefined;
  mockRpcClientFailure = undefined;
});
afterEach(() => {
  jest.useRealTimers();
});

it('accepts ordinary code entry without offering a native clipboard read off mobile', () => {
  mockMobile = false;
  render(<Entry />);
  fireEvent.change(screen.getByTestId('mainnet-code'), { target: { value: 'ABCDEF-123456' } });
  expect(screen.getByTestId('mainnet-code')).toHaveValue('ABCDEF123456');
  expect(screen.getByRole('button', { name: 'Check code' })).toBeEnabled();
  expect(screen.queryByTestId('mainnet-paste')).not.toBeInTheDocument();
  expect(Clipboard.read).not.toHaveBeenCalled();
});

it('keeps mobile native paste and normalizes the returned text', async () => {
  jest.mocked(Clipboard.read).mockResolvedValueOnce({ type: 'text/plain', value: 'ABCDEF-123456' });
  render(<Entry />);
  await act(async () => {
    fireEvent.click(screen.getByTestId('mainnet-paste'));
  });
  expect(screen.getByTestId('mainnet-code')).toHaveValue('ABCDEF123456');
  expect(screen.getByRole('button', { name: 'Check code' })).toBeEnabled();
});

it.each([
  ['rejected', 'mainnetAccessCodeRejected'],
  ['unchecked', 'mainnetAccessCheckFailed'],
  ['clipboard', 'mainnetAccessPasteFailed']
] as const)('reports the real %s producer as %s after 1000 ms', async (failure, id) => {
  render(<Entry />);
  if (failure === 'clipboard') {
    jest.mocked(Clipboard.read).mockRejectedValueOnce(new Error('private clipboard content'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('mainnet-paste'));
    });
  } else {
    if (failure === 'unchecked') mockCheck.mockRejectedValueOnce(new Error('private node cause'));
    else mockCheck.mockResolvedValueOnce('rejected');
    enterCode();
    await submit();
  }
  expect(screen.getByTestId('mainnet-error')).toHaveTextContent(`Visible ${id}`);
  act(() => jest.advanceTimersByTime(999));
  expect(mockReport.mock.calls).toEqual([]);
  act(() => jest.advanceTimersByTime(1));
  const expected =
    failure === 'unchecked'
      ? [
          [
            id,
            'inline',
            { kind: 'mainnet_access_check', mainnetAccessCheckFailure: 'unrecorded', uiFailureKind: 'unknown' }
          ]
        ]
      : [[id, 'inline']];
  expect(mockReport.mock.calls).toEqual(expected);
  act(() => jest.advanceTimersByTime(1000));
  expect(mockReport.mock.calls).toEqual(expected);
});

it('reports a registration refusal already displayed when the entry opens', () => {
  render(<Entry rejected />);
  expect(screen.getByRole('alert')).toHaveTextContent('Visible mainnetAccessCodeRejected');
  act(() => jest.advanceTimersByTime(999));
  expect(mockReport.mock.calls).toEqual([]);
  act(() => jest.advanceTimersByTime(1));
  expect(mockReport.mock.calls).toEqual([['mainnetAccessCodeRejected', 'inline']]);
});

it('does not report empty entry, hint, pending check or granted success', async () => {
  let finish!: (outcome: MainnetAccessOutcome) => void;
  mockCheck.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  render(<Entry />);
  expect(screen.getByText('Visible mainnetAccessHint')).toBeInTheDocument();
  act(() => jest.advanceTimersByTime(1000));
  enterCode();
  await submit();
  expect(screen.getByTestId('mainnet-code')).toBeDisabled();
  act(() => jest.advanceTimersByTime(1000));
  await act(async () => {
    finish('granted');
  });
  expect(mockGranted).toHaveBeenCalledWith('ABCDEF123456');
  act(() => jest.advanceTimersByTime(1000));
  expect(mockReport.mock.calls).toEqual([]);
});

it.each(['change', 'unmount'])('drops a refusal cleared at 999 ms by %s', ending => {
  const view = render(<Entry rejected />);
  expect(screen.getByRole('alert')).toBeInTheDocument();
  act(() => jest.advanceTimersByTime(999));
  if (ending === 'change') enterCode();
  else view.unmount();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  act(() => jest.advanceTimersByTime(1000));
  expect(mockReport.mock.calls).toEqual([]);
});

it.each(['endpoint_resolve', 'sdk_ready', 'rpc_client', 'invitation_check'])(
  'reports the actual access-check failure at %s without its message',
  async stage => {
    const privateMessage = 'RPC failed for 0x1234567890abcdef1234567890abcdef with 1234.5678 private-canary';
    const error = new Error(privateMessage);
    if (stage === 'endpoint_resolve') mockEndpointFailure = error;
    else if (stage === 'sdk_ready') mockSdkReady.mockRejectedValueOnce(error);
    else if (stage === 'rpc_client') mockRpcClientFailure = error;
    else mockInvitationCheck.mockRejectedValue(error);
    mockCheck.mockImplementation(code => checkMainnetAccessCode(code));
    render(<Entry />);
    enterCode();
    await submit();
    expect(screen.getByTestId('mainnet-error')).toHaveTextContent('Visible mainnetAccessCheckFailed');
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([
      [
        'mainnetAccessCheckFailed',
        'inline',
        {
          kind: 'mainnet_access_check',
          mainnetAccessCheckFailure: stage,
          uiFailureKind: 'rpc'
        }
      ]
    ]);
    const report = JSON.stringify(mockReport.mock.calls);
    for (const value of [privateMessage, '1234.5678', 'private-canary', '0x1234567890abcdef1234567890abcdef']) {
      expect(report).not.toContain(value);
    }
  }
);

it('does not invent an access-check stage for a primitive rejection', async () => {
  mockCheck.mockImplementation(code => checkMainnetAccessCode(code));
  mockSdkReady.mockRejectedValueOnce('network rejected private-canary');
  render(<Entry />);
  enterCode();
  await submit();
  act(() => jest.advanceTimersByTime(1000));
  expect(mockReport.mock.calls).toEqual([
    [
      'mainnetAccessCheckFailed',
      'inline',
      {
        kind: 'mainnet_access_check',
        mainnetAccessCheckFailure: 'unrecorded',
        uiFailureKind: 'network'
      }
    ]
  ]);
  expect(JSON.stringify(mockReport.mock.calls)).not.toContain('private-canary');
});
