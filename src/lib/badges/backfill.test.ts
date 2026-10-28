import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';

import { backfillWalletBadges, badgesFromHistory, type BadgeBackfillSource } from './backfill';
import { ISSUABLE_BADGES } from './evidence';
import type { BadgeId } from './types';

const row = (patch: Partial<ITransaction> = {}): ITransaction => ({
  id: 'send',
  type: 'send',
  accountId: 'account-a_tag',
  secondaryAccountId: 'recipient',
  faucetId: 'coin-a',
  amount: 10n,
  status: ITransactionStatus.Completed,
  initiatedAt: 1,
  displayIcon: 'SEND',
  badgeNetwork: 'mainnet',
  ...patch
});
const swap = () =>
  row({ id: 'swap', type: 'swap', extraInputs: { requestedAmount: 100n, requestedFaucetId: 'coin-b' } });
const claim = (id: string, amount = 100n) =>
  row({
    id,
    type: 'consume',
    amount,
    faucetId: 'coin-b',
    noteIds: [id],
    extraInputs: { swapOrderTxId: 'swap', swapSettleKind: 'settle' }
  });
const evaluate = (rows: ITransaction[]) => badgesFromHistory(rows, ['account-a', 'account-b'], ISSUABLE_BADGES);

it('awards a completed send without a chain ID, SDK record, or balance snapshot', () => {
  expect(evaluate([row()])).toEqual(['first-send']);
});

it.each(['mainnet', 'testnet'])('uses the saved network for recovered %s history', network => {
  const recovered = row({
    badgeNetwork: undefined,
    recovered: true,
    restoredFromBackup: true,
    recovery: {
      version: 5,
      network,
      operators: ['guardian'],
      nonce: 1,
      inputNotes: [],
      outputNotes: [],
      completeness: 'decoded',
      reclaimed: false
    }
  });
  expect(evaluate([recovered])).toEqual(network === 'mainnet' ? ['first-send'] : []);
});

it.each<Partial<ITransaction>>([
  { status: ITransactionStatus.Queued },
  { status: ITransactionStatus.GeneratingTransaction },
  { status: ITransactionStatus.Failed },
  { status: ITransactionStatus.Unconfirmed },
  { badgeNetwork: undefined },
  { badgeNetwork: 'testnet' },
  { accountId: 'another-wallet' },
  { restoredFromBackup: true },
  { amount: 0n },
  { amount: -1n },
  { secondaryAccountId: undefined },
  { secondaryAccountId: 'account-b_tag' },
  { dappOrigins: ['https://app.example'] }
])('does not award an ineligible send: %s', patch => {
  expect(evaluate([row(patch)])).toEqual([]);
});

it.each(['submitting', 'delivering', 'ready', 'failed', undefined])(
  'does not treat a Completed bridge tracking row in phase %s as a deposit',
  phase => {
    expect(evaluate([row({ type: 'bridged-receive', extraInputs: { phase } })])).toEqual([]);
  }
);

it('awards a received deposit without claim links or submission nonce evidence', () => {
  expect(evaluate([row({ type: 'bridged-receive', extraInputs: { phase: 'received' } })])).toEqual(['first-deposit']);
});

it('waits for the requested swap amount and combines distinct completed claims', () => {
  expect(evaluate([swap()])).toEqual([]);
  expect(evaluate([swap(), claim('a', 50n)])).toEqual([]);
  expect(evaluate([swap(), claim('a', 50n), claim('b', 50n)])).toEqual(['first-swap']);
});

it('does not count duplicate notes, incomplete claims, another account, or another token', () => {
  const first = claim('a', 50n);
  expect(evaluate([swap(), first, { ...first, id: 'duplicate' }])).toEqual([]);
  expect(evaluate([swap(), { ...claim('a'), noteIds: ['a', 'a'] }])).toEqual([]);
  expect(evaluate([swap(), { ...claim('a'), noteIds: undefined }])).toEqual([]);
  expect(evaluate([swap(), { ...claim('a'), status: ITransactionStatus.Failed }])).toEqual([]);
  expect(evaluate([swap(), { ...claim('a'), accountId: 'account-b' }])).toEqual([]);
  expect(evaluate([swap(), { ...claim('a'), faucetId: 'coin-c' }])).toEqual([]);
});

it('does not award reclaimed swaps or unavailable tasks', () => {
  expect(evaluate([{ ...swap(), extraInputs: { ...swap().extraInputs, reclaimedAt: 5 } }, claim('a')])).toEqual([]);
  const reclaim = { ...claim('reclaim'), extraInputs: { swapOrderTxId: 'swap', swapSettleKind: 'reclaim' } };
  expect(evaluate([swap(), claim('a'), reclaim])).toEqual([]);
  expect(badgesFromHistory([row()], ['account-a'], ['first-receive', 'recovery-checked', 'miniapp-explorer'])).toEqual(
    []
  );
});

function source(earned: BadgeId[] = []): BadgeBackfillSource {
  return {
    readAwards: jest.fn(async () => earned),
    readTransactions: jest.fn(async () => [row()]),
    accounts: ['account-a'],
    isCurrent: jest.fn(() => true),
    mergeAwards: jest.fn(async () => {})
  };
}

it('reads saved awards before history and queries only missing tasks', async () => {
  const testSource = source(['first-deposit']);
  testSource.readTransactions = jest.fn(async wanted => {
    expect(testSource.readAwards).toHaveBeenCalledTimes(1);
    expect(wanted).toEqual(['first-send', 'first-swap']);
    return [row()];
  });
  await backfillWalletBadges(testSource);
  expect(testSource.mergeAwards).toHaveBeenCalledWith(['first-send'], testSource.isCurrent);
});

it('does not scan history when all available awards are saved', async () => {
  const testSource = source([...ISSUABLE_BADGES]);
  await backfillWalletBadges(testSource);
  expect(testSource.readTransactions).not.toHaveBeenCalled();
  expect(testSource.mergeAwards).not.toHaveBeenCalled();
});

it('does not scan on another network or after page close', async () => {
  const testSource = source();
  testSource.isCurrent = () => false;
  await backfillWalletBadges(testSource);
  expect(testSource.readAwards).toHaveBeenCalledTimes(1);
  expect(testSource.readTransactions).not.toHaveBeenCalled();
});

it('does not save an award if the page closes during the history read', async () => {
  const testSource = source();
  testSource.readTransactions = async () => {
    testSource.isCurrent = () => false;
    return [row()];
  };
  await backfillWalletBadges(testSource);
  expect(testSource.mergeAwards).not.toHaveBeenCalled();
});
