import { beginBalanceSnapshot, hasBalanceSnapshotForNetwork, tagBalanceSnapshot } from './balance-snapshot';
import type { TokenBalanceData } from './front/balance';
import {
  applyEndpointOverride,
  buildNetworkChoiceOverride,
  clearEndpointOverride
} from '../miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from '../miden-chain/networks-config';

jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({ set: jest.fn(async () => {}), remove: jest.fn(async () => {}) })
}));

afterEach(async () => {
  await clearEndpointOverride();
});

it('recognizes an ordinary persisted network choice without accepting a custom endpoint', async () => {
  await applyEndpointOverride(buildNetworkChoiceOverride(MIDEN_NETWORK_NAME.TESTNET));
  const rows: TokenBalanceData[] = [];
  const account = { nonce: () => ({ asInt: () => 7n }) };
  tagBalanceSnapshot(rows, beginBalanceSnapshot()(account));
  expect(hasBalanceSnapshotForNetwork(rows, 'testnet')).toBe(true);
  expect(hasBalanceSnapshotForNetwork(rows, 'mainnet')).toBe(false);
  await applyEndpointOverride({
    ...buildNetworkChoiceOverride(MIDEN_NETWORK_NAME.TESTNET),
    rpcUrl: 'https://custom.example'
  });
  tagBalanceSnapshot(rows, beginBalanceSnapshot()(account));
  expect(hasBalanceSnapshotForNetwork(rows, 'testnet')).toBe(false);
});

it('drops display provenance when a saved choice becomes custom during a read', async () => {
  await applyEndpointOverride(buildNetworkChoiceOverride(MIDEN_NETWORK_NAME.TESTNET));
  const finish = beginBalanceSnapshot();
  await applyEndpointOverride({ ...buildNetworkChoiceOverride(MIDEN_NETWORK_NAME.TESTNET), allowNoGuardian: true });
  const rows: TokenBalanceData[] = [];
  tagBalanceSnapshot(rows, finish({ nonce: () => ({ asInt: () => 7n }) }));
  expect(hasBalanceSnapshotForNetwork(rows, 'testnet')).toBe(false);
});
