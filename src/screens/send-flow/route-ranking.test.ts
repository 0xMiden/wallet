import { rankBridgeRoutes } from './route-ranking';

const routes = [
  { id: 'balanced', receivedValue: 99.9, totalCostUsd: 0.2, etaSeconds: 90 },
  { id: 'value', receivedValue: 99.95, totalCostUsd: 0.4, etaSeconds: 1800 },
  { id: 'cheap', receivedValue: 99.8, totalCostUsd: 0.08, etaSeconds: 180 },
  { id: 'speed', receivedValue: 99.7, totalCostUsd: 0.3, etaSeconds: 25 }
];

it.each([
  ['best-value', ['value', 'balanced', 'cheap', 'speed']],
  ['cheapest', ['cheap', 'balanced', 'speed', 'value']],
  ['fastest', ['speed', 'balanced', 'cheap', 'value']]
] as const)('ranks by %s without mutating provider data', (ranking, expected) => {
  expect(rankBridgeRoutes(routes, ranking).map(route => route.id)).toEqual(expected);
  expect(routes.map(route => route.id)).toEqual(['balanced', 'value', 'cheap', 'speed']);
});

it('keeps unavailable routes last even if their quote looks best', () => {
  expect(
    rankBridgeRoutes([{ ...routes[1]!, id: 'unavailable', disabled: true }, ...routes], 'best-value').at(-1)?.id
  ).toBe('unavailable');
});

it.each(['best-value', 'cheapest', 'fastest'] as const)(
  'keeps missing and invalid %s metrics after known quotes',
  ranking => {
    const unknown = [
      { id: 'missing' },
      { id: 'nan', receivedValue: NaN, totalCostUsd: NaN, etaSeconds: NaN },
      { id: 'infinite', receivedValue: Infinity, totalCostUsd: Infinity, etaSeconds: Infinity },
      { id: 'negative', receivedValue: -1, totalCostUsd: -1, etaSeconds: -1 }
    ];
    expect(rankBridgeRoutes([...unknown, routes[0]!], ranking).map(route => route.id)).toEqual([
      'balanced',
      'missing',
      'nan',
      'infinite',
      'negative'
    ]);
  }
);

it('preserves provider order for equal metrics, including a free route', () => {
  const tied = [
    { id: 'first', totalCostUsd: 0 },
    { id: 'second', totalCostUsd: 0 }
  ];
  expect(rankBridgeRoutes(tied, 'cheapest')).toEqual(tied);
});
