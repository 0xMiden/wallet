/* eslint-disable import/first */
const mockProcessDApp = jest.fn();
jest.mock('lib/miden/back/actions', () => ({
  DAppQueueDeadlineError: class DAppQueueDeadlineError extends Error {},
  processDApp: (...args: unknown[]) => mockProcessDApp(...args)
}));

const mockGetTransactionById = jest.fn();
jest.mock('lib/miden/transaction/get', () => ({
  getTransactionById: (id: string) => mockGetTransactionById(id)
}));

jest.mock('lib/miden/transaction/initiate', () => ({
  TransactionQueuedError: class TransactionQueuedError extends Error {
    readonly transactionId: string;

    constructor(transactionId: string, options: { cause: unknown }) {
      super(`Transaction ${transactionId} is queued but its carried notes could not be queued`, options);
      this.transactionId = transactionId;
    }
  }
}));

let mockDApps: Record<string, unknown[]> = {};
jest.mock('lib/miden/back/dapp', () => ({
  getAllDApps: () => Promise.resolve(mockDApps)
}));

const mockStore = new Map<string, unknown>();
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) =>
      Object.fromEntries(keys.filter(key => mockStore.has(key)).map(key => [key, mockStore.get(key)])),
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) mockStore.set(key, JSON.parse(JSON.stringify(value)));
    }
  })
}));

import {
  type AppConnection,
  type AppSession,
  BREAD_REQUEST_URL,
  type DAppMessage,
  finishConnect,
  MAX_MESSAGE_LENGTH,
  readLink,
  readResponse,
  REQUEST_MAX_AGE_MS,
  type RequestAnswer,
  sendRequest,
  SESSION_IDLE_MS,
  startConnect,
  toBase64Url
} from '@miden-sdk/bread-connect';
import { DAppQueueDeadlineError } from 'lib/miden/back/actions';
import { ITransactionStatus } from 'lib/miden/db/types';
import { TransactionQueuedError } from 'lib/miden/transaction/initiate';

import { answerRequestLink, type BreadConnectAnswer } from './answer';

const CALLBACK = 'https://game.example/bread';
const ORIGIN = 'https://game.example';
const NOW = 1_800_000_000_000;
const PERMISSION_REQUEST: DAppMessage = {
  type: 'PERMISSION_REQUEST',
  appMeta: { name: 'Where Legends Grow' },
  force: false,
  privateDataPermission: 'UPON_REQUEST',
  network: 'testnet'
};
const PERMISSION_RESPONSE: DAppMessage = {
  type: 'PERMISSION_RESPONSE',
  accountId: 'mtst1account',
  network: 'testnet',
  privateDataPermission: 'UPON_REQUEST',
  allowedPrivateData: 0,
  publicKey: 'AAEC'
};
const SIGN_REQUEST: DAppMessage = {
  type: 'SIGN_REQUEST',
  sourceAccountId: 'mtst1account',
  payload: 'AQID',
  kind: 'word'
};
const SEND_REQUEST: DAppMessage = { type: 'SEND_TRANSACTION_REQUEST', transaction: { amount: '5' } };

beforeEach(() => {
  mockStore.clear();
  mockDApps = { [ORIGIN]: [{ accountId: 'mtst1account' }] };
  mockProcessDApp.mockReset();
  mockGetTransactionById.mockReset();
});

function connectedAnswer(answer: BreadConnectAnswer, connection: AppConnection) {
  const read = readLink(answer.link, CALLBACK);
  if (read?.kind !== 'envelope' || read.envelope.type !== 'connected') throw new Error('not a connected link');
  return finishConnect(read.envelope, connection);
}

function requestAnswer(answer: BreadConnectAnswer, session: AppSession): RequestAnswer {
  const read = readLink(answer.link, session.callback);
  if (read?.kind !== 'envelope' || read.envelope.type !== 'response') throw new Error('not a response link');
  return readResponse(read.envelope, session);
}

const messageLength = (link: string) => link.length - link.indexOf('&m=', CALLBACK.length) - 3;

function unsealedError(answer: BreadConnectAnswer | null) {
  const read = answer && readLink(answer.link, answer.callback);
  if (read?.kind !== 'envelope' || read.envelope.type !== 'error') throw new Error('not an error link');
  return read.envelope;
}

async function connected(): Promise<AppSession> {
  const { link, connection } = startConnect(CALLBACK, PERMISSION_REQUEST);
  mockProcessDApp.mockResolvedValueOnce(PERMISSION_RESPONSE);
  const answer = await answerRequestLink(link, { now: NOW });
  await answer?.keep?.();
  mockProcessDApp.mockReset();
  return connectedAnswer(answer!, connection).session;
}

function messageLink(version: string, message: unknown): string {
  return `${BREAD_REQUEST_URL}#v=${version}&m=${toBase64Url(new TextEncoder().encode(JSON.stringify(message)))}`;
}

describe('a connect link', () => {
  it("asks exactly as for a website with the callback's origin, and answers with Bread's response", async () => {
    const { link, connection } = startConnect(CALLBACK, PERMISSION_REQUEST);
    mockProcessDApp.mockResolvedValueOnce(PERMISSION_RESPONSE);

    const answer = await answerRequestLink(link, { now: NOW });

    expect(mockProcessDApp).toHaveBeenCalledWith(ORIGIN, PERMISSION_REQUEST);
    expect(answer?.callback).toBe(CALLBACK);
    expect(connectedAnswer(answer!, connection).answer).toEqual({ response: PERMISSION_RESPONSE });
  });

  it('keeps the session only when asked, and drops that session alone', async () => {
    mockProcessDApp.mockResolvedValue(PERMISSION_RESPONSE);
    const earlier = startConnect(CALLBACK, PERMISSION_REQUEST);
    const earlierAnswer = await answerRequestLink(earlier.link, { now: NOW });
    await earlierAnswer?.keep?.();
    const kept = connectedAnswer(earlierAnswer!, earlier.connection).session.session;
    const { link, connection } = startConnect(CALLBACK, PERMISSION_REQUEST);
    const answer = await answerRequestLink(link, { now: NOW });
    expect(Object.keys(mockStore.get('bread_connect_sessions') as object)).toEqual([kept]);

    await answer?.keep?.();

    const { session } = connectedAnswer(answer!, connection);
    expect(mockStore.get('bread_connect_sessions')).toEqual({
      [kept]: expect.objectContaining({ session: kept }),
      [session.session]: expect.objectContaining({
        session: session.session,
        callback: CALLBACK,
        origin: ORIGIN,
        answered: []
      })
    });

    await answer?.drop?.();

    expect(Object.keys(mockStore.get('bread_connect_sessions') as object)).toEqual([kept]);
  });

  it.each([
    ['a refusal', new Error('NOT_GRANTED'), { code: 'NOT_GRANTED', message: 'NOT_GRANTED' }],
    [
      'a refusal with details after its code, without them',
      new Error('NOT_GRANTED: Wallet is locked'),
      { code: 'NOT_GRANTED', message: 'NOT_GRANTED' }
    ],
    [
      'a network Bread does not serve',
      new Error('NETWORK_NOT_GRANTED'),
      { code: 'NETWORK_NOT_GRANTED', message: 'NETWORK_NOT_GRANTED' }
    ],
    [
      'a wallet code the protocol lacks as an internal error',
      new Error('LOGIN_KEY_UNAVAILABLE'),
      { code: 'INTERNAL_ERROR', message: 'Bread could not complete the request' }
    ],
    [
      'any other failure, without its text',
      new Error('vault exploded at /data/x'),
      { code: 'INTERNAL_ERROR', message: 'Bread could not complete the request' }
    ]
  ])('answers %s sealed and keeps nothing', async (_name, thrown, error) => {
    const { link, connection } = startConnect(CALLBACK, PERMISSION_REQUEST);
    mockProcessDApp.mockRejectedValueOnce(thrown);

    const answer = await answerRequestLink(link, { now: NOW });

    expect(connectedAnswer(answer!, connection).answer).toEqual({ error });
    expect(answer?.keep).toBeUndefined();
    expect(answer?.drop).toBeUndefined();
  });

  it('answers an empty response as an internal error', async () => {
    const { link, connection } = startConnect(CALLBACK, PERMISSION_REQUEST);
    mockProcessDApp.mockResolvedValueOnce(undefined);

    const answer = await answerRequestLink(link, { now: NOW });

    expect(connectedAnswer(answer!, connection).answer).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Bread could not complete the request' }
    });
  });
});

describe('a request link', () => {
  it('asks exactly as for a website with the session origin, and answers sealed to the session callback', async () => {
    const session = await connected();
    const { link } = sendRequest(session, SIGN_REQUEST, NOW);
    mockProcessDApp.mockResolvedValueOnce({ type: 'SIGN_RESPONSE', signature: 'c2ln' });

    const answer = await answerRequestLink(link, { now: NOW });

    expect(mockProcessDApp).toHaveBeenCalledWith(ORIGIN, SIGN_REQUEST, undefined, NOW + REQUEST_MAX_AGE_MS);
    expect(answer?.callback).toBe(CALLBACK);
    expect(answer?.sentTransaction).toBeUndefined();
    expect(requestAnswer(answer!, session)).toEqual({ response: { type: 'SIGN_RESPONSE', signature: 'c2ln' } });
  });

  it('finishes an approved transaction before answering, with its outcome', async () => {
    const session = await connected();
    const { link } = sendRequest(session, SEND_REQUEST, NOW);
    const output = { txHash: '0xabc', outputNotes: ['0xnote'] };
    mockProcessDApp
      .mockResolvedValueOnce({ type: 'SEND_TRANSACTION_RESPONSE', transactionId: 'tx-1' })
      .mockResolvedValueOnce({ type: 'WAIT_FOR_TRANSACTION_RESPONSE', transactionOutput: output });
    const onTransactionSent = jest.fn();

    const answer = await answerRequestLink(link, { now: NOW, onTransactionSent });

    expect(mockProcessDApp).toHaveBeenLastCalledWith(ORIGIN, { type: 'WAIT_FOR_TRANSACTION_REQUEST', txId: 'tx-1' });
    expect(onTransactionSent).toHaveBeenCalledWith(CALLBACK);
    expect(answer?.sentTransaction).toBe(true);
    expect(requestAnswer(answer!, session)).toEqual({
      response: { type: 'SEND_TRANSACTION_RESPONSE', transactionId: 'tx-1' },
      transaction: { output }
    });
  });

  it.each([
    ['failed', { status: ITransactionStatus.Failed }, 'TRANSACTION_FAILED'],
    ['still queued', { status: ITransactionStatus.Queued }, 'TRANSACTION_TIMEOUT'],
    ['still generating', { status: ITransactionStatus.GeneratingTransaction }, 'TRANSACTION_TIMEOUT'],
    ['waiting for the node', { status: ITransactionStatus.Unconfirmed }, 'TRANSACTION_TIMEOUT'],
    ['landed without a result', { status: ITransactionStatus.Completed }, 'TRANSACTION_TIMEOUT']
  ])('tells a transaction that %s from the wait', async (_name, row, code) => {
    const session = await connected();
    const { link } = sendRequest(session, SEND_REQUEST, NOW);
    mockProcessDApp
      .mockResolvedValueOnce({ type: 'SEND_TRANSACTION_RESPONSE', transactionId: 'tx-1' })
      .mockResolvedValueOnce({ type: 'WAIT_FOR_TRANSACTION_RESPONSE', transactionOutput: { errorMessage: 'no luck' } });
    mockGetTransactionById.mockResolvedValueOnce(row);

    const answer = await answerRequestLink(link, { now: NOW });

    expect(mockGetTransactionById).toHaveBeenCalledWith('tx-1');
    expect(requestAnswer(answer!, session)).toMatchObject({ transaction: { error: { code, message: 'no luck' } } });
  });

  it.each([
    ['is gone', new Error('Transaction not found')],
    ['cannot be read', new Error('The database connection is closing')]
  ])('answers an unknown outcome when the transaction row %s', async (_name, lookup) => {
    const session = await connected();
    const { link } = sendRequest(session, SEND_REQUEST, NOW);
    mockProcessDApp
      .mockResolvedValueOnce({ type: 'SEND_TRANSACTION_RESPONSE', transactionId: 'tx-1' })
      .mockResolvedValueOnce({ type: 'WAIT_FOR_TRANSACTION_RESPONSE', transactionOutput: { errorMessage: 'gone' } });
    mockGetTransactionById.mockRejectedValueOnce(lookup);

    const answer = await answerRequestLink(link, { now: NOW });

    expect(requestAnswer(answer!, session)).toMatchObject({
      transaction: { error: { code: 'TRANSACTION_TIMEOUT', message: 'gone' } }
    });
  });

  it.each([
    [
      'refuses',
      () => Promise.reject(new Error('NOT_GRANTED')),
      { code: 'TRANSACTION_TIMEOUT', message: 'NOT_GRANTED' }
    ],
    [
      'answers nothing',
      () => Promise.resolve(undefined),
      { code: 'TRANSACTION_TIMEOUT', message: "Bread could not learn the transaction's outcome" }
    ]
  ])('answers an unknown outcome when the wait %s', async (_name, wait, error) => {
    const session = await connected();
    const { link } = sendRequest(session, SEND_REQUEST, NOW);
    mockProcessDApp
      .mockResolvedValueOnce({ type: 'SEND_TRANSACTION_RESPONSE', transactionId: 'tx-1' })
      .mockImplementationOnce(wait);

    const answer = await answerRequestLink(link, { now: NOW });

    expect(requestAnswer(answer!, session)).toMatchObject({ transaction: { error } });
  });

  it('answers a transaction response without an id at once, still marked as sent', async () => {
    const session = await connected();
    const { link } = sendRequest(session, SEND_REQUEST, NOW);
    mockProcessDApp.mockResolvedValueOnce({ type: 'SEND_TRANSACTION_RESPONSE' });
    const onTransactionSent = jest.fn();

    const answer = await answerRequestLink(link, { now: NOW, onTransactionSent });

    expect(mockProcessDApp).toHaveBeenCalledTimes(1);
    expect(onTransactionSent).not.toHaveBeenCalled();
    expect(answer?.sentTransaction).toBe(true);
    expect(requestAnswer(answer!, session)).toEqual({ response: { type: 'SEND_TRANSACTION_RESPONSE' } });
  });

  it.each([
    ['TRANSACTION_REQUEST', 'TRANSACTION_RESPONSE'],
    ['SEND_TRANSACTION_REQUEST', 'SEND_TRANSACTION_RESPONSE'],
    ['CONSUME_REQUEST', 'CONSUME_RESPONSE']
  ])(
    'answers a %s the wallet may have queued with its id and an unknown outcome, marked as sent',
    async (type, responseType) => {
      const session = await connected();
      const { link } = sendRequest(session, { type }, NOW);
      const queued = new TransactionQueuedError('tx-1', { cause: new Error('write parked') });
      mockProcessDApp.mockRejectedValueOnce(
        new Error('OUTCOME_UNKNOWN: transaction tx-1 may already be queued; wait for it before sending again', {
          cause: queued
        })
      );
      const onTransactionSent = jest.fn();

      const answer = await answerRequestLink(link, { now: NOW, onTransactionSent });

      expect(mockProcessDApp).toHaveBeenCalledTimes(1);
      expect(onTransactionSent).not.toHaveBeenCalled();
      expect(answer?.sentTransaction).toBe(true);
      expect(requestAnswer(answer!, session)).toEqual({
        response: { type: responseType, transactionId: 'tx-1' },
        transaction: {
          error: { code: 'TRANSACTION_TIMEOUT', message: "Bread could not learn the transaction's outcome" }
        }
      });
    }
  );

  it('answers a transaction the wallet cannot tell was sent with a sealed timeout, marked as sent', async () => {
    const session = await connected();
    const { link } = sendRequest(session, SEND_REQUEST, NOW);
    mockProcessDApp.mockRejectedValueOnce(
      new Error(
        'OUTCOME_UNKNOWN: the wallet could not confirm whether the transaction was queued; check before sending again'
      )
    );

    const answer = await answerRequestLink(link, { now: NOW });

    expect(answer?.sentTransaction).toBe(true);
    expect(requestAnswer(answer!, session)).toEqual({
      error: { code: 'TRANSACTION_TIMEOUT', message: 'Bread could not tell whether the transaction was sent' }
    });
  });

  it.each([
    ['refusal', () => Promise.reject(new Error('NOT_GRANTED')), { code: 'NOT_GRANTED', message: 'NOT_GRANTED' }],
    [
      'refusal with details after its code, without them,',
      () => Promise.reject(new Error('INVALID_PARAMS: senderAddress is required')),
      { code: 'INVALID_PARAMS', message: 'INVALID_PARAMS' }
    ],
    [
      'unknown outcome, for a request that sends no transaction, as an internal error',
      () => Promise.reject(new Error('OUTCOME_UNKNOWN')),
      { code: 'INTERNAL_ERROR', message: 'Bread could not complete the request' }
    ],
    [
      'empty response',
      () => Promise.resolve(undefined),
      { code: 'INTERNAL_ERROR', message: 'Bread could not complete the request' }
    ]
  ])("answers Bread's %s sealed", async (_name, outcome, error) => {
    const session = await connected();
    const { link } = sendRequest(session, SIGN_REQUEST, NOW);
    mockProcessDApp.mockImplementationOnce(outcome);

    const answer = await answerRequestLink(link, { now: NOW });

    expect(requestAnswer(answer!, session)).toEqual({ error });
  });

  it('answers a response longer than a link carries with a sealed internal error', async () => {
    const session = await connected();
    const { link } = sendRequest(session, { type: 'PRIVATE_NOTES_REQUEST', notefilterType: 'all' }, NOW);
    mockProcessDApp.mockResolvedValueOnce({
      type: 'PRIVATE_NOTES_RESPONSE',
      privateNotes: [{ noteId: 'n'.repeat(MAX_MESSAGE_LENGTH) }]
    });

    const answer = await answerRequestLink(link, { now: NOW });

    expect(messageLength(answer!.link)).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(requestAnswer(answer!, session)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: "Bread's answer is longer than a link carries" }
    });
  });

  it('answers a transaction whose outcome is longer than a link carries with its id and a timeout', async () => {
    const session = await connected();
    const { link } = sendRequest(session, SEND_REQUEST, NOW);
    mockProcessDApp
      .mockResolvedValueOnce({ type: 'SEND_TRANSACTION_RESPONSE', transactionId: 'tx-1' })
      .mockResolvedValueOnce({
        type: 'WAIT_FOR_TRANSACTION_RESPONSE',
        transactionOutput: { txHash: '0xabc', outputNotes: ['n'.repeat(MAX_MESSAGE_LENGTH)] }
      });

    const answer = await answerRequestLink(link, { now: NOW });

    expect(messageLength(answer!.link)).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(answer?.sentTransaction).toBe(true);
    expect(requestAnswer(answer!, session)).toEqual({
      response: { type: 'SEND_TRANSACTION_RESPONSE', transactionId: 'tx-1' },
      transaction: {
        error: { code: 'TRANSACTION_TIMEOUT', message: "The transaction's outcome is longer than a link carries" }
      }
    });
  });

  it('refuses a request id it already answered, without asking again', async () => {
    const session = await connected();
    const { link } = sendRequest(session, SIGN_REQUEST, NOW);
    mockProcessDApp.mockResolvedValue({ type: 'SIGN_RESPONSE', signature: 'c2ln' });
    await answerRequestLink(link, { now: NOW });

    const again = await answerRequestLink(link, { now: NOW + 1_000 });

    expect(mockProcessDApp).toHaveBeenCalledTimes(1);
    expect(requestAnswer(again!, session)).toEqual({
      error: { code: 'DUPLICATE_REQUEST', message: 'Bread already answered this request' }
    });
  });

  it.each([
    ['sent more than ten minutes ago', NOW - 10 * 60 * 1000 - 1],
    ['sent more than a minute ahead of Bread', NOW + 60 * 1000 + 1]
  ])('refuses a request %s', async (_name, sentAt) => {
    const session = await connected();
    const { link } = sendRequest(session, SIGN_REQUEST, sentAt);

    const answer = await answerRequestLink(link, { now: NOW });

    expect(mockProcessDApp).not.toHaveBeenCalled();
    expect(requestAnswer(answer!, session)).toEqual({
      error: { code: 'REQUEST_EXPIRED', message: 'The request is too old, or from a clock far ahead' }
    });
  });

  it("refuses a request whose turn in Bread's queue comes after its age limit", async () => {
    const session = await connected();
    const sentAt = NOW - 60 * 1000;
    mockProcessDApp.mockRejectedValueOnce(new DAppQueueDeadlineError('late'));

    const answer = await answerRequestLink(sendRequest(session, SIGN_REQUEST, sentAt).link, { now: NOW });

    expect(mockProcessDApp).toHaveBeenCalledWith(ORIGIN, SIGN_REQUEST, undefined, sentAt + REQUEST_MAX_AGE_MS);
    expect(requestAnswer(answer!, session)).toEqual({
      error: { code: 'REQUEST_EXPIRED', message: 'The request waited too long behind other requests in Bread' }
    });
  });

  it('answers a request at the edges of the age limit', async () => {
    const session = await connected();
    mockProcessDApp.mockResolvedValue({ type: 'SIGN_RESPONSE', signature: 'c2ln' });

    for (const sentAt of [NOW - 10 * 60 * 1000, NOW + 60 * 1000]) {
      const answer = await answerRequestLink(sendRequest(session, SIGN_REQUEST, sentAt).link, { now: NOW });
      expect(requestAnswer(answer!, session)).toEqual({ response: { type: 'SIGN_RESPONSE', signature: 'c2ln' } });
    }
  });

  it.each([
    'PERMISSION_REQUEST',
    'DISCONNECT_REQUEST',
    'GET_CURRENT_PERMISSION_REQUEST',
    'WAIT_FOR_TRANSACTION_REQUEST'
  ])('refuses %s, which is not one of the methods', async type => {
    const session = await connected();
    const { link } = sendRequest(session, { type }, NOW);

    const answer = await answerRequestLink(link, { now: NOW });

    expect(mockProcessDApp).not.toHaveBeenCalled();
    expect(requestAnswer(answer!, session)).toEqual({
      error: { code: 'UNSUPPORTED_METHOD', message: `Bread does not answer ${type} here` }
    });
  });

  it("answers an unknown session unsealed to the envelope's callback", async () => {
    const session = await connected();
    const { link, id } = sendRequest({ ...session, session: 'AAAAAAAAAAAAAAAAAAAAAA' }, SIGN_REQUEST, NOW);

    const answer = await answerRequestLink(link, { now: NOW });

    expect(answer?.callback).toBe(CALLBACK);
    expect(unsealedError(answer)).toEqual({
      type: 'error',
      id,
      error: { code: 'SESSION_NOT_FOUND', message: 'Bread has no such session' }
    });
  });

  it("forgets a session whose app's permission the user removed", async () => {
    const session = await connected();
    mockDApps = {};

    const answer = await answerRequestLink(sendRequest(session, SIGN_REQUEST, NOW).link, { now: NOW });

    expect(unsealedError(answer).error.code).toBe('SESSION_NOT_FOUND');
    expect(mockStore.get('bread_connect_sessions')).toEqual({});
  });

  it('forgets a session unused for thirty days, and keeps one used within them', async () => {
    const session = await connected();
    const used = await answerRequestLink(sendRequest(session, { type: 'NOT_A_METHOD' }, NOW).link, { now: NOW });
    expect(requestAnswer(used!, session)).toMatchObject({ error: { code: 'UNSUPPORTED_METHOD' } });

    const later = NOW + SESSION_IDLE_MS;
    const kept = await answerRequestLink(sendRequest(session, { type: 'NOT_A_METHOD' }, later).link, { now: later });
    expect(requestAnswer(kept!, session)).toMatchObject({ error: { code: 'UNSUPPORTED_METHOD' } });

    const idle = later + SESSION_IDLE_MS + 1;
    const gone = await answerRequestLink(sendRequest(session, SIGN_REQUEST, idle).link, { now: idle });
    expect(unsealedError(gone).error.code).toBe('SESSION_NOT_FOUND');
  });

  it('drops a request whose seal does not open for the session', async () => {
    const session = await connected();
    const forged = sendRequest(
      { ...session, appSecretKey: startConnect(CALLBACK, PERMISSION_REQUEST).connection.appSecretKey },
      SIGN_REQUEST,
      NOW
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await answerRequestLink(forged.link, { now: NOW })).toBeNull();
      expect(mockProcessDApp).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('answers only to the callback the session was made with', async () => {
    const session = await connected();
    const { link } = sendRequest({ ...session, callback: 'https://other.example/bread' }, SIGN_REQUEST, NOW);
    mockProcessDApp.mockResolvedValueOnce({ type: 'SIGN_RESPONSE', signature: 'c2ln' });

    const answer = await answerRequestLink(link, { now: NOW });

    expect(answer?.callback).toBe(CALLBACK);
    expect(answer?.link.startsWith(`${CALLBACK}#`)).toBe(true);
  });
});

describe('a link Bread cannot answer normally', () => {
  const id = 'AAAAAAAAAAAAAAAAAAAAAA';

  it('answers another version unsealed when it names a callback', async () => {
    const answer = await answerRequestLink(messageLink('2', { callback: CALLBACK, id }), { now: NOW });

    expect(unsealedError(answer)).toEqual({
      type: 'error',
      id,
      error: { code: 'UNSUPPORTED_VERSION', message: 'Bread speaks version 1 of the protocol' }
    });
  });

  it('answers a malformed message unsealed when it names a callback', async () => {
    const answer = await answerRequestLink(messageLink('1', { type: 'connect', callback: CALLBACK, id }), { now: NOW });

    expect(unsealedError(answer)).toEqual({
      type: 'error',
      id,
      error: { code: 'INVALID_REQUEST', message: 'Bread could not read the request' }
    });
  });

  it.each([
    ['a malformed message without a callback', messageLink('1', { type: 'connect', id })],
    ['a link for another receiver', `${CALLBACK}#v=1&m=e30`],
    ['an answer meant for an app', messageLink('1', { type: 'error', error: { code: 'NOT_GRANTED', message: 'no' } })]
  ])('drops %s', async (_name, link) => {
    expect(await answerRequestLink(link, { now: NOW })).toBeNull();
  });
});
