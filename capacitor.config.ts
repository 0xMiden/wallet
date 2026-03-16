import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.midenfi.wallet',
  appName: 'Miden Wallet',
  webDir: 'dist/mobile',
  server: {
    // Use HTTP scheme on both platforms to allow network requests from WASM workers
    // Note: This is for development/testnet only. Production should use HTTPS throughout.
    androidScheme: 'http',
    iosScheme: 'http',
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
