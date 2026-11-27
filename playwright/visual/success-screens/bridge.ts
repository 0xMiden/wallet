// Cross-chain sends in the prototype: where a 0x recipient's money can land, the routes that carry
// it, and what arrives. The chains are five of those the app supports (lib/walletconnect/config);
// the route names, timings and "No bridge fee" are the app's own wording. Every price, fee amount
// and received amount here is invented for the prototype.
import type { ProtoToken } from './tokens';

export interface BridgeChain {
  /** The slug the app's network logo is keyed by. */
  id: string;
  name: string;
}

export const BRIDGE_CHAINS: BridgeChain[] = [
  { id: 'ethereum', name: 'Ethereum' },
  { id: 'base', name: 'Base' },
  { id: 'arbitrum', name: 'Arbitrum' },
  { id: 'optimism', name: 'Optimism' },
  { id: 'polygon', name: 'Polygon' }
];

export interface BridgeRoute {
  id: 'epoch' | 'agglayer' | 'usdcx';
  label: string;
  eta: string;
  /** What the route charges, as the review shows it. */
  fee: string;
  /** What lands on the destination chain. */
  receive: string;
  receiveSymbol: string;
  note: string;
}

export interface BridgeSend {
  chain: BridgeChain;
  route: BridgeRoute;
}

/** Invented prices: enough to show that the fast route pays out in USDC. */
const USD_PRICE: Record<string, number> = { USDCX: 1, iETH: 3480 };
const trim = (value: number, places: number) => value.toLocaleString('en-US', { maximumFractionDigits: places });

/** The routes open to this token, each with what it would deliver for `amount`. */
export function routesFor(token: ProtoToken, amount: string, chain: BridgeChain): BridgeRoute[] {
  const value = (Number(amount) || 0) * (USD_PRICE[token.symbol] ?? 1);
  const epochFee = Math.max(0.1, value * 0.003);
  const fast: BridgeRoute = {
    id: 'epoch',
    label: 'Fast · Epoch',
    eta: '~30 sec',
    fee: `${trim(epochFee, 2)} USDC`,
    receive: trim(Math.max(0, value - epochFee), 2),
    receiveSymbol: 'USDC',
    note: `Any token, delivered as USDC on ${chain.name}.`
  };
  if (token.symbol === 'USDCX') {
    const circleFee = chain.id === 'ethereum' ? 1.5 : 0.1;
    return [
      fast,
      {
        id: 'usdcx',
        label: 'USDCx (Circle xReserve)',
        eta: 'Arrival depends on the destination network',
        fee: `${circleFee} USDC Circle fee`,
        receive: trim(Math.max(0, value - circleFee), 2),
        receiveSymbol: 'USDC',
        note: `USDCx is burned on Miden and Circle pays out USDC on ${chain.name}.`
      }
    ];
  }
  return [
    fast,
    {
      id: 'agglayer',
      label: 'Slow · Agglayer',
      eta: '~30 mins',
      fee: 'No bridge fee',
      receive: amount,
      receiveSymbol: 'ETH',
      note: `Arrives as ETH on ${chain.name}, the same amount you send.`
    }
  ];
}

/** The network a recipient is on: Miden, or for a 0x address the chosen EVM chain (Ethereum until one is picked). */
export const netOf = (address: string, chain?: BridgeChain) =>
  address.startsWith('0x')
    ? ({ kind: 'ethereum', label: (chain ?? BRIDGE_CHAINS[0]!).name, slug: (chain ?? BRIDGE_CHAINS[0]!).id } as const)
    : ({ kind: 'miden', label: 'Miden', slug: undefined } as const);
