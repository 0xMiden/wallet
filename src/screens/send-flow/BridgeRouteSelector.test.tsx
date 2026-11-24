import React, { useState } from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import { BridgeRouteSelector, BridgeRouteChoice } from './BridgeRouteSelector';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));

const routes: BridgeRouteChoice[] = [
  {
    id: 'near',
    provider: 'NEAR Intents',
    receiveLabel: '99.7 USDCx',
    receivedValue: 99.7,
    costLabel: '$0.30',
    totalCostUsd: 0.3,
    etaLabel: '~25 sec',
    etaSeconds: 25
  },
  {
    id: 'circle',
    provider: 'Circle',
    receiveLabel: '99.8 USDCx',
    receivedValue: 99.8,
    costLabel: '$0.08',
    totalCostUsd: 0.08,
    etaLabel: '~3 min',
    etaSeconds: 180
  },
  {
    id: 'agglayer',
    provider: 'Agglayer',
    receiveLabel: '99.95 USDCx',
    receivedValue: 99.95,
    costLabel: '$0.40',
    totalCostUsd: 0.4,
    etaLabel: '~30 min',
    etaSeconds: 1800
  }
];

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = jest.fn();
});

it('reorders routes when the ranking changes without selecting another provider', () => {
  const onSelect = jest.fn();
  render(<BridgeRouteSelector routes={routes} selectedId="circle" onSelect={onSelect} accent="receive" />);
  expect(
    within(screen.getByRole('radiogroup', { name: 'bridgeRouteProviders' }))
      .getAllByRole('radio')
      .map(el => el.dataset.routeId)
  ).toEqual(['agglayer', 'circle', 'near']);
  fireEvent.click(screen.getByRole('radio', { name: 'bridgeRankFastest' }));
  expect(
    within(screen.getByRole('radiogroup', { name: 'bridgeRouteProviders' }))
      .getAllByRole('radio')
      .map(el => el.dataset.routeId)
  ).toEqual(['near', 'circle', 'agglayer']);
  expect(screen.getByTestId('route-choice-circle')).toHaveAttribute('aria-checked', 'true');
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('radio', { name: 'bridgeRankCheapest' }));
  expect(
    within(screen.getByRole('radiogroup', { name: 'bridgeRouteProviders' }))
      .getAllByRole('radio')
      .map(el => el.dataset.routeId)
  ).toEqual(['circle', 'near', 'agglayer']);
});

it('selects a route explicitly and blocks unavailable providers', () => {
  const Owner = () => {
    const [selectedId, onSelect] = useState('circle');
    return (
      <BridgeRouteSelector
        routes={[...routes, { ...routes[0]!, id: 'offline', disabled: true }]}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    );
  };
  render(<Owner />);
  fireEvent.click(screen.getByTestId('route-choice-near'));
  expect(screen.getByTestId('route-choice-near')).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByTestId('route-choice-circle')).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByTestId('route-choice-offline')).toBeDisabled();
});

it('handles a single provider without a meaningless ranking toggle', () => {
  render(<BridgeRouteSelector routes={[routes[1]!]} selectedId="circle" onSelect={jest.fn()} />);
  expect(screen.queryByRole('radiogroup', { name: 'bridgeRouteSort' })).not.toBeInTheDocument();
  expect(screen.getByText('99.8 USDCx')).toBeInTheDocument();
});

it('offers keyboard selection in the ranked provider list', () => {
  const onSelect = jest.fn();
  render(<BridgeRouteSelector routes={routes} selectedId="circle" onSelect={onSelect} />);
  fireEvent.keyDown(screen.getByRole('radiogroup', { name: 'bridgeRouteProviders' }), { key: 'End' });
  expect(onSelect).toHaveBeenCalledWith('near');
  expect(screen.getByTestId('route-choice-near')).toHaveFocus();
});

it('announces the received amount, cost and arrival when a provider is focused', () => {
  render(<BridgeRouteSelector routes={routes} selectedId="circle" onSelect={jest.fn()} />);
  expect(screen.getByRole('radio', { name: 'Circle' })).toHaveAccessibleDescription(
    'youReceive 99.8 USDCx bridgeEstimatedCost $0.08 bridgeArrivalEstimate ~3 min'
  );
});
