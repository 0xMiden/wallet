import { act, renderHook, waitFor } from '@testing-library/react';

import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { WalletContact } from 'lib/shared/types';

import { isNewRecipient, useIsNewRecipient } from './useIsNewRecipient';

// Both routing forms of the same account must collapse to one key, as the real SDK helper does; `0xself`
// is this wallet's account in hex, the form a dApp may name its sender in.
const CANONICAL: Record<string, string> = {
  mtst1sent: 'acct-sent',
  mtst1sentalias: 'acct-sent',
  '0xself': 'mtst1account'
};
const canonical = (id: string) => {
  const head = id.split('_')[0];
  return CANONICAL[head] ?? head;
};

// Each call stands for an SDK address parse, so a test can count them.
const mockCanonical = jest.fn((id: string) => canonical(id));
jest.mock('lib/miden/sdk/helpers', () => ({
  canonicalWalletAccountId: (id: string) => mockCanonical(id),
  sameWalletAccountId: (a: string, b: string) => mockCanonical(a) === mockCanonical(b)
}));

const mockToArray = jest.fn();
const mockAnyOf = jest.fn((..._types: string[]) => ({ toArray: (...args: unknown[]) => mockToArray(...args) }));
const mockWhere = jest.fn((_index: string) => ({ anyOf: (...types: string[]) => mockAnyOf(...types) }));
jest.mock('lib/miden/repo', () => ({
  transactions: { where: (index: string) => mockWhere(index) }
}));

let mockContacts: WalletContact[] = [];
jest.mock('lib/miden/front/use-filtered-contacts.hook', () => ({
  useFilteredContacts: () => ({ allContacts: mockContacts })
}));

const ACCOUNT = 'mtst1account';

const sendRow = (over: Partial<ITransaction> = {}): ITransaction =>
  ({
    type: 'send',
    accountId: ACCOUNT,
    secondaryAccountId: 'mtst1sent',
    status: ITransactionStatus.Completed,
    initiatedAt: 1_000,
    completedAt: 1_000,
    ...over
  }) as unknown as ITransaction;

const bridgedRow = (destinationAddress: string, over: Partial<ITransaction> = {}): ITransaction =>
  ({
    type: 'bridged-send',
    accountId: ACCOUNT,
    secondaryAccountId: 'mtst1bridgeallocator',
    status: ITransactionStatus.Completed,
    initiatedAt: 1_000,
    completedAt: 1_000,
    extraInputs: { destinationAddress, destinationNetwork: 11155111 },
    ...over
  }) as unknown as ITransaction;

const contact = (over: Partial<WalletContact> = {}): WalletContact => ({
  address: 'mtst1sent',
  name: 'Alice',
  ...over
});

describe('isNewRecipient', () => {
  const check = (to: string, rows: ITransaction[] = [], contacts: WalletContact[] = []) =>
    isNewRecipient({ to, accountId: ACCOUNT, rows, contacts });

  it('is new when nothing this account sent, no contact and no own account matches', () => {
    expect(
      check('mtst1sent', [sendRow({ secondaryAccountId: 'mtst1other' })], [contact({ address: 'mtst1else' })])
    ).toBe(true);
  });

  it('knows a recipient sent to before in another address form', () => {
    expect(check('mtst1sentalias', [sendRow({ secondaryAccountId: 'mtst1sent_qr7route' })])).toBe(false);
  });

  it('knows a bridged recipient whatever the letter case of its 0x address', () => {
    const rows = [bridgedRow('0xAbCdEf0000000000000000000000000000000001')];

    expect(check('0xabcdef0000000000000000000000000000000001', rows)).toBe(false);
  });

  it('does not count a row restored from a backup file', () => {
    expect(check('mtst1sent', [sendRow({ restoredFromBackup: true })])).toBe(true);
  });

  it('does not count a failed send', () => {
    expect(check('mtst1sent', [sendRow({ status: ITransactionStatus.Failed })])).toBe(true);
  });

  it('counts a send still in flight', () => {
    for (const status of [
      ITransactionStatus.Queued,
      ITransactionStatus.GeneratingTransaction,
      ITransactionStatus.Unconfirmed
    ]) {
      expect(check('mtst1sent', [sendRow({ status })])).toBe(false);
    }
  });

  it('does not count a send from another account', () => {
    expect(check('mtst1sent', [sendRow({ accountId: 'mtst1someoneelse' })])).toBe(true);
  });

  it('counts a send stored under a hex encoding of this account', () => {
    expect(check('mtst1sentalias', [sendRow({ accountId: '0xself', secondaryAccountId: 'mtst1sent_qr7route' })])).toBe(
      false
    );
  });

  it('knows a saved contact in another address form', () => {
    expect(check('mtst1sentalias', [], [contact({ address: 'mtst1sent_qr7route' })])).toBe(false);
  });

  it("knows one of the wallet's own accounts", () => {
    expect(check('mtst1sent', [], [contact({ address: 'mtst1sent_deadbeefpublickey', accountInWallet: true })])).toBe(
      false
    );
  });

  it('is never new for a blank recipient', () => {
    expect(check('  ')).toBe(false);
  });

  it('parses the current account and each distinct stored account id once', () => {
    const rows = [
      sendRow({ accountId: '0xrestored', secondaryAccountId: 'mtst1restored', restoredFromBackup: true }),
      sendRow({ accountId: '0xfailed', secondaryAccountId: 'mtst1failed', status: ITransactionStatus.Failed }),
      sendRow({ accountId: '0xself', secondaryAccountId: 'mtst1other' }),
      sendRow({ accountId: '0xself', secondaryAccountId: 'mtst1elsewhere' }),
      sendRow({ accountId: 'mtst1someoneelse', secondaryAccountId: 'mtst1sent' }),
      sendRow({ accountId: 'mtst1someoneelse', secondaryAccountId: 'mtst1elsewhere2' }),
      sendRow({ accountId: `${ACCOUNT}_suffix`, secondaryAccountId: 'mtst1sent_qr7route' }),
      sendRow({ accountId: ACCOUNT, secondaryAccountId: 'mtst1ownform' })
    ];
    mockCanonical.mockClear();
    const parsesOf = (id: string) => mockCanonical.mock.calls.filter(([arg]) => arg === id);

    expect(check('mtst1sentalias', rows)).toBe(false);
    for (const id of ['0xself', ACCOUNT, `${ACCOUNT}_suffix`, 'mtst1someoneelse']) {
      expect(parsesOf(id)).toHaveLength(1);
    }
    // Skipped rows cost nothing, and another account's recipient is never parsed.
    for (const id of ['0xrestored', '0xfailed', 'mtst1sent']) {
      expect(parsesOf(id)).toHaveLength(0);
    }
    for (const id of ['mtst1other', 'mtst1elsewhere', 'mtst1sent_qr7route', 'mtst1ownform', 'mtst1sentalias']) {
      expect(parsesOf(id)).toHaveLength(1);
    }
    expect(mockCanonical).toHaveBeenCalledTimes(9);
  });
});

describe('useIsNewRecipient', () => {
  beforeEach(() => {
    mockToArray.mockReset();
    mockWhere.mockClear();
    mockAnyOf.mockClear();
    mockCanonical.mockClear();
    mockContacts = [];
  });

  it('reads only send rows, through the type index', async () => {
    mockToArray.mockResolvedValue([]);

    const { result } = renderHook(() => useIsNewRecipient(ACCOUNT, 'mtst1sent'));
    await waitFor(() => expect(result.current).toBe(true));

    expect(mockWhere).toHaveBeenCalledWith('type');
    expect(mockAnyOf).toHaveBeenCalledWith('send', 'bridged-send');
  });

  it('does not walk the history again when the contacts change', async () => {
    mockToArray.mockResolvedValue([
      sendRow({ accountId: 'mtst1someoneelse', secondaryAccountId: 'mtst1other' }),
      sendRow({ accountId: `${ACCOUNT}_suffix`, secondaryAccountId: 'mtst1sent' })
    ]);
    const historyParses = () => mockCanonical.mock.calls.filter(([id]) => id === 'mtst1sent').length;

    const { result, rerender } = renderHook(() => useIsNewRecipient(ACCOUNT, 'mtst1fresh'));
    await waitFor(() => expect(result.current).toBe(true));
    const before = historyParses();
    expect(before).toBe(1);

    mockContacts = [contact({ address: 'mtst1else' })];
    rerender();

    expect(historyParses() - before).toBe(0);
    expect(result.current).toBe(true);
  });

  it('answers undefined until the history read lands, then true for a first send', async () => {
    mockToArray.mockResolvedValue([]);

    const { result } = renderHook(() => useIsNewRecipient(ACCOUNT, 'mtst1sent'));

    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('reads the history once per recipient, so a send queued during review keeps the tag', async () => {
    mockToArray.mockResolvedValueOnce([]).mockResolvedValue([sendRow({ status: ITransactionStatus.Queued })]);

    const { result, rerender } = renderHook(() => useIsNewRecipient(ACCOUNT, 'mtst1sent'));
    await waitFor(() => expect(result.current).toBe(true));

    rerender();

    expect(result.current).toBe(true);
    expect(mockToArray).toHaveBeenCalledTimes(1);
  });

  it('reads again for another recipient', async () => {
    mockToArray.mockResolvedValueOnce([]).mockResolvedValueOnce([sendRow({ secondaryAccountId: 'mtst1second' })]);

    const { result, rerender } = renderHook(({ to }) => useIsNewRecipient(ACCOUNT, to), {
      initialProps: { to: 'mtst1sent' }
    });
    await waitFor(() => expect(result.current).toBe(true));

    rerender({ to: 'mtst1second' });

    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(false));
    expect(mockToArray).toHaveBeenCalledTimes(2);
  });

  it('ignores a history read that lands after the recipient changed', async () => {
    let resolveA: (rows: ITransaction[]) => void = () => undefined;
    mockToArray
      .mockReturnValueOnce(new Promise<ITransaction[]>(resolve => (resolveA = resolve)))
      .mockResolvedValueOnce([]);

    const { result, rerender } = renderHook(({ to }) => useIsNewRecipient(ACCOUNT, to), {
      initialProps: { to: 'mtst1sent' }
    });
    rerender({ to: 'mtst1second' });
    await waitFor(() => expect(result.current).toBe(true));

    // The late read would make A known, and it must not leak into B's answer.
    await act(async () => resolveA([sendRow()]));

    expect(result.current).toBe(true);
  });

  it('stays undefined and warns when the history read fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = new Error('idb closed');
    mockToArray.mockRejectedValue(err);

    const { result } = renderHook(() => useIsNewRecipient(ACCOUNT, 'mtst1sent'));

    await waitFor(() => expect(warn).toHaveBeenCalledWith('[useIsNewRecipient] history read failed', err));
    expect(result.current).toBeUndefined();
    warn.mockRestore();
  });

  it('reads nothing without an account', () => {
    const { result } = renderHook(() => useIsNewRecipient(undefined, 'mtst1sent'));

    expect(result.current).toBeUndefined();
    expect(mockToArray).not.toHaveBeenCalled();
  });
});
