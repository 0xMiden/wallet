import { fireEvent, screen, within } from '@testing-library/react';

import { assetKey } from 'lib/bridge/core/assets';
import type { BridgeRoute } from 'lib/bridge/core/routes';

import { externalSide } from '../bridge-selection';

function pick(testId: string, optionId: string) {
  const pill = screen.getByTestId(testId);
  // A picker with one option is plain text: there is nothing to choose.
  if (pill.tagName !== 'BUTTON') return;
  fireEvent.click(pill);
  fireEvent.click(within(screen.getByTestId(`${testId}-menu`)).getByTestId(`bridge-option-${optionId}`));
}

export function selectCommandBridgeRoute(route: BridgeRoute) {
  const external = externalSide(route);
  pick(`command-bridge-${external}-network`, route[external].network);
  pick('command-bridge-source-token', assetKey(route.source));
  pick('command-bridge-destination-token', assetKey(route.destination));
  const provider = screen.queryByTestId(`command-bridge-route-${route.provider}`);
  if (provider) fireEvent.click(provider);
}
