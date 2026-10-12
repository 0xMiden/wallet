import { dappWebViewManager } from '../../../packages/dapp-browser/dist/esm/multi-instance';

const mockOpen = jest.fn(async (_options: unknown) => {});
const mockClose = jest.fn(async (_options: unknown) => {});
jest.mock('../../../packages/dapp-browser/dist/esm/index.js', () => ({
  InAppBrowser: {
    openWebView: (options: unknown) => mockOpen(options),
    close: (options: unknown) => mockClose(options),
    closeAll: async () => {}
  }
}));

afterEach(async () => {
  await dappWebViewManager.closeAll();
  jest.clearAllMocks();
});

it('evicts a closed handle and permits a fresh native lifetime with the same id', async () => {
  const first = await dappWebViewManager.open({ id: 'origin', url: 'https://example.test' });
  await first.close();
  expect(dappWebViewManager.get('origin')).toBeUndefined();
  const next = await dappWebViewManager.open({ id: 'origin', url: 'https://example.test' });
  expect(next).not.toBe(first);
  expect(mockOpen).toHaveBeenCalledTimes(2);
});

it('does not resurrect a delayed open after closeAll or evict its replacement', async () => {
  let resolveOpen = () => {};
  mockOpen.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        resolveOpen = resolve;
      })
  );
  const pending = dappWebViewManager.open({ id: 'origin', url: 'https://example.test' });
  await dappWebViewManager.closeAll();
  const next = await dappWebViewManager.open({ id: 'origin', url: 'https://example.test' });
  resolveOpen();
  const stale = await pending;
  expect(dappWebViewManager.get('origin')).toBe(next);
  await stale.close();
  expect(dappWebViewManager.get('origin')).toBe(next);
  expect(mockClose).not.toHaveBeenCalled();
});
