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

  it('names a header the node does not allow', () => {
    const problems = nodeCallProblems(summarizeNodeCalls([call([...GRPC, ['x-sdk-trace', '1']])], RPC));
    expect(problems).toEqual(["the page sends x-sdk-trace, which the node's CORS answer does not allow"]);
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
