import { withRequestTimeout } from 'lib/remote-json';
import { isRecord } from 'lib/update/guards';

import { RelayProviderRpcError } from './errors';

/** One RPC read ends after this long. */
export const RELAY_RPC_TIMEOUT_MS = 30_000;

/** The JSON-RPC error code of a transport failure. viem tries such a read again. */
const INTERNAL_ERROR = -32603;

/** The read methods that the relay provider sends on to the chain's RPC endpoint. */
export const RELAY_READ_METHODS: ReadonlySet<string> = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_createAccessList',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getBlockReceipts',
  'eth_getCode',
  'eth_getLogs',
  'eth_getProof',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'net_version',
  'web3_clientVersion'
]);

export interface RelayRpcRequestInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

/** The part of `fetch` that an RPC read uses. Tests pass a stub. */
export type RelayRpcFetch = (url: string, init: RelayRpcRequestInit) => Promise<{ json(): Promise<unknown> }>;

const defaultFetch: RelayRpcFetch = (url, init) => fetch(url, init);

function rpcError(payload: Record<string, unknown>, method: string): RelayProviderRpcError {
  const error = isRecord(payload.error) ? payload.error : {};
  const code = typeof error.code === 'number' && Number.isInteger(error.code) ? error.code : INTERNAL_ERROR;
  const message = typeof error.message === 'string' ? error.message : `RPC error for ${method}`;
  return new RelayProviderRpcError(code, message, error.data);
}

/**
 * Sends one JSON-RPC read to `rpcUrl`, as the native Reown shim does (`lib/walletconnect/native.ts`). The answer's
 * error keeps its code and its data, so viem can decode a revert. A transport failure or a body that is not a
 * JSON-RPC answer is an internal error (-32603).
 */
export async function relayRpcRead(
  rpcUrl: string,
  method: string,
  params: unknown,
  fetchFn: RelayRpcFetch = defaultFetch
): Promise<unknown> {
  return withRequestTimeout(RELAY_RPC_TIMEOUT_MS, async signal => {
    let payload: unknown;
    try {
      const response = await fetchFn(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
        signal
      });
      payload = await response.json();
    } catch (error) {
      throw new RelayProviderRpcError(INTERNAL_ERROR, `The RPC read ${method} failed`, String(error));
    }
    if (!isRecord(payload)) throw new RelayProviderRpcError(INTERNAL_ERROR, `Invalid RPC response for ${method}`);
    if (payload.error !== undefined && payload.error !== null) throw rpcError(payload, method);
    return payload.result;
  });
}
