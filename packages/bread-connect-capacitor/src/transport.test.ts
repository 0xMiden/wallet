import {
  ANSWER_WAIT_MS,
  answerConnect,
  answerRequest,
  BREAD_REQUEST_URL,
  ConnectAnswer,
  DAppMessage,
  errorLink,
  openRequest,
  readLink,
  REQUEST_MAX_AGE_MS,
  RequestAnswer,
  WalletSession,
  writeLink
} from '@miden-sdk/bread-connect';

import { KeyValueStorage } from './storage.js';
import { AppSwitchTransport, BreadConnectError, LinkSource } from './transport.js';

const CALLBACK = 'https://game.example/bread';
const PERMISSION_REQUEST: DAppMessage = { type: 'PERMISSION_REQUEST', appMeta: { name: 'Game' }, network: 'testnet' };
const PERMISSION_RESPONSE: DAppMessage = { type: 'PERMISSION_RESPONSE', accountId: 'acc', publicKey: 'AQID' };

class MemoryStorage implements KeyValueStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** A store that throws for the calls in `failing`, as a full or unavailable localStorage does. */
class FailingStorage extends MemoryStorage {
  readonly failing = new Set<string>();
  getItem(key: string): string | null {
    if (this.failing.has(`get ${key}`)) throw new Error('storage unavailable');
    return super.getItem(key);
  }
  setItem(key: string, value: string): void {
    if (this.failing.has(`set ${key}`)) throw new Error('QuotaExceededError');
    super.setItem(key, value);
  }
  removeItem(key: string): void {
    if (this.failing.has(`remove ${key}`)) throw new Error('storage unavailable');
    super.removeItem(key);
  }
}

/** Bread's side of the protocol, answering every request with `answer`. */
function fakeBread(answer: (request: DAppMessage) => ConnectAnswer | RequestAnswer) {
  const sessions = new Map<string, WalletSession>();
  return {
    sessions,
    open(link: string): string {
      const read = readLink(link, BREAD_REQUEST_URL);
      if (read?.kind !== 'envelope') throw new Error(`Bread cannot read ${link}`);
      const envelope = read.envelope;
      if (envelope.type === 'connect') {
        const result = answer(envelope.request);
        const reply = 'response' in result ? { response: result.response } : result;
        const answered = answerConnect(envelope, reply);
        if ('response' in reply) sessions.set(answered.session.session, answered.session);
        return answered.link;
      }
      if (envelope.type === 'request') {
        const session = sessions.get(envelope.session);
        if (!session) return errorLink(envelope.callback, { code: 'SESSION_NOT_FOUND', message: 'gone' }, envelope.id);
        return answerRequest(envelope, session, answer(openRequest(envelope, session).request));
      }
      throw new Error(`Bread does not take ${envelope.type}`);
    }
  };
}

function harness({
  installed = true,
  launch,
  storage = new MemoryStorage()
}: { installed?: boolean; launch?: string; storage?: MemoryStorage } = {}) {
  let listener: ((url: string) => void) | null = null;
  const links: LinkSource = {
    launchUrl: jest.fn(async () => launch),
    onUrl: jest.fn((next: (url: string) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    })
  };
  const opened: string[] = [];
  const openWallet = jest.fn(async (link: string) => {
    opened.push(link);
    return installed;
  });
  const clock = { now: 1_000_000 };
  const options = { callback: CALLBACK, storage, links, openWallet, now: () => clock.now };
  const transport = new AppSwitchTransport(options);
  return {
    transport,
    storage,
    links,
    opened,
    openWallet,
    clock,
    options,
    deliver: (url: string) => listener?.(url),
    listening: () => listener !== null
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** Whether `promise` has settled once pending work has run. */
const settled = (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(
      () => 'resolved',
      () => 'rejected'
    ),
    flush().then(() => 'pending')
  ]);

const approve = (request: DAppMessage): ConnectAnswer | RequestAnswer => {
  if (request.type === 'PERMISSION_REQUEST') return { response: PERMISSION_RESPONSE };
  if (request.type === 'SEND_TRANSACTION_REQUEST') {
    return {
      response: { type: 'SEND_TRANSACTION_RESPONSE', transactionId: 'tx-1' },
      transaction: { output: { txHash: '0xabc', outputNotes: [] } }
    };
  }
  return { response: { type: 'SIGN_RESPONSE', signature: 'c2ln' } };
};

async function connected(bread = fakeBread(approve), storage = new MemoryStorage()) {
  const h = harness({ storage });
  const answer = h.transport.connect(PERMISSION_REQUEST);
  await flush();
  h.deliver(bread.open(h.opened[0]!));
  await answer;
  return { ...h, bread };
}

afterEach(() => {
  jest.useRealTimers();
});

describe('AppSwitchTransport', () => {
  it('connects through Bread and keeps the session with the request it answered', async () => {
    const h = harness();
    const answer = h.transport.connect(PERMISSION_REQUEST);
    await flush();
    expect(h.opened).toHaveLength(1);
    expect(h.storage.getItem('bread-connect:pending')).not.toBeNull();
    h.deliver(fakeBread(approve).open(h.opened[0]!));
    await expect(answer).resolves.toEqual(PERMISSION_RESPONSE);
    expect(h.transport.session()).toMatchObject({ request: PERMISSION_REQUEST, permission: PERMISSION_RESPONSE });
    expect(h.storage.getItem('bread-connect:pending')).toBeNull();
    h.transport.stop();
  });

  it('restores no session opened for another callback, so connect asks Bread again', async () => {
    const h = await connected();
    h.transport.stop();
    const moved = new AppSwitchTransport({ ...h.options, callback: 'https://game.example/bread2' });

    expect(moved.session()).toBeNull();
    await expect(moved.request({ type: 'SIGN_REQUEST' })).rejects.toMatchObject({ code: 'NOT_GRANTED' });
    const answer = moved.connect(PERMISSION_REQUEST);
    await flush();
    expect(h.opened).toHaveLength(2);
    moved.cancelPending();
    await expect(answer).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('sends a request in the session and keeps the outcome Bread reported with a transaction', async () => {
    const h = await connected();
    const answer = h.transport.request({ type: 'SEND_TRANSACTION_REQUEST', transaction: {} });
    await flush();
    h.deliver(h.bread.open(h.opened[1]!));
    await expect(answer).resolves.toEqual({ type: 'SEND_TRANSACTION_RESPONSE', transactionId: 'tx-1' });
    expect(h.transport.transactionOutcome('tx-1')).toEqual({ output: { txHash: '0xabc', outputNotes: [] } });
    expect(h.transport.transactionOutcome('tx-2')).toBeUndefined();

    const signed = h.transport.request({ type: 'SIGN_REQUEST' });
    await flush();
    h.deliver(h.bread.open(h.opened[2]!));
    await expect(signed).resolves.toEqual({ type: 'SIGN_RESPONSE', signature: 'c2ln' });
    h.transport.stop();
  });

  it("rejects with Bread's error code, and keeps no session for a refused connection", async () => {
    const h = harness();
    const answer = h.transport.connect(PERMISSION_REQUEST);
    await flush();
    h.deliver(fakeBread(() => ({ error: { code: 'NOT_GRANTED', message: 'declined' } })).open(h.opened[0]!));
    await expect(answer).rejects.toBeInstanceOf(BreadConnectError);
    await expect(answer).rejects.toMatchObject({ code: 'NOT_GRANTED', message: 'declined' });
    expect(h.transport.session()).toBeNull();
  });

  it('marks the session for a recheck once Bread refuses a request in it with NOT_GRANTED', async () => {
    let code: 'INVALID_PARAMS' | 'NOT_GRANTED' = 'INVALID_PARAMS';
    const h = await connected(
      fakeBread(request =>
        request.type === 'PERMISSION_REQUEST' ? approve(request) : { error: { code, message: 'refused' } }
      )
    );
    const invalid = h.transport.request({ type: 'SIGN_REQUEST' });
    await flush();
    h.deliver(h.bread.open(h.opened[1]!));
    await expect(invalid).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(h.transport.session()?.recheck).toBeUndefined();

    code = 'NOT_GRANTED';
    const refused = h.transport.request({ type: 'SIGN_REQUEST' });
    await flush();
    h.deliver(h.bread.open(h.opened[2]!));
    await expect(refused).rejects.toMatchObject({ code: 'NOT_GRANTED' });
    expect(h.transport.session()).toMatchObject({ permission: PERMISSION_RESPONSE, recheck: true });
    h.transport.stop();
  });

  it('settles a refusal it cannot mark on the session', async () => {
    const storage = new FailingStorage();
    const h = await connected(
      fakeBread(request =>
        request.type === 'PERMISSION_REQUEST' ? approve(request) : { error: { code: 'NOT_GRANTED', message: 'no' } }
      ),
      storage
    );
    storage.failing.add('set bread-connect:session');
    const refused = h.transport.request({ type: 'SIGN_REQUEST' });
    await flush();
    h.deliver(h.bread.open(h.opened[1]!));
    await expect(refused).rejects.toMatchObject({ code: 'NOT_GRANTED' });
    expect(h.transport.session()?.recheck).toBeUndefined();
    h.transport.stop();
  });

  it('rejects when Bread is not installed or cannot be opened', async () => {
    const missing = harness({ installed: false });
    await expect(missing.transport.connect(PERMISSION_REQUEST)).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
    expect(missing.storage.getItem('bread-connect:pending')).toBeNull();

    const broken = harness();
    broken.openWallet.mockRejectedValueOnce(new Error('no activity'));
    await expect(broken.transport.connect(PERMISSION_REQUEST)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('refuses a request without a session', async () => {
    const h = harness();
    await expect(h.transport.request({ type: 'SIGN_REQUEST' })).rejects.toMatchObject({ code: 'NOT_GRANTED' });
    expect(h.opened).toHaveLength(0);
  });

  it('replaces the waiting request with a newer one, and cancels on request', async () => {
    const h = harness();
    const first = h.transport.connect(PERMISSION_REQUEST);
    const second = h.transport.connect(PERMISSION_REQUEST);
    await expect(first).rejects.toMatchObject({ code: 'SUPERSEDED' });
    h.transport.cancelPending();
    await expect(second).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('gives up when Bread does not answer in time', async () => {
    jest.useFakeTimers();
    const h = harness();
    const failure = h.transport.connect(PERMISSION_REQUEST).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    await expect(failure).resolves.toMatchObject({ code: 'TIMEOUT' });
  });

  it('still takes an answer after the ten minutes Bread accepts the request for', async () => {
    jest.useFakeTimers();
    const h = harness();
    const answer = h.transport.connect(PERMISSION_REQUEST);
    await jest.advanceTimersByTimeAsync(REQUEST_MAX_AGE_MS + 1);
    h.deliver(fakeBread(approve).open(h.opened[0]!));
    await expect(answer).resolves.toEqual(PERMISSION_RESPONSE);
  });

  it("drops links that are not Bread's answer to the waiting request", async () => {
    const h = await connected();
    const answer = h.transport.request({ type: 'SIGN_REQUEST' });
    await flush();
    const reply = h.bread.open(h.opened[1]!);
    h.deliver('https://game.example/other#v=1&m=AA');
    h.deliver(`${CALLBACK}#v=9&m=AA`);
    h.deliver(errorLink(CALLBACK, { code: 'SESSION_NOT_FOUND', message: 'forged' }));
    h.deliver(errorLink(CALLBACK, { code: 'SESSION_NOT_FOUND', message: 'forged' }, 'AAAAAAAAAAAAAAAAAAAAAA'));
    const [base, fragment] = reply.split('#v=1&m=');
    h.deliver(`${base}#v=1&m=${fragment!.slice(0, -4)}AAAA`);
    const other = harness();
    const otherAnswer = other.transport.connect(PERMISSION_REQUEST);
    await flush();
    h.deliver(fakeBread(approve).open(other.opened[0]!));
    other.transport.cancelPending();
    await expect(otherAnswer).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(h.transport.session()).not.toBeNull();

    h.deliver(reply);
    await expect(answer).resolves.toEqual({ type: 'SIGN_RESPONSE', signature: 'c2ln' });
    h.transport.stop();
  });

  it('drops an answer whose seal does not open, and one for a session the app no longer holds', async () => {
    const h = await connected();
    const answer = h.transport.request({ type: 'SIGN_REQUEST' });
    await flush();
    const reply = h.bread.open(h.opened[1]!);
    const read = readLink(reply, CALLBACK);
    if (read?.kind !== 'envelope' || read.envelope.type !== 'response') throw new Error('no response');
    const { sealed } = read.envelope;
    h.deliver(
      writeLink(CALLBACK, { ...read.envelope, sealed: `${sealed.startsWith('A') ? 'B' : 'A'}${sealed.slice(1)}` })
    );
    const stored = h.storage.getItem('bread-connect:session');
    h.transport.forgetSession();
    h.deliver(reply);
    h.storage.setItem('bread-connect:session', stored!);
    h.deliver(reply);
    await expect(answer).resolves.toEqual({ type: 'SIGN_RESPONSE', signature: 'c2ln' });
    h.transport.stop();
  });

  it("rejects on Bread's unsealed error for the waiting request, and forgets a session Bread does not know", async () => {
    const h = await connected();
    h.bread.sessions.clear();
    const answer = h.transport.request({ type: 'SIGN_REQUEST' });
    await flush();
    h.deliver(h.bread.open(h.opened[1]!));
    await expect(answer).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(h.transport.session()).toBeNull();

    const connecting = h.transport.connect(PERMISSION_REQUEST);
    await flush();
    const connect = readLink(h.opened[2]!, BREAD_REQUEST_URL);
    if (connect?.kind !== 'envelope' || connect.envelope.type !== 'connect') throw new Error('no connect');
    h.deliver(errorLink(CALLBACK, { code: 'UNSUPPORTED_VERSION', message: 'old' }, connect.envelope.id));
    await expect(connecting).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });
  });

  describe('when the store fails while it takes an answer', () => {
    // The platform reports an exception from its link listener and carries on, so a throw is no answer.
    const deliver = (h: ReturnType<typeof harness>, url: string) => {
      try {
        h.deliver(url);
      } catch {
        // dropped, as the listener dispatch drops it
      }
    };

    it('ends a connect whose session cannot be kept with INTERNAL_ERROR at once', async () => {
      const storage = new FailingStorage();
      storage.failing.add('set bread-connect:session');
      const h = harness({ storage });
      const answer = h.transport.connect(PERMISSION_REQUEST);
      await flush();
      deliver(h, fakeBread(approve).open(h.opened[0]!));
      expect(await settled(answer)).toBe('rejected');
      await expect(answer).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    });

    it('still answers a transaction whose outcome cannot be kept', async () => {
      const storage = new FailingStorage();
      const h = await connected(fakeBread(approve), storage);
      storage.failing.add('set bread-connect:outcomes');
      const answer = h.transport.request({ type: 'SEND_TRANSACTION_REQUEST', transaction: {} });
      await flush();
      deliver(h, h.bread.open(h.opened[1]!));
      expect(await settled(answer)).toBe('resolved');
      await expect(answer).resolves.toEqual({ type: 'SEND_TRANSACTION_RESPONSE', transactionId: 'tx-1' });
      h.transport.stop();
    });

    it('drops a link it cannot authenticate while its session cannot be read, and takes the answer once it can', async () => {
      const storage = new FailingStorage();
      const h = await connected(fakeBread(approve), storage);
      const answer = h.transport.request({ type: 'SIGN_REQUEST' });
      await flush();
      const reply = h.bread.open(h.opened[1]!);
      const read = readLink(reply, CALLBACK);
      if (read?.kind !== 'envelope' || read.envelope.type !== 'response') throw new Error('no response');
      const { sealed } = read.envelope;
      const forged = writeLink(CALLBACK, {
        ...read.envelope,
        sealed: `${sealed.startsWith('A') ? 'B' : 'A'}${sealed.slice(1)}`
      });
      storage.failing.add('get bread-connect:session');
      deliver(h, forged);
      expect(await settled(answer)).toBe('pending');
      storage.failing.delete('get bread-connect:session');
      deliver(h, reply);
      await expect(answer).resolves.toEqual({ type: 'SIGN_RESPONSE', signature: 'c2ln' });
      h.transport.stop();
    });

    it('settles an answer when the pending record cannot be cleared', async () => {
      const storage = new FailingStorage();
      const h = await connected(fakeBread(approve), storage);
      const answer = h.transport.request({ type: 'SIGN_REQUEST' });
      await flush();
      storage.failing.add('remove bread-connect:pending');
      deliver(h, h.bread.open(h.opened[1]!));
      expect(await settled(answer)).toBe('resolved');
      h.transport.stop();
    });

    it('takes no late answer to a connect it cancelled while its pending record could not be removed', async () => {
      const storage = new FailingStorage();
      storage.failing.add('remove bread-connect:pending');
      const h = harness({ storage });
      const answer = h.transport.connect(PERMISSION_REQUEST);
      await flush();
      h.transport.cancelPending();
      await expect(answer).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(storage.items.has('bread-connect:pending')).toBe(true);
      deliver(h, fakeBread(approve).open(h.opened[0]!));
      expect(h.transport.session()).toBeNull();
      h.transport.stop();
    });

    it("settles Bread's unsealed SESSION_NOT_FOUND when the session cannot be forgotten", async () => {
      const storage = new FailingStorage();
      const h = await connected(fakeBread(approve), storage);
      h.bread.sessions.clear();
      const answer = h.transport.request({ type: 'SIGN_REQUEST' });
      await flush();
      storage.failing.add('remove bread-connect:session');
      deliver(h, h.bread.open(h.opened[1]!));
      expect(await settled(answer)).toBe('rejected');
      await expect(answer).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
      h.transport.stop();
    });
  });

  it('completes a connection and records an outcome from the link that relaunches the app', async () => {
    const bread = fakeBread(approve);
    const before = harness();
    void before.transport.connect(PERMISSION_REQUEST).catch(() => undefined);
    await flush();
    const relaunched = new AppSwitchTransport({
      ...before.options,
      links: { launchUrl: async () => bread.open(before.opened[0]!), onUrl: () => () => undefined }
    });
    await relaunched.start();
    expect(relaunched.session()).toMatchObject({ permission: PERMISSION_RESPONSE });
    expect(before.storage.getItem('bread-connect:pending')).toBeNull();

    void relaunched.request({ type: 'SEND_TRANSACTION_REQUEST' }).catch(() => undefined);
    await flush();
    const link = before.openWallet.mock.calls.at(-1)![0];
    const again = new AppSwitchTransport({
      ...before.options,
      links: { launchUrl: async () => bread.open(link), onUrl: () => () => undefined }
    });
    await again.start();
    expect(again.transactionOutcome('tx-1')).toEqual({ output: { txHash: '0xabc', outputNotes: [] } });
    relaunched.stop();
    before.transport.stop();
  });

  it('completes a connection from a relaunch that comes after the ten minutes Bread accepts the request for', async () => {
    const bread = fakeBread(approve);
    const before = harness();
    void before.transport.connect(PERMISSION_REQUEST).catch(() => undefined);
    await flush();
    const reply = bread.open(before.opened[0]!);
    before.clock.now += REQUEST_MAX_AGE_MS + 1;
    const relaunched = new AppSwitchTransport({
      ...before.options,
      links: { launchUrl: async () => reply, onUrl: () => () => undefined }
    });
    await relaunched.start();
    expect(relaunched.session()).toMatchObject({ permission: PERMISSION_RESPONSE });
    before.transport.stop();
  });

  it('ignores a stored request older than the app waits for, and a launch link it cannot read', async () => {
    const bread = fakeBread(approve);
    const before = harness();
    void before.transport.connect(PERMISSION_REQUEST).catch(() => undefined);
    await flush();
    const reply = bread.open(before.opened[0]!);
    before.clock.now += ANSWER_WAIT_MS + 1;
    const stale = new AppSwitchTransport({
      ...before.options,
      links: { launchUrl: async () => reply, onUrl: () => () => undefined }
    });
    await stale.start();
    expect(stale.session()).toBeNull();

    const failing = new AppSwitchTransport({
      ...before.options,
      links: { launchUrl: () => Promise.reject(new Error('no launch')), onUrl: () => () => undefined }
    });
    await expect(failing.start()).resolves.toBeUndefined();
    before.transport.stop();
  });

  it('listens once, stops listening on stop, and reads malformed storage as nothing', async () => {
    const h = harness();
    await h.transport.start();
    await h.transport.start();
    expect(h.links.onUrl).toHaveBeenCalledTimes(1);
    expect(h.listening()).toBe(true);
    h.transport.stop();
    expect(h.listening()).toBe(false);

    h.storage.setItem('bread-connect:session', '{not json');
    expect(h.transport.session()).toBeNull();
    h.storage.setItem('bread-connect:session', JSON.stringify({ session: 'x' }));
    expect(h.transport.session()).toBeNull();
    h.storage.setItem('bread-connect:outcomes', '{}');
    expect(h.transport.transactionOutcome('tx')).toBeUndefined();
    h.storage.setItem('bread-connect:outcomes', JSON.stringify([7, { transactionId: 'tx', outcome: 1 }]));
    expect(h.transport.transactionOutcome('tx')).toBeUndefined();
    for (const outcome of [{ error: {} }, { output: {}, error: { code: 'TRANSACTION_FAILED', message: 'x' } }]) {
      h.storage.setItem('bread-connect:outcomes', JSON.stringify([{ transactionId: 'tx', outcome }]));
      expect(h.transport.transactionOutcome('tx')).toBeUndefined();
    }
    const failed = { error: { code: 'TRANSACTION_FAILED', message: 'rejected' } };
    h.storage.setItem('bread-connect:outcomes', JSON.stringify([{ transactionId: 'tx', outcome: failed }]));
    expect(h.transport.transactionOutcome('tx')).toEqual(failed);

    const sessionGone = errorLink(CALLBACK, { code: 'SESSION_NOT_FOUND', message: 'x' }, 'AAAAAAAAAAAAAAAAAAAAAA');
    for (const pending of [
      { kind: 'other', sentAt: 1 },
      { kind: 'request', id: 'AAAAAAAAAAAAAAAAAAAAAA' },
      { kind: 'request', id: 'AAAAAAAAAAAAAAAAAAAAAA', sentAt: 1 },
      { kind: 'connect', sentAt: 1, request: { type: 'PERMISSION_REQUEST' }, connection: 5 },
      { kind: 'connect', sentAt: 1, request: { type: 'PERMISSION_REQUEST' }, connection: { id: 1 } }
    ]) {
      h.storage.setItem('bread-connect:session', JSON.stringify({ session: 'x' }));
      h.storage.setItem('bread-connect:pending', JSON.stringify(pending));
      h.transport.receive(sessionGone);
      expect(h.storage.getItem('bread-connect:pending')).not.toBeNull();
      expect(h.storage.getItem('bread-connect:session')).not.toBeNull();
    }
  });

  it('keeps the last twenty outcomes, one per transaction', async () => {
    const outcomes = Array.from({ length: 21 }, (_, i) => `tx-${i}`);
    let next = 0;
    const bread = fakeBread(request =>
      request.type === 'PERMISSION_REQUEST'
        ? { response: PERMISSION_RESPONSE }
        : { response: { type: 'TRANSACTION_RESPONSE', transactionId: outcomes[next++] }, transaction: { output: next } }
    );
    const h = await connected(bread);
    for (let i = 0; i < 21; i++) {
      const answer = h.transport.request({ type: 'TRANSACTION_REQUEST' });
      await flush();
      h.deliver(bread.open(h.opened.at(-1)!));
      await answer;
    }
    expect(h.transport.transactionOutcome('tx-0')).toBeUndefined();
    expect(h.transport.transactionOutcome('tx-20')).toEqual({ output: 21 });
    h.storage.setItem('bread-connect:outcomes', 'null');
    const answer = h.transport.request({ type: 'TRANSACTION_REQUEST' });
    await flush();
    next = 3;
    h.deliver(bread.open(h.opened.at(-1)!));
    await answer;
    expect(h.transport.transactionOutcome('tx-3')).toEqual({ output: 4 });
    h.transport.stop();
  });
});
