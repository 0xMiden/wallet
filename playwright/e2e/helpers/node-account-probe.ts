import fs from 'fs';
import path from 'path';

/**
 * Asks a Miden node whether a public account has STATE at the chain tip, over gRPC-web with no
 * client in the loop.
 *
 * A header-only `GetAccount` is the wrong probe: for an account that does not exist the node still
 * answers OK, with a non-membership witness and an EMPTY commitment (seen for every 0.15-era
 * account after the 2026-09 testnet reset). Only a request that asks for details makes the node
 * say `account <id> not found at block N`, and that is the exact call a transaction makes when it
 * loads the account as a foreign account, so the verdict predicts the transaction's fate.
 */
export type PublicAccountState = 'present' | 'absent' | 'unknown';

const NOT_FOUND = /not found at block/i;

function lengthDelimited(field: number, payload: Uint8Array): Uint8Array {
  if (payload.length >= 128) throw new Error('probe payloads are always short');
  return Uint8Array.from([(field << 3) | 2, payload.length, ...payload]);
}

/** `AccountRequest { account_id: AccountId { bytes id = 1 } = 1, details: { storage_maps: {} = 4 } = 3 }`. */
export function encodeGetAccountWithDetails(accountIdHex: string): Uint8Array {
  const hex = accountIdHex.replace(/^0x/, '');
  if (!/^[0-9a-f]{30}$/i.test(hex)) throw new Error(`not a 15-byte account id: ${accountIdHex}`);
  const id = Uint8Array.from(Buffer.from(hex, 'hex'));
  const accountId = lengthDelimited(1, lengthDelimited(1, id));
  const details = lengthDelimited(3, lengthDelimited(4, new Uint8Array()));
  const message = Uint8Array.from([...accountId, ...details]);
  const frame = new Uint8Array(5 + message.length);
  frame[0] = 0; // uncompressed
  new DataView(frame.buffer).setUint32(1, message.length, false);
  frame.set(message, 5);
  return frame;
}

/** The node's accept header wants the client line it serves; the CLI pin in package.json is that line. */
export function nodeVersionFromPackageJson(pkgPath = path.resolve('package.json')): string {
  const pkg: { midenClientCliVersion?: string } = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (!pkg.midenClientCliVersion) throw new Error(`${pkgPath} has no midenClientCliVersion`);
  return pkg.midenClientCliVersion;
}

/** The slice of `fetch` the probe uses, so a test can hand in a plain object and no DOM types are needed. */
export interface ProbeResponse {
  status: number;
  headers: { get(name: string): string | null };
}
export type ProbeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Uint8Array }
) => Promise<ProbeResponse>;

const nodeFetch: ProbeFetch = (url, init) => (globalThis as unknown as { fetch: ProbeFetch }).fetch(url, init);

export async function probePublicAccountState(
  rpcUrl: string,
  accountIdHex: string,
  nodeVersion: string,
  fetchImpl: ProbeFetch = nodeFetch
): Promise<{ state: PublicAccountState; detail: string }> {
  let response: ProbeResponse;
  try {
    response = await fetchImpl(`${rpcUrl.replace(/\/$/, '')}/rpc.Api/GetAccount`, {
      method: 'POST',
      headers: {
        'content-type': 'application/grpc-web+proto',
        'x-grpc-web': '1',
        accept: `application/vnd.miden; version=${nodeVersion}`
      },
      body: encodeGetAccountWithDetails(accountIdHex)
    });
  } catch (error) {
    return { state: 'unknown', detail: `probe could not reach ${rpcUrl}: ${String(error)}` };
  }
  // gRPC-web puts the status of a failed call in the response headers; a successful call carries
  // `grpc-status: 0` in the body trailer instead, so a missing header means the call went through.
  const status = response.headers.get('grpc-status');
  const message = decodeURIComponent(response.headers.get('grpc-message') ?? '');
  if (status === null || status === '0') return { state: 'present', detail: `HTTP ${response.status}` };
  if (status === '3' && NOT_FOUND.test(message)) return { state: 'absent', detail: message };
  return { state: 'unknown', detail: `grpc-status ${status}: ${message || '(no message)'}` };
}
