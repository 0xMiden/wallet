import { SystemBarsStyle, SystemBarType } from '@capacitor/core';

import { syncStatusBar } from './status-bar';

const mockIsNativePlatform = jest.fn();
const mockGetPlatform = jest.fn();
const mockSetStyle = jest.fn();
const mockSetBackground = jest.fn();

jest.mock('@capacitor/core', () => {
  const actual = jest.requireActual<typeof import('@capacitor/core')>('@capacitor/core');
  return {
    SystemBarsStyle: actual.SystemBarsStyle,
    SystemBarType: actual.SystemBarType,
    Capacitor: {
      isNativePlatform: () => mockIsNativePlatform(),
      getPlatform: () => mockGetPlatform()
    },
    SystemBars: { setStyle: (options: unknown) => mockSetStyle(options) },
    registerPlugin: (name: string) =>
      name === 'SystemChrome' ? { setBackground: (options: unknown) => mockSetBackground(options) } : undefined
  };
});

// syncStatusBar is fire and forget, so let its native calls settle before asserting.
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function onPlatform(platform: 'ios' | 'android') {
  mockIsNativePlatform.mockReturnValue(true);
  mockGetPlatform.mockReturnValue(platform);
}

describe('lib/mobile/status-bar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetStyle.mockResolvedValue(undefined);
    mockSetBackground.mockResolvedValue(undefined);
  });

  it('does nothing off a native platform', async () => {
    mockIsNativePlatform.mockReturnValue(false);
    syncStatusBar(true);
    syncStatusBar(false);
    await flush();
    expect(mockSetStyle).not.toHaveBeenCalled();
    expect(mockSetBackground).not.toHaveBeenCalled();
  });

  it('styles the iOS status bar for each theme without a background call', async () => {
    onPlatform('ios');
    syncStatusBar(true);
    await flush();
    expect(mockSetStyle).toHaveBeenLastCalledWith({ style: SystemBarsStyle.Dark, bar: SystemBarType.StatusBar });
    syncStatusBar(false);
    await flush();
    expect(mockSetStyle).toHaveBeenLastCalledWith({ style: SystemBarsStyle.Light, bar: SystemBarType.StatusBar });
    expect(mockSetStyle).toHaveBeenCalledTimes(2);
    expect(mockSetBackground).not.toHaveBeenCalled();
  });

  it('styles the Android status bar and paints the page colour under it', async () => {
    onPlatform('android');
    syncStatusBar(true);
    await flush();
    expect(mockSetStyle).toHaveBeenLastCalledWith({ style: SystemBarsStyle.Dark, bar: SystemBarType.StatusBar });
    expect(mockSetBackground).toHaveBeenLastCalledWith({ color: '#191919' });
    syncStatusBar(false);
    await flush();
    expect(mockSetStyle).toHaveBeenLastCalledWith({ style: SystemBarsStyle.Light, bar: SystemBarType.StatusBar });
    expect(mockSetBackground).toHaveBeenLastCalledWith({ color: '#ffffff' });
  });

  it('paints the Android background only after setStyle settles', async () => {
    onPlatform('android');
    let settleStyle!: () => void;
    mockSetStyle.mockReturnValue(new Promise<void>(resolve => (settleStyle = resolve)));
    syncStatusBar(true);
    await flush();
    expect(mockSetStyle).toHaveBeenCalledTimes(1);
    expect(mockSetBackground).not.toHaveBeenCalled();
    settleStyle();
    await flush();
    expect(mockSetBackground).toHaveBeenCalledWith({ color: '#191919' });
  });

  // A rejection escaping syncStatusBar would be unhandled, and Jest fails the running test on one.
  it('swallows a rejected setStyle and still paints the Android background', async () => {
    onPlatform('android');
    mockSetStyle.mockRejectedValue(new Error('setStyle failed'));
    expect(() => syncStatusBar(true)).not.toThrow();
    await flush();
    expect(mockSetBackground).toHaveBeenCalledWith({ color: '#191919' });
  });

  it('swallows a rejected setBackground', async () => {
    onPlatform('android');
    mockSetBackground.mockRejectedValue(new Error('setBackground failed'));
    expect(() => syncStatusBar(false)).not.toThrow();
    await flush();
    expect(mockSetBackground).toHaveBeenCalledWith({ color: '#ffffff' });
  });
});
