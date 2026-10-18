import { registerPlugin } from '@capacitor/core';

export interface BreadConnectPlugin {
  /**
   * Opens Bread's link in Bread only: as a universal link only on iOS, and in the `com.miden.wallet` package signed
   * with Bread's certificate on Android. When Bread is not installed it opens Bread's store page instead and
   * resolves `opened: false`.
   */
  openWallet(options: { url: string }): Promise<{ opened: boolean }>;
}

export const BreadConnectNative = registerPlugin<BreadConnectPlugin>('BreadConnect');
