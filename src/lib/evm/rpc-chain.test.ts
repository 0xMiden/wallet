import { defineChain } from 'viem';
import { sepolia } from 'viem/chains';

import { getChain } from 'lib/walletconnect/config';

import { evmRpcChain, withWalletRpc } from './rpc-chain';

/** Sets an environment variable back. An unset variable stays unset: assigning undefined would store "undefined". */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('evmRpcChain', () => {
  it('gives the wallet chain definition with the wallet RPC as its default RPC', () => {
    const chain = evmRpcChain(sepolia.id);
    expect(chain?.id).toBe(sepolia.id);
    expect(chain?.rpcUrls.default.http).toEqual([getChain(sepolia.id)?.rpcUrl]);
  });

  it('is null for a chain the wallet does not know', () => {
    expect(evmRpcChain(424242)).toBeNull();
  });
});

describe('withWalletRpc', () => {
  it('keeps a chain that the wallet has no RPC for as it is', () => {
    const unknown = defineChain({
      id: 424242,
      name: 'Unknown',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://own.example'] } }
    });
    expect(withWalletRpc(unknown)).toBe(unknown);
  });

  it('puts the E2E node in place of every RPC under MIDEN_E2E_TEST', () => {
    const saved = { test: process.env.MIDEN_E2E_TEST, rpc: process.env.E2E_EVM_RPC_URL };
    process.env.MIDEN_E2E_TEST = 'true';
    process.env.E2E_EVM_RPC_URL = ' http://127.0.0.1:8545 ';
    try {
      jest.isolateModules(() => {
        const isolated: typeof import('./rpc-chain') = jest.requireActual('./rpc-chain');
        expect(isolated.evmRpcChain(sepolia.id)?.rpcUrls.default.http).toEqual(['http://127.0.0.1:8545']);
      });
    } finally {
      restoreEnv('MIDEN_E2E_TEST', saved.test);
      restoreEnv('E2E_EVM_RPC_URL', saved.rpc);
    }
  });
});
