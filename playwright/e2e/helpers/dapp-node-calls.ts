import type { BlockHeader, RpcClient } from '@miden-sdk/miden-sdk';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rootCertificates } from 'node:tls';

import { ChainUnavailable } from './dapp-channel';

/**
 * The node seen two ways on a mobile leg: the page's own calls, from the fetch log `commandShell` installs, checked
 * once so an SDK header the node refuses fails as one named finding rather than as every cell (spike plan change 12);
 * and the node's height read by the harness itself, since the sheet hides the page while a chain wait runs (spec 3.3).
 */

export interface FetchLogEntry {
  url: string;
  method: string;
  headers: string[][];
  at: number;
  status: number | null;
  error: string | null;
  ms: number | null;
  completedAt: number | null;
  bodyDigest: string | null;
}

export interface NodeCallSummary {
  requests: number;
  failed: Array<{ url: string; status: number | null; error: string | null }>;
  preflightHeaderNames: string[];
  /** Header names on failed calls that the recorded CORS policy does not allow. */
  disallowed: string[];
}

/** What the node's CORS answer allows (miden-node-utils cors.rs, as the spike's preflight probe read it). */
export const NODE_ALLOWED_HEADERS: readonly string[] = ['content-type', 'grpc-timeout', 'x-grpc-web', 'x-user-agent'];
const SAFELISTED_VALUE_HEADERS = new Set(['accept', 'accept-language', 'content-language']);
const SIMPLE_CONTENT_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']);
// eslint-disable-next-line no-control-regex
const UNSAFE_BYTE = /[\x00-\x08\x0a-\x1f"():<>?@[\\\]{}\x7f]/;

/** The names a browser lists in Access-Control-Request-Headers for this request: non-safelisted, lower-case, sorted. */
export function preflightHeaderNames(entry: FetchLogEntry): string[] {
  return entry.headers
    .filter(([name, value]) => {
      const lower = (name ?? '').toLowerCase();
      const v = value ?? '';
      if (lower === 'content-type') {
        return UNSAFE_BYTE.test(v) || !SIMPLE_CONTENT_TYPES.has((v.split(';')[0] ?? '').trim().toLowerCase());
      }
      // `accept` stays safelisted only up to 128 bytes; the SDK's is 113 today.
      if (SAFELISTED_VALUE_HEADERS.has(lower)) return v.length > 128 || UNSAFE_BYTE.test(v);
      return true;
    })
    .map(([name]) => (name ?? '').toLowerCase())
    .sort();
}

export function summarizeNodeCalls(log: readonly FetchLogEntry[], rpcUrl: string): NodeCallSummary {
  const origin = new URL(rpcUrl).origin;
  const calls = log.filter(item => item.url.startsWith(`${origin}/`));
  const names = [...new Set(calls.flatMap(preflightHeaderNames))].sort();
  const failed = calls.filter(item => item.error !== null || (item.status !== null && item.status >= 400));
  const failedNames = [...new Set(failed.flatMap(preflightHeaderNames))].sort();
  return {
    requests: calls.length,
    failed: failed.map(item => ({ url: item.url, status: item.status, error: item.error })),
    preflightHeaderNames: names,
    disallowed: failedNames.filter(name => !NODE_ALLOWED_HEADERS.includes(name))
  };
}

/** Why the page's node calls would fail every cell rather than any one, or [] when they would not. */
export function nodeCallProblems(summary: NodeCallSummary): string[] {
  return [
    ...(summary.requests === 0 ? ['the page made no node calls'] : []),
    ...summary.failed.map(call => `${call.url} ${call.error ?? `answered ${String(call.status)}`}`),
    ...(summary.disallowed.length > 0
      ? [`the page sends ${summary.disallowed.join(', ')}, which the node's CORS answer does not allow`]
      : [])
  ];
}

/** The `__fetchLog` command's value as it crossed the channel; anything that is not an entry is dropped. */
export function toFetchLog(value: unknown): FetchLogEntry[] {
  if (!Array.isArray(value)) return [];
  const numberOrNull = (item: unknown): number | null => (typeof item === 'number' ? item : null);
  return value
    .filter((item: unknown): item is object => typeof item === 'object' && item !== null)
    .map(item => {
      const read = (key: string): unknown => Reflect.get(item, key);
      const headers = read('headers');
      const error = read('error');
      const digest = read('bodyDigest');
      return {
        url: String(read('url') ?? ''),
        method: String(read('method') ?? ''),
        headers: Array.isArray(headers)
          ? headers.filter((pair: unknown): pair is unknown[] => Array.isArray(pair)).map(pair => pair.map(String))
          : [],
        at: numberOrNull(read('at')) ?? 0,
        status: numberOrNull(read('status')),
        error: typeof error === 'string' ? error : null,
        ms: numberOrNull(read('ms')),
        completedAt: numberOrNull(read('completedAt')),
        bodyDigest: typeof digest === 'string' && /^[a-f\d]{64}$/i.test(digest) ? digest.toLowerCase() : null
      };
    });
}

const sdk = {
  header: 'getBlockHeaderByNumber' satisfies keyof RpcClient,
  blockNum: 'blockNum' satisfies keyof BlockHeader
};

// Node ends an uncaught error's stderr with its own version line, so the child reports every failure, the SDK's load
// included, on one line of its own that the parent looks for.
const FAILED = 'height query failed: ';
// A Node child, as public-note-commitment.ts runs its node query: the SDK's Node entry is ESM.
const HEIGHT_QUERY = `
try {
  const { RpcClient, Endpoint } = await import('@miden-sdk/miden-sdk');
  const rpc = new RpcClient(new Endpoint(process.argv[1]));
  const target = Number(process.argv[2]);
  const deadline = Date.now() + Number(process.argv[3]);
  for (;;) {
    const height = (await rpc.${sdk.header}()).${sdk.blockNum}();
    if (height >= target) {
      console.log(String(height));
      break;
    }
    if (Date.now() >= deadline) throw new Error('chain stuck at ' + height + ', wanted ' + target);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
} catch (error) {
  const reason = String(error?.message ?? error).replace(/\\s+/g, ' ');
  process.stderr.write(${JSON.stringify(FAILED)} + reason + '\\n', () => process.exit(1));
}
`;

/**
 * The node's height once it reaches `target`, read by one real gRPC-web call a second from the harness (a GET answering
 * 200 shows only the HTTP front end, spike plan change 13). A node that fails or a chain that stalls is ChainUnavailable.
 */
export async function waitForNodeHeight(
  rpcUrl: string,
  target: number,
  timeoutMs: number,
  repoRoot: string = path.resolve(__dirname, '../../..')
): Promise<number> {
  const killAfterMs = timeoutMs + 30_000;
  const rootDirectory =
    process.platform === 'darwin' && process.env.SSL_CERT_FILE === undefined && process.env.SSL_CERT_DIR === undefined
      ? mkdtempSync(path.join(tmpdir(), 'dapp-height-roots-'))
      : undefined;
  try {
    const env = { ...process.env };
    if (rootDirectory) {
      // The native SDK can find no keychain roots on macOS runners. Keep TLS verification with Node's public roots.
      env.SSL_CERT_FILE = path.join(rootDirectory, 'roots.pem');
      writeFileSync(env.SSL_CERT_FILE, rootCertificates.join('\n') + '\n');
    }
    return await new Promise<number>((resolve, reject) => {
      execFile(
        process.execPath,
        ['--input-type=module', '--eval', HEIGHT_QUERY, rpcUrl, String(target), String(timeoutMs)],
        { cwd: repoRoot, timeout: killAfterMs, encoding: 'utf8', env },
        (error, stdout, stderr) => {
          if (error) {
            // error.message would quote the whole script.
            const reported = stderr
              .split('\n')
              .find(line => line.startsWith(FAILED))
              ?.slice(FAILED.length);
            const reason =
              error.killed === true
                ? `timed out after ${killAfterMs} ms`
                : (reported ?? `exited with code ${String(error.code)}`);
            reject(new ChainUnavailable(`node ${rpcUrl} height ${target}: ${reason}`));
            return;
          }
          const height = Number(stdout.trim());
          if (Number.isInteger(height)) resolve(height);
          else reject(new ChainUnavailable(`node ${rpcUrl} answered no height: ${stdout.trim()}`));
        }
      );
    });
  } finally {
    if (rootDirectory) rmSync(rootDirectory, { recursive: true, force: true });
  }
}

export const nodeHeight = (rpcUrl: string, timeoutMs = 60_000): Promise<number> =>
  waitForNodeHeight(rpcUrl, 0, timeoutMs);
