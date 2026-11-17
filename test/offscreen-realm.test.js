/** @jest-environment node */
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { installOffscreenFaultRealm } = require('../playwright/e2e/harness/offscreen-realm');

const KEY = '__miden_e2e_offscreen_fetch_faults';
const URL_OFFSCREEN = 'chrome-extension://inert-fixture/offscreen.html';
const wire = [{ id: 'discovery', host: ':57291', path: 'NodeService/Sync', mode: 'hang' }];

function fixture() {
  const stored = {};
  const events = [];
  const set = jest.fn(async values => {
    Object.assign(stored, values);
    events.push('persist');
  });
  const remove = jest.fn(async key => {
    delete stored[key];
    events.push('remove');
  });
  const workerRealm = vm.createContext({ chrome: { storage: { local: { set, remove } } } });
  const doc = vm.createContext({
    fetch: jest.fn(async () => new Response('inert')),
    URL, Response, Request, Headers, performance,
    console: { log: jest.fn() },
    location: { href: URL_OFFSCREEN }
  });
  const session = new EventEmitter();
  session.send = async (method, params) => {
    if (method === 'Target.getTargets') {
      events.push('discover');
      return { targetInfos: [{ targetId: 'generation-1', url: URL_OFFSCREEN }] };
    }
    if (method === 'Target.attachToTarget') return { sessionId: 'generation-1' };
    if (method === 'Target.sendMessageToTarget') {
      const request = JSON.parse(params.message);
      const value = vm.runInContext(request.params.expression, doc);
      session.emit('Target.receivedMessageFromTarget', {
        message: JSON.stringify({ id: request.id, result: { result: { value } } })
      });
      return {};
    }
    throw new Error(`unexpected method ${method}`);
  };
  const worker = {
    url: () => 'chrome-extension://inert-fixture/background.js',
    evaluate: async (fn, arg) => vm.runInContext(`(${fn.toString()})(${JSON.stringify(arg)})`, workerRealm)
  };
  const controls = installOffscreenFaultRealm(
    () => ({ browser: () => ({ newBrowserCDPSession: async () => session }) }),
    () => worker
  );
  return { controls, stored, events, set };
}

afterEach(() => jest.useRealTimers());

test('persists active faults before a replacement offscreen document can start', async () => {
  jest.useFakeTimers();
  const f = fixture();
  try {
    await f.controls.arm(wire);
    expect(f.stored[KEY]).toEqual(wire);
    expect(f.events[0]).toBe('persist');
    await f.controls.clear();
    expect(f.stored[KEY]).toBeUndefined();
  } finally {
    await f.controls.clear();
    jest.clearAllTimers();
  }
});

test('refuses to claim an armed fault when persistence fails', async () => {
  jest.useFakeTimers();
  const f = fixture();
  f.set.mockRejectedValueOnce(new Error('storage unavailable'));
  try {
    await expect(f.controls.arm(wire)).rejects.toThrow('storage unavailable');
    expect(f.events).toEqual([]);
  } finally {
    await f.controls.clear();
    jest.clearAllTimers();
  }
});
