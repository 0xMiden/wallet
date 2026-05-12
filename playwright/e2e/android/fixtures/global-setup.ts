import * as fs from 'fs';
import * as path from 'path';

import { EmulatorControl } from '../helpers/emulator-control';

const ROOT_DIR = path.resolve(__dirname, '../../../..');
const APK_PATH = path.join(ROOT_DIR, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

/**
 * Validate the debug APK exists, then reserve and boot the emulator pair.
 * We deliberately do NOT rebuild here — that's `yarn test:e2e:android:build`'s
 * job. A missing APK is a hard error.
 */
export default async function globalSetup(): Promise<void> {
  if (!fs.existsSync(APK_PATH)) {
    throw new Error(
      `Android APK not found at ${APK_PATH}\n` +
        `Run \`yarn test:e2e:android:build\` first.`
    );
  }

  const { serialA, serialB } = await EmulatorControl.reservePair();
  const emu = new EmulatorControl();
  await Promise.all([emu.ensureBooted(serialA), emu.ensureBooted(serialB)]);

  // eslint-disable-next-line no-console
  console.log(`[android-globalSetup] reserved pair A=${serialA} B=${serialB}; both booted`);
}
