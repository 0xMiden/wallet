import { getMidenClientForRecovery, withWasmClientLock } from './miden-client';
import {
  assertStorageHealthy,
  getStorageHealth,
  markStorageUnavailable,
  resetStorageHealthForLifecycle,
  withStorageRecoveryAccess
} from '../storage-health';

const mockClient = { free: jest.fn() };
const mockCreate = jest.fn().mockResolvedValue(mockClient);
jest.mock('./miden-client-interface', () => ({
  MidenClientInterface: {
    create: (...args: unknown[]) => mockCreate(...args),
    createForRecovery: (...args: unknown[]) => mockCreate(...args)
  }
}));

it('reuses one recovery singleton across repeated unavailable checks', async () => {
  markStorageUnavailable('continuity', { backend: 'sdk', operation: 'validate' });
  try {
    const read = () =>
      withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 1000, capability =>
        withWasmClientLock(() => getMidenClientForRecovery(capability))
      );
    expect(await read()).toBe(mockClient);
    expect(await read()).toBe(mockClient);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockClient.free).not.toHaveBeenCalled();
    expect(() => assertStorageHealthy()).toThrow();
  } finally {
    await resetStorageHealthForLifecycle(getStorageHealth().epoch);
  }
});
