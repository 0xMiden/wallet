// Test fixtures of the relay client. Production code does not import this file.
import type { Hex } from 'viem';

import type { RelayChainConfig } from 'lib/remote-config/schema';

import type { RelayResponse } from './client';

export const RELAY_ADDRESS = '0x00000000000000000000000000000000000000aa';
export const EXECUTOR = '0x00000000000000000000000000000000000000e1';
export const FEE_RECIPIENT = '0x00000000000000000000000000000000000000fe';
export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const NATIVE = '0x0000000000000000000000000000000000000000';
export const SALT: Hex = `0x${'5a'.repeat(32)}`;
export const JOB_ID: Hex = `0x${'1d'.repeat(32)}`;
export const TX_HASH: Hex = `0x${'7e'.repeat(32)}`;

export const CHAIN: RelayChainConfig = {
  key: 'base',
  chainId: 8453,
  executor: EXECUTOR,
  calibur: {
    address: '0x000000009b1d0af20d8c6d0a44e162d11f9b8f00',
    runtimeHash: `0x${'ab'.repeat(32)}`,
    domainName: 'Calibur',
    domainVersion: '1.0.0'
  },
  maxFee: { [USDC]: '50000' }
};

/** A valid `GET /v1/account` body in `sponsor` mode, with upper-case hex where the service may send it. */
export function accountBody(): Record<string, unknown> {
  return {
    chainId: 8453,
    address: RELAY_ADDRESS.toUpperCase().replace('0X', '0x'),
    mode: 'sponsor',
    executor: EXECUTOR,
    feeRecipient: null,
    needsAuthorization: true,
    authorizationNonce: 0,
    salt: SALT.toUpperCase().replace('0X', '0x'),
    kinds: { 'agglayer-deposit': { sequence: '3' } },
    balances: [{ token: USDC.toUpperCase().replace('0X', '0x'), balance: '1000000', minAmount: '100000', fee: '0' }]
  };
}

export function jobBody(state = 'pending'): Record<string, unknown> {
  return { id: JOB_ID, state, txHash: TX_HASH };
}

/** A stub response. A string body is sent as it is; any other body as JSON. */
export function stubResponse(status: number, body: unknown, headers: Record<string, string> = {}): RelayResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => lower.get(name.toLowerCase()) ?? null },
    text: async () => text,
    json: async () => {
      const parsed: unknown = JSON.parse(text);
      return parsed;
    }
  };
}
