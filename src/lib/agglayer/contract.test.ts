import type { EIP1193Provider } from 'viem';

import { getAgglayerL1Bridge } from 'lib/remote-config/values';

import { claimAgglayerDeposit, midenAddrToEvmAddr } from './contract';
import { type AgglayerDeposit, fetchMerkleProof } from './status';

const mockFrom = jest.fn();
const mockClaimAsset = jest.fn();
jest.mock('ethers', () => ({
  BaseContract: { from: (...args: unknown[]) => mockFrom(...args) },
  BrowserProvider: jest.fn(() => ({ getSigner: async () => 'signer' }))
}));
jest.mock('lib/remote-config/values', () => ({ getAgglayerL1Bridge: jest.fn() }));
jest.mock('./status', () => ({ fetchMerkleProof: jest.fn() }));
// As strict as the SDK where it matters: fromHex takes only a literal `0x`, and fromBech32 rejects an
// underscore, standing in for a routing suffix it cannot decode.
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AccountId: {
    fromHex: (hex: string) => {
      if (!hex.startsWith('0x')) throw new Error('hex encoded data must start with 0x');
      return { toString: () => hex.toLowerCase() };
    }
  },
  Address: {
    fromBech32: (address: string) => {
      if (address.includes('_')) throw new Error('invalid note tag length');
      return { accountId: () => ({ toString: () => `0x${address.slice(address.indexOf('1') + 1)}` }) };
    }
  }
}));

const DEPOSIT: AgglayerDeposit = {
  leaf_type: 0,
  orig_net: 0,
  orig_addr: '0x0000000000000000000000000000000000000000',
  amount: '5',
  dest_net: 0,
  dest_addr: '0x1111111111111111111111111111111111111111',
  block_num: '1',
  deposit_cnt: 16,
  network_id: 86,
  tx_hash: '0xtx',
  metadata: '0x',
  ready_for_claim: true,
  global_index: '365072220160'
};
const provider: EIP1193Provider = { request: jest.fn(), on: jest.fn(), removeListener: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  mockFrom.mockReturnValue({ claimAsset: mockClaimAsset });
  mockClaimAsset.mockResolvedValue({ hash: '0xclaim' });
  jest.mocked(fetchMerkleProof).mockResolvedValue({
    main_exit_root: '0xmain',
    rollup_exit_root: '0xrollup',
    merkle_proof: [],
    rollup_merkle_proof: []
  });
});

it('claims on the L1 bridge the config names', async () => {
  jest.mocked(getAgglayerL1Bridge).mockReturnValue('0x00000000000000000000000000000000000000b2');
  await claimAgglayerDeposit({ deposit: DEPOSIT, provider });
  expect(mockFrom).toHaveBeenCalledWith('0x00000000000000000000000000000000000000b2', expect.any(Array), 'signer');
  expect(mockClaimAsset).toHaveBeenCalledTimes(1);
});

it('fetches no proof and sends nothing while the config names no L1 bridge', async () => {
  jest.mocked(getAgglayerL1Bridge).mockImplementation(() => {
    throw new Error('no L1 bridge');
  });
  await expect(claimAgglayerDeposit({ deposit: DEPOSIT, provider })).rejects.toThrow('no L1 bridge');
  expect(fetchMerkleProof).not.toHaveBeenCalled();
  expect(mockClaimAsset).not.toHaveBeenCalled();
});

it('pads the id of the address part of a composite whose routing suffix the bech32 parser rejects', () => {
  expect(midenAddrToEvmAddr('mtst10123456789abcdef0123456789abcd_qruqqypuyph')).toBe(
    '0x000000000123456789abcdef0123456789abcd00'
  );
});
