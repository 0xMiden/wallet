// Real Dexie: the dedup lives in a rw transaction over the noteId/noteIds indexes.
import * as Repo from 'lib/miden/repo';

import { ConsumeTransaction, ISubmitEvidence, ITransactionStatus, Transaction } from '../db/types';
import { assessOutgoingSpendingLimitDetails } from '../spending-limits/queue';
import { SpendingLimitAuthorizationRequiredError, spendsDigest } from '../spending-limits/types';
import { resolveSpendsUsd } from '../spending-limits/valuation';
import { ConsumableNote, NoteTypeEnum } from '../types';

jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isExtension: () => false }));
jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: () => false,
  getOrCreateMultisigService: jest.fn()
}));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getActiveOverride: () => null,
  isNoteTransportConfigured: () => false,
  getEffectiveNetworkName: () => 'testnet'
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: async () => 'native-faucet',
  getVerificationBaseFee: async () => null
}));
jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: {
    getInputNoteSummary: async () => ({ noteType: undefined, assets: null }),
    getAccount: async () => null
  }
}));
jest.mock('../spending-limits/valuation', () => ({ resolveSpendsUsd: jest.fn() }));
jest.mock('../activity/notes', () => ({ queueNoteImport: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  initiateGcPurchaseTransaction,
  initiateConsumeNotesTransaction,
  initiateConsumeTransaction,
  initiateConsumeTransactionFromId,
  initiatePswapReclaimTransaction,
  queueConsumeNotes
} = require('./initiate');

const ACCOUNT = 'mtst1account';
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const note = (id: string): ConsumableNote => ({
  id,
  faucetId: 'native-faucet',
  amount: '1000000',
  senderAddress: 'mtst1sender',
  isBeingClaimed: false,
  type: NoteTypeEnum.Public
});
const checkable: ISubmitEvidence = {
  attemptId: 'a1',
  capturedAt: Math.floor(Date.now() / 1000),
  source: 'stage',
  transactionId: hex(1),
  initialCommitment: hex(2),
  finalCommitment: hex(3),
  initialNonce: '1',
  outputNoteIds: [],
  nullifiers: [hex(4)],
  refBlock: 10,
  refBlockCommitment: hex(5)
};
const ORIGIN = 'https://dapp.example';
const OTHER = 'https://other.example';

const existingClaim = async (
  status: ITransactionStatus,
  submitEvidence: ISubmitEvidence[],
  extra: { neverCommittedAt?: number } = {}
) => {
  const row = new ConsumeTransaction(ACCOUNT, [note('n1')], false);
  await Repo.transactions.put({ ...row, status, submitEvidence, completedAt: 1, ...extra });
  return row.id;
};

beforeEach(async () => {
  await Repo.transactions.clear();
  await Repo.spendingLimits.clear();
  jest.mocked(resolveSpendsUsd).mockReset();
});

describe('the consume dedup and held notes (#1081)', () => {
  it.each([ITransactionStatus.Unconfirmed, ITransactionStatus.Failed])(
    'a claim in status %s that holds its notes blocks a second claim of them',
    async status => {
      const held = await existingClaim(status, [checkable]);
      const id = await initiateConsumeNotesTransaction(ACCOUNT, [note('n1')], false, true);
      expect(id).toBe(held);
      expect(await Repo.transactions.count()).toBe(1);
    }
  );

  it.each<[string, ISubmitEvidence[], { neverCommittedAt?: number }]>([
    ['whose only entry is evidence-less', [{ attemptId: 'x', capturedAt: 1, source: 'end' }], {}],
    ['whose only entry is unresolvable', [{ ...checkable, verdict: 'unresolvable' }], {}],
    ['proven never committed', [{ ...checkable, verdict: 'never-committed' }], { neverCommittedAt: 5 }]
  ])('an Unconfirmed claim %s holds nothing, so a fresh claim is admitted', async (_label, entries, extra) => {
    await existingClaim(ITransactionStatus.Unconfirmed, entries, extra);
    await initiateConsumeNotesTransaction(ACCOUNT, [note('n1')], false, true);
    expect(await Repo.transactions.count()).toBe(2);
  });
});

describe('the consume dedup and the notes a dApp transaction will consume', () => {
  const dappTransaction = async (
    status: ITransactionStatus,
    extra: { submitEvidence?: ISubmitEvidence[]; completedAt?: number; type?: 'consume' } = {}
  ) => {
    const row = new Transaction(ACCOUNT, new Uint8Array([1]));
    await Repo.transactions.put({ ...row, heldNoteIds: ['n1'], status, ...extra });
    return row.id;
  };
  const secondsAgo = (seconds: number) => Math.floor(Date.now() / 1000) - seconds;

  it.each([ITransactionStatus.Queued, ITransactionStatus.GeneratingTransaction])(
    'a dApp transaction in status %s that will consume the note blocks a claim of it',
    async status => {
      const holder = await dappTransaction(status);
      const id = await initiateConsumeNotesTransaction(ACCOUNT, [note('n1')], false, true);
      expect(id).toBe(holder);
      expect(await Repo.transactions.count()).toBe(1);
    }
  );

  it('a dApp transaction awaiting its verdict blocks a claim of its note', async () => {
    const holder = await dappTransaction(ITransactionStatus.Unconfirmed, { submitEvidence: [checkable] });
    expect(await initiateConsumeNotesTransaction(ACCOUNT, [note('n1')], false, true)).toBe(holder);
    expect(await Repo.transactions.count()).toBe(1);
  });

  it('a dApp transaction that completed moments ago still holds its note while a sync reads the nullifier', async () => {
    const holder = await dappTransaction(ITransactionStatus.Completed, { completedAt: secondsAgo(10) });
    expect(await initiateConsumeNotesTransaction(ACCOUNT, [note('n1')], false, true)).toBe(holder);
    expect(await Repo.transactions.count()).toBe(1);
  });

  it('a completed dApp transaction its completion re-typed as a claim still holds its note', async () => {
    const holder = await dappTransaction(ITransactionStatus.Completed, {
      completedAt: secondsAgo(10),
      type: 'consume'
    });
    expect(await initiateConsumeNotesTransaction(ACCOUNT, [note('n1')], false, true)).toBe(holder);
    expect(await Repo.transactions.count()).toBe(1);
  });

  it('a dApp transaction that completed before the grace window holds nothing, so the claim is queued', async () => {
    await dappTransaction(ITransactionStatus.Completed, { completedAt: secondsAgo(3600) });
    await initiateConsumeNotesTransaction(ACCOUNT, [note('n1')], false, true);
    expect(await Repo.transactions.count()).toBe(2);
  });

  it('a dApp transaction that failed holds nothing however recently, so the claim is queued', async () => {
    await dappTransaction(ITransactionStatus.Failed, { completedAt: secondsAgo(10) });
    await initiateConsumeNotesTransaction(ACCOUNT, [note('n1')], false, true);
    expect(await Repo.transactions.count()).toBe(2);
  });

  it('a live dApp transaction written before held notes were recorded holds nothing', async () => {
    await Repo.transactions.put(new Transaction(ACCOUNT, new Uint8Array([1]), ['n1']));
    await initiateConsumeNotesTransaction(ACCOUNT, [note('n1')], false, true);
    expect(await Repo.transactions.count()).toBe(2);
  });

  it('queues the notes the dApp transaction does not hold and reports the holder for the one it does', async () => {
    const holder = await dappTransaction(ITransactionStatus.Queued);
    const { committedId, coveringTxIdByNoteId } = await queueConsumeNotes(
      ACCOUNT,
      [note('n1'), note('n2')],
      false,
      true
    );
    expect(coveringTxIdByNoteId.get('n1')).toBe(holder);
    expect(coveringTxIdByNoteId.get('n2')).toBe(committedId);
    expect((await Repo.transactions.get(committedId))?.noteIds).toEqual(['n2']);
  });
});

describe("a dApp's consume request for a note another transaction holds", () => {
  const putDappTransaction = async (overrides: {
    status: ITransactionStatus;
    completedAt?: number;
    type?: 'consume';
  }) => {
    const row = new Transaction(ACCOUNT, new Uint8Array([1]));
    await Repo.transactions.put({ ...row, heldNoteIds: ['n1'], ...overrides });
    return row.id;
  };

  it('is refused, never answered with the dApp transaction holding the note', async () => {
    const holder = await putDappTransaction({ status: ITransactionStatus.Queued });
    const answer = initiateConsumeTransactionFromId(ACCOUNT, 'n1', false, true, ORIGIN);
    await expect(answer).rejects.toThrow('This note is being consumed by another transaction');
    expect(await Repo.transactions.count()).toBe(1);
    expect(await Repo.transactions.get(holder)).toBeDefined();
  });

  it('is refused when the holder is a completed dApp transaction its completion re-typed as a consume', async () => {
    await putDappTransaction({
      status: ITransactionStatus.Completed,
      completedAt: Math.floor(Date.now() / 1000) - 10,
      type: 'consume'
    });
    await expect(initiateConsumeTransactionFromId(ACCOUNT, 'n1', false, true, ORIGIN)).rejects.toThrow(
      'This note is being consumed by another transaction'
    );
  });

  it('is answered with a claim that holds the note, as before', async () => {
    const claim = await existingClaim(ITransactionStatus.Queued, []);
    expect(await initiateConsumeTransactionFromId(ACCOUNT, 'n1', false, true, ORIGIN)).toBe(claim);
  });

  it("leaves the wallet's own claim pointing at the dApp transaction that holds the note", async () => {
    const holder = await putDappTransaction({ status: ITransactionStatus.Queued });
    expect(await initiateConsumeTransactionFromId(ACCOUNT, 'n1', false, true)).toBe(holder);
  });
});

describe('the origins a dApp consume request lets wait on its answer (#1416)', () => {
  const origins = async (id: string) => (await Repo.transactions.get(id))?.dappOrigins;

  it('a fresh row lists the requesting origin in the write that creates it', async () => {
    const add = jest.spyOn(Repo.transactions, 'add');
    try {
      const id = await initiateConsumeTransactionFromId(ACCOUNT, 'n1', false, true, ORIGIN);
      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith(expect.objectContaining({ id, dappOrigins: [ORIGIN] }));
      expect(await origins(id)).toEqual([ORIGIN]);
    } finally {
      add.mockRestore();
    }
  });

  it('a wallet claim the dedup answered with gains the origin', async () => {
    const claim = await existingClaim(ITransactionStatus.Queued, []);
    expect(await initiateConsumeTransactionFromId(ACCOUNT, 'n1', false, true, ORIGIN)).toBe(claim);
    expect(await origins(claim)).toEqual([ORIGIN]);
    expect(await Repo.transactions.count()).toBe(1);
  });

  it("another origin's consume row the dedup answered with lists both origins", async () => {
    const row = new ConsumeTransaction(ACCOUNT, [note('n1')], false);
    await Repo.transactions.put({ ...row, dappOrigins: [OTHER] });
    expect(await initiateConsumeTransactionFromId(ACCOUNT, 'n1', false, true, ORIGIN)).toBe(row.id);
    expect(await origins(row.id)).toEqual([OTHER, ORIGIN]);
  });

  it('the same origin asking again is listed once', async () => {
    const first = await initiateConsumeTransactionFromId(ACCOUNT, 'n1', false, true, ORIGIN);
    expect(await initiateConsumeTransactionFromId(ACCOUNT, 'n1', false, true, ORIGIN)).toBe(first);
    expect(await origins(first)).toEqual([ORIGIN]);
  });

  it('a holder the request is refused with gains no origin', async () => {
    const holder = new Transaction(ACCOUNT, new Uint8Array([1]));
    await Repo.transactions.put({ ...holder, heldNoteIds: ['n1'], status: ITransactionStatus.Queued });
    await expect(initiateConsumeTransactionFromId(ACCOUNT, 'n1', false, true, ORIGIN)).rejects.toThrow(
      'This note is being consumed by another transaction'
    );
    expect(await origins(holder.id)).toBeUndefined();
  });

  it("the wallet's own claims list no origin", async () => {
    const fromId = await initiateConsumeTransactionFromId(ACCOUNT, 'n1', false, true);
    const batch = await initiateConsumeNotesTransaction(ACCOUNT, [note('n2')], false, true);
    expect(await origins(fromId)).toBeUndefined();
    expect(await origins(batch)).toBeUndefined();
  });
});

// A failed claim's report names what queued its row, read from the row itself, so it is stamped where the row is made.
describe('what queued a consume row', () => {
  const stamp = async (id: string) => (await Repo.transactions.get(id))?.consumeEntryPoint;

  it('stamps each row with the entry point its queue call names', async () => {
    expect(await stamp(await initiateConsumeTransaction(ACCOUNT, note('a'), false, true, 'claim'))).toBe('claim');
    const many = await queueConsumeNotes(
      ACCOUNT,
      [note('b'), note('c')],
      false,
      true,
      undefined,
      undefined,
      'claim_all'
    );
    expect(await stamp(many.committedId)).toBe('claim_all');
    const auto = await initiateConsumeNotesTransaction(ACCOUNT, [note('d')], false, false, true, null, 'auto_consume');
    expect(await stamp(auto)).toBe('auto_consume');
    expect(await stamp(await initiateConsumeTransactionFromId(ACCOUNT, 'e', false, true, ORIGIN, 'dapp'))).toBe('dapp');
    const reclaim = await initiateConsumeTransactionFromId(ACCOUNT, 'f', false, true, undefined, 'bridge_reclaim');
    expect(await stamp(reclaim)).toBe('bridge_reclaim');
  });

  it('stamps a zero-fill PSWAP reclaim as swap settlement, and a row queued without an entry point with none', async () => {
    const reclaim = await initiatePswapReclaimTransaction(ACCOUNT, note('g'), new Uint8Array([1]), 'swap-row', false);
    expect(await stamp(reclaim)).toBe('swap_settlement');
    const unnamed = await initiateConsumeTransaction(ACCOUNT, note('h'), false, true);
    expect(await Repo.transactions.get(unnamed)).toBeDefined();
    expect(await stamp(unnamed)).toBeUndefined();
  });
});

describe('GC purchase spending-limit admission', () => {
  const quote = {
    saleNoteId: hex(301),
    sellerAccountId: 'seller',
    payFaucetId: 'native-faucet',
    fillAmount: 60_000_000n,
    gcFaucetId: 'gc-faucet',
    expectedAmount: 60_000_000_000n
  };
  const saveLimit = () =>
    Repo.spendingLimits.put({
      accountId: ACCOUNT,
      limit: '50000000',
      revision: 'gc-policy-1',
      createdAt: 1,
      updatedAt: 1
    });
  const authorization = () => ({
    kind: 'usd' as const,
    id: 'gc-authorization',
    accountId: ACCOUNT,
    usdAmount: 60_000_000n,
    spendsDigest: spendsDigest([{ faucetId: quote.payFaucetId, amount: quote.fillAmount }]),
    revision: 'gc-policy-1',
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 60
  });

  it('refuses an over-cap purchase before inserting a consume row', async () => {
    await saveLimit();
    jest.mocked(resolveSpendsUsd).mockResolvedValue(60_000_000n);
    await expect(initiateGcPurchaseTransaction(ACCOUNT, quote, false)).rejects.toBeInstanceOf(
      SpendingLimitAuthorizationRequiredError
    );
    expect(await Repo.transactions.count()).toBe(0);
  });

  it('stamps the authorized pay leg and deduplicates a repeated tap', async () => {
    await saveLimit();
    jest.mocked(resolveSpendsUsd).mockResolvedValue(60_000_000n);
    const auth = authorization();
    const id = await initiateGcPurchaseTransaction(ACCOUNT, quote, false, auth);
    expect(await Repo.transactions.get(id)).toMatchObject({
      spentUsd: 60_000_000n,
      spendingLimitAuthorizationId: auth.id
    });
    expect(resolveSpendsUsd).toHaveBeenCalledWith(
      [{ faucetId: 'native-faucet', amount: 60_000_000n }],
      expect.any(Number)
    );
    const inserted = await Repo.transactions.get(id);
    expect(await initiateGcPurchaseTransaction(ACCOUNT, quote, false, auth)).toBe(id);
    expect(await Repo.transactions.count()).toBe(1);
    expect(await Repo.transactions.get(id)).toEqual(inserted);
    expect(resolveSpendsUsd).toHaveBeenCalledTimes(1);
  });

  it('does not redeem the same authorization for a fresh retry after failure', async () => {
    await saveLimit();
    jest.mocked(resolveSpendsUsd).mockResolvedValue(60_000_000n);
    const auth = authorization();
    const id = await initiateGcPurchaseTransaction(ACCOUNT, quote, false, auth);
    await Repo.transactions.update(id, { status: ITransactionStatus.Failed });
    await expect(initiateGcPurchaseTransaction(ACCOUNT, quote, false, auth)).rejects.toBeInstanceOf(
      SpendingLimitAuthorizationRequiredError
    );
    expect(await Repo.transactions.count()).toBe(1);
  });

  it('includes a queued purchase when assessing the next outgoing spend', async () => {
    await saveLimit();
    jest.mocked(resolveSpendsUsd).mockResolvedValueOnce(40_000_000n).mockResolvedValueOnce(20_000_000n);
    await initiateGcPurchaseTransaction(ACCOUNT, { ...quote, fillAmount: 40_000_000n }, false);
    const details = await assessOutgoingSpendingLimitDetails({
      accountId: ACCOUNT,
      spends: [{ faucetId: 'native-faucet', amount: 20_000_000n }]
    });
    expect(details?.assessment.breach).toMatchObject({ spent: 40_000_000n, proposedTotal: 60_000_000n });
  });

  it('does not value or stamp an ordinary incoming consume', async () => {
    await saveLimit();
    const { committedId: id } = await queueConsumeNotes(ACCOUNT, [note('ordinary-incoming')], false, true);
    expect(await Repo.transactions.get(id)).toMatchObject({ type: 'consume' });
    expect((await Repo.transactions.get(id))?.spentUsd).toBeUndefined();
    expect(resolveSpendsUsd).not.toHaveBeenCalled();
  });

  it('enforces a cap created between the price probe and the insert lock', async () => {
    await saveLimit();
    jest.mocked(resolveSpendsUsd).mockResolvedValue(60_000_000n);
    const read = jest.spyOn(Repo.spendingLimits, 'get').mockResolvedValueOnce(undefined);
    try {
      await expect(initiateGcPurchaseTransaction(ACCOUNT, quote, false)).rejects.toBeInstanceOf(
        SpendingLimitAuthorizationRequiredError
      );
      expect(await Repo.transactions.count()).toBe(0);
      expect(resolveSpendsUsd).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });

  it('keeps the no-cap purchase path independent of pricing', async () => {
    const id = await initiateGcPurchaseTransaction(ACCOUNT, quote, false);
    expect(await Repo.transactions.get(id)).toMatchObject({ type: 'consume' });
    expect(resolveSpendsUsd).not.toHaveBeenCalled();
  });
});
