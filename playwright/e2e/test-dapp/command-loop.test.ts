/**
 * @jest-environment jsdom
 */
import fs from 'node:fs';
import path from 'node:path';

import { PAGE_RETRY_MS } from '../helpers/dapp-command-server';

// The loop runs on import (command-loop.ts exports nothing), against a fetch that stands in for the command server.
interface PollAnswer {
  status: number;
  body?: unknown;
}
interface Posted {
  url: string;
  body: unknown;
}

let polls: string[] = [];
let posted: Posted[] = [];
let pollAnswers: Array<() => Promise<PollAnswer>> = [];
let idlePoll: () => Promise<PollAnswer>;
let resultReplies: Array<() => Promise<number>> = [];
let resultAttempts = 0;

const held = (): Promise<PollAnswer> => new Promise(resolve => setTimeout(() => resolve({ status: 204 }), 1_000));

function installFetch(): void {
  const fakeFetch = (
    input: unknown,
    init?: { body?: unknown }
  ): Promise<{ status: number; json(): Promise<unknown> }> => {
    const url = String(input);
    if (url.startsWith('/command?')) {
      polls.push(url);
      const next = pollAnswers.shift() ?? idlePoll;
      return next().then(answer => ({ status: answer.status, json: () => Promise.resolve(answer.body ?? null) }));
    }
    if (url.startsWith('/result?')) {
      resultAttempts += 1;
      const reply = resultReplies.shift() ?? (() => Promise.resolve(204));
      return reply().then(status => {
        if (status >= 200 && status < 300)
          posted.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
        return { status, json: () => Promise.resolve(null) };
      });
    }
    posted.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    return Promise.resolve({ status: 204, json: () => Promise.resolve(null) });
  };
  Object.defineProperty(window, 'fetch', { value: fakeFetch, configurable: true, writable: true });
}

function installPage(call: (command: string, input: unknown) => Promise<unknown>): void {
  Object.defineProperty(window, 'testDapp', { value: { ready: true, call }, configurable: true, writable: true });
}

function startLoop(): void {
  jest.isolateModules(() => {
    require('./command-loop');
  });
}

const kindOf = (body: unknown): unknown =>
  typeof body === 'object' && body !== null ? Reflect.get(body, 'kind') : undefined;
const eventsOf = (kind: string): unknown[] =>
  posted.filter(entry => entry.url.startsWith('/event?') && kindOf(entry.body) === kind).map(entry => entry.body);
const resultsPosted = (): unknown[] =>
  posted.filter(entry => entry.url.startsWith('/result?')).map(entry => entry.body);
const command =
  (id: string, name: string, input: unknown = {}) =>
  () =>
    Promise.resolve({ status: 200, body: { id, command: name, input } });

// The Android WebView's own words, read from its source, so the page's copy cannot drift from them.
const FALLBACK =
  /"(Native presentation is unsupported in this WebView)"/.exec(
    fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../packages/dapp-browser/android/src/main/java/ee/forgr/capacitor_inappbrowser/BreadPresentationController.java'
      ),
      'utf8'
    )
  )?.[1] ?? 'missing from the WebView source';

// isolateModules gives each test a fresh module but the same jsdom window and document, so each test removes the
// listeners its module added; otherwise a `load` reaches every earlier test's module too, and each posts its events.
let added: Array<() => void> = [];

function trackListeners(): void {
  const onWindow = window.addEventListener.bind(window);
  jest.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    onWindow(type, listener, options);
    added.push(() => window.removeEventListener(type, listener, options));
  });
  const onDocument = document.addEventListener.bind(document);
  jest.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    onDocument(type, listener, options);
    added.push(() => document.removeEventListener(type, listener, options));
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  polls = [];
  posted = [];
  pollAnswers = [];
  resultReplies = [];
  resultAttempts = 0;
  idlePoll = held;
  added = [];
  trackListeners();
  installFetch();
  installPage(async () => ({ ok: true }));
  Reflect.deleteProperty(window, 'bread');
});

// A test's loop keeps its timers on that test's clock; the next useFakeTimers() installs a fresh one, so they never fire.
afterEach(() => {
  for (const remove of added) remove();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('stops its loop when a newer poll for its key is answered 409', async () => {
  idlePoll = () => Promise.resolve({ status: 409 });
  startLoop();
  await jest.advanceTimersByTimeAsync(5_000);
  expect(polls).toHaveLength(1);
  expect(eventsOf('pollSuperseded')).toEqual([expect.objectContaining({ data: { poll: 1 } })]);
});

// The control: the same fake keeps seeing polls when they are held and answered idle.
test('keeps polling while held polls are answered idle', async () => {
  startLoop();
  await jest.advanceTimersByTimeAsync(5_000);
  expect(polls.length).toBeGreaterThanOrEqual(4);
  expect(eventsOf('pollSuperseded')).toEqual([]);
});

// The server derives its poll gap from PAGE_RETRY_MS and reads a command no page took within it as a page that
// stopped polling, so every failed poll's wait is pinned to that value.
test.each([
  ['is answered 500', () => Promise.resolve({ status: 500 })],
  ['carries a malformed command', () => Promise.resolve({ status: 200, body: { id: 7 } })],
  ['fails', () => Promise.reject(new TypeError('Load failed'))]
])('polls again after the server-side retry wait when a poll %s', async (_, failed) => {
  const at: number[] = [];
  const timed = (answer: () => Promise<PollAnswer>) => () => {
    at.push(Date.now());
    return answer();
  };
  pollAnswers = [timed(failed)];
  idlePoll = timed(held);
  const start = Date.now();
  startLoop();
  await jest.advanceTimersByTimeAsync(PAGE_RETRY_MS * 2);
  expect(at.slice(0, 2)).toEqual([start, start + PAGE_RETRY_MS]);
});

test('answers a command with the value the page returned', async () => {
  installPage(async (name, input) => ({ name, input }));
  pollAnswers = [command('c1', 'session', { a: 1 })];
  startLoop();
  await jest.advanceTimersByTimeAsync(100);
  expect(resultsPosted()).toEqual([{ id: 'c1', ok: true, value: { name: 'session', input: { a: 1 } } }]);
});

test('answers a result JSON cannot carry with an error naming the command', async () => {
  installPage(async () => ({ amount: BigInt(1) }));
  pollAnswers = [command('c2', 'chainAccount')];
  startLoop();
  await jest.advanceTimersByTimeAsync(100);
  expect(resultsPosted()).toEqual([
    {
      id: 'c2',
      ok: false,
      error: { name: 'HarnessCheckError', message: expect.stringContaining('the chainAccount result cannot be sent') }
    }
  ]);
});

test('answers a page error with its name, so the driver can tell the node from the page', async () => {
  installPage(async () => {
    throw Object.assign(new Error('syncChain: TypeError: Failed to fetch'), { name: 'ChainUnavailableError' });
  });
  pollAnswers = [command('c3', 'syncHeight')];
  startLoop();
  await jest.advanceTimersByTimeAsync(100);
  expect(resultsPosted()).toEqual([
    { id: 'c3', ok: false, error: { name: 'ChainUnavailableError', message: 'syncChain: TypeError: Failed to fetch' } }
  ]);
});

test('reads the fallback answer from the WebView source', () => {
  expect(FALLBACK).toBe('Native presentation is unsupported in this WebView');
});

test.each([
  ['fallback', () => Promise.reject(new Error(FALLBACK)), FALLBACK],
  ['gated', () => Promise.resolve(), 'ready() resolved'],
  ['other', () => Promise.reject(new Error('Presentation request timed out')), 'Presentation request timed out']
])('reports the %s presentation path its WebView answered', async (kind, ready, detail) => {
  Object.defineProperty(window, 'bread', { value: { presentation: { ready } }, configurable: true });
  startLoop();
  window.dispatchEvent(new Event('load'));
  await jest.advanceTimersByTimeAsync(10);
  expect(eventsOf('presentation')).toEqual([expect.objectContaining({ data: { path: kind, detail } })]);
});

test('reports a page with no presentation API as absent', async () => {
  startLoop();
  window.dispatchEvent(new Event('load'));
  await jest.advanceTimersByTimeAsync(10);
  expect(eventsOf('presentation')).toEqual([
    expect.objectContaining({ data: { path: 'absent', detail: 'window.bread.presentation.ready is not a function' } })
  ]);
});

test.each([
  ['rejects', () => Promise.reject(new TypeError('Load failed'))],
  ['answers 500', () => Promise.resolve(500)]
])('retries a result POST that %s once and then delivers it', async (_, fail) => {
  resultReplies = [fail];
  pollAnswers = [command('retry-result', 'session')];
  startLoop();
  await jest.advanceTimersByTimeAsync(1_100);
  expect(resultsPosted()).toEqual([{ id: 'retry-result', ok: true, value: { ok: true } }]);
  expect(resultAttempts).toBe(2);
  expect(eventsOf('result-undelivered')).toEqual([]);
});

test('reports the command id after three undelivered result attempts', async () => {
  resultReplies = Array.from({ length: 3 }, () => () => Promise.resolve(500));
  pollAnswers = [command('lost-result', 'session')];
  startLoop();
  await jest.advanceTimersByTimeAsync(3_100);
  expect(resultAttempts).toBe(3);
  expect(resultsPosted()).toEqual([]);
  expect(eventsOf('result-undelivered')).toEqual([
    expect.objectContaining({ data: { id: 'lost-result', command: 'session', attempts: 3 } })
  ]);
});
