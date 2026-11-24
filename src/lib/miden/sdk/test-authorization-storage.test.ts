import { handleTestAuthorizationStorage } from './test-authorization-storage';

const key = '__miden_e2e_offscreen_fetch_faults';
const wire = [{ id: 'discovery', host: ':57291', path: 'NodeService/Sync', mode: 'hang' }];
const mockGet = jest.fn(async () => ({ [key]: wire }));
const mockSet = jest.fn();
const originalE2eFlag = process.env.MIDEN_E2E_TEST;
jest.mock('../../platform/storage-adapter', () => ({
  getStorageProvider: () => ({ get: mockGet, set: mockSet })
}));

beforeEach(() => {
  process.env.MIDEN_E2E_TEST = 'true';
  mockGet.mockClear();
  mockSet.mockClear();
});
afterEach(() => {
  if (originalE2eFlag === undefined) delete process.env.MIDEN_E2E_TEST;
  else process.env.MIDEN_E2E_TEST = originalE2eFlag;
});

it('reads the public offscreen fault policy through the existing E2E metadata relay', async () => {
  const result = await handleTestAuthorizationStorage({ operation: 'get', keys: [key] }).catch(() => undefined);
  expect(result).toEqual({ ok: true, value: { [key]: wire } });
});

it('does not turn the fault-policy read into permission to write through the authorization relay', async () => {
  await expect(handleTestAuthorizationStorage({ operation: 'set', items: { [key]: wire } })).rejects.toThrow();
  expect(mockSet).not.toHaveBeenCalled();
});

it('keeps arbitrary storage keys inaccessible', async () => {
  await expect(handleTestAuthorizationStorage({ operation: 'get', keys: ['vault'] })).rejects.toThrow();
  expect(mockGet).not.toHaveBeenCalled();
});

it('keeps the fault-policy relay disabled outside E2E builds', async () => {
  process.env.MIDEN_E2E_TEST = 'false';
  await expect(handleTestAuthorizationStorage({ operation: 'get', keys: [key] })).rejects.toThrow();
  expect(mockGet).not.toHaveBeenCalled();
});
