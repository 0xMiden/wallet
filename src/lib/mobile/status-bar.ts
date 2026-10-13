import { Capacitor, registerPlugin, SystemBars, SystemBarsStyle, SystemBarType } from '@capacitor/core';

import { ResolvedTheme } from 'lib/settings/constants';

interface SystemChromePlugin {
  setBackground(options: { color: string }): Promise<void>;
}

const SystemChrome = registerPlugin<SystemChromePlugin>('SystemChrome');

/** The page colour native chrome sits on in each resolved theme; the WebView headers use it too. */
export const NATIVE_PAGE_COLOR: Record<ResolvedTheme, string> = { dark: '#191919', light: '#ffffff' };

async function ignoreFailure(call: () => Promise<void>): Promise<void> {
  try {
    await call();
  } catch {
    // Theming never fails on a native call.
  }
}

async function applyNativeTheme(dark: boolean): Promise<void> {
  await ignoreFailure(() =>
    SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light, bar: SystemBarType.StatusBar })
  );
  if (Capacitor.getPlatform() !== 'android') return;
  // SystemBars.setStyle resets the window background to the theme's
  // windowBackground, so the page colour goes on only after it settles.
  await ignoreFailure(() => SystemChrome.setBackground({ color: NATIVE_PAGE_COLOR[dark ? 'dark' : 'light'] }));
}

/**
 * Matches the native status bar to the app theme: contrasting icons or text on
 * iOS and Android, and on Android the theme's page colour under the bar (on
 * iOS the WebView draws under the bar, so the themed body shows there).
 * Fire and forget; a no-op off native.
 */
export function syncStatusBar(dark: boolean): void {
  if (!Capacitor.isNativePlatform()) return;
  void applyNativeTheme(dark);
}
