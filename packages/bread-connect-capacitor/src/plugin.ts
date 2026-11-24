import { registerPlugin } from '@capacitor/core';

export type NativeOpenStep = 'wallet' | 'primaryStore' | 'secondaryStore';

export interface NativeOpenResult {
  opened: boolean;
  next?: NativeOpenStep;
  cancelled?: boolean;
}

export interface BreadConnectPlugin {
  /**
   * Opens Bread's link in Bread only: as a universal link only on iOS, and in the `com.miden.wallet` package signed
   * with Bread's certificate on Android. When Bread is not installed it opens Bread's store page instead and
   * resolves `opened: false`.
   */
  openWallet(options: { url: string }): Promise<{ opened: boolean }>;
  /** Registers a validated Bread request without opening it. */
  prepareOpen(options: { url: string }): Promise<{ attemptId: string }>;
  /** Performs one native handoff; fallback requires another explicit step. */
  openStep(options: { attemptId: string; step: NativeOpenStep }): Promise<NativeOpenResult>;
  /** Requests release of this attempt's native resources. */
  revokeOpen(options: { attemptId: string }): Promise<void>;
}

export const BreadConnectNative = registerPlugin<BreadConnectPlugin>('BreadConnect');
