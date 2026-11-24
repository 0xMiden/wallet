import * as Repo from 'lib/miden/repo';

import {
  applyVerifiedLanding,
  completeVerifiedLandedTransaction,
  setTransactionStage,
  updateTransactionStatus,
  verifiedLandingRowFields,
  waitForTransactionCompletion
} from './helper';
import { ITransaction, ITransactionStatus } from '../db/types';

jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));

const unconfirmed = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx-u',
  type: 'send',
  accountId: 'acct',
  status: ITransactionStatus.Unconfirmed,
  initiatedAt: 1000,
  completedAt: 1200,
  stage: 'sending',
  displayIcon: 'SEND',
  ...overrides
});

const read = () => Repo.transactions.where({ id: 'tx-u' }).first();

beforeEach(async () => {
  await Repo.transactions.clear();
});

describe('Unconfirmed rows are past the pipeline (#1081)', () => {
  it('updateTransactionStatus refuses one and writes nothing', async () => {
    await Repo.transactions.put(unconfirmed());
    await expect(
      updateTransactionStatus('tx-u', ITransactionStatus.Completed, { displayMessage: 'Sent' })
    ).rejects.toThrow('Transaction already in a finalized state');
    expect((await read())?.status).toBe(ITransactionStatus.Unconfirmed);
  });

  it('setTransactionStage drops the write: the stage records where the attempt stopped', async () => {
    await Repo.transactions.put(unconfirmed());
    await setTransactionStage('tx-u', 'confirming');
    expect((await read())?.stage).toBe('sending');
  });
});

describe('a row proven landed takes its type`s icon (#1081)', () => {
  it('verifiedLandingRowFields carries it', () => {
    expect(verifiedLandingRowFields({ type: 'swap', accountId: 'acct' })).toMatchObject({ displayIcon: 'SWAP' });
  });

  // A relay that ran before the row was failed recorded which notes the transport took; re-deriving the label must
  // not forget them.
  it('verifiedLandingRowFields counts only the notes the transport did not acknowledge', () => {
    expect(
      verifiedLandingRowFields({
        type: 'execute',
        accountId: 'acct',
        secondaryAccountId: 'recipient',
        noteDelivery: 'undelivered',
        relayNoteIds: ['0xa', '0xb'],
        relayAckedNoteIds: ['0xb']
      })
    ).toMatchObject({
      displayMessage: 'Executed - a private note could not be delivered',
      noteDelivery: 'undelivered'
    });
  });

  it('the landed write replaces a Failed row`s icon when its caller passes none', async () => {
    await Repo.transactions.put(
      unconfirmed({ type: 'consume', status: ITransactionStatus.Failed, displayIcon: 'FAILED' })
    );
    await completeVerifiedLandedTransaction('tx-u');
    expect(await read()).toMatchObject({ status: ITransactionStatus.Completed, displayIcon: 'RECEIVE' });
  });
});

describe('a verified landing of a swap opens the order its landed failure decided', () => {
  const ORDER_NOTE = `0x${'ab'.repeat(32)}`;
  const failedSwap = (extraInputs: Record<string, unknown>, overrides: Partial<ITransaction> = {}): ITransaction =>
    unconfirmed({
      type: 'swap',
      status: ITransactionStatus.Failed,
      completedAt: 5000,
      extraInputs: { requestedFaucetId: 'faucet-req', requestedAmount: 9n, expirySeconds: 100, ...extraInputs },
      ...overrides
    });

  it('promotes the decided order once, at its landing expiry, with its note as the row`s output note', () => {
    const row = failedSwap({ landedOrder: { orderId: '42', expiresAt: 1100, noteId: ORDER_NOTE } });

    applyVerifiedLanding(row);
    applyVerifiedLanding(row);

    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.extraInputs).toEqual({
      requestedFaucetId: 'faucet-req',
      requestedAmount: 9n,
      expirySeconds: 100,
      orderId: 42n,
      expiresAt: 1100
    });
    expect(row.outputNoteIds).toEqual([ORDER_NOTE]);
  });

  it.each<[string, unknown]>([
    ['hex', '0x2a'],
    ['negative', '-1'],
    ['exponent', '1e3'],
    ['a number', 42],
    ['at the field modulus', '18446744069414584321']
  ])('a decided order id that is %s opens no order', (_label, orderId) => {
    const row = failedSwap({ landedOrder: { orderId, expiresAt: 1100, noteId: ORDER_NOTE } });

    applyVerifiedLanding(row);

    expect(row.extraInputs.orderId).toBeUndefined();
    expect(row.extraInputs.expiresAt).toBeUndefined();
    expect(row.extraInputs.landedOrder).toBeUndefined();
    expect(row.outputNoteIds).toBeUndefined();
  });

  it('a decided order whose expiry is not a whole number of seconds opens no order', () => {
    const row = failedSwap({ landedOrder: { orderId: '42', expiresAt: 'soon', noteId: ORDER_NOTE } });

    applyVerifiedLanding(row);

    expect(row.extraInputs.orderId).toBeUndefined();
    expect(row.extraInputs.expiresAt).toBeUndefined();
  });

  it('a decided note that is not note-id shaped is not recorded as the row`s output note', () => {
    const row = failedSwap({ landedOrder: { orderId: '42', expiresAt: 1100, noteId: 'order-note' } });

    applyVerifiedLanding(row);

    expect(row.extraInputs.orderId).toBe(42n);
    expect(row.outputNoteIds).toBeUndefined();
  });

  it('a row that holds its own order keeps it and drops the held one', () => {
    const row = failedSwap({
      orderId: 7n,
      expiresAt: 500,
      landedOrder: { orderId: '42', expiresAt: 1100, noteId: ORDER_NOTE }
    });

    applyVerifiedLanding(row);

    expect(row.extraInputs).toEqual({
      requestedFaucetId: 'faucet-req',
      requestedAmount: 9n,
      expirySeconds: 100,
      orderId: 7n,
      expiresAt: 500
    });
    expect(row.outputNoteIds).toBeUndefined();
  });

  it('keeps the output notes a row already records', () => {
    const row = failedSwap(
      { landedOrder: { orderId: '42', expiresAt: 1100, noteId: ORDER_NOTE } },
      { outputNoteIds: [`0x${'cd'.repeat(32)}`] }
    );

    applyVerifiedLanding(row);

    expect(row.extraInputs.orderId).toBe(42n);
    expect(row.outputNoteIds).toEqual([`0x${'cd'.repeat(32)}`]);
  });

  // The receipt reads an expiry as an order the wallet settles, so a row with no order keeps its claim route.
  it('a swap with no decided order opens none and gets no expiry', () => {
    const row = failedSwap({});

    applyVerifiedLanding(row, { completedAt: 2000 });

    expect(row.extraInputs.orderId).toBeUndefined();
    expect(row.extraInputs.expiresAt).toBeUndefined();
    expect(row.outputNoteIds).toBeUndefined();
  });

  // The order is fixed when the request is built, so the one its saved request recorded stands in for a landing that
  // read none, with no decode.
  const RECORDED = { orderId: '42', noteId: ORDER_NOTE };

  it('a landing whose facts name no order opens the one its saved request recorded', () => {
    const row = failedSwap({ expirySeconds: 60, requestOrder: RECORDED }, { completedAt: 500 });

    applyVerifiedLanding(row, {}, {});

    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.extraInputs).toMatchObject({ orderId: 42n, expiresAt: 560 });
    expect(row.outputNoteIds).toEqual([ORDER_NOTE]);
  });

  it('a recorded order keeps the output notes a row already records', () => {
    const recordedNotes = [`0x${'cd'.repeat(32)}`];
    const row = failedSwap({ requestOrder: RECORDED }, { outputNoteIds: recordedNotes });

    applyVerifiedLanding(row);

    expect(row.extraInputs.orderId).toBe(42n);
    expect(row.outputNoteIds).toEqual(recordedNotes);
  });

  it('a read that is not well formed opens the recorded order, never a mix of the two', () => {
    const row = failedSwap({ requestOrder: RECORDED });

    applyVerifiedLanding(row, {}, { orderId: '0x2a', orderNoteId: `0x${'08'.repeat(32)}` });

    expect(row.extraInputs.orderId).toBe(42n);
    expect(row.outputNoteIds).toEqual([ORDER_NOTE]);
  });

  it('the held order and the landing`s own read outrank the recorded one, each as a pair', () => {
    const held = failedSwap({ requestOrder: RECORDED, landedOrder: { orderId: '7', expiresAt: 99 } });
    applyVerifiedLanding(held);
    expect(held.extraInputs).toMatchObject({ orderId: 7n, expiresAt: 99 });
    expect(held.outputNoteIds).toBeUndefined();

    const readNote = `0x${'08'.repeat(32)}`;
    const read = failedSwap({ requestOrder: RECORDED });
    applyVerifiedLanding(read, {}, { orderId: '8', orderNoteId: readNote });
    expect(read.extraInputs.orderId).toBe(8n);
    expect(read.outputNoteIds).toEqual([readNote]);
  });

  it.each<[string, unknown]>([
    ['a hex order id', { orderId: '0x2a', noteId: ORDER_NOTE }],
    ['a note id that is not note-id shaped', { orderId: '42', noteId: 'bad' }],
    ['no note id', { orderId: '42' }],
    ['no object', '42']
  ])('a recorded order with %s opens none', (_label, requestOrder) => {
    const row = failedSwap({ requestOrder });

    applyVerifiedLanding(row);

    expect(row.extraInputs.orderId).toBeUndefined();
    expect(row.extraInputs.expiresAt).toBeUndefined();
    expect(row.outputNoteIds).toBeUndefined();
  });

  it.each<[string, Partial<ITransaction>]>([
    ['send', { type: 'send', extraInputs: { recallBlocks: 10, landedOrder: { orderId: '42', expiresAt: 1100 } } }],
    ['bridged-send', { type: 'bridged-send', extraInputs: { provider: 'agglayer' } }]
  ])('leaves a %s row`s extraInputs as they are', (_type, overrides) => {
    const row = unconfirmed({ status: ITransactionStatus.Failed, ...overrides });
    const extraInputs = row.extraInputs;

    applyVerifiedLanding(row);

    expect(row.extraInputs).toBe(extraInputs);
    expect(row.outputNoteIds).toBeUndefined();
  });
});

describe('waitForTransactionCompletion and Unconfirmed (#1081)', () => {
  afterEach(() => jest.useRealTimers());

  it('keeps waiting through Unconfirmed and resolves once the row is written Failed', async () => {
    await Repo.transactions.put(unconfirmed());
    const waiting = waitForTransactionCompletion('tx-u');
    let settled = false;
    void waiting.then(() => (settled = true));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    await Repo.transactions.where({ id: 'tx-u' }).modify(row => {
      row.status = ITransactionStatus.Failed;
      row.error = 'boom';
    });
    await expect(waiting).resolves.toEqual({ errorMessage: 'boom' });
  });

  it.each<[string, Partial<ITransaction>, string]>([
    [
      'with the latest entry`s id',
      { submitEvidence: [{ attemptId: 'a', capturedAt: 1, source: 'error-text', transactionId: '0xabc' }] },
      'Transaction 0xabc was submitted, but the network has not confirmed it yet'
    ],
    ['without one', {}, 'Transaction was submitted, but the network has not confirmed it yet']
  ])('times out on a row last seen Unconfirmed %s, never as a failure', async (_label, overrides, message) => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick', 'setImmediate'] });
    await Repo.transactions.put(unconfirmed(overrides));
    const waiting = waitForTransactionCompletion('tx-u');
    await jest.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await expect(waiting).resolves.toEqual({ errorMessage: message });
  });
});
