import React, { ReactElement } from 'react';

import BigNumber from 'bignumber.js';
import { render, screen } from '@testing-library/react';

import Balance from './Balance';

// ---------------------------------------------------------------------------
// Mocks.
//
// `Balance` is a thin aggregator: it pulls the current account, the full token
// metadata map, and every token balance from the WASM-backed `lib/miden/front`
// barrel, reads `tokenPrices` out of the zustand store, then folds all balances
// into a single fiat total that it hands to a render-prop child.
//
// We stub the four impure inputs so we can drive the fold by hand, and mock the
// pure `getTokenPrice` lookup so per-symbol prices are deterministic and
// assertable. `CSSTransition` is replaced with a capturing pass-through so the
// component's real `cloneElement` / `classNames` output is what lands in the DOM
// while we still get to inspect the transition props it was constructed with.
// ---------------------------------------------------------------------------
const mockUseAccount = jest.fn<{ publicKey: string }, []>(() => ({ publicKey: 'pk-abc' }));
const mockUseAllTokensBaseMetadata = jest.fn<Record<string, unknown>, []>(() => ({ ETH: {} }));
const mockUseAllBalances = jest.fn<{ data?: unknown[] }, [string, Record<string, unknown>]>(() => ({ data: [] }));

jest.mock('lib/miden/front', () => ({
  useAccount: () => mockUseAccount(),
  useAllTokensBaseMetadata: () => mockUseAllTokensBaseMetadata(),
  useAllBalances: (publicKey: string, metadata: Record<string, unknown>) => mockUseAllBalances(publicKey, metadata)
}));

// The store slice the component reads is just `tokenPrices`; run the real
// selector against a controllable state object.
let mockStoreState: { tokenPrices: Record<string, unknown> } = { tokenPrices: { SEED: 1 } };
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState)
}));

// Pure price lookup — mocked so each symbol maps to a known price.
const mockGetTokenPrice = jest.fn((_prices: Record<string, unknown>, _symbol: string) => ({ price: 1 }));
jest.mock('lib/prices', () => ({
  getTokenPrice: (prices: Record<string, unknown>, symbol: string) => mockGetTokenPrice(prices, symbol)
}));

// Capture the props `Balance` builds the transition with, and render the single
// cloned child element straight through so the real DOM output is preserved.
let capturedTransitionProps: Record<string, unknown> | null = null;
jest.mock('react-transition-group/CSSTransition', () => ({
  __esModule: true,
  default: ({ children, ...rest }: { children: ReactElement }) => {
    capturedTransitionProps = rest;
    return children;
  }
}));

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
type TokenBalance = { balance: number; metadata: { symbol: string } };

const balancesReturn = (data?: unknown[]) => ({ data });

// Default render-prop child: surfaces the fiat total for assertions and carries
// a className so the merge branch runs.
const renderChild =
  (className?: string) =>
  (b: BigNumber): ReactElement =>
    (
      <span data-testid="total" className={className}>
        {b.toString()}
      </span>
    );

const total = () => screen.getByTestId('total');

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAccount.mockReturnValue({ publicKey: 'pk-abc' });
  mockUseAllTokensBaseMetadata.mockReturnValue({ ETH: {} });
  mockUseAllBalances.mockReturnValue(balancesReturn([]));
  mockGetTokenPrice.mockReturnValue({ price: 1 });
  mockStoreState = { tokenPrices: { SEED: 1 } };
  capturedTransitionProps = null;
});

describe('Balance', () => {
  it('yields a zero fiat total when there are no balances', () => {
    mockUseAllBalances.mockReturnValue(balancesReturn([]));

    render(<Balance>{renderChild('base-cls')}</Balance>);

    expect(total()).toHaveTextContent('0');
    // Empty balances => the reduce never runs => the price lookup is untouched.
    expect(mockGetTokenPrice).not.toHaveBeenCalled();
  });

  it('falls back to an empty balance list when the query returns no `data`', () => {
    // `useAllBalances` resolves to `{}` (no `data` key) before the query settles;
    // the `= []` default must keep the fold from throwing.
    mockUseAllBalances.mockReturnValue(balancesReturn(undefined));

    render(<Balance>{renderChild()}</Balance>);

    expect(total()).toHaveTextContent('0');
    expect(mockGetTokenPrice).not.toHaveBeenCalled();
  });

  it('folds balance × per-symbol price across every token into the fiat total', () => {
    const tokens: TokenBalance[] = [
      { balance: 2, metadata: { symbol: 'ETH' } },
      { balance: 3, metadata: { symbol: 'BTC' } }
    ];
    mockUseAllBalances.mockReturnValue(balancesReturn(tokens));
    mockGetTokenPrice.mockImplementation((_prices, symbol) => ({ price: symbol === 'ETH' ? 100 : 50 }));

    render(<Balance>{renderChild()}</Balance>);

    // 2 * 100 + 3 * 50 = 350
    expect(total()).toHaveTextContent('350');
    // Price is looked up once per token, with the live store slice and symbol.
    expect(mockGetTokenPrice).toHaveBeenCalledTimes(2);
    expect(mockGetTokenPrice).toHaveBeenNthCalledWith(1, { SEED: 1 }, 'ETH');
    expect(mockGetTokenPrice).toHaveBeenNthCalledWith(2, { SEED: 1 }, 'BTC');
  });

  it('forwards the account public key and metadata map into useAllBalances', () => {
    const metadata = { ETH: { decimals: 18 } };
    mockUseAccount.mockReturnValue({ publicKey: 'pk-xyz' });
    mockUseAllTokensBaseMetadata.mockReturnValue(metadata);

    render(<Balance>{renderChild()}</Balance>);

    expect(mockUseAllBalances).toHaveBeenCalledWith('pk-xyz', metadata);
  });

  it('merges an existing child className through cloneElement', () => {
    mockUseAllBalances.mockReturnValue(balancesReturn([]));

    render(<Balance>{renderChild('foo bar')}</Balance>);

    // `classNames(child.props.className, false)` => the original class survives
    // (`!exist` is constant-false, so no `invisible` class is ever added).
    expect(total()).toHaveClass('foo', 'bar');
    expect(total()).not.toHaveClass('invisible');
  });

  it('handles a child that has no className (undefined className branch)', () => {
    mockUseAllBalances.mockReturnValue(balancesReturn([]));

    render(<Balance>{renderChild(undefined)}</Balance>);

    const node = total();
    // `classNames(undefined, false)` collapses to an empty string.
    expect(node.className).toBe('');
  });

  it('constructs the CSSTransition with the expected timeout and class map', () => {
    render(<Balance>{renderChild('x')}</Balance>);

    expect(capturedTransitionProps).toMatchObject({
      in: true,
      timeout: 200,
      classNames: {
        enter: 'opacity-0',
        enterActive: 'opacity-100 transition ease-out duration-200',
        exit: 'opacity-0 transition ease-in duration-200'
      }
    });
  });

  it('passes a real BigNumber instance to the render-prop child', () => {
    const tokens: TokenBalance[] = [{ balance: 4, metadata: { symbol: 'ETH' } }];
    mockUseAllBalances.mockReturnValue(balancesReturn(tokens));
    mockGetTokenPrice.mockReturnValue({ price: 25 });

    let received: unknown;
    render(
      <Balance>
        {(b: BigNumber) => {
          received = b;
          return <span data-testid="total">{b.toString()}</span>;
        }}
      </Balance>
    );

    expect(received).toBeInstanceOf(BigNumber);
    expect((received as BigNumber).toNumber()).toBe(100);
    expect(total()).toHaveTextContent('100');
  });
});
