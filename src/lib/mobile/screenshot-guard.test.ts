import { act, renderHook } from '@testing-library/react';

import { __resetScreenshotGuardForTest, useScreenshotGuard } from './screenshot-guard';

const mockEnable = jest.fn();
const mockDisable = jest.fn();

jest.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ enable: () => mockEnable(), disable: () => mockDisable() })
}));

jest.mock('lib/platform', () => ({ isMobile: () => true }));

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useScreenshotGuard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetScreenshotGuardForTest();
    mockEnable.mockResolvedValue(undefined);
    mockDisable.mockResolvedValue(undefined);
  });

  it('enables once for two holders and disables only when the last one unmounts', async () => {
    const first = renderHook(() => useScreenshotGuard());
    const second = renderHook(() => useScreenshotGuard());
    await settle();
    expect(mockEnable).toHaveBeenCalledTimes(1);

    first.unmount();
    expect(mockDisable).not.toHaveBeenCalled();
    expect(second.result.current).toBe(true);

    second.unmount();
    expect(mockDisable).toHaveBeenCalledTimes(1);
  });

  it('reports true in both holders only after the shared enable resolves', async () => {
    const enable = deferred();
    mockEnable.mockReturnValue(enable.promise);
    const first = renderHook(() => useScreenshotGuard());
    const second = renderHook(() => useScreenshotGuard());
    await settle();
    expect(first.result.current).toBe(false);
    expect(second.result.current).toBe(false);

    enable.resolve();
    await settle();
    expect(first.result.current).toBe(true);
    expect(second.result.current).toBe(true);
  });

  it('reports true on the next render for a holder that mounts after the enable resolved', async () => {
    renderHook(() => useScreenshotGuard());
    await settle();

    const seen: boolean[] = [];
    renderHook(() => {
      const ready = useScreenshotGuard();
      seen.push(ready);
      return ready;
    });
    await settle();
    expect(seen[0]).toBe(false);
    expect(seen[seen.length - 1]).toBe(true);
  });

  it('leaves every holder false when the enable rejects', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockEnable.mockRejectedValue(new Error('enable failed'));
    const first = renderHook(() => useScreenshotGuard());
    const second = renderHook(() => useScreenshotGuard());
    await settle();
    expect(first.result.current).toBe(false);
    expect(second.result.current).toBe(false);
    warn.mockRestore();
  });

  it('neither enables nor counts an inactive holder', async () => {
    const inactive = renderHook(() => useScreenshotGuard(false));
    await settle();
    expect(mockEnable).not.toHaveBeenCalled();
    expect(inactive.result.current).toBe(true);

    const active = renderHook(() => useScreenshotGuard());
    await settle();
    active.unmount();
    expect(mockDisable).toHaveBeenCalledTimes(1);
  });
});
