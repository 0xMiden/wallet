import React from 'react';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import {
  ITransaction,
  ITransactionStatus,
  MidenNamePhase,
  MidenNamePublishPhase,
  PublishNameRecordTransaction,
  RegisterNameTransaction
} from 'lib/miden/db/types';
import type { MidenNameRecordState } from 'lib/miden/name/useMidenNameRecord';

import MidenNameSettings from './MidenNameSettings';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

const mockSignTransaction = jest.fn<Promise<Uint8Array>, [string, string]>();
const mockStartProcessing = jest.fn();
jest.mock('lib/miden/front/client', () => ({
  useMidenContext: () => ({ signTransaction: mockSignTransaction })
}));
jest.mock('screens/miden-name/processing', () => ({
  startMidenNameProcessing: (...args: object[]) => mockStartProcessing(...args)
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

// The registry-record state per label, as `useMidenNameRecord` would read it
// from the chain. `undefined` label (a row that is not owned) is never read.
let mockRecords: Record<string, MidenNameRecordState> = {};
const mockUseRecord = jest.fn();
jest.mock('lib/miden/name/useMidenNameRecord', () => ({
  useMidenNameRecord: (accountId: string | undefined, label: string | undefined, refreshKey: string) => {
    mockUseRecord(accountId, label, refreshKey);
    if (label === undefined) return 'checking';
    return mockRecords[label] ?? 'none';
  }
}));

const mockPublishRegistryRecord = jest.fn<Promise<string>, [string, string]>();
jest.mock('lib/miden/name/nfa', () => ({
  REGISTRY_CLEARING_SUPPORTED: false,
  publishRegistryRecord: (accountId: string, label: string) => mockPublishRegistryRecord(accountId, label)
}));

let mockRows: ITransaction[] = [];
let mockPublishes: ITransaction[] = [];
let mockLoaded = true;
const mockUseRegistrations = jest.fn();
const mockUsePublishes = jest.fn();
jest.mock('lib/miden/name/registrations', () => ({
  ...jest.requireActual('lib/miden/name/registrations'),
  useMidenNameRegistrations: (accountId: string | undefined) => {
    mockUseRegistrations(accountId);
    return { rows: mockRows, loaded: mockLoaded };
  },
  useMidenNamePublishes: (accountId: string | undefined) => {
    mockUsePublishes(accountId);
    return mockPublishes;
  }
}));

function publishRow(label: string, phase: MidenNamePublishPhase): ITransaction {
  const row: ITransaction = new PublishNameRecordTransaction({
    accountId: 'mtst1account',
    label,
    network: 'testnet',
    registryAccountId: 'mtst1registry',
    nfaFaucetId: 'mtst1registry',
    requestBytes: new Uint8Array([1]),
    registryNoteId: `0xpublish-${label}`,
    reclaimHeight: 1300,
    builtAtBlock: 1000,
    action: 3n
  });
  row.extraInputs = { ...row.extraInputs, phase };
  row.status = ITransactionStatus.Completed;
  return row;
}

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
    mockPublishes = [];
    mockLoaded = true;
    mockRecords = {};
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

  it('shows the primary name as not yet resolvable, with publishing enabled and clearing disabled', () => {
    mockRows = [registerRow('reg-1', 'alice', 'owned')];
    render(<MidenNameSettings />);

    const card = screen.getByTestId('miden-name-primary-card');
    expect(within(card).getByTestId('miden-name-primary-label')).toHaveTextContent('alice.miden');
    expect(within(card).getByTestId('miden-name-primary-unresolved')).toHaveTextContent('midenNameNotYetResolvable');
    expect(within(card).queryByTestId('miden-name-primary-resolves')).not.toBeInTheDocument();

    const publish = screen.getByTestId('miden-name-publish');
    expect(publish).toBeEnabled();
    expect(publish).toHaveTextContent('midenNamePublish');
    expect(screen.getByTestId('miden-name-clear-records')).toBeDisabled();
    expect(screen.queryByTestId('miden-name-publish-coming-soon')).not.toBeInTheDocument();
  });

  it('reads the publishes of the current account', () => {
    render(<MidenNameSettings />);
    expect(mockUsePublishes).toHaveBeenCalledWith('mtst1account');
  });

  it('publishes the record of an owned name and opens its in-progress page', async () => {
    mockRows = [registerRow('reg-1', 'alice', 'owned')];
    let finish: (txId: string) => void = () => undefined;
    mockPublishRegistryRecord.mockReturnValue(
      new Promise<string>(resolve => {
        finish = resolve;
      })
    );
    render(<MidenNameSettings />);

    fireEvent.click(screen.getByTestId('miden-name-publish'));

    expect(mockPublishRegistryRecord).toHaveBeenCalledWith('mtst1account', 'alice');
    // The button is busy while the registry note is built.
    await waitFor(() => expect(screen.getByTestId('miden-name-publish')).toBeDisabled());
    expect(screen.getByTestId('miden-name-publish')).toHaveTextContent('midenNamePublishing');

    expect(mockStartProcessing).not.toHaveBeenCalled();
    finish('tx/1');
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction/tx%2F1'));
    expect(mockStartProcessing).toHaveBeenCalledTimes(1);
    expect(mockStartProcessing).toHaveBeenCalledWith(mockSignTransaction);
    await waitFor(() => expect(screen.getByTestId('miden-name-publish')).toBeEnabled());
  });

  it('logs a failed publish and enables the button again', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockRows = [registerRow('reg-1', 'alice', 'owned')];
    const error = new Error('The account does not hold the name "alice"');
    mockPublishRegistryRecord.mockRejectedValue(error);
    render(<MidenNameSettings />);

    fireEvent.click(screen.getByTestId('miden-name-publish'));

    await waitFor(() => expect(warn).toHaveBeenCalledWith('[miden-name] Publish to registry failed:', error));
    await waitFor(() => expect(screen.getByTestId('miden-name-publish')).toBeEnabled());
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockStartProcessing).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each<MidenNamePublishPhase>(['requested', 'submitted', 'recorded', 'returning'])(
    'disables publishing while a publish of the name is %s',
    phase => {
      mockRows = [registerRow('reg-1', 'alice', 'owned')];
      mockPublishes = [publishRow('alice', phase)];
      render(<MidenNameSettings />);

      const publish = screen.getByTestId('miden-name-publish');
      expect(publish).toBeDisabled();
      expect(publish).toHaveTextContent('midenNamePublishing');
      fireEvent.click(publish);
      expect(mockPublishRegistryRecord).not.toHaveBeenCalled();
    }
  );

  it.each<MidenNamePublishPhase>(['done', 'failed'])('enables publishing again after a publish that is %s', phase => {
    mockRows = [registerRow('reg-1', 'alice', 'owned')];
    mockPublishes = [publishRow('alice', phase), publishRow('bob', 'recorded')];
    render(<MidenNameSettings />);

    expect(screen.getByTestId('miden-name-publish')).toBeEnabled();
  });

  it('shows the resolves line on the primary card when the reverse check passes', () => {
    mockRows = [registerRow('reg-1', 'alice', 'owned')];
    mockRecords.alice = 'here';
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
