import { dappWebViewManager } from '../../../packages/dapp-browser/dist/esm/multi-instance';

const mockOpen = jest.fn(async (_options: unknown) => {});
const mockCloseAll = jest.fn(async () => {});
const mockClose = jest.fn(async (_options: unknown) => {});
jest.mock('../../../packages/dapp-browser/dist/esm/index.js', () => ({
  InAppBrowser: {
    openWebView: (options: unknown) => mockOpen(options),
    close: (options: unknown) => mockClose(options),
    closeAll: () => mockCloseAll()
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

it('reserves a managed id while its native close promise still owns the surface', async () => {
  let finish = () => {};
  mockClose.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  const first = await dappWebViewManager.open({
    id: 'origin',
    url: 'https://example.test',
    managedHostClose: { token: 'old', errorLabel: '', retryLabel: '', exitLabel: '' }
  });
  const closing = first.close();
  await expect(dappWebViewManager.open({ id: 'origin', url: 'https://replacement.test' })).rejects.toThrow(
    'managed instance'
  );
  expect(mockOpen).toHaveBeenCalledTimes(1);
  finish();
  await closing;
  expect(await dappWebViewManager.open({ id: 'origin', url: 'https://replacement.test' })).not.toBe(first);
});

it('keeps an evicted managed id reserved and ignores a stale terminal token', async () => {
  await dappWebViewManager.open({
    id: 'origin',
    url: 'https://example.test',
    managedHostClose: { token: 'old', errorLabel: '', retryLabel: '', exitLabel: '' }
  });
  dappWebViewManager.reserveClose('origin', 'old');
  dappWebViewManager.forget('origin', 'stale');
  expect(dappWebViewManager.get('origin')).toBeUndefined();
  await expect(dappWebViewManager.open({ id: 'origin', url: 'https://replacement.test' })).rejects.toThrow(
    'managed instance'
  );
  dappWebViewManager.forget('origin', 'old');
  await dappWebViewManager.open({ id: 'origin', url: 'https://replacement.test' });
  expect(mockOpen).toHaveBeenCalledTimes(2);
});

it('does not release managed ids until native closeAll has settled', async () => {
  await dappWebViewManager.open({
    id: 'origin',
    url: 'https://example.test',
    managedHostClose: { token: 'old', errorLabel: '', retryLabel: '', exitLabel: '' }
  });
  let finish = () => {};
  mockCloseAll.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  const closing = dappWebViewManager.closeAll();
  await expect(dappWebViewManager.open({ id: 'origin', url: 'https://replacement.test' })).rejects.toThrow(
    'managed instance'
  );
  finish();
  await closing;
  await dappWebViewManager.open({ id: 'origin', url: 'https://replacement.test' });
  expect(mockOpen).toHaveBeenCalledTimes(2);
});

it('keeps the host reservation after native close until persistence releases it', async () => {
  let finish = () => {};
  mockClose.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  const instance = await dappWebViewManager.open({
    id: 'origin',
    url: 'https://example.test',
    managedHostClose: { token: 'old', errorLabel: '', retryLabel: '', exitLabel: '' }
  });
  const closing = instance.close();
  dappWebViewManager.reserveClose('origin', 'old');
  finish();
  await closing;
  await expect(dappWebViewManager.open({ id: 'origin', url: 'https://replacement.test' })).rejects.toThrow(
    'managed instance'
  );
  dappWebViewManager.forget('origin', 'old');
  expect(await dappWebViewManager.open({ id: 'origin', url: 'https://replacement.test' })).not.toBe(instance);
});

it('rejects a different token while a managed lifetime is live without replacing its cache', async () => {
  const options = {
    id: 'origin',
    url: 'https://example.test',
    managedHostClose: { token: 'old', errorLabel: '', retryLabel: '', exitLabel: '' }
  };
  const first = await dappWebViewManager.open(options);
  await expect(
    dappWebViewManager.open({ ...options, managedHostClose: { ...options.managedHostClose, token: 'new' } })
  ).rejects.toThrow('managed instance');
  expect(await dappWebViewManager.open(options)).toBe(first);
  expect(dappWebViewManager.get('origin')).toBe(first);
  expect(mockOpen).toHaveBeenCalledTimes(1);
});
