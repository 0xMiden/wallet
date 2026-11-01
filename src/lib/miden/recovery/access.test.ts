import {
  assertStorageHealthy,
  assertStorageRecoveryAllowed,
  getStorageHealth,
  markStorageUnavailable,
  resetStorageHealthForLifecycle,
  withStorageRecoveryAccess,
  type StorageRecoveryCapability
} from '../storage-health';

it('grants bounded recovery reads without allowing ordinary writes or clearing health', async () => {
  markStorageUnavailable('continuity', { backend: 'sdk', operation: 'validate' });
  let granted: StorageRecoveryCapability | undefined;
  try {
    const epoch = getStorageHealth().epoch;
    const result = await withStorageRecoveryAccess(epoch, Date.now() + 1000, async capability => {
      granted = capability;
      expect(() => assertStorageHealthy()).toThrow();
      assertStorageRecoveryAllowed(capability);
      return 'retained';
    });
    expect(result).toBe('retained');
    expect(getStorageHealth().status).toBe('unavailable');
    if (!granted) throw new Error('Missing capability');
    const expired = granted;
    expect(() => assertStorageRecoveryAllowed(expired)).toThrow();
  } finally {
    await resetStorageHealthForLifecycle(getStorageHealth().epoch);
  }
});
it('refuses late recovery results after a new failure revokes the grant', async () => {
  try {
    const epoch = getStorageHealth().epoch;
    await expect(
      withStorageRecoveryAccess(epoch, Date.now() + 1000, async () => {
        markStorageUnavailable('continuity', { backend: 'sdk', operation: 'validate' });
        return 'late';
      })
    ).rejects.toThrow('StorageUnavailableError');
  } finally {
    await resetStorageHealthForLifecycle(getStorageHealth().epoch);
  }
});
it('refuses remote recovery windows longer than five seconds', async () => {
  await expect(
    withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 6000, async () => true)
  ).rejects.toThrow();
});
