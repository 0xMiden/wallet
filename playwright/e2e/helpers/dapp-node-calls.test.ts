/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChainUnavailable } from './dapp-channel';
import {
  nodeCallProblems,
  preflightHeaderNames,
  summarizeNodeCalls,
  toFetchLog,
  waitForNodeHeight,
  type FetchLogEntry
} from './dapp-node-calls';

const RPC = 'https://rpc.testnet.miden.io';
const call = (headers: string[][], extra: Partial<FetchLogEntry> = {}): FetchLogEntry => ({
  url: `${RPC}/miden.node.v1.NodeService/GetBlockHeaderByNumber`,
  method: 'POST',
  headers,
  at: 1,
  status: 200,
  error: null,
  ms: 5,
  completedAt: 6,
  bodyDigest: 'a'.repeat(64),
  ...extra
});
const GRPC = [
  ['content-type', 'application/grpc-web+proto'],
  ['x-grpc-web', '1'],
  ['accept', 'application/vnd.miden; version=0.17.3']
];

describe('the page node-call guard', () => {
  it('names the headers the SDK needs preflighted, leaving a short accept safelisted', () => {
    expect(preflightHeaderNames(call(GRPC))).toEqual(['content-type', 'x-grpc-web']);
  });

  it('a text/plain content type needs no preflight', () => {
    expect(preflightHeaderNames(call([['content-type', 'text/plain;charset=UTF-8']]))).toEqual([]);
  });

  it('counts an accept past 128 bytes as a header the browser preflights', () => {
    expect(preflightHeaderNames(call([['accept', 'a'.repeat(129)]]))).toEqual(['accept']);
  });

  it('passes calls the node answered with headers it allows', () => {
    expect(nodeCallProblems(summarizeNodeCalls([call(GRPC)], RPC))).toEqual([]);
  });

  it('accepts a 200 call with a header outside the preflight allowlist', () => {
    expect(nodeCallProblems(summarizeNodeCalls([call([...GRPC, ['x-sdk-trace', '1']])], RPC))).toEqual([]);
  });

  it('explains a failed call with a header outside the preflight allowlist as a page/CORS fault', () => {
    const problems = nodeCallProblems(
      summarizeNodeCalls([call([...GRPC, ['x-sdk-trace', '1']], { status: null, error: 'Failed to fetch' })], RPC)
    );
    expect(problems).toEqual([
      `${RPC}/miden.node.v1.NodeService/GetBlockHeaderByNumber Failed to fetch`,
      "the page sends x-sdk-trace, which the node's CORS answer does not allow"
    ]);
  });

  it('fails a call the browser rejected, which is how a refused preflight shows, and a page with no calls', () => {
    expect(nodeCallProblems(summarizeNodeCalls([call(GRPC, { status: null, error: 'Failed to fetch' })], RPC))).toEqual(
      [`${RPC}/miden.node.v1.NodeService/GetBlockHeaderByNumber Failed to fetch`]
    );
    expect(nodeCallProblems(summarizeNodeCalls([], RPC))).toEqual(['the page made no node calls']);
  });

  it('reads the page log as it crossed the channel and drops what is not an entry', () => {
    expect(toFetchLog([call(GRPC), 'noise', null])).toEqual([call(GRPC)]);
    expect(toFetchLog('not a log')).toEqual([]);
  });

  it('keeps completion and request identity metadata while treating missing metadata as unknown', () => {
    expect(toFetchLog([{ url: RPC, method: 'POST', bodyDigest: 'invalid', completedAt: 'unknown' }])).toEqual([
      expect.objectContaining({ bodyDigest: null, completedAt: null })
    ]);
  });
});

// A repo root whose SDK is a stand-in: its block header read runs `body`.
function stubSdk(body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dapp-node-sdk-'));
  const sdk = path.join(root, 'node_modules/@miden-sdk/miden-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(
    path.join(sdk, 'package.json'),
    JSON.stringify({ name: '@miden-sdk/miden-sdk', type: 'module', exports: './index.js' })
  );
  fs.writeFileSync(
    path.join(sdk, 'index.js'),
    [
      'export class Endpoint { constructor(url) { this.url = url; } }',
      `export class RpcClient { async getBlockHeaderByNumber() { ${body} } }`
    ].join('\n')
  );
  return root;
}

describe('the harness node height read', () => {
  it('names the error the node call failed with, on one line', async () => {
    const read = waitForNodeHeight('http://stub', 5, 5_000, stubSdk("throw new Error('stub node refused:\\n503');"));
    await expect(read).rejects.toBeInstanceOf(ChainUnavailable);
    await expect(read).rejects.toMatchObject({ message: 'node http://stub height 5: stub node refused: 503' });
  });

  it('tells a stalled chain apart from a failed call', async () => {
    const read = waitForNodeHeight('http://stub', 5, 0, stubSdk('return { blockNum: () => 3 };'));
    await expect(read).rejects.toMatchObject({ message: 'node http://stub height 5: chain stuck at 3, wanted 5' });
  });

  it('answers the height once the chain reaches the target', async () => {
    await expect(waitForNodeHeight('http://stub', 5, 5_000, stubSdk('return { blockNum: () => 7 };'))).resolves.toBe(7);
  });
});

describe('macOS height-query trust roots', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const certFile = process.env.SSL_CERT_FILE;
  const certDir = process.env.SSL_CERT_DIR;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    delete process.env.SSL_CERT_FILE;
    delete process.env.SSL_CERT_DIR;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    if (certFile === undefined) delete process.env.SSL_CERT_FILE;
    else process.env.SSL_CERT_FILE = certFile;
    if (certDir === undefined) delete process.env.SSL_CERT_DIR;
    else process.env.SSL_CERT_DIR = certDir;
  });

  it('provides parseable public roots to the child and removes the temporary bundle afterwards', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'height-cert-marker-')), 'path');
    const root = stubSdk(`
      const fs = await import('node:fs');
      const { X509Certificate } = await import('node:crypto');
      const file = process.env.SSL_CERT_FILE;
      if (!file) throw new Error('no native certs found');
      new X509Certificate(fs.readFileSync(file));
      fs.writeFileSync(${JSON.stringify(marker)}, file);
      return { blockNum: () => 7 };
    `);
    try {
      await expect(waitForNodeHeight('http://stub', 5, 5_000, root)).resolves.toBe(7);
      expect(fs.existsSync(fs.readFileSync(marker, 'utf8'))).toBe(false);
      expect(process.env.SSL_CERT_FILE).toBeUndefined();
    } finally {
      fs.rmSync(path.dirname(marker), { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['SSL_CERT_FILE', 'SSL_CERT_DIR'])('preserves an explicit %s configuration', async variable => {
    process.env[variable] = '/explicit/trust';
    const root = stubSdk(`
      if (process.env[${JSON.stringify(variable)}] !== '/explicit/trust') throw new Error('trust override lost');
      if (${JSON.stringify(variable)} === 'SSL_CERT_DIR' && process.env.SSL_CERT_FILE) throw new Error('file added');
      return { blockNum: () => 7 };
    `);
    try {
      await expect(waitForNodeHeight('http://stub', 5, 5_000, root)).resolves.toBe(7);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
