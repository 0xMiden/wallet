import {
  AUTO_CONSUME_STORAGE_KEY,
  BG_SETTINGS_MIRRORED_KEY,
  DELEGATE_PROOF_STORAGE_KEY,
  TELEMETRY_STORAGE_KEY
} from './constants';
import {
  areBackgroundSettingsMirrored,
  isDelegateProofEnabledAsync,
  isTelemetryEnabledAsync,
  mirrorBackgroundSettings,
  setDelegateProofSetting,
  setTelemetrySetting
} from './helpers';

const mockValues = new Map<string, string>();
const mockDelegateKey = DELEGATE_PROOF_STORAGE_KEY;
const mockAutoConsumeKey = AUTO_CONSUME_STORAGE_KEY;
let mockPauseDelegate: (() => Promise<void>) | undefined;
let mockPauseAutoConsume: (() => Promise<void>) | undefined;

jest.mock('lib/platform', () => ({ isExtension: () => false, isMobile: () => true, isDesktop: () => false }));
jest.mock('lib/miden-chain/networks-config', () => ({ RENAMED_GUARDIAN_ENDPOINTS: {} }));
jest.mock('lib/platform/storage-adapter', () => {
  const actual = jest.requireActual('lib/platform/storage-adapter');
  return { ...actual, getStorageProvider: () => new actual.CapacitorStorage() };
});
jest.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: mockValues.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      mockValues.set(key, value);
      if (key === mockAutoConsumeKey && value === 'true' && mockPauseAutoConsume) await mockPauseAutoConsume();
      // Hold the preceding native write before a batch can dispatch telemetry.
      if (key === mockDelegateKey && value === 'true') await mockPauseDelegate?.();
    }
  }
}));

it('keeps a completed telemetry opt-out while a sequential native mirror batch is in flight', async () => {
  localStorage.clear();
  mockValues.clear();
  for (const key of [AUTO_CONSUME_STORAGE_KEY, DELEGATE_PROOF_STORAGE_KEY, TELEMETRY_STORAGE_KEY]) {
    localStorage.setItem(key, 'true');
  }
  let releaseDelegate!: () => void;
  const delegatePending = new Promise<void>(resolve => {
    releaseDelegate = resolve;
  });
  let signalPaused!: () => void;
  const delegatePaused = new Promise<void>(resolve => {
    signalPaused = resolve;
  });
  mockPauseDelegate = () => {
    signalPaused();
    return delegatePending;
  };

  try {
    mirrorBackgroundSettings();
    await delegatePaused;
    await setTelemetrySetting(false);
    expect(await isTelemetryEnabledAsync()).toBe(false);
    releaseDelegate();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(await areBackgroundSettingsMirrored()).toBe(true);
    expect(await isTelemetryEnabledAsync()).toBe(false);
    expect(mockValues.get(TELEMETRY_STORAGE_KEY)).toBe('false');
    expect(mockValues.get(BG_SETTINGS_MIRRORED_KEY)).toBe('true');
  } finally {
    releaseDelegate();
    mockPauseDelegate = undefined;
    localStorage.clear();
  }
});

it('keeps completed later-key opt-outs while an earlier native write is in flight', async () => {
  localStorage.clear();
  mockValues.clear();
  for (const key of [AUTO_CONSUME_STORAGE_KEY, DELEGATE_PROOF_STORAGE_KEY, TELEMETRY_STORAGE_KEY]) {
    localStorage.setItem(key, 'true');
  }
  let releaseAutoConsume!: () => void;
  const autoConsumePending = new Promise<void>(resolve => {
    releaseAutoConsume = resolve;
  });
  let signalPaused!: () => void;
  const autoConsumePaused = new Promise<void>(resolve => {
    signalPaused = resolve;
  });
  mockPauseAutoConsume = () => {
    signalPaused();
    return autoConsumePending;
  };

  try {
    mirrorBackgroundSettings();
    await autoConsumePaused;
    setDelegateProofSetting(false);
    await setTelemetrySetting(false);
    expect(await isDelegateProofEnabledAsync()).toBe(false);
    expect(await isTelemetryEnabledAsync()).toBe(false);
    releaseAutoConsume();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(await isTelemetryEnabledAsync()).toBe(false);
    expect(await isDelegateProofEnabledAsync()).toBe(false);
    expect(await areBackgroundSettingsMirrored()).toBe(true);
    expect(mockValues.get(TELEMETRY_STORAGE_KEY)).toBe('false');
    expect(mockValues.get(DELEGATE_PROOF_STORAGE_KEY)).toBe('false');
  } finally {
    releaseAutoConsume();
    mockPauseAutoConsume = undefined;
    localStorage.clear();
  }
});
