// Real Dexie: every write here is a guarded modify or a rw transaction, so stubbing the store would test nothing.
import { NoteScript, NoteType, TransactionRequest } from '@miden-sdk/miden-sdk/lazy';

import * as Repo from 'lib/miden/repo';
import { NoteTypeEnum } from 'lib/miden/types';

import { TRANSACTION_NEVER_COMMITTED_ERROR } from './constants';
import { RowJudgement } from './reconcile-judge';
import { AccountState, NodeReads, RPC_READ_TIMEOUT_MS } from './reconcile-reads';
import { applyEntryWrites, checkEvidenceForRetry, judgeAndWrite } from './reconcile-unconfirmed';
import { INoteDeliveryState, ISubmitEvidence, ITransaction, ITransactionStatus } from '../db/types';

jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  sameWalletAccountId: (a: string, b: string) => a.split('_')[0] === b.split('_')[0]
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));
jest.mock('lib/telemetry/transaction-failure', () => ({ reportTransactionFailure: jest.fn() }));

const NOW = Math.floor(Date.now() / 1000);
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const HEADER = hex(1);
const INITIAL = hex(10);
const FINAL = hex(11);
const OTHER = hex(12);
const NOTE = hex(20);

/** Fake reads; `during` runs once, inside the note read, to model a writer outside the lock. */
const node = (
  tip: AccountState,
  options: { notes?: Record<string, number>; during?: () => Promise<void>; headerAfter?: string } = {}
): NodeReads => {
  let headerReads = 0;
  let ran = false;
  return {
    blockCommitment: async () => {
      headerReads += 1;
      return options.headerAfter !== undefined && headerReads > 2 ? options.headerAfter : HEADER;
    },
    account: async () => ({ ok: true, state: tip }),
    noteInclusions: async ids => {
      if (!ran && options.during) {
        ran = true;
        await options.during();
      }
      const found = new Map<string, number>();
      for (const id of ids) {
        const block = options.notes?.[id];
        if (block !== undefined) found.set(id, block);
      }
      return found;
    },
    nullifierHeight: async () => null
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

const unconfirmed = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx-1',
  type: 'send',
  accountId: 'mtst1acct_s',
  status: ITransactionStatus.Unconfirmed,
  initiatedAt: NOW - 120,
  completedAt: NOW - 100,
  error: 'sdk said no definite outcome',
  mayHaveSubmitted: true,
  noteType: NoteTypeEnum.Public,
  displayIcon: 'SEND',
  submitEvidence: [entry()],
  ...overrides
});

const context = (reads: NodeReads) => ({ node: reads, nowSec: NOW, cadenceMs: 3_000 });
const read = (id = 'tx-1') => Repo.transactions.where({ id }).first();
const UNDELIVERED_SEND = 'Sent - the private note could not be delivered';

beforeEach(async () => {
  jest.clearAllMocks();
  await Repo.transactions.clear();
});

describe('the landed write (#1081)', () => {
  it('completes the row with the landed fields, binds the id, keeps completedAt and reports completed', async () => {
    await Repo.transactions.put(unconfirmed());
    const outcome = await judgeAndWrite(
      'tx-1',
      context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } }))
    );
    expect(outcome.kind).toBe('landed');
    const row = await read();
    expect(row).toMatchObject({
      status: ITransactionStatus.Completed,
      transactionId: hex(2),
      completedAt: NOW - 100,
      displayMessage: 'Sent'
    });
    expect(row?.error).toBeUndefined();
    const { reportOperation } = jest.requireMock('lib/telemetry/report-operation');
    expect(reportOperation).toHaveBeenCalledWith({ operation: expect.any(String), result: 'completed' });
  });

  // The landed write has no result to read a fee or outputs from: the burn keeps the identity its poll reads, and
  // nothing else is invented for it.
  it('completes a USDCx burn that landed with its burn identity intact and no fee or outputs', async () => {
    const usdcxBurn = { noteId: NOTE, destinationDomain: 26, phase: 'pending' };
    const extraInputs = { provider: 'usdcx', destinationAddress: '0xkey', destinationNetwork: 5042002, usdcxBurn };
    await Repo.transactions.put(unconfirmed({ type: 'bridged-send', displayIcon: 'SEND', extraInputs }));

    const outcome = await judgeAndWrite(
      'tx-1',
      context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } }))
    );

    expect(outcome.kind).toBe('landed');
    const row = await read();
    expect(row).toMatchObject({
      status: ITransactionStatus.Completed,
      displayMessage: 'Bridged to EVM',
      transactionId: hex(2),
      extraInputs
    });
    expect(row?.feeAmount).toBeUndefined();
    expect(row?.resultBytes).toBeUndefined();
    expect(row?.resultReleasedAt).toBeUndefined();
  });

  it.each<[ITransaction['type'], ITransaction['displayIcon']]>([
    ['send', 'SEND'],
    ['swap', 'SWAP'],
    ['execute', 'DEFAULT']
  ])('a Failed %s that landed stops drawing as failed: it takes its type`s icon', async (type, icon) => {
    await Repo.transactions.put(unconfirmed({ type, status: ITransactionStatus.Failed, displayIcon: 'FAILED' }));
    await judgeAndWrite('tx-1', context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } })));
    expect(await read()).toMatchObject({ status: ITransactionStatus.Completed, displayIcon: icon });
  });

  it.each([ITransactionStatus.Unconfirmed, ITransactionStatus.Failed])(
    'the landed write opens the order a swap`s landed failure decided (status %s)',
    async status => {
      const extraInputs = {
        requestedFaucetId: 'faucet-req',
        requestedAmount: 9n,
        expirySeconds: 100,
        landedOrder: { orderId: '42', expiresAt: 1100, noteId: NOTE }
      };
      await Repo.transactions.put(unconfirmed({ type: 'swap', status, displayIcon: 'SWAP', extraInputs }));

      await judgeAndWrite('tx-1', context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } })));

      const row = await read();
      expect(row?.status).toBe(ITransactionStatus.Completed);
      expect(row?.extraInputs).toEqual({
        requestedFaucetId: 'faucet-req',
        requestedAmount: 9n,
        expirySeconds: 100,
        orderId: 42n,
        expiresAt: 1100
      });
      expect(row?.outputNoteIds).toEqual([NOTE]);
    }
  );

  it.each([ITransactionStatus.Unconfirmed, ITransactionStatus.Failed])(
    'the landed write of a swap that decided no order writes no expiry (status %s)',
    async status => {
      const extraInputs = { requestedFaucetId: 'faucet-req', requestedAmount: 9n, expirySeconds: 100 };
      await Repo.transactions.put(unconfirmed({ type: 'swap', status, displayIcon: 'SWAP', extraInputs }));

      await judgeAndWrite('tx-1', context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } })));

      const row = await read();
      expect(row?.status).toBe(ITransactionStatus.Completed);
      expect(row?.extraInputs).toEqual(extraInputs);
      expect(row?.outputNoteIds).toBeUndefined();
    }
  );

  // A single-key swap saves no request: its leaf named the order on the stamp of the attempt that landed.
  it('the landed write of a swap with no saved request opens the order its landed attempt recorded', async () => {
    const extraInputs = { requestedFaucetId: 'faucet-req', requestedAmount: 9n, expirySeconds: 100 };
    await Repo.transactions.put(
      unconfirmed({
        type: 'swap',
        displayIcon: 'SWAP',
        extraInputs,
        submitEvidence: [entry({ orderId: '42', orderNoteId: NOTE })]
      })
    );

    await judgeAndWrite('tx-1', context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } })));

    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Completed);
    expect(row?.extraInputs).toEqual({ ...extraInputs, orderId: 42n, expiresAt: NOW - 100 + 100 });
    expect(row?.outputNoteIds).toEqual([NOTE]);
  });

  it('the landed write of a swap opens no order another attempt recorded', async () => {
    const extraInputs = { requestedFaucetId: 'faucet-req', requestedAmount: 9n, expirySeconds: 100 };
    const OTHER_NOTE = hex(21);
    await Repo.transactions.put(
      unconfirmed({
        type: 'swap',
        displayIcon: 'SWAP',
        extraInputs,
        submitEvidence: [
          entry(),
          entry({
            attemptId: 'a2',
            transactionId: hex(3),
            outputNoteIds: [OTHER_NOTE],
            orderId: '7',
            orderNoteId: OTHER_NOTE
          })
        ]
      })
    );

    await judgeAndWrite('tx-1', context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } })));

    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Completed);
    expect(row?.extraInputs).toEqual(extraInputs);
    expect(row?.outputNoteIds).toBeUndefined();
  });

  it('the landed write of a swap that holds no order opens the one its saved request names', async () => {
    const savedNote = {
      id: () => ({ toString: () => NOTE }),
      metadata: () => ({ noteType: () => NoteType.Public }),
      recipient: () => ({
        script: () => ({ root: () => NoteScript.pswap().root() }),
        serialNum: () => ({ toFelts: () => [{ asInt: () => 0n }, { asInt: () => 42n }] })
      })
    };
    const deserialize = jest.mocked(TransactionRequest.deserialize);
    const decodes = deserialize.mock.calls.length;
    deserialize.mockImplementation(
      () => ({ expectedOutputOwnNotes: () => [savedNote] }) as unknown as ReturnType<typeof deserialize>
    );
    const extraInputs = { requestedFaucetId: 'faucet-req', requestedAmount: 9n, expirySeconds: 100 };
    await Repo.transactions.put(
      unconfirmed({ type: 'swap', displayIcon: 'SWAP', extraInputs, requestBytes: new Uint8Array([7, 7, 7]) })
    );

    try {
      await judgeAndWrite('tx-1', context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } })));
    } finally {
      deserialize.mockImplementation(
        () => ({ expectedOutputOwnNotes: () => [] }) as unknown as ReturnType<typeof deserialize>
      );
    }
    expect(deserialize.mock.calls.length).toBeGreaterThan(decodes);

    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Completed);
    expect(row?.extraInputs).toEqual({ ...extraInputs, orderId: 42n, expiresAt: NOW - 100 + 100 });
    expect(row?.outputNoteIds).toEqual([NOTE]);
  });

  it('the landed write of a swap whose saved request recorded its order opens it with no decode', async () => {
    const deserialize = jest.mocked(TransactionRequest.deserialize);
    const decodes = deserialize.mock.calls.length;
    const extraInputs = {
      requestedFaucetId: 'faucet-req',
      requestedAmount: 9n,
      expirySeconds: 100,
      requestOrder: { orderId: '42', noteId: NOTE }
    };
    await Repo.transactions.put(
      unconfirmed({ type: 'swap', displayIcon: 'SWAP', extraInputs, requestBytes: new Uint8Array([7, 7, 7]) })
    );

    await judgeAndWrite('tx-1', context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } })));

    expect(deserialize.mock.calls.length).toBe(decodes);
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Completed);
    expect(row?.extraInputs).toEqual({ ...extraInputs, orderId: 42n, expiresAt: NOW - 100 + 100 });
    expect(row?.outputNoteIds).toEqual([NOTE]);
  });

  it('a header that moves while a swap landing decodes its saved request voids the landing', async () => {
    const savedNote = {
      id: () => ({ toString: () => NOTE }),
      metadata: () => ({ noteType: () => NoteType.Public }),
      recipient: () => ({
        script: () => ({ root: () => NoteScript.pswap().root() }),
        serialNum: () => ({ toFelts: () => [{ asInt: () => 0n }, { asInt: () => 42n }] })
      })
    };
    let header = HEADER;
    const deserialize = jest.mocked(TransactionRequest.deserialize);
    deserialize.mockImplementation(() => {
      header = OTHER;
      return { expectedOutputOwnNotes: () => [savedNote] } as unknown as ReturnType<typeof deserialize>;
    });
    const reads: NodeReads = {
      ...node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } }),
      blockCommitment: async () => header
    };
    const extraInputs = { requestedFaucetId: 'faucet-req', requestedAmount: 9n, expirySeconds: 100 };
    await Repo.transactions.put(
      unconfirmed({ type: 'swap', displayIcon: 'SWAP', extraInputs, requestBytes: new Uint8Array([7, 7, 7]) })
    );

    let outcome: Awaited<ReturnType<typeof judgeAndWrite>>;
    try {
      outcome = await judgeAndWrite('tx-1', context(reads));
    } finally {
      deserialize.mockImplementation(
        () => ({ expectedOutputOwnNotes: () => [] }) as unknown as ReturnType<typeof deserialize>
      );
    }

    expect(deserialize).toHaveBeenCalled();
    expect(outcome.kind).toBe('landing-pending');
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Unconfirmed);
    expect(row?.extraInputs.orderId).toBeUndefined();
    expect(row?.transactionId).toBeUndefined();
  });

  it('marks a private send undelivered', async () => {
    await Repo.transactions.put(unconfirmed({ noteType: NoteTypeEnum.Private }));
    await judgeAndWrite('tx-1', context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } })));
    expect((await read())?.noteDelivery).toBe('undelivered');
  });

  // A cancelled private send's pipeline runs on and relays its note, and the terminal guard keeps the row Failed:
  // what the relay recorded is its own outcome and survives the landing, exactly as Retry's landed path keeps it.
  it.each<[INoteDeliveryState | undefined, INoteDeliveryState, string]>([
    [undefined, 'undelivered', UNDELIVERED_SEND],
    ['undelivered', 'undelivered', UNDELIVERED_SEND],
    ['relayed', 'relayed', 'Sent'],
    ['pending', 'pending', 'Sent'],
    ['confirmed', 'confirmed', 'Sent']
  ])('a landed private send recorded as %s ends %s', async (recorded, delivery, label) => {
    await Repo.transactions.put(
      unconfirmed({ status: ITransactionStatus.Failed, noteType: NoteTypeEnum.Private, noteDelivery: recorded })
    );
    await judgeAndWrite('tx-1', context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } })));
    expect(await read()).toMatchObject({
      status: ITransactionStatus.Completed,
      noteDelivery: delivery,
      displayMessage: label
    });
  });

  it('a landing the network check voids just before its write still reads as a landing, and writes nothing', async () => {
    await Repo.transactions.put(unconfirmed());
    const outcome = await judgeAndWrite(
      'tx-1',
      context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 }, headerAfter: OTHER }))
    );
    expect(outcome.kind).toBe('landing-pending');
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Unconfirmed);
    expect(row?.transactionId).toBeUndefined();
  });

  it('writes nothing when another row of the account gains an entry naming the note meanwhile, and never binds the stale id', async () => {
    await Repo.transactions.put(unconfirmed());
    await Repo.transactions.put(unconfirmed({ id: 'tx-2', status: ITransactionStatus.Failed, submitEvidence: [] }));
    const outcome = await judgeAndWrite(
      'tx-1',
      context(
        node(
          { blockNum: 150, commitment: OTHER },
          {
            notes: { [NOTE]: 140 },
            during: async () => {
              await Repo.transactions.where({ id: 'tx-2' }).modify(row => {
                row.submitEvidence = [entry({ attemptId: 'b', transactionId: hex(9) })];
              });
            }
          }
        )
      )
    );
    expect(outcome.kind).not.toBe('landed');
    expect((await read())?.status).toBe(ITransactionStatus.Unconfirmed);
    expect((await read())?.transactionId).toBeUndefined();
  });

  it('a sibling that turns live before the write voids it, and the landing record survives for the next pass', async () => {
    const consume = unconfirmed({
      type: 'consume',
      submitEvidence: [entry({ outputNoteIds: [], nullifiers: [hex(30)] })]
    });
    await Repo.transactions.put(consume);
    await Repo.transactions.put(unconfirmed({ id: 'tx-2', status: ITransactionStatus.Failed, submitEvidence: [] }));
    const reads: NodeReads = {
      ...node({ blockNum: 160, commitment: OTHER }),
      nullifierHeight: async () => 150,
      account: async (_id, atBlock) => {
        if (atBlock === 150) {
          await Repo.transactions.where({ id: 'tx-2' }).modify(row => {
            row.status = ITransactionStatus.Queued;
          });
          return { ok: true, state: { blockNum: 150, commitment: FINAL } };
        }
        return { ok: true, state: { blockNum: 160, commitment: OTHER } };
      }
    };
    const outcome = await judgeAndWrite('tx-1', context(reads));
    expect(outcome.kind).toBe('landing-pending');
    expect((await read())?.submitEvidence?.[0]).toMatchObject({ landingSeenAtBlock: 150, landingSeenBy: 3 });
  });

  describe('a note landing, re-checked against siblings that turn live before the write', () => {
    // Neither sibling changes its entries, so only the deferral's note branch can tell the two apart.
    const siblingTurnsLive = async (type: ITransaction['type']): Promise<NodeReads> => {
      await Repo.transactions.put(
        unconfirmed({ id: 'tx-2', type, status: ITransactionStatus.Failed, attemptId: 'sibling', submitEvidence: [] })
      );
      return node(
        { blockNum: 150, commitment: OTHER },
        {
          notes: { [NOTE]: 140 },
          during: async () => {
            await Repo.transactions.where({ id: 'tx-2' }).modify(row => {
              row.status = ITransactionStatus.GeneratingTransaction;
            });
          }
        }
      );
    };

    it('an execute whose output list is still unknown could have made the note: nothing is written, the record stays', async () => {
      await Repo.transactions.put(unconfirmed());
      const reads = await siblingTurnsLive('execute');
      const outcome = await judgeAndWrite('tx-1', context(reads));
      expect(outcome.kind).toBe('landing-pending');
      const row = await read();
      expect(row?.status).toBe(ITransactionStatus.Unconfirmed);
      expect(row?.transactionId).toBeUndefined();
      expect(row?.submitEvidence?.[0]).toMatchObject({ landingSeenAtBlock: 140, landingSeenBy: 2 });
    });

    it('a send cannot have made it, so the landing is written', async () => {
      await Repo.transactions.put(unconfirmed());
      const reads = await siblingTurnsLive('send');
      const outcome = await judgeAndWrite('tx-1', context(reads));
      expect(outcome.kind).toBe('landed');
      expect(await read()).toMatchObject({ status: ITransactionStatus.Completed, transactionId: hex(2) });
    });
  });

  // A landing that binds no attempt owes a private list, or a swap order, only when every attempt that can have
  // produced it reads the same one.
  describe('an unbound landing owes only what every compatible attempt agrees on', () => {
    const RECIPIENT = 'mtst1recip';
    const NULLIFIER = hex(30);
    const THE_NOTE = 'Executed - the private note could not be delivered';
    const A_NOTE = 'Executed - a private note could not be delivered';
    const bare = (overrides: Partial<ISubmitEvidence> = {}): ISubmitEvidence =>
      entry({ outputNoteIds: [], nullifiers: [], fromExecute: true, privateOutputNoteIds: [], ...overrides });
    const executeRow = (first: Partial<ISubmitEvidence>, second: Partial<ISubmitEvidence>) =>
      unconfirmed({
        type: 'execute',
        displayIcon: 'DEFAULT',
        secondaryAccountId: RECIPIENT,
        submitEvidence: [bare(first), bare({ attemptId: 'a2', transactionId: hex(3), ...second })]
      });
    const atFinal = (notes?: Record<string, number>) =>
      context(node({ blockNum: 150, commitment: FINAL, nonce: '6' }, notes === undefined ? {} : { notes }));
    const withNullifier = (notes?: Record<string, number>): NodeReads => ({
      ...node({ blockNum: 160, commitment: FINAL, nonce: '6' }, notes === undefined ? {} : { notes }),
      nullifierHeight: async () => 150
    });

    // The note on chain is the second attempt's, and the judge's first landed entry is the note-less one.
    it('a commitment landing whose attempts disagree on private notes is not labelled clean', async () => {
      await Repo.transactions.put(executeRow({}, { outputNoteIds: [NOTE], privateOutputNoteIds: [NOTE] }));

      expect((await judgeAndWrite('tx-1', atFinal({ [NOTE]: 140 }))).kind).toBe('landed');

      const row = await read();
      expect(row?.displayMessage).toBe(THE_NOTE);
      expect(row?.relayNoteIds).toBeUndefined();
      expect(row?.noteDelivery).toBe('undelivered');
      expect(row?.transactionId).toBeUndefined();
    });

    it('both attempts agree on [] and the row stays Executed with no relayNoteIds', async () => {
      await Repo.transactions.put(executeRow({}, { outputNoteIds: [], privateOutputNoteIds: [] }));

      expect((await judgeAndWrite('tx-1', atFinal())).kind).toBe('landed');

      const row = await read();
      expect(row?.displayMessage).toBe('Executed');
      expect(row?.relayNoteIds).toBeUndefined();
      expect(row?.noteDelivery).toBeUndefined();
    });

    // A row 1 attempt recorded no output note, so the only list it can share is empty. Both attempts here record the
    // note and the nullifier; the proof matches both and binds neither, and the shared private list is what is owed.
    it('both attempts agree on [NOTE]', async () => {
      const noted = { outputNoteIds: [NOTE], nullifiers: [NULLIFIER], privateOutputNoteIds: [NOTE] };
      await Repo.transactions.put(executeRow(noted, noted));

      expect((await judgeAndWrite('tx-1', context(withNullifier()))).kind).toBe('landed');

      expect(await read()).toMatchObject({
        noteDelivery: 'undelivered',
        relayNoteIds: [NOTE],
        relayRecipientId: RECIPIENT,
        displayMessage: A_NOTE
      });
      expect((await read())?.transactionId).toBeUndefined();
    });

    it('a second attempt whose finalCommitment differs does not block the clean Executed label', async () => {
      await Repo.transactions.put(
        executeRow({}, { outputNoteIds: [NOTE], privateOutputNoteIds: [NOTE], finalCommitment: OTHER })
      );

      expect((await judgeAndWrite('tx-1', atFinal({ [NOTE]: 140 }))).kind).toBe('landed');

      const row = await read();
      expect(row?.displayMessage).toBe('Executed');
      expect(row?.relayNoteIds).toBeUndefined();
      expect(row?.noteDelivery).toBeUndefined();
    });

    it('a second attempt this pass judges never-committed does not block the clean Executed label', async () => {
      await Repo.transactions.put(executeRow({}, { outputNoteIds: [NOTE], privateOutputNoteIds: [NOTE] }));
      const reads: NodeReads = {
        ...node({ blockNum: 720, commitment: FINAL, nonce: '6' }),
        account: async (_id, atBlock) => ({
          ok: true,
          state:
            atBlock === 700 ? { blockNum: 700, commitment: INITIAL } : { blockNum: 720, commitment: FINAL, nonce: '6' }
        })
      };

      expect((await judgeAndWrite('tx-1', context(reads))).kind).toBe('landed');

      const row = await read();
      expect(row?.displayMessage).toBe('Executed');
      expect(row?.relayNoteIds).toBeUndefined();
      expect(row?.noteDelivery).toBeUndefined();
    });

    it('a nullifier landing whose attempts disagree on private notes is not labelled clean', async () => {
      await Repo.transactions.put(
        executeRow(
          { nullifiers: [NULLIFIER] },
          { outputNoteIds: [NOTE], nullifiers: [NULLIFIER], privateOutputNoteIds: [NOTE] }
        )
      );

      expect((await judgeAndWrite('tx-1', context(withNullifier({ [NOTE]: 140 })))).kind).toBe('landed');

      const row = await read();
      expect(row?.displayMessage).toBe(THE_NOTE);
      expect(row?.relayNoteIds).toBeUndefined();
      expect(row?.transactionId).toBeUndefined();
    });

    const swapRow = (secondOrder: { orderId: string; orderNoteId: string }, same: boolean) => {
      const extraInputs = { requestedFaucetId: 'faucet-req', requestedAmount: 9n, expirySeconds: 100 };
      const order = { orderId: '42', orderNoteId: NOTE };
      return unconfirmed({
        type: 'swap',
        displayIcon: 'SWAP',
        extraInputs,
        submitEvidence: [
          entry({ outputNoteIds: [], nullifiers: [], ...order }),
          entry({
            attemptId: 'a2',
            transactionId: hex(3),
            outputNoteIds: [],
            nullifiers: [],
            ...(same ? order : secondOrder)
          })
        ]
      });
    };

    it('a single-key swap landed by an unbound commitment proof opens no order when its attempts stamped different ones', async () => {
      await Repo.transactions.put(swapRow({ orderId: '7', orderNoteId: hex(21) }, false));

      expect((await judgeAndWrite('tx-1', atFinal())).kind).toBe('landed');

      const row = await read();
      expect(row?.extraInputs).toEqual({ requestedFaucetId: 'faucet-req', requestedAmount: 9n, expirySeconds: 100 });
      expect(row?.outputNoteIds).toBeUndefined();
    });

    it('a single-key swap landed by an unbound commitment proof opens no order when one attempt stamped none', async () => {
      // The silent attempt is the one the judge takes as the landing, so only the other attempt names an order.
      const row = swapRow({ orderId: '42', orderNoteId: NOTE }, true);
      const [landing, other] = row.submitEvidence ?? [];
      const { orderId: _orderId, orderNoteId: _orderNoteId, ...silent } = landing!;
      await Repo.transactions.put({ ...row, submitEvidence: [silent, other!] });

      expect((await judgeAndWrite('tx-1', atFinal())).kind).toBe('landed');

      const stored = await read();
      expect(stored?.extraInputs).toEqual({ requestedFaucetId: 'faucet-req', requestedAmount: 9n, expirySeconds: 100 });
      expect(stored?.outputNoteIds).toBeUndefined();
    });

    it('a single-key swap landed by an unbound commitment proof opens the order its attempts stamped', async () => {
      await Repo.transactions.put(swapRow({ orderId: '42', orderNoteId: NOTE }, true));

      expect((await judgeAndWrite('tx-1', atFinal())).kind).toBe('landed');

      expect((await read())?.extraInputs).toEqual({
        requestedFaucetId: 'faucet-req',
        requestedAmount: 9n,
        expirySeconds: 100,
        orderId: 42n,
        expiresAt: NOW - 100 + 100
      });
      expect((await read())?.outputNoteIds).toEqual([NOTE]);
    });
  });
});

describe('the never-committed write (#1081)', () => {
  it('marks a Failed row safe: the reason, the old reason kept raw, the marker and the verdicts', async () => {
    await Repo.transactions.put(
      unconfirmed({ status: ITransactionStatus.Failed, error: 'old reason', rawError: undefined })
    );
    const outcome = await judgeAndWrite('tx-1', context(node({ blockNum: 750, commitment: INITIAL })));
    expect(outcome.kind).toBe('never-committed');
    const row = await read();
    expect(row).toMatchObject({
      status: ITransactionStatus.Failed,
      error: TRANSACTION_NEVER_COMMITTED_ERROR,
      rawError: 'old reason',
      displayMessage: 'Failed',
      displayIcon: 'FAILED',
      neverCommittedAt: NOW
    });
    expect(row?.submitEvidence?.[0]).toMatchObject({ verdict: 'never-committed', initialSeenAtBlock: 750 });
    expect(jest.requireMock('lib/telemetry/transaction-failure').reportTransactionFailure).toHaveBeenCalledWith(
      expect.objectContaining({ point: 'node_verdict', reason: 'never_committed', alreadyReported: true })
    );
  });

  it('moves an Unconfirmed row to Failed and reports the definitive verdict once', async () => {
    const priorError = 'failed to execute transaction: failed to fetch transaction inputs from the data store';
    await Repo.transactions.put(
      unconfirmed({
        attemptId: 'a1',
        rawError: priorError,
        stageTimestamps: { executing: 1_000, submitting: 10_000 }
      })
    );
    await judgeAndWrite('tx-1', context(node({ blockNum: 750, commitment: INITIAL })));
    expect((await read())?.status).toBe(ITransactionStatus.Failed);
    expect(jest.requireMock('lib/telemetry/report-operation').reportOperation).not.toHaveBeenCalled();
    const report = jest.requireMock('lib/telemetry/transaction-failure').reportTransactionFailure;
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      point: 'node_verdict',
      type: 'send',
      stage: undefined,
      delegateTransaction: undefined,
      diagnostics: undefined,
      reason: 'never_committed',
      neverCommittedRule: 'expired',
      alreadyReported: false,
      priorError,
      proofWaitBlocks: 3,
      expiryWindowBlocks: 600,
      submitApproachHidden: 'not_measured',
      proofWindow: 'over_180_blocks',
      error: TRANSACTION_NEVER_COMMITTED_ERROR
    });
    await judgeAndWrite('tx-1', context(node({ blockNum: 750, commitment: INITIAL })));
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('reports a never-committed consume row with its stored deferral and fee admission', async () => {
    await Repo.transactions.put(
      unconfirmed({
        type: 'consume',
        consumeEntryPoint: 'auto_consume',
        lastDeferral: 'guardian_rate_limited',
        feeAdmission: 'known_sufficient',
        submitEvidence: [entry({ outputNoteIds: [], nullifiers: [hex(30)] })]
      })
    );

    const outcome = await judgeAndWrite('tx-1', context(node({ blockNum: 750, commitment: INITIAL })));

    expect(outcome.kind).toBe('never-committed');
    expect((await read())?.status).toBe(ITransactionStatus.Failed);
    const report = jest.requireMock('lib/telemetry/transaction-failure').reportTransactionFailure;
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        point: 'node_verdict',
        type: 'consume',
        entryPoint: 'auto_consume',
        lastDeferral: 'guardian_rate_limited',
        feeAdmission: 'known_sufficient',
        reason: 'never_committed'
      })
    );
  });

  it('reports a legacy never-committed consume row without a deferral or fee admission', async () => {
    await Repo.transactions.put(
      unconfirmed({
        type: 'consume',
        submitEvidence: [entry({ outputNoteIds: [], nullifiers: [hex(30)] })]
      })
    );

    const outcome = await judgeAndWrite('tx-1', context(node({ blockNum: 750, commitment: INITIAL })));

    expect(outcome.kind).toBe('never-committed');
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Failed);
    expect(row?.lastDeferral).toBeUndefined();
    expect(row?.feeAdmission).toBeUndefined();
    const report = jest.requireMock('lib/telemetry/transaction-failure').reportTransactionFailure;
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        point: 'node_verdict',
        type: 'consume',
        lastDeferral: undefined,
        feeAdmission: undefined,
        reason: 'never_committed'
      })
    );
  });

  it('stores the rule that proved an attempt dead beside its verdict, and none beside another result', () => {
    const judgement: RowJudgement = {
      rowId: 'tx-1',
      judgedEntries: [entry(), entry({ attemptId: 'a2' })],
      entries: [
        { attemptId: 'a1', result: 'never-committed', neverCommittedBy: 'spent_elsewhere', readsFailed: false },
        { attemptId: 'a2', result: 'unresolvable', readsFailed: false }
      ],
      allDead: false,
      landingHeld: false
    };
    expect(
      applyEntryWrites([entry(), entry({ attemptId: 'a2' })], judgement).map(written => [
        written.verdict,
        written.neverCommittedBy
      ])
    ).toEqual([
      ['never-committed', 'spent_elsewhere'],
      ['unresolvable', undefined]
    ]);
  });

  it('reports mixed for attempts proved dead by different checks in separate passes', async () => {
    await Repo.transactions.put(
      unconfirmed({ submitEvidence: [entry(), entry({ attemptId: 'a2', expirationBlock: undefined })] })
    );
    expect((await judgeAndWrite('tx-1', context(node({ blockNum: 750, commitment: INITIAL })))).kind).toBe('pending');
    expect((await read())?.submitEvidence?.map(stored => [stored.verdict, stored.neverCommittedBy])).toEqual([
      ['never-committed', 'expired'],
      [undefined, undefined]
    ]);
    const report = jest.requireMock('lib/telemetry/transaction-failure').reportTransactionFailure;
    expect(report).not.toHaveBeenCalled();

    const outcome = await judgeAndWrite('tx-1', context(node({ blockNum: 760, commitment: OTHER, nonce: '6' })));
    expect(outcome.kind).toBe('never-committed');
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'never_committed', neverCommittedRule: 'mixed' })
    );
  });

  it('does not report an imported backup row as a new failure', async () => {
    await Repo.transactions.put(unconfirmed({ restoredFromBackup: true }));
    await judgeAndWrite('tx-1', context(node({ blockNum: 750, commitment: INITIAL })));
    expect(jest.requireMock('lib/telemetry/transaction-failure').reportTransactionFailure).not.toHaveBeenCalled();
  });

  it('a late stamp adding an attempt voids it', async () => {
    await Repo.transactions.put(unconfirmed());
    const reads: NodeReads = {
      ...node({ blockNum: 750, commitment: INITIAL }),
      account: async () => {
        await Repo.transactions.where({ id: 'tx-1' }).modify(row => {
          row.submitEvidence = [...(row.submitEvidence ?? []), { attemptId: 'late', capturedAt: NOW, source: 'stage' }];
        });
        return { ok: true, state: { blockNum: 750, commitment: INITIAL } };
      }
    };
    await judgeAndWrite('tx-1', context(reads));
    expect((await read())?.neverCommittedAt).toBeUndefined();
    expect(jest.requireMock('lib/telemetry/transaction-failure').reportTransactionFailure).not.toHaveBeenCalled();
  });

  it('a header that changes before the write voids it', async () => {
    await Repo.transactions.put(unconfirmed());
    await judgeAndWrite('tx-1', context(node({ blockNum: 750, commitment: INITIAL }, { headerAfter: OTHER })));
    expect((await read())?.neverCommittedAt).toBeUndefined();
    expect((await read())?.submitEvidence?.[0]?.verdict).toBeUndefined();
  });
});

describe('the catch-all write (#1081)', () => {
  it('persists an unresolvable verdict and leaves the stored message alone', async () => {
    await Repo.transactions.put(
      unconfirmed({ submitEvidence: [entry({ expirationBlock: undefined, initialSeenAtBlock: 101 })] })
    );
    const outcome = await judgeAndWrite('tx-1', context(node({ blockNum: 150, commitment: OTHER })));
    expect(outcome.kind).toBe('pending');
    const row = await read();
    expect(row?.submitEvidence?.[0]?.verdict).toBe('unresolvable');
    expect(row?.error).toBe('sdk said no definite outcome');
  });

  it('skips a row that is no longer in the set', async () => {
    await Repo.transactions.put(unconfirmed({ neverCommittedAt: 5 }));
    expect((await judgeAndWrite('tx-1', context(node({ blockNum: 750, commitment: INITIAL })))).kind).toBe('skipped');
  });
});

describe('checkEvidenceForRetry (#1081)', () => {
  it.each<[string, string, AccountState, Record<string, number>]>([
    ['a landed row', 'landed', { blockNum: 150, commitment: OTHER }, { [NOTE]: 140 }],
    ['a dead row', 'proven', { blockNum: 750, commitment: INITIAL }, {}],
    ['an undecided row', 'undecided', { blockNum: 150, commitment: OTHER }, {}]
  ])('%s -> %s', async (_label, kind, tip, notes) => {
    await Repo.transactions.put(unconfirmed());
    const check = await checkEvidenceForRetry(unconfirmed(), { createReads: async () => node(tip, { notes }) });
    expect(check.kind).toBe(kind);
  });

  it('a landing whose write the network check voids -> landing-pending, never undecided', async () => {
    await Repo.transactions.put(unconfirmed());
    const check = await checkEvidenceForRetry(unconfirmed(), {
      createReads: async () =>
        node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 }, headerAfter: OTHER })
    });
    expect(check.kind).toBe('landing-pending');
  });
});

describe('the account that created an execute`s attempt note (#2147)', () => {
  // A dApp's row stores the bare address; the read compares the sender in canonical form.
  const DAPP_ACCOUNT = 'mtst1acct';
  const execute = () =>
    unconfirmed({ type: 'execute', accountId: DAPP_ACCOUNT, submitEvidence: [entry({ fromExecute: true })] });
  /** NOTE on chain as `creator` created it: a read naming another sender gets no answer, as the real read's. */
  const heldBy = (creator: string, overrides: Partial<NodeReads> = {}) => {
    const noteInclusions = jest.fn(
      async (
        ...[, , sender]: Parameters<NodeReads['noteInclusions']>
      ): Promise<ReadonlyMap<string, number> | undefined> =>
        sender === undefined || sender === creator ? new Map([[NOTE, 140]]) : undefined
    );
    const reads: NodeReads = { ...node({ blockNum: 150, commitment: OTHER }), noteInclusions, ...overrides };
    return { reads, noteInclusions };
  };
  type Check = (reads: NodeReads) => Promise<string>;
  const reconciler: Check = async reads => (await judgeAndWrite('tx-1', context(reads))).kind;
  const tapTime: Check = async reads => {
    const row = await read();
    if (row === undefined) throw new Error('the row is missing');
    return (await checkEvidenceForRetry(row, { createReads: async () => reads })).kind;
  };

  it.each<[string, Check, string]>([
    ['the reconciler', reconciler, 'pending'],
    ['the tap-time check', tapTime, 'undecided']
  ])(
    '%s leaves an execute unresolved, not Completed, when the node holds its note only as another account`s',
    async (_label, check, kind) => {
      await Repo.transactions.put(execute());
      const { reads, noteInclusions } = heldBy('mtst1other');
      expect(await check(reads)).toBe(kind);
      const row = await read();
      expect(row?.status).toBe(ITransactionStatus.Unconfirmed);
      expect(row?.transactionId).toBeUndefined();
      expect(row?.neverCommittedAt).toBeUndefined();
      expect(row?.submitEvidence?.[0]?.landingSeenAtBlock).toBeUndefined();
      expect(row?.submitEvidence?.[0]?.verdict).toBeUndefined();
      expect(noteInclusions.mock.calls).toStrictEqual([[[NOTE], RPC_READ_TIMEOUT_MS, DAPP_ACCOUNT]]);
    }
  );

  // X passed with the account at E.initial there: with that note read as absent, the attempt would prove expired.
  const PAST_X: Partial<NodeReads> = {
    account: async (_id, atBlock) => ({
      ok: true,
      state: atBlock === 700 ? { blockNum: 700, commitment: INITIAL } : { blockNum: 720, commitment: OTHER }
    })
  };

  it.each<[string, Check, string]>([
    ['the reconciler', reconciler, 'pending'],
    ['the tap-time check', tapTime, 'undecided']
  ])(
    '%s never reads that note as absent, so it does not prove the execute dead either',
    async (_label, check, kind) => {
      await Repo.transactions.put(execute());
      const { reads } = heldBy('mtst1other', PAST_X);
      expect(await check(reads)).toBe(kind);
      const row = await read();
      expect(row?.status).toBe(ITransactionStatus.Unconfirmed);
      expect(row?.neverCommittedAt).toBeUndefined();
      expect(row?.submitEvidence?.[0]?.verdict).toBeUndefined();
    }
  );

  it.each<[string, Check]>([
    ['the reconciler', reconciler],
    ['the tap-time check', tapTime]
  ])('%s still completes an execute from a note its own account created', async (_label, check) => {
    await Repo.transactions.put(execute());
    const { reads, noteInclusions } = heldBy(DAPP_ACCOUNT);
    expect(await check(reads)).toBe('landed');
    expect(await read()).toMatchObject({ status: ITransactionStatus.Completed, transactionId: hex(2) });
    expect(noteInclusions.mock.calls).toStrictEqual([[[NOTE], RPC_READ_TIMEOUT_MS, DAPP_ACCOUNT]]);
  });

  it.each<[string, 'send' | 'swap', Check]>([
    ['the reconciler', 'send', reconciler],
    ['the reconciler', 'swap', reconciler],
    ['the tap-time check', 'send', tapTime],
    ['the tap-time check', 'swap', tapTime]
  ])('%s completes a %s from a copy under another sender, asking with no sender', async (_label, type, check) => {
    await Repo.transactions.put(unconfirmed({ type }));
    const { reads, noteInclusions } = heldBy('mtst1other');
    expect(await check(reads)).toBe('landed');
    expect(await read()).toMatchObject({ status: ITransactionStatus.Completed, transactionId: hex(2) });
    expect(noteInclusions.mock.calls).toStrictEqual([[[NOTE], RPC_READ_TIMEOUT_MS]]);
  });
});
