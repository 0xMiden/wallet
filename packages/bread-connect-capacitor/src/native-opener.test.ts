import { openManagedWallet } from './native-opener.js';

const mockPrepare = jest.fn();
const mockStep = jest.fn();
const mockRevoke = jest.fn();

jest.mock('./plugin.js', () => ({
  BreadConnectNative: {
    prepareOpen: (options: unknown) => mockPrepare(options),
    openStep: (options: unknown) => mockStep(options),
    revokeOpen: (options: unknown) => mockRevoke(options)
  }
}));

const LINK = 'https://bread.miden.xyz/request#v=1&m=request';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  mockPrepare.mockReset().mockResolvedValue({ attemptId: 'native-1' });
  mockStep.mockReset();
  mockRevoke.mockReset().mockResolvedValue(undefined);
});

it('finishes a successful wallet step and releases its native handle once', async () => {
  mockStep.mockResolvedValueOnce({ opened: true });
  const controller = new AbortController();
  await expect(openManagedWallet(LINK, controller.signal)).resolves.toBe(true);
  expect(mockPrepare).toHaveBeenCalledWith({ url: LINK });
  expect(mockStep.mock.calls).toEqual([[{ attemptId: 'native-1', step: 'wallet' }]]);
  expect(mockRevoke).not.toHaveBeenCalled();
  controller.abort();
  expect(mockRevoke).not.toHaveBeenCalled();
});

it('stops after the native primary store result without treating the store as Bread', async () => {
  mockStep.mockResolvedValueOnce({ opened: false, next: 'primaryStore' }).mockResolvedValueOnce({ opened: false });
  await expect(openManagedWallet(LINK, new AbortController().signal)).resolves.toBe(false);
  expect(mockStep.mock.calls).toEqual([
    [{ attemptId: 'native-1', step: 'wallet' }],
    [{ attemptId: 'native-1', step: 'primaryStore' }]
  ]);
  expect(mockRevoke).not.toHaveBeenCalled();
});

it('uses a native secondary store only when the primary store returns that next step', async () => {
  mockStep
    .mockResolvedValueOnce({ opened: false, next: 'primaryStore' })
    .mockResolvedValueOnce({ opened: false, next: 'secondaryStore' })
    .mockResolvedValueOnce({ opened: false });
  await expect(openManagedWallet(LINK, new AbortController().signal)).resolves.toBe(false);
  expect(mockStep.mock.calls.map(call => call[0].step)).toEqual(['wallet', 'primaryStore', 'secondaryStore']);
  expect(mockRevoke).not.toHaveBeenCalled();
});

it('leaves a closed native attempt neutral instead of inventing a not-installed result', async () => {
  mockStep.mockResolvedValueOnce({ opened: false, cancelled: true });
  await expect(openManagedWallet(LINK, new AbortController().signal)).resolves.toBe(true);
  expect(mockStep).toHaveBeenCalledTimes(1);
  expect(mockRevoke).toHaveBeenCalledTimes(1);
});

it('preserves preparation failure without trying to revoke an unknown handle', async () => {
  const error = new Error('invalid request');
  mockPrepare.mockRejectedValueOnce(error);
  await expect(openManagedWallet(LINK, new AbortController().signal)).rejects.toBe(error);
  expect(mockStep).not.toHaveBeenCalled();
  expect(mockRevoke).not.toHaveBeenCalled();
});

it('carries an abort close request while an admitted successful operation completes', async () => {
  let finish: ((result: { opened: boolean }) => void) | undefined;
  mockStep.mockImplementationOnce(() => new Promise(resolve => (finish = resolve)));
  const controller = new AbortController();
  const opening = openManagedWallet(LINK, controller.signal);
  await flush();
  controller.abort();
  expect(mockRevoke.mock.calls).toEqual([[{ attemptId: 'native-1' }]]);
  if (!finish) throw new Error('wallet step not reached');
  finish({ opened: true });
  await expect(opening).resolves.toBe(true);
  expect(mockRevoke).toHaveBeenCalledTimes(1);
});

it('keeps the active open error when cleanup rejects', async () => {
  const error = new Error('open failed');
  mockStep.mockRejectedValueOnce(error);
  mockRevoke.mockRejectedValueOnce(new Error('cleanup failed'));
  await expect(openManagedWallet(LINK, new AbortController().signal)).rejects.toBe(error);
  await flush();
  expect(mockRevoke).toHaveBeenCalledTimes(1);
});
