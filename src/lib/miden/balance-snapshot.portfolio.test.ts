import { beginBalanceSnapshot, readBalanceSnapshot, tagBalanceSnapshot } from './balance-snapshot';
import type { TokenBalanceData } from './front/balance';

let mockNetwork = 'testnet';
let mockRpc = 'https://node-a';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getActiveOverride: () => null,
  getEffectiveNetworkName: () => mockNetwork,
  getEffectiveRpcUrl: () => mockRpc,
  isNetworkChoiceOverride: () => false
}));

const scope = { accountId: 'account-a', network: 'testnet', rpcUrl: 'https://node-a' };
beforeEach(() => {
  mockNetwork = 'testnet';
  mockRpc = 'https://node-a';
});

it('reads only proven landed rows for the same account, network and RPC at read time', () => {
  const rows: TokenBalanceData[] = [];
  tagBalanceSnapshot(rows, beginBalanceSnapshot()({ nonce: () => ({ asInt: () => 7n }) }), scope.accountId);
  expect(readBalanceSnapshot(rows, scope)).toMatchObject({ capturedAt: expect.any(Number), rpcUrl: scope.rpcUrl });
  expect(readBalanceSnapshot(rows, { ...scope, rpcUrl: 'https://node-b' })).toBeNull();
  expect(readBalanceSnapshot(rows, { ...scope, accountId: 'account-b' })).toBeNull();
  expect(readBalanceSnapshot([], scope)).toBeNull();
});

it('declines a late read when the endpoint or effective network changes during the vault read', () => {
  const finish = beginBalanceSnapshot();
  mockRpc = 'https://node-b';
  const rows: TokenBalanceData[] = [];
  tagBalanceSnapshot(rows, finish({ nonce: () => ({ asInt: () => 1n }) }), scope.accountId);
  expect(readBalanceSnapshot(rows, scope)).toBeNull();
  mockRpc = 'https://node-a';
  const finishNetwork = beginBalanceSnapshot();
  mockNetwork = 'devnet';
  const otherRows: TokenBalanceData[] = [];
  tagBalanceSnapshot(otherRows, finishNetwork({ nonce: () => ({ asInt: () => 1n }) }), scope.accountId);
  expect(readBalanceSnapshot(otherRows, { ...scope, network: 'devnet' })).toBeNull();
});
