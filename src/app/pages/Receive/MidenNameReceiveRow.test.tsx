import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { ITransaction, ITransactionStatus, MidenNamePhase, RegisterNameTransaction } from 'lib/miden/db/types';

import { MidenNameReceiveRow } from './MidenNameReceiveRow';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const values = opts ? Object.values(opts) : [];
      return values.length > 0 ? `${key}_${values.join('_')}` : key;
    }
  })
}));

const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args),
  Link: () => null
}));

const mockHapticLight = jest.fn();
jest.mock('lib/mobile/haptics', () => ({ hapticLight: () => mockHapticLight() }));
jest.mock('app/icons/v2', () => ({ Icon: () => null, IconName: { User: 'user' } }));

let mockSupported = true;
jest.mock('lib/miden/name/config', () => ({
  isMidenNameSupported: () => mockSupported
}));

let mockRows: ITransaction[] = [];
const mockUseRegistrations = jest.fn();
jest.mock('lib/miden/name/registrations', () => ({
  ...jest.requireActual('lib/miden/name/registrations'),
  useMidenNameRegistrations: (accountId: string | undefined) => {
    mockUseRegistrations(accountId);
    return { rows: mockRows, loaded: true };
  }
}));

function registerRow(id: string, label: string, phase: MidenNamePhase): ITransaction {
  const row: ITransaction = new RegisterNameTransaction({
    accountId: 'mtst1account',
    label,
    network: 'testnet',
    paymentFaucetId: 'mtst1miden',
    registryAccountId: 'mtst1registry',
    priceBaseUnits: 20_000_000n,
    networkFeeBaseUnits: 210n,
    requestBytes: new Uint8Array([1]),
    registrationNoteId: `0x${label}`,
    reclaimHeight: 1300,
    builtAtBlock: 1000
  });
  row.id = id;
  row.extraInputs = { ...row.extraInputs, phase };
  row.status = phase === 'requested' ? ITransactionStatus.Queued : ITransactionStatus.Completed;
  return row;
}

describe('MidenNameReceiveRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSupported = true;
    mockRows = [];
  });

  it('renders nothing and reads no rows when the network has no deployment', () => {
    mockSupported = false;
    const { container } = render(<MidenNameReceiveRow address="mtst1account" />);
    expect(container).toBeEmptyDOMElement();
    expect(mockUseRegistrations).toHaveBeenCalledWith(undefined);
  });

  it('offers to claim a name when the account has none', () => {
    render(<MidenNameReceiveRow address="mtst1account" />);
    const row = screen.getByTestId('receive-miden-name');
    expect(row).toHaveTextContent('midenNameClaimCta');
    expect(row).toHaveTextContent('midenNameClaimCtaSubtitle_.miden');
    fireEvent.click(row);
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/miden-name');
    expect(mockUseRegistrations).toHaveBeenCalledWith('mtst1account');
  });

  it('opens the status page of the newest claim in progress', () => {
    mockRows = [registerRow('reg-2', 'bob', 'issued'), registerRow('reg-1', 'old', 'failed')];
    render(<MidenNameReceiveRow address="mtst1account" />);
    const row = screen.getByTestId('receive-miden-name');
    expect(row).toHaveTextContent('midenName');
    expect(row).toHaveTextContent('midenNameClaiming_bob.miden');
    fireEvent.click(row);
    expect(mockNavigate).toHaveBeenCalledWith('/miden-name/status/reg-2');
  });

  it('shows the owned name and opens its settings page', () => {
    mockRows = [registerRow('reg-2', 'bob', 'claiming'), registerRow('reg-1', 'alice', 'owned')];
    render(<MidenNameReceiveRow address="mtst1account" />);
    const row = screen.getByTestId('receive-miden-name');
    expect(row).toHaveTextContent('alice.miden');
    fireEvent.click(row);
    expect(mockNavigate).toHaveBeenCalledWith('/settings/miden-name');
  });

  it('offers a new claim when every registration failed', () => {
    mockRows = [registerRow('reg-1', 'alice', 'failed')];
    render(<MidenNameReceiveRow address="mtst1account" />);
    expect(screen.getByTestId('receive-miden-name')).toHaveTextContent('midenNameClaimCta');
  });
});
