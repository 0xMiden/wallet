import type { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';

import type { BridgeRoute } from './core/routes';

export function deriveBridgeRoutes(_snapshot: ReturnType<typeof getBridgeConfigSnapshot>): readonly BridgeRoute[] {
  return [];
}
