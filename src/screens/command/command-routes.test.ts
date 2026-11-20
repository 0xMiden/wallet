import { resolveCommandRoute } from './command-routes';

it.each([
  ['/', { kind: 'dashboard' }],
  ['/send', { kind: 'flow', action: 'send' }],
  ['/send/review', { kind: 'flow', action: 'send' }],
  ['/receive', { kind: 'flow', action: 'receive' }],
  ['/swap', { kind: 'flow', action: 'swap' }],
  ['/earn/positions', { kind: 'flow', action: 'earn' }],
  ['/earn/vaults/v1/deposit/review', { kind: 'flow', action: 'earn' }],
  ['/earn/positions/p1/withdraw/review', { kind: 'flow', action: 'earn' }],
  ['/bridge/deposit', { kind: 'flow', action: 'bridge' }],
  ['/generating-transaction/tx1', { kind: 'operation', id: 'tx1' }],
  ['/generating-transaction-full/tx2', { kind: 'operation', id: 'tx2' }],
  ['/earn/withdraw-status/tx3', { kind: 'operation', id: 'tx3' }],
  ['/history-details/tx4', { kind: 'operation', id: 'tx4' }]
])('resolves registered Command route %s', (path, expected) => {
  expect(resolveCommandRoute(path)).toEqual(expected);
});

it.each([
  '/settings/general',
  '/me',
  '/browser',
  '/activity/group/swap',
  '/send/unknown',
  '/earn/vaults',
  '/history-details/',
  '/reset-wallet',
  '/explore'
])('leaves %s in the legacy router', path => {
  expect(resolveCommandRoute(path)).toBeNull();
});
