/** @jest-environment node */
/**
 * The extension's service worker, where the delivery sweep runs. `isExtension()` holds there as it does in a page;
 * only the missing `window` tells the two apart, and jsdom cannot drop it (`window` is not configurable there).
 */
import { noteDeliveryWriteCount, recordNoteDelivery } from './helper';

const mockWakeWorker = jest.fn<Promise<unknown>, [unknown]>();

jest.mock('lib/intercom/client', () => ({
  createIntercomClient: () => ({ request: (payload: unknown) => mockWakeWorker(payload), subscribe: () => () => {} })
}));

jest.mock('lib/platform', () => ({
  ...jest.requireActual<typeof import('lib/platform')>('lib/platform'),
  isExtension: () => true
}));

jest.mock('lib/miden/repo', () => ({
  transactions: { where: () => ({ modify: async () => 1 }) }
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockWakeWorker.mockResolvedValue(undefined);
});

it('counts a delivery write made in the worker and sends it no signal', async () => {
  expect(typeof window).toBe('undefined');
  const writes = noteDeliveryWriteCount();

  await recordNoteDelivery('tx-1', 'relayed', { ackedNoteIds: ['0xnote'] });

  expect(noteDeliveryWriteCount()).toBe(writes + 1);
  expect(mockWakeWorker).not.toHaveBeenCalled();
});
