import type { CapacitorConfig } from '@capacitor/cli';

///@ts-ignore
const isLiveReload = process.argv.includes('--live-reload') || process.argv.includes('-l');

const config: CapacitorConfig = {
  appId: 'com.miden.bread',
  appName: 'Bread',
  webDir: 'dist/mobile',
  server: {
    // Android keeps `http://localhost` so WASM workers can do gRPC fetches.
    // iOS uses Capacitor's default `capacitor://localhost` because Capacitor 8
    // rejects `iosScheme: 'http'` (WKWebView.handlesURLScheme('http') is true,
    // and InstanceDescriptor.normalize() silently resets to 'capacitor').
    // Mobile prove uses the native @miden/native-prover plugin, so we do not
    // need cross-origin isolation in the WebView.
    androidScheme: 'http',
    cleartext: true,
    ...(isLiveReload ? { appStartPath: '/mobile.html' } : {})
  },
  plugins: {
    Preferences: {
      // No special config needed
    },
    Keyboard: {
      // Prevent keyboard from pushing content - overlay instead.
      // iOS-ONLY: the Android Keyboard plugin ignores `resize` entirely
      // (it only reads `resizeOnFullScreen`). Android instead pins
      // android:windowSoftInputMode="adjustResize" on MainActivity so the
      // native window resize is the single compensator there; the JS
      // --keyboard-height inset (lib/mobile/keyboard-inset.ts) is gated to
      // iOS only. Changing either side alone double-compensates or removes
      // all compensation — keep the pair in sync.
      resize: 'none'
      // The iOS accessory bar (Done + arrows) — the only way to dismiss the
      // number pad, which has no return key — is enabled at RUNTIME via
      // Keyboard.setAccessoryBarVisible() in lib/mobile/keyboard-inset.ts.
      // There is no `accessoryBarVisible` Keyboard *config* key; setting one
      // here typechecks (PluginsConfig has an index signature) but is ignored.
    },
    SplashScreen: {
      // Auto-hide after app is ready
      launchAutoHide: true,
      // Show splash for at least 1 second
      launchShowDuration: 1000,
      // Fade out animation duration
      launchFadeOutDuration: 300,
      // Background color while loading
      backgroundColor: '#FFFFFF',
      // Don't show spinner - we have a logo
      showSpinner: false,
      // Android: scale image to fit
      androidScaleType: 'CENTER_CROP',
      // iOS: use dark spinner if needed
      iosSpinnerStyle: 'small'
    }
  }
};

export default config;
