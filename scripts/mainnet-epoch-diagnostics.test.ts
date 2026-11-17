/** @jest-environment node */
import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  epochSolveFailureMetadata,
  observeEpochSolveFailure
} from '../playwright/e2e/helpers/mainnet-epoch-diagnostics';

jest.mock('node:crypto', () => ({
  ...jest.requireActual<typeof import('node:crypto')>('node:crypto'),
  randomBytes: jest.fn(() => Buffer.alloc(32, 19))
}));

const prefix = '[EpochBridge] EVM→Miden solveIntent failed:';
const privateMarker = 'synthetic-private-request-placeholder';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const message = (text: string, value: unknown = { name: 'APIError', status: 409 }) => ({
  type: () => 'error',
  text: () => text,
  args: () => [{}, { evaluate: async (read: typeof epochSolveFailureMetadata) => read(value) }]
});

it.each([
  {
    value: { name: 'APIError', status: 409, code: privateMarker, txHash: privateMarker },
    want: { kind: 'api-error', httpStatus: 409 }
  },
  { value: { name: 'TransactionError', status: 409, txHash: privateMarker }, want: { kind: 'transaction-error' } },
  { value: { name: 'CompactSDKError', code: privateMarker }, want: { kind: 'compact-sdk-error' } },
  { value: { name: 'APIError', statusCode: 409 }, want: { kind: 'api-error' } },
  { value: { name: privateMarker, status: 409 }, want: { kind: 'unknown' } },
  { value: Object.create({ name: 'APIError', status: 409 }), want: { kind: 'unknown' } },
  { value: null, want: { kind: 'unknown' } },
  { value: privateMarker, want: { kind: 'unknown' } }
])('exports only fixed SDK kind and actual APIError HTTP status %#', ({ value, want }) => {
  const result = epochSolveFailureMetadata(value);
  expect(result).toEqual(want);
  expect(JSON.stringify(result)).not.toContain(privateMarker);
});

it.each([99, 600, NaN, Infinity, '409', null, undefined])('omits non-HTTP or malformed API status %p', status => {
  expect(epochSolveFailureMetadata({ name: 'APIError', status })).toEqual({ kind: 'api-error' });
});

it('does not invoke error getters or leak descriptor/proxy failures', () => {
  let read = false;
  const value = Object.defineProperty({}, 'name', {
    get() {
      read = true;
      return 'APIError';
    }
  });
  expect(epochSolveFailureMetadata(value)).toEqual({ kind: 'unknown' });
  expect(read).toBe(false);
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error(privateMarker);
      }
    }
  );
  expect(epochSolveFailureMetadata(hostile)).toEqual({ kind: 'unknown' });
});

describe('scoped first Epoch solve failure observer', () => {
  let directory: string, checkpoint: string, target: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(join(tmpdir(), 'epoch-safe-diagnostic-'));
    checkpoint = join(directory, 'roundtrip.json');
    target = `${checkpoint}.return-solve-failure.json`;
    fs.writeFileSync(checkpoint, '{"original":"unchanged"}', { mode: 0o600 });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('immediately retains a private0600 keyed record, then only finite remote error metadata', async () => {
    const source = new EventEmitter(),
      text = `${prefix} ${privateMarker}`;
    const stop = observeEpochSolveFailure(source, checkpoint);
    source.emit('console', message(text));
    expect(fs.existsSync(target)).toBe(true);
    const basic = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(basic.site).toBe('evm-to-miden-solve');
    expect(basic.errorSha256).toBe(createHmac('sha256', Buffer.alloc(32, 19)).update(text).digest('hex'));
    expect(basic.errorSha256).not.toBe(createHash('sha256').update(text).digest('hex'));
    expect(basic.kind).toBe('unknown');
    await flush();
    const saved = fs.readFileSync(target, 'utf8'),
      result = JSON.parse(saved);
    expect(result.kind).toBe('api-error');
    expect(result.httpStatus).toBe(409);
    expect(Object.keys(result).sort()).toEqual(['errorSha256', 'httpStatus', 'kind', 'observedAt', 'site']);
    expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
    expect(saved).not.toContain(privateMarker);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(checkpoint, 'utf8')).toBe('{"original":"unchanged"}');
    stop();
    expect(source.listenerCount('console')).toBe(0);
  });

  it('ignores unrelated console sites and non-error events', () => {
    const source = new EventEmitter(),
      stop = observeEpochSolveFailure(source, checkpoint);
    source.emit('console', message(`unrelated ${privateMarker}`));
    source.emit('console', { ...message(prefix), type: () => 'warning' });
    expect(fs.existsSync(target)).toBe(false);
    stop();
  });

  it('never overwrites the first original solve failure with later errors', async () => {
    const source = new EventEmitter(),
      stop = observeEpochSolveFailure(source, checkpoint);
    source.emit('console', message(`${prefix} first`, { name: 'APIError', status: 409 }));
    source.emit('console', message(`${prefix} later`, { name: 'APIError', status: 503 }));
    await flush();
    expect(fs.existsSync(target)).toBe(true);
    const result = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(result.httpStatus).toBe(409);
    expect(result.errorSha256).toBe(createHmac('sha256', Buffer.alloc(32, 19)).update(`${prefix} first`).digest('hex'));
    stop();
  });

  it('keeps the basic keyed record if the browser error handle disappears', async () => {
    const source = new EventEmitter(),
      stop = observeEpochSolveFailure(source, checkpoint);
    source.emit('console', {
      ...message(prefix),
      args: () => [
        {},
        {
          evaluate: async () => {
            throw new Error(privateMarker);
          }
        }
      ]
    });
    await flush();
    expect(fs.existsSync(target)).toBe(true);
    const saved = fs.readFileSync(target, 'utf8');
    expect(JSON.parse(saved).kind).toBe('unknown');
    expect(saved).not.toContain(privateMarker);
    stop();
  });

  it('never writes arbitrary fields or free-form kinds returned by a malformed browser handle', async () => {
    const source = new EventEmitter(),
      stop = observeEpochSolveFailure(source, checkpoint);
    source.emit('console', {
      ...message(prefix),
      args: () => [{}, { evaluate: async () => ({ kind: privateMarker, httpStatus: 409, raw: privateMarker }) }]
    });
    await flush();
    expect(fs.existsSync(target)).toBe(true);
    const saved = fs.readFileSync(target, 'utf8'),
      result = JSON.parse(saved);
    expect(result.kind).toBe('unknown');
    expect(result.httpStatus).toBeUndefined();
    expect(result.raw).toBeUndefined();
    expect(saved).not.toContain(privateMarker);
    stop();
  });

  it('disposal prevents late metadata from rewriting the first record', async () => {
    const source = new EventEmitter();
    let complete: (metadata: ReturnType<typeof epochSolveFailureMetadata>) => void = () => {};
    const pending = new Promise<ReturnType<typeof epochSolveFailureMetadata>>(resolve => {
      complete = resolve;
    });
    const stop = observeEpochSolveFailure(source, checkpoint);
    source.emit('console', { ...message(prefix), args: () => [{}, { evaluate: () => pending }] });
    expect(fs.existsSync(target)).toBe(true);
    const before = fs.readFileSync(target, 'utf8');
    stop();
    complete({ kind: 'api-error', httpStatus: 409 });
    await flush();
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
    source.emit('console', message(`${prefix} stopped`));
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
  });

  it('diagnostic I/O never throws into the original operation', async () => {
    const source = new EventEmitter(),
      stop = observeEpochSolveFailure(source, checkpoint);
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error(privateMarker);
    });
    expect(() => source.emit('console', message(prefix))).not.toThrow();
    await flush();
    expect(fs.existsSync(target)).toBe(false);
    expect(() => stop()).not.toThrow();
  });

  it('unavailable console registration and disposal never replace an operation failure', () => {
    const source = new EventEmitter();
    jest.spyOn(source, 'on').mockImplementation(() => {
      throw new Error(privateMarker);
    });
    expect(() => observeEpochSolveFailure(source, checkpoint)()).not.toThrow();
    jest.restoreAllMocks();
    const stop = observeEpochSolveFailure(source, checkpoint);
    jest.spyOn(source, 'off').mockImplementation(() => {
      throw new Error(privateMarker);
    });
    expect(() => stop()).not.toThrow();
  });
});
