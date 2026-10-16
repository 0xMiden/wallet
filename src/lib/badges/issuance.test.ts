import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';

import { badgeCandidates } from './evidence';
import { createBadgeIssuer, type BadgeIssuanceSource } from './issuance';
import { readEarnedBadges, type BadgeId } from './types';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const base = (patch: Partial<ITransaction> = {}): ITransaction => ({
  id: 'send',
  type: 'send',
  accountId: 'account-a_tag',
  secondaryAccountId: 'recipient',
  faucetId: 'coin-a',
  amount: 10n,
  status: ITransactionStatus.Completed,
  transactionId: hash(1),
  initiatedAt: 1,
  displayIcon: 'SEND',
  badgeNetwork: 'mainnet',
  submitEvidence: [{ attemptId: 'claim', capturedAt: 1, source: 'stage', transactionId: hash(1), initialNonce: '4' }],
  ...patch
});
const deposit = (phase = 'received') =>
  base({
    id: 'deposit',
    type: 'bridged-receive',
    extraInputs: { phase, provider: 'epoch', midenNoteId: 'note-deposit' }
  });
const depositClaim = () =>
  base({
    id: 'deposit-claim',
    type: 'consume',
    noteIds: ['note-deposit'],
    consumedNotes: [{ id: 'note-deposit', senderAddress: 'bridge', faucetId: 'coin-a', amount: 10n }]
  });
const swap = () =>
  base({ id: 'swap', type: 'swap', extraInputs: { requestedAmount: 100n, requestedFaucetId: 'coin-b', orderId: '7' } });
const fill = (n: number, amount = 50n) =>
  base({
    id: `fill-${n}`,
    type: 'consume',
    transactionId: hash(n + 1),
    submitEvidence: [
      { attemptId: 'claim', capturedAt: 1, source: 'stage', transactionId: hash(n + 1), initialNonce: String(n + 4) }
    ],
    noteIds: [`payback-${n}`],
    faucetId: 'coin-b',
    amount,
    extraInputs: { swapOrderTxId: 'swap', swapSettleKind: 'settle' }
  });

function harness(rows: ITransaction[] = [base()]) {
  let awards: BadgeId[] = [];
  const source: BadgeIssuanceSource = {
    accounts: () => ['account-a', 'account-b'],
    isMainnet: () => true,
    readTransactions: jest.fn(async () => rows),
    isCommitted: jest.fn(async () => true),
    isBalanceReflected: jest.fn(() => true),
    isFilledApprovedSwap: jest.fn(async () => true),
    readAwards: jest.fn(async () => awards),
    mergeAwards: jest.fn(async (newAwards, current) => {
      if (current()) awards = readEarnedBadges([...awards, ...newAwards]);
    }),
    reportError: jest.fn()
  };
  return { source, issuer: createBadgeIssuer(source), awards: () => awards };
}

describe('verified wallet-wide badge issuance', () => {
  it('does nothing after stop, including a later timer refresh', async () => {
    const h = harness();
    h.issuer.stop();
    await h.issuer.refresh();
    expect(h.source.readTransactions).not.toHaveBeenCalled();
  });
  it('checks the wallet again immediately before each chain read', async () => {
    const h = harness();
    let reads = 0;
    h.source.accounts = () => (++reads >= 4 ? ['new-wallet'] : ['account-a', 'account-b']);
    await h.issuer.refresh();
    expect(h.source.isCommitted).not.toHaveBeenCalled();
  });
  it('coalesces overlapping DB wake-ups without issuing twice', async () => {
    const h = harness();
    h.source.isCommitted = async () => {
      void h.issuer.refresh();
      return true;
    };
    await h.issuer.refresh();
    expect(h.awards()).toEqual(['first-send']);
    expect(h.source.mergeAwards).toHaveBeenCalledTimes(1);
  });
  it('accepts only known, deduplicated identifiers from persistent storage', () => {
    expect(readEarnedBadges(null)).toEqual([]);
    expect(readEarnedBadges({ badge: 'first-send' })).toEqual([]);
    expect(readEarnedBadges(['first-send', 'first-send', 'unknown', 3])).toEqual(['first-send']);
  });
  it('does not issue when completion is cancelled during confirmation', async () => {
    const h = harness();
    h.source.isCommitted = async () => {
      jest.mocked(h.source.readTransactions).mockResolvedValue([base({ status: ITransactionStatus.Failed })]);
      return true;
    };
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
  });
  it('does not publish an award on failed persistence, and retries it later', async () => {
    const h = harness();
    jest.mocked(h.source.mergeAwards).mockRejectedValueOnce(new Error('storage unavailable'));
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
    await h.issuer.refresh();
    expect(h.awards()).toEqual(['first-send']);
  });
  it('waits for actual chain confirmation, even when the local row says Completed', async () => {
    const h = harness();
    jest.mocked(h.source.isCommitted).mockResolvedValueOnce(false);
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
    await h.issuer.refresh();
    expect(h.awards()).toEqual(['first-send']);
  });
  it('shares the first award across all wallet accounts and deduplicates replays', async () => {
    const h = harness([base({ accountId: 'account-b' }), base({ id: 'retry', accountId: 'account-b' })]);
    await h.issuer.refresh();
    await h.issuer.refresh();
    expect(h.awards()).toEqual(['first-send']);
    expect(h.source.mergeAwards).toHaveBeenCalledTimes(1);
  });
  it.each([
    ITransactionStatus.Queued,
    ITransactionStatus.GeneratingTransaction,
    ITransactionStatus.Failed,
    ITransactionStatus.Unconfirmed
  ])('does not issue for non-completed status %s', async status => {
    const h = harness([base({ status })]);
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
  });
  it.each([undefined, 'testnet', 'devnet', 'localnet'])(
    'does not relabel %s history as Mainnet',
    async badgeNetwork => {
      const h = harness([base({ badgeNetwork })]);
      await h.issuer.refresh();
      expect(h.awards()).toEqual([]);
    }
  );
  it.each<Partial<ITransaction>>([
    { accountId: 'another-wallet' },
    { restoredFromBackup: true },
    { recovered: true },
    { amount: 0n },
    { amount: -1n },
    { transactionId: undefined },
    { transactionId: 'not-a-chain-id' },
    { secondaryAccountId: 'account-a' },
    { secondaryAccountId: 'account-b_tag' },
    { dappOrigins: ['https://app.example'] }
  ])('rejects unsupported send evidence %s', async patch => {
    const h = harness([base(patch)]);
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
  });
  it('does no evidence reads on a non-Mainnet runtime', async () => {
    const h = harness();
    h.source.isMainnet = () => false;
    await h.issuer.refresh();
    expect(h.source.readTransactions).not.toHaveBeenCalled();
  });
  it('reuses persistent awards on restart without duplicating a grant', async () => {
    const h = harness();
    await h.issuer.refresh();
    const restarted = createBadgeIssuer(h.source);
    await restarted.refresh();
    expect(h.awards()).toEqual(['first-send']);
    expect(h.source.mergeAwards).toHaveBeenCalledTimes(1);
  });
  it('retries unavailable evidence instead of treating an error as success', async () => {
    const h = harness();
    jest.mocked(h.source.isCommitted).mockRejectedValueOnce(new Error('offline'));
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
    expect(h.source.reportError).toHaveBeenCalledTimes(1);
    await h.issuer.refresh();
    expect(h.awards()).toEqual(['first-send']);
  });
  it.each(['stop', 'invalidate'] as const)('does not commit an in-flight award after %s', async action => {
    const h = harness();
    h.source.isCommitted = async () => {
      h.issuer[action]();
      return true;
    };
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
  });
  it('rejects a stale result after a wallet or network switch', async () => {
    const h = harness();
    h.source.isCommitted = async () => {
      h.source.accounts = () => ['new-wallet'];
      return true;
    };
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
    const other = harness();
    other.source.isCommitted = async () => {
      other.source.isMainnet = () => false;
      return true;
    };
    await other.issuer.refresh();
    expect(other.awards()).toEqual([]);
  });
  it('stops rescanning transaction blobs once all supported badges are earned', async () => {
    const h = harness();
    h.source.readAwards = async () => ['first-send', 'first-deposit', 'first-swap'];
    await h.issuer.refresh();
    expect(h.source.readTransactions).not.toHaveBeenCalled();
  });
});

describe('deposit completion evidence', () => {
  it('keeps a confirmed consume locked until its balance snapshot has landed', async () => {
    const h = harness([deposit(), depositClaim()]);
    jest.mocked(h.source.isBalanceReflected).mockReturnValue(false);
    await h.issuer.refresh();
    expect(h.source.isCommitted).not.toHaveBeenCalled();
    expect(h.awards()).toEqual([]);
    expect(h.source.isBalanceReflected).toHaveBeenCalledWith({
      accountId: 'account-a_tag',
      faucetId: 'coin-a',
      minimumNonce: '5'
    });
    jest.mocked(h.source.isBalanceReflected).mockReturnValue(true);
    await h.issuer.refresh();
    expect(h.awards()).toEqual(['first-deposit']);
  });
  it('rechecks displayed balance evidence after waiting for the storage lock', async () => {
    const h = harness([deposit(), depositClaim()]);
    h.source.mergeAwards = async (_ids, current) => {
      jest.mocked(h.source.isBalanceReflected).mockReturnValue(false);
      expect(current()).toBe(false);
    };
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
  });
  it.each([
    undefined,
    [],
    [{ attemptId: 'a', capturedAt: 1, source: 'stage' as const, transactionId: hash(1), initialNonce: '-1' }],
    [{ attemptId: 'a', capturedAt: 1, source: 'stage' as const, transactionId: hash(2), initialNonce: '4' }],
    [{ attemptId: 'a', capturedAt: 1, source: 'stage' as const, transactionId: hash(1) }],
    [
      { attemptId: 'a', capturedAt: 1, source: 'stage' as const, transactionId: hash(1), initialNonce: '4' },
      { attemptId: 'b', capturedAt: 1, source: 'stage' as const, transactionId: hash(1), initialNonce: '5' }
    ]
  ])('rejects a claim with missing, unrelated, invalid or conflicting nonce evidence %s', async submitEvidence => {
    const h = harness([deposit(), { ...depositClaim(), submitEvidence }]);
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
  });
  it.each(['submitting', 'delivering', 'ready', 'failed'])('does not award for bridge phase %s', async phase => {
    const h = harness([deposit(phase), depositClaim()]);
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
  });
  it('requires an exact completed claim of the bridge output before granting First Deposit', async () => {
    const h = harness([deposit()]);
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
    jest.mocked(h.source.readTransactions).mockResolvedValue([deposit(), depositClaim()]);
    await h.issuer.refresh();
    expect(h.awards()).toEqual(['first-deposit']);
  });
  it.each<Partial<ITransaction>>([
    { amount: 9n },
    { accountId: 'account-b' },
    { status: ITransactionStatus.Failed },
    { restoredFromBackup: true },
    { transactionId: hash(9) },
    { consumedNotes: [] }
  ])('does not credit mismatched bridge output %s', async patch => {
    const h = harness([deposit(), { ...depositClaim(), ...patch }]);
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
  });
});

describe('fully settled swap evidence', () => {
  it('waits for every claimed fill to be reflected in the displayed account balances', async () => {
    const h = harness([swap(), fill(1), fill(2)]);
    jest.mocked(h.source.isBalanceReflected).mockImplementation(requirement => requirement.minimumNonce === '6');
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
    jest.mocked(h.source.isBalanceReflected).mockReturnValue(true);
    await h.issuer.refresh();
    expect(h.awards()).toEqual(['first-swap']);
  });
  it.each([
    { requestedAmount: 0n, requestedFaucetId: 'coin-b', orderId: '7' },
    { requestedAmount: 100n, requestedFaucetId: undefined, orderId: '7' },
    { requestedAmount: 100n, requestedFaucetId: 'coin-b' },
    { requestedAmount: 100n, requestedFaucetId: 'coin-b', orderId: '7', reclaimedAt: 9 }
  ])('refuses incomplete or reclaimed order metadata %s', async extraInputs => {
    const h = harness([{ ...swap(), extraInputs }, fill(1), fill(2)]);
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
  });
  it('rejects a claim of the wrong asset or one without identifiable notes', () => {
    expect(badgeCandidates([swap(), { ...fill(1, 100n), faucetId: 'wrong' }], ['account-a'])).toEqual([]);
    expect(
      badgeCandidates([swap(), { ...fill(1, 100n), noteIds: undefined, noteId: undefined }], ['account-a'])
    ).toEqual([]);
  });
  it('accepts legacy single-note fields for a new, provenance-stamped settlement', async () => {
    const h = harness([swap(), { ...fill(1, 100n), noteIds: undefined, noteId: 'single-note' }]);
    await h.issuer.refresh();
    expect(h.awards()).toEqual(['first-swap']);
  });
  it('does not award for order placement or only a partial payback', async () => {
    for (const rows of [[swap()], [swap(), fill(1)]]) {
      const h = harness(rows);
      await h.issuer.refresh();
      expect(h.awards()).toEqual([]);
    }
  });
  it('requires full claimed output, every claim committed, and an approved fully-filled lineage', async () => {
    const h = harness([swap(), fill(1), fill(2)]);
    jest.mocked(h.source.isFilledApprovedSwap).mockResolvedValueOnce(false);
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
    jest.mocked(h.source.isCommitted).mockImplementation(async id => id !== hash(3));
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
    jest.mocked(h.source.isCommitted).mockResolvedValue(true);
    await h.issuer.refresh();
    expect(h.awards()).toEqual(['first-swap']);
  });
  it('does not count overlapping notes or replayed consumes toward a full fill', () => {
    expect(badgeCandidates([swap(), fill(1), { ...fill(2), noteIds: ['payback-1'] }], ['account-a'])).toEqual([]);
    expect(badgeCandidates([swap(), fill(1), { ...fill(2), transactionId: hash(2) }], ['account-a'])).toEqual([]);
  });
  it('does not award cancelled or partially-filled-then-reclaimed orders', async () => {
    const h = harness([
      swap(),
      fill(1),
      fill(2),
      { ...fill(3), extraInputs: { swapOrderTxId: 'swap', swapSettleKind: 'reclaim' } }
    ]);
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
  });
  it('does not award unsupported receive, recovery or miniapp events', async () => {
    const h = harness([base({ type: 'consume' }), base({ type: 'execute' })]);
    await h.issuer.refresh();
    expect(h.awards()).toEqual([]);
  });
});
