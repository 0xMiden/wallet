import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import { ITransaction, ITransactionStatus, MidenNamePhase, RegisterNameTransaction } from 'lib/miden/db/types';

import MidenNameSettings from './MidenNameSettings';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args),
  Link: () => null
}));

const mockHapticLight = jest.fn();
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: () => mockHapticLight(),
  hapticMedium: jest.fn()
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: new Proxy({}, { get: (_target, prop) => String(prop) })
}));

jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: { currentAccount: { publicKey: string } }) => unknown) =>
    selector({ currentAccount: { publicKey: 'mtst1account' } })
}));

let mockResolvesHere = false;
jest.mock('lib/miden/name/useMidenNameResolvesHere', () => ({
  useMidenNameResolvesHere: () => mockResolvesHere
}));

let mockRows: ITransaction[] = [];
let mockLoaded = true;
const mockUseRegistrations = jest.fn();
jest.mock('lib/miden/name/registrations', () => ({
  ...jest.requireActual('lib/miden/name/registrations'),
  useMidenNameRegistrations: (accountId: string | undefined) => {
    mockUseRegistrations(accountId);
    return { rows: mockRows, loaded: mockLoaded };
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
  row.status = phase === 'failed' ? ITransactionStatus.Failed : ITransactionStatus.Completed;
  return row;
}

describe('MidenNameSettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRows = [];
    mockLoaded = true;
    mockResolvesHere = false;
  });

  it('reads the registrations of the current account', () => {
    render(<MidenNameSettings />);
    expect(mockUseRegistrations).toHaveBeenCalledWith('mtst1account');
  });

  it('shows the empty state and a claim button when the account has no names', () => {
    render(<MidenNameSettings />);

    expect(screen.getByTestId('miden-name-empty')).toHaveTextContent('midenNameEmpty');
    expect(screen.queryByTestId('miden-name-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('miden-name-primary-card')).not.toBeInTheDocument();

    const claim = screen.getByTestId('miden-name-claim');
    expect(claim).toHaveTextContent('midenNameClaimCta');
    fireEvent.click(claim);
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/miden-name');
  });

  it('renders nothing until the first live-query result is available', () => {
    mockLoaded = false;
    render(<MidenNameSettings />);

    expect(screen.queryByTestId('miden-name-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('miden-name-claim')).not.toBeInTheDocument();
  });

  it('lists each name with the pill of its state', () => {
    mockRows = [
      registerRow('reg-3', 'carol', 'issued'),
      registerRow('reg-2', 'bob', 'failed'),
      registerRow('reg-1', 'alice', 'owned')
    ];
    render(<MidenNameSettings />);

    const rows = within(screen.getByTestId('miden-name-list')).getAllByTestId('miden-name-row');
    expect(rows.map(row => row.querySelector('[data-slot="title"]')?.textContent)).toEqual([
      'carol.miden',
      'bob.miden',
      'alice.miden'
    ]);
    expect(rows.map(row => within(row).getByTestId('miden-name-row-state').textContent)).toEqual([
      'midenNameStateClaiming',
      'midenNameStateFailed',
      'midenNameStateOwned'
    ]);
    expect(screen.getByTestId('miden-name-claim')).toHaveTextContent('midenNameClaimAnother');
  });

  it('opens the status page of a name that is not owned', () => {
    mockRows = [registerRow('reg-2', 'bob', 'failed'), registerRow('reg-1', 'alice', 'owned')];
    render(<MidenNameSettings />);

    const rows = screen.getAllByTestId('miden-name-row');
    expect(rows).toHaveLength(2);
    const failed = rows[0]!;
    const owned = rows[1]!;
    expect(failed.tagName).toBe('BUTTON');
    fireEvent.click(failed);
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/miden-name/status/reg-2');

    // An owned row is not a control of its own: only its Publish button is.
    expect(owned.tagName).not.toBe('BUTTON');
  });

  it('shows the primary name as not yet resolvable, with publishing and clearing disabled', () => {
    mockRows = [registerRow('reg-1', 'alice', 'owned')];
    render(<MidenNameSettings />);

    const card = screen.getByTestId('miden-name-primary-card');
    expect(within(card).getByTestId('miden-name-primary-label')).toHaveTextContent('alice.miden');
    expect(within(card).getByTestId('miden-name-primary-unresolved')).toHaveTextContent('midenNameNotYetResolvable');
    expect(within(card).queryByTestId('miden-name-primary-resolves')).not.toBeInTheDocument();

    expect(screen.getByTestId('miden-name-publish')).toBeDisabled();
    expect(screen.getByTestId('miden-name-clear-records')).toBeDisabled();
    expect(screen.getByTestId('miden-name-publish-coming-soon')).toHaveTextContent('midenNamePublishComingSoon');
  });

  it('shows the resolves line on the primary card when the reverse check passes', () => {
    mockRows = [registerRow('reg-1', 'alice', 'owned')];
    mockResolvesHere = true;
    render(<MidenNameSettings />);

    const card = screen.getByTestId('miden-name-primary-card');
    expect(within(card).getByTestId('miden-name-primary-resolves')).toHaveTextContent('midenNameResolvesHere');
    expect(within(card).queryByTestId('miden-name-primary-unresolved')).not.toBeInTheDocument();
  });

  it('shows no primary card or options while no name is owned', () => {
    mockRows = [registerRow('reg-1', 'alice', 'issued')];
    render(<MidenNameSettings />);

    expect(screen.queryByTestId('miden-name-primary-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('miden-name-clear-records')).not.toBeInTheDocument();
  });
});
