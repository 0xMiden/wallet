/**
 * Runs src-tauri/scripts/dapp-injection.js, the desktop dApp window's bridge, in a fresh JSDOM.
 * A request is a hidden iframe navigated to https://miden-wallet-request/<base64>; the harness
 * records those as they are appended and answers through window.__midenWalletResponse, as the
 * wallet window does.
 */
import fs from 'fs';
import { JSDOM } from 'jsdom';
import path from 'path';

const SOURCE = fs.readFileSync(path.join(__dirname, '../../../src-tauri/scripts/dapp-injection.js'), 'utf8');
const PREFIX = 'https://miden-wallet-request/';

type Wallet = {
  address?: string;
  publicKey?: Uint8Array;
  permission?: unknown;
  connect: (...args: unknown[]) => Promise<unknown>;
  disconnect: () => Promise<unknown>;
  on: (event: string, cb: (data: unknown) => void) => () => void;
  off: (event: string, cb: (data: unknown) => void) => void;
  emit: (event: string, data: unknown) => void;
};
type Sent = { payload: { type: string }; reqId: string };
type DappWindow = Window & {
  midenWallet: Wallet;
  __midenWalletResponse: (r: string) => void;
  __MIDEN_BRIDGE_TOKEN__?: string;
};

function load() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://dapp.example/' });
  const win = dom.window as unknown as DappWindow;
  const sent: Sent[] = [];
  const body = win.document.body;
  const append = body.appendChild.bind(body);
  body.appendChild = <T extends Node>(node: T): T => {
    const src = (node as unknown as { src?: string }).src;
    if (typeof src === 'string' && src.startsWith(PREFIX)) {
      sent.push(JSON.parse(decodeURIComponent(escape(atob(src.slice(PREFIX.length))))) as Sent);
    }
    return append(node);
  };
  win.__MIDEN_BRIDGE_TOKEN__ = 'token';
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'globalThis', 'setTimeout', 'clearTimeout', SOURCE)(
    win,
    win.document,
    win,
    setTimeout,
    clearTimeout
  );
  const answer = (reqId: string, payload: unknown) =>
    win.__midenWalletResponse(JSON.stringify({ type: 'MIDEN_PAGE_RESPONSE', payload, reqId }));
  const polls = () => sent.filter(m => m.payload?.type === 'GET_CURRENT_PERMISSION_REQUEST');
  const last = () => sent[sent.length - 1]!;
  return { win, sent, answer, polls, last };
}

// The connect response names the network by id and the poll by RPC URL, as the real host does.
const PERM = {
  rpc: 'https://rpc.testnet.miden.io',
  address: '0xabc',
  privateDataPermission: 'ALL',
  allowedPrivateData: ['balance']
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const CONNECT = {
  network: 'testnet',
  accountId: '0xabc',
  privateDataPermission: 'ALL',
  allowedPrivateData: ['balance'],
  publicKey: btoa('abc')
};

async function connected() {
  const h = load();
  const connecting = h.win.midenWallet.connect('ALL', 'testnet', ['balance']);
  h.answer(h.last().reqId, CONNECT);
  await connecting;
  return h;
}

async function answerPoll(h: ReturnType<typeof load>, permission: unknown) {
  jest.advanceTimersByTime(10000);
  const poll = h.polls()[h.polls().length - 1]!;
  h.answer(poll.reqId, { type: 'GET_CURRENT_PERMISSION_RESPONSE', permission });
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('loads the real script and installs the wallet', () => {
  expect(load().win.midenWallet.connect).toBeInstanceOf(Function);
});

describe('account switch (#174)', () => {
  it('does not poll before 10 s, and an unchanged grant emits nothing', async () => {
    const h = await connected();
    const spy = jest.fn();
    h.win.midenWallet.on('accountChange', spy);
    jest.advanceTimersByTime(9999);
    expect(h.polls()).toHaveLength(0);
    await answerPoll(h, PERM);
    expect(h.polls()).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('takes a switched account before emitting it', async () => {
    const h = await connected();
    const seen: unknown[][] = [];
    h.win.midenWallet.on('accountChange', p =>
      seen.push([p, h.win.midenWallet.address, Array.from(h.win.midenWallet.publicKey ?? [])])
    );
    const next = { ...PERM, address: '0xdef', publicKey: btoa('def') };
    await answerPoll(h, next);
    const taken = { ...next, publicKey: new Uint8Array([100, 101, 102]) };
    expect(seen).toEqual([[taken, '0xdef', [100, 101, 102]]]);
    expect(h.win.midenWallet.permission).toEqual(taken);
    expect(seen[0]![0]).toBe(h.win.midenWallet.permission);
  });

  it('clears on null and emits it, keeps polling, and emits the grant again on the switch back', async () => {
    const h = await connected();
    const spy = jest.fn();
    h.win.midenWallet.on('accountChange', spy);
    await answerPoll(h, null);
    expect(spy).toHaveBeenLastCalledWith(null);
    const w = h.win.midenWallet;
    expect([w.address, w.publicKey, w.permission]).toEqual([undefined, undefined, undefined]);
    await answerPoll(h, { ...PERM, publicKey: btoa('abc') });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(h.win.midenWallet.address).toBe('0xabc');
  });

  it('ignores a same-address grant, and changes nothing on a malformed key', async () => {
    const h = await connected();
    const spy = jest.fn();
    h.win.midenWallet.on('accountChange', spy);
    await answerPoll(h, { ...PERM, rpc: 'https://rpc.other.example' });
    expect(spy).not.toHaveBeenCalled();
    expect(Array.from(h.win.midenWallet.publicKey ?? [])).toEqual([97, 98, 99]);
    await answerPoll(h, { ...PERM, address: '0xdef', publicKey: '%%%' });
    expect(h.win.midenWallet.address).toBe('0xabc');
    expect(spy).not.toHaveBeenCalled();
    await answerPoll(h, { ...PERM, address: '0xdef', publicKey: btoa('def') });
    expect(h.win.midenWallet.address).toBe('0xdef');
  });

  // Desktop's _emit isolates each listener, so the one registered after a throwing listener hears every emission.
  it('a repeated poll for the same account emits once, and a switch back lands, to every listener', async () => {
    const h = await connected();
    const listener = jest.fn(() => {
      throw new Error('listener failed');
    });
    const after = jest.fn();
    h.win.midenWallet.on('accountChange', listener);
    h.win.midenWallet.on('accountChange', after);
    const next = { ...PERM, address: '0xdef', publicKey: btoa('def') };
    await answerPoll(h, next);
    await answerPoll(h, next);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    await answerPoll(h, { ...PERM, publicKey: btoa('abc') });
    expect(h.win.midenWallet.address).toBe('0xabc');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(after).toHaveBeenCalledTimes(2);
  });

  it('a repeated null poll emits once, to every listener', async () => {
    const h = await connected();
    const listener = jest.fn(() => {
      throw new Error('listener failed');
    });
    const after = jest.fn();
    h.win.midenWallet.on('accountChange', listener);
    h.win.midenWallet.on('accountChange', after);
    await answerPoll(h, null);
    await answerPoll(h, null);
    expect(listener.mock.calls).toEqual([[null]]);
    expect(after.mock.calls).toEqual([[null]]);
  });

  it('stops on disconnect, and a poll answered after disconnect changes nothing', async () => {
    const h = await connected();
    const spy = jest.fn();
    h.win.midenWallet.on('accountChange', spy);
    jest.advanceTimersByTime(10000);
    const inFlight = h.polls()[0]!;
    const disconnecting = h.win.midenWallet.disconnect();
    h.answer(h.last().reqId, { type: 'DISCONNECT_RESPONSE' });
    await disconnecting;
    h.answer(inFlight.reqId, { type: 'GET_CURRENT_PERMISSION_RESPONSE', permission: { ...PERM, address: '0xdef' } });
    await flush();
    expect(h.win.midenWallet.address).toBeUndefined();
    // disconnect() itself emits accountChange(null); the late poll adds nothing.
    expect(spy.mock.calls).toEqual([[null]]);
    jest.advanceTimersByTime(60000);
    expect(h.polls()).toHaveLength(1);
  });

  it('a second connect keeps one poll', async () => {
    const h = await connected();
    const again = h.win.midenWallet.connect('ALL', 'testnet', ['balance']);
    h.answer(h.last().reqId, CONNECT);
    await again;
    jest.advanceTimersByTime(10000);
    expect(h.polls()).toHaveLength(1);
  });

  it('a connect whose key cannot be decoded changes nothing, and the first watch still drives', async () => {
    const h = await connected();
    const spy = jest.fn();
    h.win.midenWallet.on('accountChange', spy);
    const again = h.win.midenWallet.connect('ALL', 'devnet', ['balance']);
    h.answer(h.last().reqId, { ...CONNECT, accountId: '0xdef', publicKey: '%%%' });
    await expect(again).rejects.toThrow('Invalid publicKey in wallet response');
    expect(h.win.midenWallet).toMatchObject({ address: '0xabc', network: 'testnet', permission: { address: '0xabc' } });
    expect(Array.from(h.win.midenWallet.publicKey ?? [])).toEqual([97, 98, 99]);
    expect(spy).not.toHaveBeenCalled();
    const polls = h.polls().length;
    await answerPoll(h, { ...PERM, address: '0xdef', publicKey: btoa('def') });
    expect(h.polls()).toHaveLength(polls + 1);
    expect(h.win.midenWallet.address).toBe('0xdef');
  });

  it('a listener that disconnects from the connect emission leaves no poll', async () => {
    const h = load();
    const w = h.win.midenWallet;
    let disconnecting: Promise<unknown> | undefined;
    w.on('accountChange', p => {
      if (p && !disconnecting) disconnecting = w.disconnect();
    });
    const connecting = w.connect('ALL', 'testnet', ['balance']);
    h.answer(h.last().reqId, CONNECT);
    await connecting;
    const reqId = h.last().reqId;
    jest.advanceTimersByTime(10000);
    expect(h.polls()).toHaveLength(0);
    h.answer(reqId, { type: 'DISCONNECT_RESPONSE' });
    await disconnecting;
    jest.advanceTimersByTime(10000);
    expect(h.polls()).toHaveLength(0);
  });

  it('a poll that times out is followed by the next one', async () => {
    const h = await connected();
    jest.advanceTimersByTime(10000);
    expect(h.polls()).toHaveLength(1);
    jest.advanceTimersByTime(300000);
    await flush();
    jest.advanceTimersByTime(10000);
    expect(h.polls()).toHaveLength(2);
  });
});

describe('a disconnect ends the connection (#1227)', () => {
  const disconnects = (h: ReturnType<typeof load>) => h.sent.filter(m => m.payload?.type === 'DISCONNECT_REQUEST');
  const refuse = (h: ReturnType<typeof load>, reqId: string) =>
    h.win.__midenWalletResponse(JSON.stringify({ type: 'MIDEN_PAGE_ERROR_RESPONSE', error: 'NOT_FOUND', reqId }));

  it.each([
    ['refuses', 'NOT_FOUND', (h: ReturnType<typeof load>) => refuse(h, h.last().reqId)],
    ['never answers', 'Request timeout', () => jest.advanceTimersByTime(300000)]
  ])(
    'a disconnect the wallet %s still clears the account, signals once and polls no more',
    async (_, error, settle) => {
      const h = await connected();
      const spy = jest.fn();
      h.win.midenWallet.on('accountChange', spy);
      const disconnecting = h.win.midenWallet.disconnect();
      settle(h);
      await expect(disconnecting).rejects.toThrow(error);
      const w = h.win.midenWallet;
      expect([w.address, w.publicKey, w.permission]).toEqual([undefined, undefined, undefined]);
      expect(spy.mock.calls).toEqual([[null]]);
      jest.advanceTimersByTime(60000);
      expect(h.polls()).toHaveLength(0);
    }
  );

  it('a listener that disconnects on accountChange(null) is refused once and signals nothing more', async () => {
    const h = await connected();
    const w = h.win.midenWallet;
    const again: Promise<unknown>[] = [];
    const spy = jest.fn((p: unknown) => {
      if (p === null) again.push(w.disconnect());
    });
    w.on('accountChange', spy);
    const disconnecting = w.disconnect();
    h.answer(h.last().reqId, { type: 'DISCONNECT_RESPONSE' });
    await disconnecting;
    refuse(h, h.last().reqId);
    await expect(again[0]).rejects.toThrow('NOT_FOUND');
    await flush();
    expect(spy.mock.calls).toEqual([[null]]);
    expect(disconnects(h)).toHaveLength(2);
  });

  it('a listener that disconnects on a switch to an account that never connected here is refused once', async () => {
    const h = await connected();
    const w = h.win.midenWallet;
    const again: Promise<unknown>[] = [];
    const spy = jest.fn((p: unknown) => {
      if (p === null) again.push(w.disconnect());
    });
    w.on('accountChange', spy);
    await answerPoll(h, null);
    refuse(h, h.last().reqId);
    await expect(again[0]).rejects.toThrow('NOT_FOUND');
    await flush();
    expect(spy.mock.calls).toEqual([[null]]);
    expect(disconnects(h)).toHaveLength(1);
  });

  it('an accountChange listener that throws does not replace the error of a refused disconnect', async () => {
    const h = await connected();
    h.win.midenWallet.on('accountChange', () => {
      throw new Error('listener failed');
    });
    const disconnecting = h.win.midenWallet.disconnect();
    refuse(h, h.last().reqId);
    await expect(disconnecting).rejects.toThrow('NOT_FOUND');
    expect(h.win.midenWallet.address).toBeUndefined();
  });

  it('two overlapping disconnects signal once, and the refused one still rejects', async () => {
    const h = await connected();
    const spy = jest.fn();
    h.win.midenWallet.on('accountChange', spy);
    const first = h.win.midenWallet.disconnect();
    const second = h.win.midenWallet.disconnect();
    const [firstReq, secondReq] = disconnects(h).map(m => m.reqId);
    h.answer(firstReq!, { type: 'DISCONNECT_RESPONSE' });
    await first;
    refuse(h, secondReq!);
    await expect(second).rejects.toThrow('NOT_FOUND');
    expect(spy.mock.calls).toEqual([[null]]);
  });

  // A fresh wallet whose connect() is still waiting for its answer when disconnect() runs.
  function connectingThenDisconnecting() {
    const h = load();
    const spy = jest.fn();
    h.win.midenWallet.on('accountChange', spy);
    const connecting = h.win.midenWallet.connect('ALL', 'testnet', ['balance']);
    const connectReq = h.last().reqId;
    const disconnecting = h.win.midenWallet.disconnect();
    const disconnectReq = h.last().reqId;
    return {
      connecting,
      disconnecting,
      answerConnect: () => h.answer(connectReq, CONNECT),
      answerDisconnect: () => h.answer(disconnectReq, { type: 'DISCONNECT_RESPONSE' }),
      expectNothingStarted: () => {
        jest.advanceTimersByTime(10000);
        expect(h.polls()).toHaveLength(0);
        const w = h.win.midenWallet;
        expect([w.address, w.publicKey, w.permission]).toEqual([undefined, undefined, undefined]);
        expect(spy).not.toHaveBeenCalled();
      }
    };
  }

  it('a connect answered after the disconnect it overlapped rejects and starts nothing', async () => {
    const race = connectingThenDisconnecting();
    race.answerDisconnect();
    await race.disconnecting;
    race.answerConnect();
    await expect(race.connecting).rejects.toThrow('The wallet was disconnected while connecting');
    race.expectNothingStarted();
  });

  it('a connect answered while the disconnect it overlapped is pending rejects and starts nothing', async () => {
    const race = connectingThenDisconnecting();
    race.answerConnect();
    await expect(race.connecting).rejects.toThrow('The wallet was disconnected while connecting');
    race.answerDisconnect();
    await race.disconnecting;
    race.expectNothingStarted();
  });

  it('a connect begun after a disconnect connects once the disconnect settles', async () => {
    const h = await connected();
    const disconnecting = h.win.midenWallet.disconnect();
    const disconnectReq = h.last().reqId;
    const connecting = h.win.midenWallet.connect('ALL', 'testnet', ['balance']);
    const connectReq = h.last().reqId;
    h.answer(disconnectReq, { type: 'DISCONNECT_RESPONSE' });
    await disconnecting;
    h.answer(connectReq, CONNECT);
    await expect(connecting).resolves.toBeUndefined();
    expect(h.win.midenWallet.address).toBe('0xabc');
    jest.advanceTimersByTime(10000);
    expect(h.polls()).toHaveLength(1);
  });

  // A disconnect the bridge drops never reaches the wallet's queue, so a later connect is answered first.
  it('a disconnect that times out after a later connect was answered ends that connection and its watch', async () => {
    const h = await connected();
    const spy = jest.fn();
    h.win.midenWallet.on('accountChange', spy);
    const disconnecting = h.win.midenWallet.disconnect();
    const connecting = h.win.midenWallet.connect('ALL', 'testnet', ['balance']);
    h.answer(h.last().reqId, CONNECT);
    await expect(connecting).resolves.toBeUndefined();
    jest.advanceTimersByTime(300000);
    await expect(disconnecting).rejects.toThrow('Request timeout');
    expect(h.win.midenWallet.address).toBeUndefined();
    expect(h.polls()).toHaveLength(1);
    h.answer(h.polls()[0]!.reqId, {
      type: 'GET_CURRENT_PERMISSION_RESPONSE',
      permission: { ...PERM, address: '0xdef' }
    });
    await flush();
    expect(h.win.midenWallet.address).toBeUndefined();
    expect(spy.mock.calls).toEqual([[expect.objectContaining({ address: '0xabc' })], [null]]);
    jest.advanceTimersByTime(60000);
    expect(h.polls()).toHaveLength(1);
  });
});

describe('an emission visits the listeners registered when it began (#1241)', () => {
  it('runs a listener that re-registers itself once per emission', () => {
    const wallet = load().win.midenWallet;
    let calls = 0;
    const listener = () => {
      calls += 1;
      // Bounded, so an emitter that visits the re-added listener fails here instead of never returning.
      if (calls > 5) return;
      wallet.off('accountChange', listener);
      wallet.on('accountChange', listener);
    };
    wallet.on('accountChange', listener);

    wallet.emit('accountChange', null);
    expect(calls).toBe(1);
    wallet.emit('accountChange', null);
    expect(calls).toBe(2);
  });

  it('runs a listener added during an emission from the next one', () => {
    const wallet = load().win.midenWallet;
    const late = jest.fn();
    wallet.on('accountChange', () => {
      wallet.on('accountChange', late);
    });

    wallet.emit('accountChange', 'first');
    expect(late).not.toHaveBeenCalled();
    wallet.emit('accountChange', 'second');
    expect(late.mock.calls).toEqual([['second']]);
  });

  it('still runs a listener an earlier one removed during the same emission, as on mobile', () => {
    const wallet = load().win.midenWallet;
    const second = jest.fn();
    wallet.on('accountChange', () => wallet.off('accountChange', second));
    wallet.on('accountChange', second);

    wallet.emit('accountChange', 'x');
    expect(second.mock.calls).toEqual([['x']]);
    wallet.emit('accountChange', 'y');
    expect(second.mock.calls).toEqual([['x']]);
  });

  it('logs a throwing listener like the other providers and runs the next one', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const wallet = load().win.midenWallet;
      const boom = new Error('boom');
      const after = jest.fn();
      wallet.on('accountChange', () => {
        throw boom;
      });
      wallet.on('accountChange', after);

      wallet.emit('accountChange', 'x');
      expect(error).toHaveBeenCalledWith('[MidenWallet] Error in accountChange listener:', boom);
      expect(after.mock.calls).toEqual([['x']]);
    } finally {
      error.mockRestore();
    }
  });
});
