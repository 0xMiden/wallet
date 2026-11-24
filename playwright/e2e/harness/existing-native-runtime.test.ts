/** @jest-environment node */
import { connectExistingNativeRuntime } from './existing-native-runtime';
const mockClose = jest.fn(async () => {});
const mockConnectIos: jest.Mock = jest.fn(async () => ({ close: mockClose }));
const mockConnectAndroid: jest.Mock = jest.fn(async () => ({ close: mockClose }));
jest.mock('../ios/helpers/cdp-bridge', () => ({
  CdpBridge: { connect: (...args: unknown[]) => mockConnectIos(...args) }
}));
jest.mock('../android/helpers/cdp-bridge', () => ({
  CdpBridge: { connect: (...args: unknown[]) => mockConnectAndroid(...args) }
}));
jest.mock('../ios/helpers/ios-wallet-page', () => ({ IosWalletPage: jest.fn() }));
jest.mock('../android/helpers/android-wallet-page', () => ({ AndroidWalletPage: jest.fn() }));
const mockReserve = jest.fn(() => {
  throw new Error('must not reserve or reset');
});
jest.mock('../ios/helpers/simulator-control', () => ({
  SimulatorControl: Object.assign(jest.fn(), { reservePair: () => mockReserve() })
}));
jest.mock('../android/helpers/emulator-control', () => ({
  EmulatorControl: Object.assign(jest.fn(), { reservePair: () => mockReserve() })
}));

test('requires explicit runtime and attaches without paired allocation or data reset', async () => {
  await expect(connectExistingNativeRuntime({ platform: 'ios', id: '' })).rejects.toThrow('explicit');
  const ios = await connectExistingNativeRuntime({ platform: 'ios', id: 'selected-ios' });
  expect(mockConnectIos).toHaveBeenCalledWith({ udid: 'selected-ios', bundleId: 'com.miden.bread' });
  await ios.close();
  const android = await connectExistingNativeRuntime({ platform: 'android', id: 'selected-android', hostPort: 19231 });
  expect(mockConnectAndroid).toHaveBeenCalledWith({
    serial: 'selected-android',
    packageName: 'com.miden.wallet',
    hostPort: 19231
  });
  await android.close();
  expect(mockReserve).not.toHaveBeenCalled();
  expect(mockClose).toHaveBeenCalledTimes(2);
});
