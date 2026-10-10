import * as fs from 'fs';
import * as path from 'path';

import bridgeInGlobalSetup from '../../fixtures/bridge-in-global-setup';
import { EmulatorControl } from '../helpers/emulator-control';

const ROOT_DIR = path.resolve(__dirname, '../../../..');
const APK_PATH = path.join(ROOT_DIR, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const FORWARDED_HOST_PORTS = [8545, 8550];

/** Boot one wallet emulator, forward host ports, and start the bridge config server. */
export default async function androidBridgeInGlobalSetup(): Promise<() => Promise<void>> {
  if (!fs.existsSync(APK_PATH)) {
    throw new Error(`Android APK not found at ${APK_PATH}\nRun \`yarn test:e2e:android:build\` first.`);
  }

  const serial = await EmulatorControl.reserveSingle();
  const emulator = new EmulatorControl();
  await emulator.ensureBooted(serial);
  const portMappings = FORWARDED_HOST_PORTS.map(port => ({ serial, port }));
  const reversedPorts: Array<{ serial: string; port: number }> = [];

  try {
    // Keep adb operations serial, matching the Android fixture's other device
    // commands; parallel adb calls have raced on the shared adb server before.
    for (const mapping of portMappings) {
      await emulator.reversePort(mapping.serial, mapping.port);
      reversedPorts.push(mapping);
    }
    const stopBridgeConfig = await bridgeInGlobalSetup();
    return async () => {
      try {
        await stopBridgeConfig();
      } finally {
        for (const mapping of reversedPorts) {
          await emulator.removeReversePort(mapping.serial, mapping.port);
        }
      }
    };
  } catch (error) {
    for (const mapping of reversedPorts) {
      await emulator.removeReversePort(mapping.serial, mapping.port);
    }
    throw error;
  }
}
