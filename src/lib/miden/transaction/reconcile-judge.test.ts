import { judgeSubmitEvidence, RowJudgement } from './reconcile-judge';
import { AccountState, NodeReads } from './reconcile-reads';
import { ISubmitEvidence, ITransaction, ITransactionStatus } from '../db/types';

jest.mock('../sdk/helpers', () => ({
  sameWalletAccountId: (a: string, b: string) => a.split('_')[0] === b.split('_')[0]
}));

const NOW = 1_800_000_000;
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const HEADER = hex(1);
const INITIAL = hex(10);
const FINAL = hex(11);
const OTHER = hex(12);
const NOTE = hex(20);
const NULLIFIER = hex(30);

interface FakeChain {
  tip: AccountState;
  headers?: Record<number, string | undefined>;
  history?: Record<number, AccountState | 'pruned'>;
  notes?: Record<string, number>;
  spent?: Record<string, number>;
  tipFails?: boolean;
  notesFail?: boolean;
  nullifierFails?: boolean;
  /** How long a read pinned to a block takes: one given less time than this times out. */
  readTakesMs?: number;
  /** Return a different header from the Nth header read on: the endpoint moved mid-pass. */
  headerChangesAfter?: number;
  /** The tip once the headers changed: the chain behind the same URL was swapped. */
  tipAfterChange?: AccountState;
}

const chain = (fake: FakeChain): NodeReads & { calls: string[] } => {
  const calls: string[] = [];
  let headerReads = 0;
  const swapped = () => fake.headerChangesAfter !== undefined && headerReads > fake.headerChangesAfter;
  return {
    calls,
    blockCommitment: async block => {
      calls.push(`header:${block}`);
      headerReads += 1;
      if (swapped()) return OTHER;
      return fake.headers === undefined ? HEADER : fake.headers[block];
    },
    account: async (_id, atBlock, timeoutMs) => {
      calls.push(atBlock === undefined ? 'tip' : `account@${atBlock}`);
      if (atBlock === undefined)
        return fake.tipFails
          ? { ok: false, pruned: false, timedOut: false }
          : { ok: true, state: swapped() ? (fake.tipAfterChange ?? fake.tip) : fake.tip };
      if (fake.readTakesMs !== undefined && fake.readTakesMs > timeoutMs)
        return { ok: false, pruned: false, timedOut: true };
      const state = fake.history?.[atBlock];
      if (state === 'pruned') return { ok: false, pruned: true, timedOut: false };
      return state === undefined ? { ok: false, pruned: false, timedOut: false } : { ok: true, state };
    },
    noteInclusions: async ids => {
      calls.push('notes');
      if (fake.notesFail) return undefined;
      const found = new Map<string, number>();
      for (const id of ids) {
        const block = fake.notes?.[id];
        if (block !== undefined) found.set(id, block);
      }
      return found;
    },
    nullifierHeight: async nullifier => {
      calls.push(`nullifier:${nullifier}`);
      if (fake.nullifierFails) return undefined;
      return fake.spent?.[nullifier] ?? null;
    }
  };
};

const entry = (overrides: Partial<ISubmitEvidence> = {}): ISubmitEvidence => ({
  attemptId: 'a1',
  capturedAt: NOW - 60,
  source: 'stage',
  transactionId: hex(2),
  initialCommitment: INITIAL,
  finalCommitment: FINAL,
  initialNonce: '5',
  outputNoteIds: [NOTE],
  nullifiers: [],
  refBlock: 100,
  refBlockCommitment: HEADER,
  expirationBlock: 700,
  ...overrides
});

const row = (id: string, overrides: Partial<ITransaction> = {}): ITransaction => ({
  id,
  type: 'send',
  accountId: 'mtst1acct_s',
  status: ITransactionStatus.Unconfirmed,
  initiatedAt: NOW - 120,
  displayIcon: 'SEND',
  submitEvidence: [entry()],
  ...overrides
});

const judge = (target: ITransaction, fake: FakeChain, others: ITransaction[] = []): Promise<RowJudgement> =>
  judgeSubmitEvidence(target, { node: chain(fake), accountRows: [target, ...others], nowSec: NOW, cadenceMs: 3_000 });

const resultOf = async (target: ITransaction, fake: FakeChain, others: ITransaction[] = []) =>
  (await judge(target, fake, others)).entries[0]?.result;

// A consume: no output notes, one nullifier.
const consumeEntry = (overrides: Partial<ISubmitEvidence> = {}) =>
  entry({ outputNoteIds: [], nullifiers: [NULLIFIER], ...overrides });
// An execute that only moved the vault: no notes, no nullifiers.
const bareEntry = (overrides: Partial<ISubmitEvidence> = {}) =>
  entry({ outputNoteIds: [], nullifiers: [], fromExecute: true, ...overrides });

describe('row 1: the account reached E.final and E has no marks', () => {
  it('lands, never binds', async () => {
    const target = row('t', { type: 'execute', submitEvidence: [bareEntry()] });
    const judged = await judge(target, { tip: { blockNum: 150, commitment: FINAL, nonce: '6' } });
    expect(judged.entries[0]).toMatchObject({ result: 'landed', landingRecord: { block: 150, by: 1 } });
    expect(judged.landed?.boundTransactionId).toBeUndefined();
  });

  it('falls through when another row`s unresolved attempt records the same final commitment', async () => {
    const target = row('t', { type: 'execute', submitEvidence: [bareEntry()] });
    const twin = row('twin', {
      type: 'execute',
      status: ITransactionStatus.Failed,
      submitEvidence: [bareEntry({ attemptId: 'b', initialCommitment: OTHER })]
    });
    expect(await resultOf(target, { tip: { blockNum: 150, commitment: FINAL, nonce: '6' } }, [twin])).toBe(
      'unresolvable'
    );
  });

  it('lands when that other attempt is proven never-committed', async () => {
    const target = row('t', { type: 'execute', submitEvidence: [bareEntry()] });
    const dead = row('dead', {
      status: ITransactionStatus.Failed,
      submitEvidence: [bareEntry({ attemptId: 'b', verdict: 'never-committed' })]
    });
    expect(await resultOf(target, { tip: { blockNum: 150, commitment: FINAL, nonce: '6' } }, [dead])).toBe('landed');
  });
});

describe('row 2: an attributable output note on chain', () => {
  it('lands and binds when exactly one attempt names it', async () => {
    const judged = await judge(row('t'), { tip: { blockNum: 150, commitment: OTHER }, notes: { [NOTE]: 140 } });
    expect(judged.entries[0]).toMatchObject({ result: 'landed', landingRecord: { block: 140, by: 2 } });
    expect(judged.landed?.boundTransactionId).toBe(hex(2));
  });

  it('a copy included at or before E.refBlock is never E`s', async () => {
    expect(await resultOf(row('t'), { tip: { blockNum: 150, commitment: OTHER }, notes: { [NOTE]: 100 } })).toBe(
      'pending'
    );
  });

  it('a note another row of the account names is not attributable', async () => {
    const other = row('o', {
      status: ITransactionStatus.Completed,
      submitEvidence: [entry({ attemptId: 'b', transactionId: hex(3) })]
    });
    expect(
      await resultOf(row('t'), { tip: { blockNum: 150, commitment: OTHER }, notes: { [NOTE]: 140 } }, [other])
    ).toBe('pending');
  });

  it('an execute entry elsewhere with an unknown output list blocks every note; a send`s does not', async () => {
    const blindExecute = row('x', {
      type: 'execute',
      status: ITransactionStatus.Failed,
      submitEvidence: [{ attemptId: 'b', capturedAt: 1, source: 'end', fromExecute: true }]
    });
    expect(
      await resultOf(row('t'), { tip: { blockNum: 150, commitment: OTHER }, notes: { [NOTE]: 140 } }, [blindExecute])
    ).toBe('pending');
    const blindSend = row('s', {
      status: ITransactionStatus.Failed,
      submitEvidence: [{ attemptId: 'b', capturedAt: 1, source: 'end' }]
    });
    expect(
      await resultOf(row('t'), { tip: { blockNum: 150, commitment: OTHER }, notes: { [NOTE]: 140 } }, [blindSend])
    ).toBe('landed');
  });

  it('a retired pin elsewhere blocks nothing', async () => {
    const retired = row('x', {
      type: 'execute',
      status: ITransactionStatus.Failed,
      submitEvidence: [{ attemptId: 'b', capturedAt: 1, source: 'pin', fromExecute: true, preSubmitEnd: true }]
    });
    expect(
      await resultOf(row('t'), { tip: { blockNum: 150, commitment: OTHER }, notes: { [NOTE]: 140 } }, [retired])
    ).toBe('landed');
  });

  it('matches the account across id forms: a bare-address dApp row is the same account', async () => {
    const dapp = row('d', {
      accountId: 'mtst1acct',
      type: 'execute',
      status: ITransactionStatus.Failed,
      submitEvidence: [{ attemptId: 'b', capturedAt: 1, source: 'kill', fromExecute: true }]
    });
    expect(
      await resultOf(row('t'), { tip: { blockNum: 150, commitment: OTHER }, notes: { [NOTE]: 140 } }, [dapp])
    ).toBe('pending');
  });
});

describe('row 3: E`s nullifier spent at h with the account at E.final there', () => {
  const consume = (overrides: Partial<ITransaction> = {}) =>
    row('t', { type: 'consume', submitEvidence: [consumeEntry()], ...overrides });

  it('lands and binds', async () => {
    const judged = await judge(consume(), {
      tip: { blockNum: 160, commitment: OTHER },
      spent: { [NULLIFIER]: 150 },
      history: { 150: { blockNum: 150, commitment: FINAL } }
    });
    expect(judged.entries[0]).toMatchObject({ result: 'landed', landingRecord: { block: 150, by: 3 } });
    expect(judged.landed?.boundTransactionId).toBe(hex(2));
  });

  it('two attempts of the row from one pre-state complete it unbound; from different pre-states bind the match', async () => {
    const shared = consume({
      submitEvidence: [consumeEntry(), consumeEntry({ attemptId: 'a2', transactionId: hex(4) })]
    });
    const fake = {
      tip: { blockNum: 160, commitment: OTHER },
      spent: { [NULLIFIER]: 150 },
      history: { 150: { blockNum: 150, commitment: FINAL } }
    };
    expect((await judge(shared, fake)).landed).toMatchObject({ boundTransactionId: undefined });
    const split = consume({
      submitEvidence: [
        consumeEntry(),
        consumeEntry({ attemptId: 'a2', transactionId: hex(4), initialCommitment: OTHER, finalCommitment: hex(13) })
      ]
    });
    expect((await judge(split, fake)).landed?.boundTransactionId).toBe(hex(2));
  });

  it('lands from a recorded row-3 landing after h left the node`s history', async () => {
    const recorded = consume({ submitEvidence: [consumeEntry({ landingSeenAtBlock: 150, landingSeenBy: 3 })] });
    expect(
      await resultOf(recorded, {
        tip: { blockNum: 260, commitment: OTHER },
        spent: { [NULLIFIER]: 150 },
        history: { 150: 'pruned' }
      })
    ).toBe('landed');
  });

  it('a recorded row-3 landing skips the read at h, so a failing read there cannot hold it back', async () => {
    const recorded = consume({ submitEvidence: [consumeEntry({ landingSeenAtBlock: 150, landingSeenBy: 3 })] });
    const node = chain({ tip: { blockNum: 160, commitment: OTHER }, spent: { [NULLIFIER]: 150 }, history: {} });
    const judged = await judgeSubmitEvidence(recorded, {
      node,
      accountRows: [recorded],
      nowSec: NOW,
      cadenceMs: 3_000
    });
    expect(judged.entries[0]?.result).toBe('landed');
    expect(node.calls).not.toContain('account@150');
  });

  it('a retired attempt that left the account unchanged is no second nullifier match', async () => {
    const retired = consumeEntry({
      attemptId: 'a2',
      transactionId: hex(4),
      initialCommitment: FINAL,
      finalCommitment: FINAL,
      preSubmitEnd: true
    });
    const landed = await judge(consume({ submitEvidence: [consumeEntry(), retired] }), {
      tip: { blockNum: 160, commitment: OTHER },
      spent: { [NULLIFIER]: 150 },
      history: { 150: { blockNum: 150, commitment: FINAL } }
    });
    expect(landed.landed?.boundTransactionId).toBe(hex(2));
  });

  it('an attempt that left the account unchanged never lands through a nullifier', async () => {
    const unchanged = consume({ submitEvidence: [consumeEntry({ finalCommitment: INITIAL })] });
    expect(
      await resultOf(unchanged, { tip: { blockNum: 160, commitment: INITIAL }, spent: { [NULLIFIER]: 150 } })
    ).toBe('pending');
  });
});

describe('row 4: the account still at E.initial (or absent) at a block at or past X', () => {
  it('from the tip at b = X', async () => {
    expect(await resultOf(row('t'), { tip: { blockNum: 700, commitment: INITIAL } })).toBe('never-committed');
  });

  it('not one block earlier', async () => {
    expect(await resultOf(row('t'), { tip: { blockNum: 699, commitment: INITIAL } })).toBe('pending');
  });

  it('from the one-off read at X after the account moved', async () => {
    const fake = {
      tip: { blockNum: 720, commitment: OTHER },
      history: { 700: { blockNum: 700, commitment: INITIAL } }
    };
    const node = chain(fake);
    const judged = await judgeSubmitEvidence(row('t'), {
      node,
      accountRows: [row('t')],
      nowSec: NOW,
      cadenceMs: 3_000
    });
    expect(judged.entries[0]?.result).toBe('never-committed');
    expect(node.calls).toContain('account@700');
  });

  it('a non-inclusion witness proves expiry but never marks E.initial as seen', async () => {
    const judged = await judge(row('t'), { tip: { blockNum: 750 } });
    expect(judged.entries[0]).toMatchObject({ result: 'never-committed' });
    expect(judged.entries[0]?.initialSeenAtBlock).toBeUndefined();
  });
});

describe('row 5: nonce E.initialNonce + 1 with another commitment', () => {
  it.each<[string, string, AccountState]>([
    ['nonce + 1, another commitment', 'never-committed', { blockNum: 150, commitment: OTHER, nonce: '6' }],
    ['nonce + 1 at E.final', 'unresolvable', { blockNum: 150, commitment: FINAL, nonce: '6' }],
    ['nonce + 2', 'unresolvable', { blockNum: 150, commitment: OTHER, nonce: '7' }],
    ['a private account', 'pending', { blockNum: 150, commitment: OTHER }]
  ])('%s -> %s', async (_label, expected, tip) => {
    expect(await resultOf(row('t', { submitEvidence: [entry({ expirationBlock: undefined })] }), { tip })).toBe(
      expected
    );
  });
});

describe('an attempt that left the account unchanged', () => {
  const unchanged = (overrides: Partial<ISubmitEvidence> = {}) =>
    row('t', { type: 'consume', submitEvidence: [consumeEntry({ finalCommitment: INITIAL, ...overrides })] });

  it('gets no row 4: E.initial at or past X proves nothing', async () => {
    expect(await resultOf(unchanged(), { tip: { blockNum: 750, commitment: INITIAL } })).toBe('pending');
  });

  it('gets no row 5: nonce + 1 with another commitment proves nothing', async () => {
    const tip = { blockNum: 150, commitment: OTHER, nonce: '6' };
    expect(await resultOf(unchanged({ expirationBlock: undefined }), { tip })).toBe('unresolvable');
  });

  it('lands through an attributable output note while the account sits', async () => {
    const target = unchanged({ outputNoteIds: [NOTE] });
    expect(await resultOf(target, { tip: { blockNum: 150, commitment: INITIAL }, notes: { [NOTE]: 140 } })).toBe(
      'landed'
    );
  });
});

describe('row 5 without a commitment', () => {
  it('a read with no commitment proves nothing: absent at N, or a nonce without one', async () => {
    const target = row('t', { submitEvidence: [entry({ expirationBlock: undefined })] });
    expect(await resultOf(target, { tip: { blockNum: 150 } })).toBe('pending');
    expect(await resultOf(target, { tip: { blockNum: 150, nonce: '6' } })).toBe('unresolvable');
  });
});

describe('row 6: E`s input spent elsewhere while the account held E.initial', () => {
  const consume = row('t', { type: 'consume', submitEvidence: [consumeEntry({ expirationBlock: undefined })] });

  it('from the tip when h <= Bt, with no read at h', async () => {
    const node = chain({ tip: { blockNum: 160, commitment: INITIAL }, spent: { [NULLIFIER]: 150 } });
    const judged = await judgeSubmitEvidence(consume, { node, accountRows: [consume], nowSec: NOW, cadenceMs: 3_000 });
    expect(judged.entries[0]?.result).toBe('never-committed');
    expect(node.calls).not.toContain('account@150');
  });

  it('from the read at h after the account moved', async () => {
    expect(
      await resultOf(consume, {
        tip: { blockNum: 160, commitment: OTHER },
        spent: { [NULLIFIER]: 150 },
        history: { 150: { blockNum: 150, commitment: INITIAL } }
      })
    ).toBe('never-committed');
  });

  it('a spend after the tip leaves it pending', async () => {
    expect(await resultOf(consume, { tip: { blockNum: 160, commitment: INITIAL }, spent: { [NULLIFIER]: 170 } })).toBe(
      'pending'
    );
  });
});

describe('row 7: the binding budget', () => {
  const consume = row('t', { type: 'consume', submitEvidence: [consumeEntry({ expirationBlock: undefined })] });

  it('spent (h more than 40 blocks behind the tip) makes the entry unresolvable', async () => {
    expect(await resultOf(consume, { tip: { blockNum: 200, commitment: OTHER }, spent: { [NULLIFIER]: 150 } })).toBe(
      'unresolvable'
    );
  });

  it('a pruned h makes it unresolvable', async () => {
    expect(
      await resultOf(consume, {
        tip: { blockNum: 160, commitment: OTHER },
        spent: { [NULLIFIER]: 150 },
        history: { 150: 'pruned' }
      })
    ).toBe('unresolvable');
  });

  it('with slow successful reads, 500 ms blocks spend the budget while 3 s blocks bind', async () => {
    // 30 blocks behind the tip leaves 10 blocks of history: 5 s at 500 ms, 15 s (capped) at 3 s. The read takes 8 s.
    const fake = {
      tip: { blockNum: 180, commitment: OTHER },
      spent: { [NULLIFIER]: 150 },
      history: { 150: { blockNum: 150, commitment: FINAL } },
      readTakesMs: 8_000
    };
    const fast = await judgeSubmitEvidence(consume, {
      node: chain(fake),
      accountRows: [consume],
      nowSec: NOW,
      cadenceMs: 500
    });
    const slow = await judgeSubmitEvidence(consume, {
      node: chain(fake),
      accountRows: [consume],
      nowSec: NOW,
      cadenceMs: 3_000
    });
    expect(fast.entries[0]?.result).toBe('unresolvable');
    expect(slow.entries[0]?.result).toBe('landed');
    expect(slow.landed?.boundTransactionId).toBe(hex(2));
  });

  it('a read that fails with budget left is retried next pass, not given up', async () => {
    expect(await resultOf(consume, { tip: { blockNum: 160, commitment: OTHER }, spent: { [NULLIFIER]: 150 } })).toBe(
      'no-read'
    );
  });

  it('a budget of exactly zero, 40 blocks behind the tip, is spent: no read at h, and no one-off read', async () => {
    const atH = {
      tip: { blockNum: 190, commitment: OTHER },
      spent: { [NULLIFIER]: 150 },
      history: { 150: { blockNum: 150, commitment: FINAL } }
    };
    expect(await resultOf(consume, atH)).toBe('unresolvable');
    const atX = {
      tip: { blockNum: 740, commitment: OTHER, nonce: '7' },
      history: { 700: { blockNum: 700, commitment: INITIAL } }
    };
    expect(await resultOf(row('t'), atX)).toBe('unresolvable');
  });

  it('a read at h that times out at the full 15 s budget is retried next pass, not given up', async () => {
    // 10 blocks behind the tip leaves 30 blocks of history at 3 s: the budget is capped at 15 s, and the read takes 20.
    const fake = {
      tip: { blockNum: 160, commitment: OTHER },
      spent: { [NULLIFIER]: 150 },
      history: { 150: { blockNum: 150, commitment: FINAL } },
      readTakesMs: 20_000
    };
    expect(await resultOf(consume, fake)).toBe('no-read');
  });
});

describe('rows 8 and 9 (S-1): no proof either way', () => {
  it('stays pending while the chain is not provably past E.initial', async () => {
    expect(
      await resultOf(row('t', { submitEvidence: [entry({ expirationBlock: undefined })] }), {
        tip: { blockNum: 150, commitment: OTHER }
      })
    ).toBe('pending');
  });

  it('turns unresolvable once E.initial was seen and the account moved on', async () => {
    const seen = row('t', { submitEvidence: [entry({ expirationBlock: undefined, initialSeenAtBlock: 120 })] });
    expect(await resultOf(seen, { tip: { blockNum: 150, commitment: OTHER } })).toBe('unresolvable');
  });

  it('a landed send whose note a batch erased becomes unresolvable, never never-committed', async () => {
    const erased = row('t', { submitEvidence: [entry({ expirationBlock: undefined, initialSeenAtBlock: 101 })] });
    expect(await resultOf(erased, { tip: { blockNum: 150, commitment: FINAL } })).toBe('unresolvable');
  });

  it('keeps the earliest block E.initial was seen at, never raising it', async () => {
    const judged = await judge(row('t', { submitEvidence: [entry({ initialSeenAtBlock: 90 })] }), {
      tip: { blockNum: 150, commitment: INITIAL }
    });
    expect(judged.entries[0]?.initialSeenAtBlock).toBeUndefined();
    const fresh = await judge(row('t'), { tip: { blockNum: 150, commitment: INITIAL } });
    expect(fresh.entries[0]?.initialSeenAtBlock).toBe(150);
  });
});

describe('the network check', () => {
  it('a mismatched reference block costs no other read, records otherNetworkSince, and blocks safe', async () => {
    const node = chain({ tip: { blockNum: 750, commitment: INITIAL }, headers: { 100: OTHER } });
    const judged = await judgeSubmitEvidence(row('t'), {
      node,
      accountRows: [row('t')],
      nowSec: NOW,
      cadenceMs: 3_000
    });
    expect(judged.entries[0]).toMatchObject({ result: 'other-network', otherNetworkSince: NOW });
    expect(node.calls).toEqual(['header:100']);
    expect(judged.allDead).toBe(false);
  });

  it('a matching check clears a recorded otherNetworkSince', async () => {
    const judged = await judge(row('t', { submitEvidence: [entry({ otherNetworkSince: NOW - 60 })] }), {
      tip: { blockNum: 750, commitment: INITIAL }
    });
    expect(judged.entries[0]?.otherNetworkSince).toBeNull();
  });

  it('a header that changes between the first check and the reads voids the verdict and the seen block', async () => {
    const judged = await judge(row('t'), { tip: { blockNum: 750, commitment: INITIAL }, headerChangesAfter: 1 });
    expect(judged.entries[0]).toMatchObject({ result: 'no-read', readsFailed: true });
    expect(judged.entries[0]?.initialSeenAtBlock).toBeUndefined();
  });

  it('a failed read after a matching check leaves a recorded otherNetworkSince, which only a judgement clears', async () => {
    const judged = await judge(row('t', { submitEvidence: [entry({ otherNetworkSince: NOW - 60 })] }), {
      tip: { blockNum: 750, commitment: INITIAL },
      tipFails: true
    });
    expect(judged.entries[0]).toMatchObject({ result: 'no-read' });
    expect(judged.entries[0]?.otherNetworkSince).toBeUndefined();
  });

  it('each entry reads its own tip after its own check, so a chain swapped between entries is never mixed in', async () => {
    // A is on the first chain, B on the chain the same URL serves after the swap.
    const target = row('t', {
      submitEvidence: [entry(), entry({ attemptId: 'b', transactionId: hex(4), refBlockCommitment: OTHER })]
    });
    const judged = await judge(target, {
      tip: { blockNum: 750, commitment: INITIAL },
      headerChangesAfter: 2,
      tipAfterChange: { blockNum: 150, commitment: INITIAL }
    });
    expect(judged.entries.map(judgement => judgement.result)).toEqual(['never-committed', 'pending']);
    expect(judged.allDead).toBe(false);
  });

  it('a failed header read means no verdict this pass', async () => {
    expect(await resultOf(row('t'), { tip: { blockNum: 750, commitment: INITIAL }, headers: {} })).toBe('no-read');
  });
});

describe('the live-sibling deferral', () => {
  const consume = row('t', { type: 'consume', submitEvidence: [consumeEntry()] });
  const landedAtH = {
    tip: { blockNum: 160, commitment: OTHER },
    spent: { [NULLIFIER]: 150 },
    history: { 150: { blockNum: 150, commitment: FINAL } }
  };

  it('a Queued sibling defers a row 1 landing, which is still recorded', async () => {
    const target = row('t', { type: 'execute', submitEvidence: [bareEntry()] });
    const live = row('live', { status: ITransactionStatus.Queued, submitEvidence: undefined });
    const judged = await judge(target, { tip: { blockNum: 150, commitment: FINAL, nonce: '6' } }, [live]);
    expect(judged.entries[0]).toMatchObject({ result: 'deferred', landingRecord: { block: 150, by: 1 } });
    expect(judged.landingHeld).toBe(true);
  });

  it('a Queued or Generating sibling defers a row 3 landing, which is still recorded', async () => {
    const live = row('live', { status: ITransactionStatus.Queued, submitEvidence: undefined });
    const judged = await judge(consume, landedAtH, [live]);
    expect(judged.entries[0]).toMatchObject({ result: 'deferred', landingRecord: { block: 150, by: 3 } });
    expect(judged.landingHeld).toBe(true);
    expect(judged.landed).toBeUndefined();
  });

  it('a cancelled sibling inside MAX_WAIT_BEFORE_CANCEL of its end is live; past it, it is not', async () => {
    const cancelled = (endedAt: number) =>
      row('c', {
        type: 'execute',
        status: ITransactionStatus.Failed,
        submitEvidence: [
          {
            attemptId: 'b',
            capturedAt: endedAt,
            source: 'out-of-band',
            endedBy: 'out-of-band',
            endedAt,
            fromExecute: true
          }
        ]
      });
    expect(await resultOf(consume, landedAtH, [cancelled(Math.floor(Date.now() / 1000) - 10)])).toBe('deferred');
    expect(await resultOf(consume, landedAtH, [cancelled(Math.floor(Date.now() / 1000) - 24 * 3600)])).toBe('landed');
  });

  it('defers a row 2 landing only while an execute sibling (or an execute E) leaves its latest output list unknown', async () => {
    const onChain = { tip: { blockNum: 150, commitment: OTHER }, notes: { [NOTE]: 140 } };
    const liveExecute = row('x', {
      type: 'execute',
      status: ITransactionStatus.GeneratingTransaction,
      attemptId: 'b',
      submitEvidence: []
    });
    expect(await resultOf(row('t'), onChain, [liveExecute])).toBe('deferred');
    const listed = row('x', {
      type: 'execute',
      status: ITransactionStatus.GeneratingTransaction,
      attemptId: 'b',
      submitEvidence: [entry({ attemptId: 'b', outputNoteIds: [hex(99)], fromExecute: true })]
    });
    expect(await resultOf(row('t'), onChain, [listed])).toBe('landed');
    const liveSend = row('s', { status: ITransactionStatus.GeneratingTransaction, attemptId: 'b', submitEvidence: [] });
    expect(await resultOf(row('t'), onChain, [liveSend])).toBe('landed');
  });

  it('with two such siblings each leaving its list unknown, the note is still a candidate', async () => {
    const onChain = { tip: { blockNum: 150, commitment: OTHER }, notes: { [NOTE]: 140 } };
    const blind = (id: string) =>
      row(id, {
        type: 'execute',
        status: ITransactionStatus.GeneratingTransaction,
        attemptId: `${id}-a`,
        submitEvidence: [{ attemptId: `${id}-a`, capturedAt: 1, source: 'pin', fromExecute: true }]
      });
    expect(await resultOf(row('t'), onChain, [blind('x'), blind('y')])).toBe('deferred');
  });
});

describe('row 3 over row 2', () => {
  it('a judgement whose reads satisfy both records row 3', async () => {
    const both = row('t', { type: 'execute', submitEvidence: [entry({ nullifiers: [NULLIFIER], fromExecute: true })] });
    // A live execute sibling with no entry yet: E's note is only a candidate, and the row 3 landing is deferred.
    const live = row('live', {
      type: 'execute',
      status: ITransactionStatus.GeneratingTransaction,
      attemptId: 'b',
      submitEvidence: []
    });
    const judged = await judge(
      both,
      {
        tip: { blockNum: 160, commitment: OTHER },
        notes: { [NOTE]: 150 },
        spent: { [NULLIFIER]: 150 },
        history: { 150: { blockNum: 150, commitment: FINAL } }
      },
      [live]
    );
    expect(judged.entries[0]).toMatchObject({ result: 'deferred', landingRecord: { block: 150, by: 3 } });
  });
});

describe('the row`s verdict', () => {
  it('is all dead when every entry is provable and dead or retired before its submit', async () => {
    const target = row('t', {
      submitEvidence: [entry(), { attemptId: 'b', capturedAt: 1, source: 'pin', preSubmitEnd: true }]
    });
    expect((await judge(target, { tip: { blockNum: 750, commitment: INITIAL } })).allDead).toBe(true);
  });

  it('is never all dead with an evidence-less, an unresolvable or a pending entry beside a dead one', async () => {
    const fake = { tip: { blockNum: 750, commitment: INITIAL } };
    expect(
      (await judge(row('t', { submitEvidence: [entry(), { attemptId: 'b', capturedAt: 1, source: 'end' }] }), fake))
        .allDead
    ).toBe(false);
    expect(
      (await judge(row('t', { submitEvidence: [entry(), entry({ attemptId: 'b', verdict: 'unresolvable' })] }), fake))
        .allDead
    ).toBe(false);
    expect(
      (
        await judge(
          row('t', { submitEvidence: [entry(), entry({ attemptId: 'b', expirationBlock: undefined })] }),
          fake
        )
      ).allDead
    ).toBe(false);
  });

  it('holds a recorded landing whose reads fail this time', async () => {
    const judged = await judge(row('t', { submitEvidence: [entry({ landingSeenAtBlock: 140, landingSeenBy: 2 })] }), {
      tip: { blockNum: 150, commitment: OTHER },
      tipFails: true
    });
    expect(judged.landingHeld).toBe(true);
  });

  it('A`s attributable note beside a retired B lands A and binds A`s id', async () => {
    const target = row('t', {
      submitEvidence: [entry(), { attemptId: 'b', capturedAt: 1, source: 'pin', preSubmitEnd: true }]
    });
    expect(
      (await judge(target, { tip: { blockNum: 150, commitment: OTHER }, notes: { [NOTE]: 140 } })).landed
        ?.boundTransactionId
    ).toBe(hex(2));
  });

  it('an evidence-less entry carrying a never-committed verdict still blocks all dead', async () => {
    const target = row('t', {
      submitEvidence: [entry(), { attemptId: 'b', capturedAt: 1, source: 'end', verdict: 'never-committed' }]
    });
    expect((await judge(target, { tip: { blockNum: 750, commitment: INITIAL } })).allDead).toBe(false);
  });
});

describe('E`s nullifier window', () => {
  it('a spend before E.refBlock is never E`s landing', async () => {
    const consume = row('t', { type: 'consume', submitEvidence: [consumeEntry({ expirationBlock: undefined })] });
    const node = chain({
      tip: { blockNum: 120, commitment: OTHER },
      spent: { [NULLIFIER]: 95 },
      history: { 95: { blockNum: 95, commitment: FINAL }, 100: { blockNum: 100, commitment: INITIAL } }
    });
    const judged = await judgeSubmitEvidence(consume, { node, accountRows: [consume], nowSec: NOW, cadenceMs: 3_000 });
    expect(judged.entries[0]?.result).toBe('unresolvable');
    expect(node.calls).not.toContain('account@95');
  });

  it('a spend after X is never E`s landing, and the read at X proves it expired', async () => {
    const consume = row('t', { type: 'consume', submitEvidence: [consumeEntry()] });
    const fake = {
      tip: { blockNum: 720, commitment: OTHER },
      spent: { [NULLIFIER]: 710 },
      history: { 700: { blockNum: 700, commitment: INITIAL }, 710: { blockNum: 710, commitment: FINAL } }
    };
    expect(await resultOf(consume, fake)).toBe('never-committed');
  });
});

describe('a failed read means no verdict this pass', () => {
  it('a failed note read', async () => {
    expect(await resultOf(row('t'), { tip: { blockNum: 150, commitment: OTHER }, notesFail: true })).toBe('no-read');
  });

  it('a failed nullifier-height read', async () => {
    const consume = row('t', { type: 'consume', submitEvidence: [consumeEntry({ expirationBlock: undefined })] });
    expect(await resultOf(consume, { tip: { blockNum: 160, commitment: INITIAL }, nullifierFails: true })).toBe(
      'no-read'
    );
  });

  it('a one-off read that fails with budget left, retried next pass', async () => {
    const tip = { blockNum: 720, commitment: OTHER, nonce: '7' };
    expect(await resultOf(row('t'), { tip, history: {} })).toBe('no-read');
    // 20 blocks past X at 3 s leaves the full 15 s, and the read takes 20.
    const slow = { tip, history: { 700: { blockNum: 700, commitment: INITIAL } }, readTakesMs: 20_000 };
    expect(await resultOf(row('t'), slow)).toBe('no-read');
  });
});

describe('the one-off read', () => {
  it('a pruned read, or one that runs out a budget under 15 s, only withholds its proof', async () => {
    const tip = { blockNum: 720, commitment: OTHER, nonce: '7' };
    expect(await resultOf(row('t'), { tip, history: { 700: 'pruned' } })).toBe('unresolvable');
    // 36 blocks past X at 3 s leaves 12 s, and the read takes 13.
    const short = {
      tip: { ...tip, blockNum: 736 },
      history: { 700: { blockNum: 700, commitment: INITIAL } },
      readTakesMs: 13_000
    };
    expect(await resultOf(row('t'), short)).toBe('unresolvable');
  });

  it('a note another row names is no landing mark, so the read at X still runs', async () => {
    const other = row('o', {
      status: ITransactionStatus.Completed,
      submitEvidence: [entry({ attemptId: 'b', transactionId: hex(3) })]
    });
    const node = chain({
      tip: { blockNum: 720, commitment: OTHER, nonce: '7' },
      notes: { [NOTE]: 140 },
      history: { 700: { blockNum: 700, commitment: INITIAL } }
    });
    const target = row('t');
    const judged = await judgeSubmitEvidence(target, {
      node,
      accountRows: [target, other],
      nowSec: NOW,
      cadenceMs: 3_000
    });
    expect(judged.entries[0]?.result).toBe('never-committed');
    expect(node.calls).toContain('account@700');
  });

  it('a candidate note does not skip it, and the read only records a seen block', async () => {
    const live = row('live', {
      type: 'execute',
      status: ITransactionStatus.GeneratingTransaction,
      attemptId: 'b',
      submitEvidence: []
    });
    const judged = await judge(
      row('t'),
      {
        tip: { blockNum: 720, commitment: OTHER },
        notes: { [NOTE]: 140 },
        history: { 700: { blockNum: 700, commitment: INITIAL } }
      },
      [live]
    );
    expect(judged.entries[0]).toMatchObject({
      result: 'deferred',
      initialSeenAtBlock: 700,
      landingRecord: { block: 140, by: 2 }
    });
  });

  it('a candidate note keeps its hold when that read fails', async () => {
    const live = row('live', {
      type: 'execute',
      status: ITransactionStatus.GeneratingTransaction,
      attemptId: 'b',
      submitEvidence: []
    });
    const judged = await judge(
      row('t'),
      { tip: { blockNum: 720, commitment: OTHER }, notes: { [NOTE]: 140 }, history: {} },
      [live]
    );
    expect(judged.entries[0]).toMatchObject({ result: 'deferred', landingRecord: { block: 140, by: 2 } });
    expect(judged.entries[0]?.initialSeenAtBlock).toBeUndefined();
    expect(judged.landingHeld).toBe(true);
  });
});
