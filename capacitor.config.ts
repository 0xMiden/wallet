import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.miden.wallet',
  appName: 'Miden Wallet',
  webDir: 'dist/mobile',
  server: {
    // Android keeps `http://localhost` so WASM workers can do gRPC fetches.
    // iOS uses Capacitor's default `capacitor://localhost` because Capacitor 8
    // rejects `iosScheme: 'http'` (WKWebView.handlesURLScheme('http') is true,
    // and InstanceDescriptor.normalize() silently resets to 'capacitor').
    // Mobile prove uses the native @miden/native-prover plugin, so we do not
    // need cross-origin isolation in the WebView.
    androidScheme: 'http',
    cleartext: true
  },
  plugins: {
    Preferences: {
      // No special config needed
    },
    Keyboard: {
      // Prevent keyboard from pushing content - overlay instead
      resize: 'none',
      // Show accessory bar (Done button) on iOS
      resizeOnFullScreen: true
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
