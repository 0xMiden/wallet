/**
 * @jest-environment node
 */
import type { RelaySignResult } from 'lib/shared/types';

import { createRelayProvider } from './provider';
import { relayRpcRead } from './rpc';
import { CHAIN, RELAY_ADDRESS, SALT } from './testing';

// The provider's default RPC read is `relayRpcRead` on its `rpcUrl`.
jest.mock('./rpc', () => ({ ...jest.requireActual('./rpc'), relayRpcRead: jest.fn() }));

it('sends a read method to the chain RPC when the caller injects no read', async () => {
  const provider = createRelayProvider({
    chain: CHAIN,
    address: RELAY_ADDRESS,
    rpcUrl: 'https://rpc.example',
    sign: async (): Promise<RelaySignResult> => ({ op: 'batch', digest: SALT, signature: SALT })
  });
  jest.mocked(relayRpcRead).mockResolvedValue('0x5');
  expect(await provider.request({ method: 'eth_getBalance', params: [RELAY_ADDRESS, 'latest'] })).toBe('0x5');
  expect(relayRpcRead).toHaveBeenCalledWith('https://rpc.example', 'eth_getBalance', [RELAY_ADDRESS, 'latest']);
});
