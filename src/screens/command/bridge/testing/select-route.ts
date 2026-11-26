import { fireEvent, screen, within } from '@testing-library/react';

import { assetKey } from 'lib/bridge/core/assets';
import type { BridgeRoute } from 'lib/bridge/core/routes';
import { getBridgeNetwork } from 'screens/send-flow/bridge-networks';

import { externalSide } from '../bridge-selection';

function pick(testId: string, optionId: string) {
  const pill = screen.getByTestId(testId);
  // A picker with one option is plain text: there is nothing to choose.
  if (pill.tagName !== 'BUTTON') return;
  fireEvent.click(pill);
  fireEvent.click(within(screen.getByTestId(`${testId}-menu`)).getByTestId(`bridge-option-${optionId}`));
}

function expectShown(testId: string, label: string) {
  const shown = screen.getByTestId(testId).querySelector('.truncate')?.textContent;
  if (shown !== label) throw new Error(`${testId} shows ${shown}, expected ${label}`);
}

export function selectCommandBridgeRoute(route: BridgeRoute) {
  const external = externalSide(route);
  pick(`command-bridge-${external}-network`, route[external].network);
  pick('command-bridge-source-token', assetKey(route.source));
  pick('command-bridge-destination-token', assetKey(route.destination));
  const provider = screen.queryByTestId(`command-bridge-route-${route.provider}`);
  if (provider) fireEvent.click(provider);

  const { network } = route[external];
  expectShown(`command-bridge-${external}-network`, getBridgeNetwork(network)?.name ?? network);
  expectShown('command-bridge-source-token', route.source.symbol);
  expectShown('command-bridge-destination-token', route.destination.symbol);
  // The consumers mock t() to return keys, which drops the via line's provider name: read the attribute.
  const reached = provider
    ? screen.getByTestId(`command-bridge-route-${route.provider}`).getAttribute('aria-checked') === 'true'
    : screen.getByTestId('command-bridge-via').getAttribute('data-provider') === route.provider;
  if (!reached) throw new Error(`Command Bridge did not select the ${route.provider} route ${route.id}`);
}
