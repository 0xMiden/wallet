import { fireEvent, screen } from '@testing-library/react';

import { assetKey } from 'lib/bridge/core/assets';
import type { BridgeRoute } from 'lib/bridge/core/routes';

export function selectCommandBridgeRoute(route: BridgeRoute) {
  fireEvent.change(screen.getByTestId('command-bridge-source'), { target: { value: assetKey(route.source) } });
  fireEvent.change(screen.getByTestId('command-bridge-destination'), { target: { value: route.id } });
}
