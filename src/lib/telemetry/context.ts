import { isAndroid, isIOS } from 'lib/platform';

import { TelemetryContext, TelemetryPlatform } from './types';
import packageJson from '../../../package.json';

function resolvePlatform(): TelemetryPlatform {
  if (isIOS()) return 'ios';
  if (isAndroid()) return 'android';
  return 'extension';
}

/**
 * Derive the allowed context in the background. Deliberately not passed in from
 * the frontend: a caller that could supply `appVersion` or `platform` could
 * supply anything, which is the hole the allowlist exists to close.
 */
export function resolveTelemetryContext(): TelemetryContext {
  return {
    appVersion: packageJson.version,
    platform: resolvePlatform()
  };
}
