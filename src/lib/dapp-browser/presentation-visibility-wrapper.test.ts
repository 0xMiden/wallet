import { DappWebViewInstance } from '../../../packages/dapp-browser/dist/esm/multi-instance';

const mockVisible = jest.fn(async (_options: unknown) => {});
const mockRect = jest.fn(async (_options: unknown) => {});
jest.mock('../../../packages/dapp-browser/dist/esm/index.js', () => ({
  InAppBrowser: {
    setVisible: (options: unknown) => mockVisible(options),
    updateDimensions: (options: unknown) => mockRect(options),
    close: async () => {}
  }
}));

afterEach(() => jest.clearAllMocks());

it('binds each visibility command to its immutable lifetime and increasing sequence', async () => {
  const instance = new DappWebViewInstance('session', 'lifetime');
  const acknowledge = instance.setVisible as (visible: boolean, revision?: number) => Promise<void>;
  await acknowledge.call(instance, true, 3);
  await acknowledge.call(instance, false);
  await acknowledge.call(instance, true, 3);
  expect(mockVisible.mock.calls.map(([options]) => options)).toEqual([
    { id: 'session', visible: true, managedHostCloseToken: 'lifetime', visibilitySequence: 1, policyRevision: 3 },
    { id: 'session', visible: false, managedHostCloseToken: 'lifetime', visibilitySequence: 2 },
    { id: 'session', visible: true, managedHostCloseToken: 'lifetime', visibilitySequence: 3, policyRevision: 3 }
  ]);
});

it('does not let a closed wrapper dispatch into a replacement lifetime', async () => {
  const instance = new DappWebViewInstance('session', 'outgoing');
  await instance.close();
  await instance.setVisible(true);
  await instance.setRect({ x: 0, y: 0, width: 100, height: 100 });
  expect(mockVisible).not.toHaveBeenCalled();
  expect(mockRect).not.toHaveBeenCalled();
});

it('binds bounds to the same managed lifetime and preserves the legacy signature', async () => {
  const rect = { x: 0, y: 10, width: 100, height: 90 };
  await new DappWebViewInstance('managed', 'lifetime').setRect(rect);
  await new DappWebViewInstance('legacy').setVisible(true);
  expect(mockRect).toHaveBeenCalledWith({ id: 'managed', managedHostCloseToken: 'lifetime', ...rect });
  expect(mockVisible).toHaveBeenCalledWith({ id: 'legacy', visible: true });
});

it('exposes the latest issued visibility sequence without a writable getter', async () => {
  const instance = new DappWebViewInstance('session', 'lifetime');
  expect(instance.currentVisibilitySequence).toBe(0);
  await instance.setVisible(true, 3);
  expect(instance.currentVisibilitySequence).toBe(1);
  await instance.setVisible(false);
  expect(instance.currentVisibilitySequence).toBe(2);
  expect(
    Object.getOwnPropertyDescriptor(DappWebViewInstance.prototype, 'currentVisibilitySequence')?.set
  ).toBeUndefined();
});
