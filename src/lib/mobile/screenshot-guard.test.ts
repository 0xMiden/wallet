import { act, renderHook } from '@testing-library/react';

import { __resetScreenshotGuardForTest, useScreenshotGuard } from './screenshot-guard';

const mockEnable = jest.fn();
const mockDisable = jest.fn();

jest.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ enable: () => mockEnable(), disable: () => mockDisable() })
}));

const mockSetProtected = jest.fn();
let mockPlatform: 'mobile' | 'desktop' | 'extension' = 'mobile';

jest.mock('lib/desktop/content-protection', () => ({
  setWindowContentProtected: (enabled: boolean) => mockSetProtected(enabled)
}));

jest.mock('lib/platform', () => ({
  isMobile: () => mockPlatform === 'mobile',
  isDesktop: () => mockPlatform === 'desktop'
}));

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

function deferred() {
  let resolve: () => void = () => {};
  let reject: (err: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nativeCallOrder() {
  return [
    ...mockEnable.mock.invocationCallOrder.map(order => ({ order, call: 'enable' })),
    ...mockDisable.mock.invocationCallOrder.map(order => ({ order, call: 'disable' }))
  ]
    .sort((a, b) => a.order - b.order)
    .map(({ call }) => call);
}

describe('useScreenshotGuard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetScreenshotGuardForTest();
    mockPlatform = 'mobile';
    mockSetProtected.mockResolvedValue(undefined);
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

  it('retries the native enable for the next holder after a failed one', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockEnable.mockRejectedValue(new Error('enable failed'));
    const first = renderHook(() => useScreenshotGuard());
    await settle();
    expect(first.result.current).toBe(false);

    mockEnable.mockResolvedValue(undefined);
    const second = renderHook(() => useScreenshotGuard());
    await settle();
    expect(mockEnable).toHaveBeenCalledTimes(2);
    expect(second.result.current).toBe(true);
    expect(first.result.current).toBe(false);
    warn.mockRestore();
  });

  it('starts a fresh enable for a holder that mounts after the last one released', async () => {
    const firstEnable = deferred();
    mockEnable.mockReturnValueOnce(firstEnable.promise);
    const first = renderHook(() => useScreenshotGuard());
    await settle();
    expect(first.result.current).toBe(false);
    first.unmount();
    expect(mockDisable).toHaveBeenCalledTimes(1);

    const secondEnable = deferred();
    mockEnable.mockReturnValueOnce(secondEnable.promise);
    const second = renderHook(() => useScreenshotGuard());
    await settle();
    expect(second.result.current).toBe(false);

    secondEnable.resolve();
    await settle();
    expect(second.result.current).toBe(true);
    expect(nativeCallOrder()).toEqual(['enable', 'disable', 'enable']);
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

  it('keeps a newer shared enable when an enable from before the release rejects', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const firstEnable = deferred();
    mockEnable.mockReturnValueOnce(firstEnable.promise);
    const first = renderHook(() => useScreenshotGuard());
    await settle();
    first.unmount();
    expect(mockDisable).toHaveBeenCalledTimes(1);

    const secondEnable = deferred();
    mockEnable.mockReturnValueOnce(secondEnable.promise);
    const second = renderHook(() => useScreenshotGuard());
    await settle();

    firstEnable.reject(new Error('enable failed'));
    await settle();

    const third = renderHook(() => useScreenshotGuard());
    await settle();
    expect(mockEnable).toHaveBeenCalledTimes(2);

    secondEnable.resolve();
    await settle();
    expect(second.result.current).toBe(true);
    expect(third.result.current).toBe(true);
    warn.mockRestore();
  });

  it('ignores an enable that resolves after its holder released and acquired again', async () => {
    const firstEnable = deferred();
    mockEnable.mockReturnValueOnce(firstEnable.promise);
    const { result, rerender } = renderHook(({ active }) => useScreenshotGuard(active), {
      initialProps: { active: true }
    });
    await settle();

    const secondEnable = deferred();
    mockEnable.mockReturnValueOnce(secondEnable.promise);
    rerender({ active: false });
    rerender({ active: true });
    await settle();
    expect(nativeCallOrder()).toEqual(['enable', 'disable', 'enable']);

    firstEnable.resolve();
    await settle();
    expect(result.current).toBe(false);

    secondEnable.resolve();
    await settle();
    expect(result.current).toBe(true);
  });

  describe('on desktop', () => {
    beforeEach(() => {
      mockPlatform = 'desktop';
    });

    it('on desktop, withholds until window protection is on, then reports ready', async () => {
      const enable = deferred();
      mockSetProtected.mockReturnValue(enable.promise);
      const { result } = renderHook(() => useScreenshotGuard());
      await settle();
      expect(result.current).toBe(false);
      expect(mockSetProtected).toHaveBeenCalledTimes(1);
      expect(mockSetProtected).toHaveBeenCalledWith(true);
      expect(mockEnable).not.toHaveBeenCalled();

      enable.resolve();
      await settle();
      expect(result.current).toBe(true);
    });

    it('on desktop, two holders share one enable and the last release turns protection off', async () => {
      const first = renderHook(() => useScreenshotGuard());
      const second = renderHook(() => useScreenshotGuard());
      await settle();
      expect(mockSetProtected).toHaveBeenCalledTimes(1);

      first.unmount();
      expect(mockSetProtected).not.toHaveBeenCalledWith(false);

      second.unmount();
      expect(mockSetProtected.mock.calls.filter(([enabled]) => enabled === false)).toHaveLength(1);
    });

    it('on desktop, a failed enable still reports ready and logs', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockSetProtected.mockRejectedValue(new Error('no window flag'));
      const { result } = renderHook(() => useScreenshotGuard());
      await settle();
      expect(result.current).toBe(true);
      expect(warn).toHaveBeenCalledWith('[screenshot-guard] content protection failed:', expect.any(Error));
      warn.mockRestore();
    });
  });

  it('on the extension, reports ready at once and protects nothing', async () => {
    mockPlatform = 'extension';
    const { result } = renderHook(() => useScreenshotGuard());
    await settle();
    expect(result.current).toBe(true);
    expect(mockEnable).not.toHaveBeenCalled();
    expect(mockSetProtected).not.toHaveBeenCalled();
  });
});
