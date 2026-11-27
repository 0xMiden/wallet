import type { BridgeProvider, FlowMode } from 'lib/bridge/core/models';
import type { BridgeRoute } from 'lib/bridge/core/routes';

import {
  externalSide,
  networkChoices,
  pairRoutes,
  routeForNetwork,
  tokenChoices,
  type BridgeSide
} from './bridge-selection';

function make(
  provider: BridgeProvider,
  mode: FlowMode,
  network: string,
  evmSymbol: string,
  faucet: string
): BridgeRoute {
  const evm = { kind: 'erc20' as const, address: `0x${evmSymbol}`, network, symbol: evmSymbol, decimals: 6 };
  const miden = { kind: 'miden' as const, faucetId: faucet, network: 'miden-testnet', symbol: faucet, decimals: 6 };
  return {
    id: [provider, mode, network, evmSymbol, faucet].join('/'),
    provider,
    mode,
    source: mode === 'receive' ? evm : miden,
    destination: mode === 'receive' ? miden : evm,
    recovery: {} as BridgeRoute['recovery']
  };
}

const usdc = make('agglayer', 'receive', 'eth', 'USDC', 'f1');
const ids = (routes: readonly BridgeRoute[]) => routes.map(route => route.id);
const tokenIds = (routes: BridgeRoute[], current: BridgeRoute, side: BridgeSide) =>
  tokenChoices(routes, current, side).map(choice => choice.route.id);

describe('bridge selection rules', () => {
  it('network change keeps the same Miden token', () => {
    const routes = [
      usdc,
      make('agglayer', 'receive', 'base', 'USDC', 'f2'),
      make('agglayer', 'receive', 'base', 'DAI', 'f1')
    ];
    expect(routeForNetwork(routes, usdc, 'base')?.id).toBe('agglayer/receive/base/DAI/f1');
  });

  it('network change falls back to the same external symbol', () => {
    const routes = [
      usdc,
      make('agglayer', 'receive', 'base', 'DAI', 'f3'),
      make('agglayer', 'receive', 'base', 'USDC', 'f2')
    ];
    expect(routeForNetwork(routes, usdc, 'base')?.id).toBe('agglayer/receive/base/USDC/f2');
  });

  it('network change falls back to the first route', () => {
    const routes = [
      usdc,
      make('agglayer', 'receive', 'base', 'DAI', 'f3'),
      make('agglayer', 'receive', 'base', 'WETH', 'f4')
    ];
    expect(routeForNetwork(routes, usdc, 'base')?.id).toBe('agglayer/receive/base/DAI/f3');
  });

  it('network change prefers a quotable route over a blocked Epoch receive', () => {
    const blocked = make('epoch', 'receive', 'base', 'USDC', 'f1');
    const quotable = make('xreserve', 'receive', 'base', 'USDC', 'f1');
    expect(routeForNetwork([usdc, blocked, quotable], usdc, 'base')?.id).toBe(quotable.id);
    const epoch = make('epoch', 'receive', 'eth', 'USDC', 'f1');
    expect(routeForNetwork([epoch, blocked, quotable], epoch, 'base')?.id).toBe(quotable.id);
    const other = make('epoch', 'receive', 'base', 'DAI', 'f3');
    const open = make('agglayer', 'receive', 'base', 'WETH', 'f4');
    expect(routeForNetwork([usdc, other, open], usdc, 'base')?.id).toBe(open.id);
  });

  it('choosing the current network keeps the current route', () => {
    const current = make('xreserve', 'receive', 'eth', 'USDC', 'f1');
    expect(routeForNetwork([usdc, current], current, 'eth')?.id).toBe(current.id);
    // A blocked route loses every preference, so only keeping the current one can return it.
    const blocked = make('epoch', 'receive', 'eth', 'USDC', 'f1');
    expect(routeForNetwork([usdc, blocked], blocked, 'eth')?.id).toBe(blocked.id);
  });

  it('token change keeps the network', () => {
    const routes = [
      make('agglayer', 'receive', 'base', 'DAI', 'f1'),
      usdc,
      make('agglayer', 'receive', 'eth', 'DAI', 'f2')
    ];
    expect(tokenIds(routes, usdc, 'source')).toEqual([usdc.id, 'agglayer/receive/eth/DAI/f2']);
    expect(tokenIds(routes, usdc, 'destination')).toEqual([usdc.id, 'agglayer/receive/eth/DAI/f2']);
  });

  it('token change keeps the other asset when a route allows it, then the provider', () => {
    const routes = [
      usdc,
      make('agglayer', 'receive', 'eth', 'DAI', 'f2'),
      make('xreserve', 'receive', 'eth', 'DAI', 'f1'),
      make('agglayer', 'receive', 'eth', 'DAI', 'f1'),
      make('xreserve', 'receive', 'eth', 'WETH', 'f3'),
      make('agglayer', 'receive', 'eth', 'WETH', 'f4'),
      make('agglayer', 'receive', 'eth', 'LINK', 'f5'),
      make('xreserve', 'receive', 'eth', 'LINK', 'f1')
    ];
    expect(tokenIds(routes, usdc, 'source')).toEqual([
      usdc.id,
      'agglayer/receive/eth/DAI/f1',
      'agglayer/receive/eth/WETH/f4',
      'xreserve/receive/eth/LINK/f1'
    ]);
    expect(tokenChoices(routes, usdc, 'source').map(choice => choice.asset.symbol)).toEqual([
      'USDC',
      'DAI',
      'WETH',
      'LINK'
    ]);
  });

  it('an assistant-prefilled route is the selected entry in both token menus', () => {
    const current = make('xreserve', 'receive', 'eth', 'USDC', 'f1');
    const routes = [usdc, current, make('agglayer', 'receive', 'eth', 'DAI', 'f2')];
    expect(tokenIds(routes, current, 'source')[0]).toBe(current.id);
    expect(tokenIds(routes, current, 'destination')[0]).toBe(current.id);
    expect(routeForNetwork(routes, current, 'eth')?.id).toBe(current.id);
    const blocked = make('epoch', 'receive', 'eth', 'USDC', 'f1');
    expect(tokenIds([usdc, blocked], blocked, 'source')).toEqual([blocked.id]);
    expect(tokenIds([usdc, blocked], blocked, 'destination')).toEqual([blocked.id]);
  });

  it('a route row needs two providers for the exact pair', () => {
    const second = make('xreserve', 'receive', 'eth', 'USDC', 'f1');
    const lone = make('agglayer', 'receive', 'eth', 'USDC', 'f2');
    const routes = [usdc, second, lone, make('agglayer', 'receive', 'eth', 'DAI', 'f1')];
    expect(ids(pairRoutes(routes, usdc))).toEqual([usdc.id, second.id]);
    expect(ids(pairRoutes(routes, lone))).toEqual([lone.id]);
  });

  it('networks are listed once in route order, from the external side, in both directions', () => {
    for (const mode of ['receive', 'send'] as const) {
      const routes = ['eth', 'base', 'eth'].map(network => make('agglayer', mode, network, 'USDC', 'f1'));
      expect(externalSide(routes[0]!)).toBe(mode === 'receive' ? 'source' : 'destination');
      expect(networkChoices(routes)).toEqual(['eth', 'base']);
    }
  });
});
