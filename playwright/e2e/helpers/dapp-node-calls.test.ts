/**
 * @jest-environment node
 */
import {
  nodeCallProblems,
  preflightHeaderNames,
  summarizeNodeCalls,
  toFetchLog,
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
