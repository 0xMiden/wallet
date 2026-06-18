import * as fs from 'fs';
import * as path from 'path';

import { SimulatorControl } from '../helpers/simulator-control';

const ROOT_DIR = path.resolve(__dirname, '../../../..');
const APP_PATH = path.join(
  ROOT_DIR,
  'ios',
  'App',
  'build',
  'Build',
  'Products',
  'Debug-iphonesimulator',
  'App.app'
);

/**
 * Validate the App.app exists and reserve+boot the simulator pair before any
 * test runs. We deliberately do NOT rebuild here — that's the `:build`
 * script's job. A missing App.app is a hard error.
 */
export default async function globalSetup(): Promise<void> {
  if (!fs.existsSync(APP_PATH)) {
    throw new Error(
      `iOS app bundle not found at ${APP_PATH}\n` +
        `Run \`yarn test:e2e:mobile:build\` first.`
    );
  }

  const { udidA, udidB } = await SimulatorControl.reservePair();
  const sim = new SimulatorControl();
  await Promise.all([sim.ensureBooted(udidA), sim.ensureBooted(udidB)]);

  // eslint-disable-next-line no-console
  console.log(`[ios-globalSetup] reserved pair A=${udidA} B=${udidB}; both Booted`);
}
