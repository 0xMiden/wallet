import type { ITransactionIcon, ITransactionType } from 'lib/miden/db/types';

import { guardianHistoryActionKey, guardianHistoryIcon, historyEntryActionTitle } from './guardianHistoryLabels';
import { HistoryEntryType, type IHistoryEntry } from './IHistoryEntry';

// The fake `t` returns the key in brackets, so each assertion names the i18n key that the title uses.
const t = (key: string): string => `[${key}]`;

const entry = (overrides: Partial<IHistoryEntry>): IHistoryEntry => ({
  key: 'row-1',
  address: 'mtst1account',
  timestamp: 1_700_000_000,
  type: HistoryEntryType.CompletedTransaction,
  txType: 'execute',
  ...overrides
});

describe('guardianHistoryIcon', () => {
  const cases: ReadonlyArray<[ITransactionType, ITransactionIcon]> = [
    ['send', 'SEND'],
    ['bridged-send', 'SEND'],
    ['consume', 'RECEIVE'],
    ['swap', 'SWAP'],
    ['execute', 'DEFAULT'],
    ['replace-hot-key', 'DEFAULT'],
    ['switch-guardian', 'DEFAULT']
  ];

  it.each(cases)('gives %s the %s icon', (type, icon) => {
    expect(guardianHistoryIcon(type)).toBe(icon);
  });
});

describe('guardianHistoryActionKey', () => {
  const cases: ReadonlyArray<[ITransactionType, string]> = [
    ['send', 'sent'],
    ['consume', 'received'],
    ['swap', 'guardianHistorySwap'],
    ['bridged-send', 'guardianHistoryBridgeOut'],
    ['earn-deposit', 'guardianHistoryEarnDeposit'],
    ['switch-guardian', 'guardianHistoryGuardianChanged'],
    ['replace-hot-key', 'guardianHistoryDeviceReplaced'],
    ['update-procedure-threshold', 'guardianHistoryAccountSecured'],
    ['execute', 'guardianHistoryExecuted'],
    ['earn-withdraw', 'guardianHistoryExecuted']
  ];

  it.each(cases)('maps %s to %s with the default flags', (type, key) => {
    expect(guardianHistoryActionKey(type)).toBe(key);
  });

  it('names a reclaimed consume as reclaimed', () => {
    expect(guardianHistoryActionKey('consume', true)).toBe('reclaimed');
  });

  it('names a replace-hot-key row that added a device as "device added"', () => {
    expect(guardianHistoryActionKey('replace-hot-key', false, true)).toBe('guardianHistoryDeviceAdded');
  });

  it('keeps "device replaced" for a replace-hot-key row that did not add a device', () => {
    expect(guardianHistoryActionKey('replace-hot-key', false, false)).toBe('guardianHistoryDeviceReplaced');
  });

  it('ignores the hot-key flag on every other type', () => {
    expect(guardianHistoryActionKey('send', false, true)).toBe('sent');
    expect(guardianHistoryActionKey('switch-guardian', false, true)).toBe('guardianHistoryGuardianChanged');
  });
});

describe('historyEntryActionTitle', () => {
  it('shows the failed title for a failed row, before every other rule', () => {
    const failed = entry({
      message: 'Transaction failed',
      guardianRecovered: true,
      txType: 'replace-hot-key',
      hotKeyAdded: true
    });
    expect(historyEntryActionTitle(failed, t)).toBe('[transactionFailedNotificationTitle]');
  });

  it('labels a recovered add-device row as "device added", not with its stored message', () => {
    const recovered = entry({
      guardianRecovered: true,
      txType: 'replace-hot-key',
      hotKeyAdded: true,
      message: 'Replace device (hot) signer'
    });
    expect(historyEntryActionTitle(recovered, t)).toBe('[guardianHistoryDeviceAdded]');
  });

  it('labels a recovered replace row as "device replaced"', () => {
    const recovered = entry({ guardianRecovered: true, txType: 'replace-hot-key' });
    expect(historyEntryActionTitle(recovered, t)).toBe('[guardianHistoryDeviceReplaced]');
  });

  it('labels a recovered reclaimed consume as reclaimed', () => {
    const recovered = entry({ guardianRecovered: true, guardianReclaimed: true, txType: 'consume' });
    expect(historyEntryActionTitle(recovered, t)).toBe('[reclaimed]');
  });

  it('uses the rotation verdict title for a switch-guardian row with a verdict', () => {
    const confirmed = entry({ txType: 'switch-guardian', guardianSwitchVerdict: 'confirmed', message: 'Switched' });
    expect(historyEntryActionTitle(confirmed, t)).toBe('[guardianSwitchedRowTitle]');
    const submitted = entry({ txType: 'switch-guardian', guardianSwitchVerdict: 'submitted-unconfirmed' });
    expect(historyEntryActionTitle(submitted, t)).toBe('[guardianSwitchSubmittedRowTitle]');
  });

  it('falls back to the stored message when a switch verdict has no title of its own', () => {
    const inFlight = entry({ txType: 'switch-guardian', guardianSwitchVerdict: 'in-flight', message: 'Switching' });
    expect(historyEntryActionTitle(inFlight, t)).toBe('Switching');
  });

  it('shows the trimmed stored message of a live row', () => {
    const live = entry({ txType: 'replace-hot-key', hotKeyAdded: true, message: '  Device added  ' });
    expect(historyEntryActionTitle(live, t)).toBe('Device added');
  });

  it('labels a live add-device row without a message as "device added"', () => {
    const live = entry({ txType: 'replace-hot-key', hotKeyAdded: true, message: '   ' });
    expect(historyEntryActionTitle(live, t)).toBe('[guardianHistoryDeviceAdded]');
  });

  it('labels a live replace row without a message as "device replaced"', () => {
    const live = entry({ txType: 'replace-hot-key' });
    expect(historyEntryActionTitle(live, t)).toBe('[guardianHistoryDeviceReplaced]');
  });
});
