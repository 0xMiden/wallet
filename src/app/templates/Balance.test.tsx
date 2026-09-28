import React, { ReactElement } from 'react';

import { render, screen } from '@testing-library/react';
import BigNumber from 'bignumber.js';

import { TOKEN_IETH } from 'lib/miden/swap/tokens';
import type { TokenPrices } from 'lib/prices';

import Balance from './Balance';

// ---------------------------------------------------------------------------
// Mocks.
//
// `Balance` is a thin aggregator: it pulls the current account, the full token
// metadata map, and every token balance from the WASM-backed `lib/miden/front`
// barrel, reads `tokenPrices` out of the zustand store, then folds all balances
// into a single fiat total that it hands to a render-prop child.
//
// We stub the impure inputs so we can drive the fold by hand; the price lookup
// is the real one, fed a price map through the store. `CSSTransition` is replaced with a capturing pass-through so the
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
let mockStoreState: { tokenPrices: TokenPrices } = { tokenPrices: {} };
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState)
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
type TokenBalance = {
  tokenId: string;
  balance: number;
  metadata: { symbol: string; name?: string; decimals?: number; scaleIsUnknown?: boolean };
};

const balancesReturn = (data?: unknown[]) => ({ data });

// Default render-prop child: surfaces the fiat total for assertions and carries
// a className so the merge branch runs.
const renderChild =
  (className?: string) =>
  (b: BigNumber | null): ReactElement => (
    <span data-testid="total" className={className}>
      {b === null ? 'no figure' : b.toString()}
    </span>
  );

const quote = (price: number) => ({ price, change24h: 0, percentageChange24h: 0 });

const total = () => screen.getByTestId('total');

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAccount.mockReturnValue({ publicKey: 'pk-abc' });
  mockUseAllTokensBaseMetadata.mockReturnValue({ ETH: {} });
  mockUseAllBalances.mockReturnValue(balancesReturn([]));
  mockStoreState = { tokenPrices: { ETH: quote(100), BTC: quote(50) } };
  capturedTransitionProps = null;
});

describe('Balance', () => {
  it('yields a zero fiat total when there are no balances', () => {
    mockUseAllBalances.mockReturnValue(balancesReturn([]));

    render(<Balance>{renderChild('base-cls')}</Balance>);

    expect(total().textContent).toBe('0');
  });

  it('falls back to an empty balance list when the query returns no `data`', () => {
    // `useAllBalances` resolves to `{}` (no `data` key) before the query settles;
    // the `= []` default must keep the fold from throwing.
    mockUseAllBalances.mockReturnValue(balancesReturn(undefined));

    render(<Balance>{renderChild()}</Balance>);

    expect(total().textContent).toBe('0');
  });

  it('folds balance × quoted price across every token into the fiat total', () => {
    const tokens: TokenBalance[] = [
      { tokenId: 'eth-faucet', balance: 2, metadata: { symbol: 'ETH' } },
      { tokenId: 'btc-faucet', balance: 3, metadata: { symbol: 'BTC' } }
    ];
    mockUseAllBalances.mockReturnValue(balancesReturn(tokens));

    render(<Balance>{renderChild()}</Balance>);

    // 2 * 100 + 3 * 50
    expect(total().textContent).toBe('350');
  });

  it('values IETH at the ETH price, the symbol the feed quotes it under', () => {
    mockUseAllBalances.mockReturnValue(
      balancesReturn([{ tokenId: TOKEN_IETH.faucetId, balance: 0.38, metadata: { symbol: 'IETH' } }])
    );
    mockStoreState = { tokenPrices: { ETH: quote(3000) } };

    render(<Balance>{renderChild()}</Balance>);

    expect(total().textContent).toBe('1140');
  });

  it('leaves a token the feed does not quote out of the total, never at $1 a unit', () => {
    const tokens: TokenBalance[] = [
      { tokenId: 'eth-faucet', balance: 2, metadata: { symbol: 'ETH' } },
      { tokenId: 'miden-faucet', balance: 1000, metadata: { symbol: 'MIDEN' } }
    ];
    mockUseAllBalances.mockReturnValue(balancesReturn(tokens));

    render(<Balance>{renderChild()}</Balance>);

    expect(total().textContent).toBe('200');
  });

  it('hands no figure when the account holds tokens but none of them is quoted', () => {
    mockUseAllBalances.mockReturnValue(
      balancesReturn([{ tokenId: 'miden-faucet', balance: 1000, metadata: { symbol: 'MIDEN' } }])
    );

    render(<Balance>{renderChild()}</Balance>);

    expect(total().textContent).toBe('no figure');
  });

  it('totals an account holding nothing as zero, even beside an unquoted empty row', () => {
    mockUseAllBalances.mockReturnValue(
      balancesReturn([{ tokenId: 'miden-faucet', balance: 0, metadata: { symbol: 'MIDEN' } }])
    );

    render(<Balance>{renderChild()}</Balance>);

    expect(total().textContent).toBe('0');
  });

  // A token whose faucet never resolved carries the unknown-token placeholder,
  // whose 6 decimals are a guess — so `balance` was scaled by the wrong power of
  // ten and can be off by a factor of a trillion. There is no way to show WHICH
  // asset spoiled a single combined number, so it is left out of the fold
  // entirely rather than allowed to invent a portfolio, even when its symbol is quoted.
  it('hands no figure when the only holding is a quoted token whose scale never resolved', () => {
    mockUseAllBalances.mockReturnValue(
      balancesReturn([
        {
          tokenId: 'unresolved-faucet',
          balance: 1_000_000,
          metadata: { symbol: 'ETH', name: 'Unknown', decimals: 6, scaleIsUnknown: true }
        }
      ])
    );

    render(<Balance>{renderChild()}</Balance>);

    // Something is held, so this is not an empty wallet's $0.00; nothing can be valued.
    expect(total().textContent).toBe('no figure');
  });

  it('leaves a token with an unresolved scale out of the fiat total', () => {
    const tokens: TokenBalance[] = [
      { tokenId: 'eth-faucet', balance: 2, metadata: { symbol: 'ETH' } },
      {
        tokenId: 'unresolved-faucet',
        balance: 1_000_000,
        metadata: { symbol: 'ETH', name: 'Unknown', decimals: 6, scaleIsUnknown: true }
      }
    ];
    mockUseAllBalances.mockReturnValue(balancesReturn(tokens));

    render(<Balance>{renderChild()}</Balance>);

    expect(total().textContent).toBe('200');
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
    const tokens: TokenBalance[] = [{ tokenId: 'eth-faucet', balance: 4, metadata: { symbol: 'ETH' } }];
    mockUseAllBalances.mockReturnValue(balancesReturn(tokens));
    mockStoreState = { tokenPrices: { ETH: quote(25) } };

    let received: unknown;
    render(
      <Balance>
        {b => {
          received = b;
          return <span data-testid="total">{String(b)}</span>;
        }}
      </Balance>
    );

    expect(received).toBeInstanceOf(BigNumber);
    expect((received as BigNumber).toNumber()).toBe(100);
    expect(total().textContent).toBe('100');
  });
});
