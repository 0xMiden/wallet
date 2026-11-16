import { activityRoute, createActivity, stampLegTimes, activityStartedAt } from './activity';
import { parseReceiptRoute } from './receipt-route';
import { now, testRoute } from '../testing/fixtures';

afterEach(() => jest.restoreAllMocks());
it('recovers from the original contracts even when current starts are paused or contracts change', () => {
  jest.spyOn(Date, 'now').mockReturnValue(now);
  const original = testRoute();
  const row = createActivity(original, '1.00000000');
  const parsed = parseReceiptRoute(JSON.parse(JSON.stringify(row.routeSnapshot)));
  expect(parsed).toEqual(original);
  const current = testRoute();
  current.disabled = true;
  const currentBridge = current.recovery.config.supportedEvmChains.sepolia?.bridges.agglayer;
  if (!currentBridge) throw new Error('Missing AggLayer fixture');
  currentBridge.contractAddress = `0x${'2'.repeat(40)}`;
  expect(activityRoute(row)?.recovery.config.supportedEvmChains.sepolia?.bridges.agglayer?.contractAddress).toBe(
    original.recovery.config.supportedEvmChains.sepolia?.bridges.agglayer?.contractAddress
  );
  expect(activityRoute({ ...row, provider: 'epoch' })).toBeUndefined();
  expect(activityRoute({ ...row, routeSnapshot: undefined })).toBeUndefined();
  expect(row.sourceTxHash).toBeUndefined();
  expect(row.destinationTxHash).toBeUndefined();
  expect(row.amount).toBe('1.00000000');
});
it('rejects corrupted receipts, cross-network assets and contracts not present in the recorded configuration', () => {
  expect(parseReceiptRoute(null)).toBeUndefined();
  expect(parseReceiptRoute({})).toBeUndefined();
  const route = testRoute();
  expect(
    parseReceiptRoute({ ...route, destination: { ...route.destination, network: 'miden-mainnet' } })
  ).toBeUndefined();
  expect(parseReceiptRoute({ ...route, recovery: { ...route.recovery, config: null } })).toBeUndefined();
  expect(
    parseReceiptRoute({ ...route, destination: { ...route.destination, faucetId: `0x${'2'.repeat(30)}` } })
  ).toBeUndefined();
});
it('stamps actual observed leg hashes once without inventing delivery or restarting old history', () => {
  jest.spyOn(Date, 'now').mockReturnValue(now);
  const row = createActivity(testRoute(), '1');
  expect(activityStartedAt(row)).toBe(now);
  const later = now + 1000;
  jest.spyOn(Date, 'now').mockReturnValue(later);
  const observed = stampLegTimes({ ...row, sourceTxHash: '0xsource', destinationTxHash: '0xdestination' });
  expect(observed.sourceTxAt).toBe(now);
  expect(observed.destinationTxAt).toBe(later);
  expect(stampLegTimes(observed)).toEqual(observed);
  expect(activityStartedAt({ ...row, sourceTxAt: undefined, updatedAt: later })).toBe(now);
  expect(activityStartedAt({ ...row, id: 'legacy', sourceTxAt: undefined, updatedAt: later })).toBe(later);
});
