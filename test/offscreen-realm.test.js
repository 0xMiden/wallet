/** @jest-environment node */
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('@swc/core');
const { installOffscreenFaultRealm } = require('../playwright/e2e/harness/offscreen-realm');
const { installFetchInstrumentation } = require('../playwright/e2e/harness/fetch-instrumentation');

const KEY = '__miden_e2e_offscreen_fetch_faults';
const URL_OFFSCREEN = 'chrome-extension://inert-fixture/offscreen.html';
const URL_SYNC = 'http://localhost:57291/miden.node.v1.NodeService/SyncNotes';
const wire = [{ id: 'discovery', host: ':57291', path: 'NodeService/Sync', mode: 'hang' }];
const bootstrap = () => transformSync(readFileSync(resolve(__dirname, '../src/offscreen/e2e-fetch-faults.ts'), 'utf8'), {
  jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
  module: { type: 'commonjs' }
}).code;

function fixture() {
  const stored = {};
  const events = [];
  const evaluations = [];
  const listeners = new Set();
  const set = jest.fn(async values => {
    Object.assign(stored, values);
    events.push('persist');
    for (const listener of listeners) listener({ [KEY]: { newValue: values[KEY] } }, 'local');
  });
  const remove = jest.fn(async key => {
    delete stored[key];
    events.push('remove');
    for (const listener of listeners) listener({ [key]: {} }, 'local');
  });
  const chrome = {
    storage: {
      local: { set, remove, get: async () => structuredClone(stored) },
      onChanged: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) }
    }
  };
  const workerRealm = vm.createContext({ chrome });
  const newDocument = () => {
    const nativeFetch = jest.fn(async () => new Response('inert'));
    return vm.createContext({
      fetch: nativeFetch, nativeFetch,
      URL, Response, Request, Headers, performance, chrome,
      console: { log: jest.fn() },
      location: { href: URL_OFFSCREEN }
    });
  };
  let doc = newDocument();
  let targetId = 'generation-1';
  const session = new EventEmitter();
  let hold;
  let release;
  session.send = async (method, params) => {
    if (method === 'Target.getTargets') {
      events.push('discover');
      return { targetInfos: [{ targetId, url: URL_OFFSCREEN }] };
    }
    if (method === 'Target.attachToTarget') return { sessionId: params.targetId };
    if (method === 'Target.sendMessageToTarget') {
      if (params.sessionId !== targetId) throw new Error('document destroyed');
      const request = JSON.parse(params.message);
      evaluations.push(targetId);
      const value = vm.runInContext(request.params.expression, doc);
      const reply = { message: JSON.stringify({ id: request.id, result: { result: { value } } }) };
      if (hold) {
        release = () => session.emit('Target.receivedMessageFromTarget', reply);
        const held = hold;
        hold = undefined;
        held();
      } else session.emit('Target.receivedMessageFromTarget', reply);
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
  return {
    controls, stored, events, set, evaluations,
    get doc() { return doc; },
    holdNextEvaluation: () => new Promise(resolve => { hold = resolve; }),
    releaseEvaluation: () => release(),
    async replace() {
      session.emit('Target.detachedFromTarget', { sessionId: targetId });
      targetId += '-next';
      listeners.clear();
      doc = newDocument();
      doc.exports = {};
      // Only module loading and Chrome/CDP are faked. Both algorithms execute unchanged in the fresh realm.
      doc.require = path => {
        if (path !== '../../playwright/e2e/harness/fetch-instrumentation') throw new Error(`unexpected import ${path}`);
        return {
          OFFSCREEN_FETCH_FAULTS_KEY: KEY,
          SW_FETCH_LOG_PREFIX: '[E2E_NET] ',
          installFetchInstrumentation: vm.runInContext(`(${installFetchInstrumentation.toString()})`, doc)
        };
      };
      vm.runInContext(bootstrap(), doc);
      await doc.exports.restoreOffscreenFetchFaults();
      return targetId;
    }
  };
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

test('blocks replacement discovery before the next watcher tick and removes policy for later generations', async () => {
  jest.useFakeTimers({ now: 0 });
  const f = fixture();
  try {
    await f.controls.arm(wire);
    void f.doc.fetch(URL_SYNC);
    expect(await f.controls.hits()).toBe(1);
    await jest.advanceTimersByTimeAsync(499);
    const replacement = await f.replace();
    const native = f.doc.fetch;
    let settled = false;
    void f.doc.fetch(URL_SYNC).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.doc.nativeFetch).not.toHaveBeenCalled();
    expect(f.doc.__E2E_NET_FAULT_HITS).toEqual({ discovery: 1 });
    expect(f.evaluations.filter(id => id === replacement)).toHaveLength(0);
    expect(await f.controls.hits()).toBe(2);
    expect(Date.now()).toBe(499);
    await f.controls.clear();
    await f.replace();
    expect(f.doc.__e2e_fetch_wrapped).toBeUndefined();
    expect((await f.doc.fetch(URL_SYNC)).status).toBe(200);
    expect(f.doc.fetch).not.toBe(native);
  } finally {
    await f.controls.clear();
    jest.clearAllTimers();
  }
});

test('does not resurrect old hit evidence when a read finishes after clear', async () => {
  jest.useFakeTimers();
  const f = fixture();
  try {
    await f.controls.arm(wire);
    void f.doc.fetch(URL_SYNC);
    const held = f.holdNextEvaluation();
    const reading = f.controls.hits();
    await held;
    await f.controls.clear();
    f.releaseEvaluation();
    expect(await reading).toBe(0);
  } finally {
    await f.controls.clear();
    jest.clearAllTimers();
  }
});
