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

async function connected() {
  const h = load();
  const connecting = h.win.midenWallet.connect('ALL', 'testnet', ['balance']);
  h.answer(h.last().reqId, {
    network: 'testnet',
    accountId: '0xabc',
    privateDataPermission: 'ALL',
    allowedPrivateData: ['balance'],
    publicKey: btoa('abc')
  });
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
    const seen: unknown[] = [];
    h.win.midenWallet.on('accountChange', p =>
      seen.push([p, h.win.midenWallet.address, Array.from(h.win.midenWallet.publicKey ?? [])])
    );
    const next = { ...PERM, address: '0xdef', publicKey: btoa('def') };
    await answerPoll(h, next);
    expect(seen).toEqual([[next, '0xdef', [100, 101, 102]]]);
    expect(h.win.midenWallet.permission).toEqual(next);
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
    h.answer(h.last().reqId, {
      network: 'testnet',
      accountId: '0xabc',
      privateDataPermission: 'ALL',
      allowedPrivateData: ['balance'],
      publicKey: btoa('abc')
    });
    await again;
    jest.advanceTimersByTime(10000);
    expect(h.polls()).toHaveLength(1);
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
