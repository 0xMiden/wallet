import { installProviderReceiptBackend } from './receipt-backend';
import { checkpointProviderReceipt } from './receipt-writer';
import { getStorageHealth, markStorageUnavailable, resetStorageHealthForLifecycle } from '../storage-health';
import { oneClickReceiptRow } from './testing/provider-receipts';

const request = jest.fn();
jest.mock('lib/intercom/client', () => ({ createIntercomClient: () => ({ request }) }));
jest.mock('../back/store', () => ({
  withUnlocked: () => {
    throw new Error('Unexpected custody reentry');
  }
}));
const originalTarget = process.env.WALLET_BUILD_TARGET;
afterEach(async () => {
  installProviderReceiptBackend(undefined);
  process.env.WALLET_BUILD_TARGET = originalTarget;
  request.mockReset();
  await resetStorageHealthForLifecycle(getStorageHealth().epoch);
});

function deferred() {
  let release = () => {};
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}

it('Task4C2 writer awaits its role-bound backend without reentering unlocked custody', async () => {
  process.env.WALLET_BUILD_TARGET = 'extension';
  const ack = deferred();
  const received: unknown[] = [];
  installProviderReceiptBackend(async (value, epoch) => {
    received.push(value, epoch);
    await ack.promise;
  });
  let state = 'pending';
  const result = checkpointProviderReceipt(oneClickReceiptRow()).then(
    () => {
      state = 'fulfilled';
    },
    () => {
      state = 'refused';
    }
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(state).toBe('pending');
  expect(received.length).toBe(2);
  ack.release();
  await result;
  expect(state).toBe('fulfilled');
  expect(request).not.toHaveBeenCalled();
});

it.each(['popup', 'offscreen'])('Task4C2 writer awaits authenticated IPC acknowledgement from %s', async () => {
  process.env.WALLET_BUILD_TARGET = 'extension';
  const ack = deferred();
  request.mockImplementation(async () => {
    await ack.promise;
    return { type: 'PROVIDER_RECEIPT_RESPONSE' };
  });
  let state = 'pending';
  const result = checkpointProviderReceipt(oneClickReceiptRow()).then(
    () => {
      state = 'fulfilled';
    },
    () => {
      state = 'refused';
    }
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(state).toBe('pending');
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'PROVIDER_RECEIPT_REQUEST', expectedEpoch: getStorageHealth().epoch })
  );
  ack.release();
  await result;
  expect(state).toBe('fulfilled');
});

it('Task4C2 writer refuses an acknowledgement from an obsolete storage epoch', async () => {
  const ack = deferred();
  let reached = false;
  installProviderReceiptBackend(async () => {
    reached = true;
    await ack.promise;
  });
  const result = checkpointProviderReceipt(oneClickReceiptRow()).catch(error => error);
  await Promise.resolve();
  expect(reached).toBe(true);
  markStorageUnavailable('quota', { backend: 'wallet', operation: 'mutate' });
  ack.release();
  await expect(result).resolves.toMatchObject({ name: 'StorageUnavailableError' });
});
