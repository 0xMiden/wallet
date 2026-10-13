import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';

import { selectUsdcxRoutes } from './chains';
import type { UsdcxRoutes } from './routes';

/**
 * The USDCx routes of the effective network, or null while its document lists none. The component re-renders when a
 * document lands, so the synchronous getters of `./chains` it calls while it renders read the same document.
 */
export function useUsdcxRoutes(): UsdcxRoutes | null {
  return selectUsdcxRoutes(useBridgeConfigSnapshot({ load: false }));
}
