import React from 'react';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { requestOneClickQuote } from 'lib/one-click/client';
import { persistNearIntentsDeposit } from 'lib/one-click/tracking';
import type {
  NearIntentsCatalog,
  NearIntentsConfig,
  OneClickQuoteRequest,
  OneClickQuoteResponse
} from 'lib/one-click/types';
import type { WalletAccount } from 'lib/shared/types';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { navigate } from 'lib/woozie';
import type { DepositAmountViewProps } from 'screens/deposit-flow/DepositAmountView';
import type { DepositReviewViewProps } from 'screens/deposit-flow/DepositReviewView';
import type { DepositRouteSheetProps } from 'screens/deposit-flow/DepositRouteSheet';
import type { DepositTokenSheetProps } from 'screens/deposit-flow/DepositTokenSheet';
import { WalletType } from 'screens/onboarding/types';

import type { BridgeInBalanceCapVerdict } from './bridge-in-balance-cap';
import type { DepositPairs } from './deposit-pairs';
import { NearDepositFlow, type NearDepositFlowProps } from './NearDepositFlow';
import type { NearDepositQuote, NearDepositQuoteInput } from './useNearDepositQuote';

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key)
  })
}));
jest.mock('lib/miden/front', () => ({ useAccount: () => ({ publicKey: 'miden-account' }) }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => 'mainnet',
  getEffectiveRpcUrl: () => 'https://rpc.test'
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));
let mockBackHandler: (() => boolean | void) | undefined;
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean | void) => {
    mockBackHandler = handler;
  }
}));
jest.mock('lib/one-click/client', () => ({ requestOneClickQuote: jest.fn() }));
jest.mock('lib/one-click/tracking', () => ({ persistNearIntentsDeposit: jest.fn() }));
let mockMobile = false;
jest.mock('lib/platform', () => ({ isExtension: () => false, isMobile: () => mockMobile }));
jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));
jest.mock('app/layouts/page-active', () => ({ usePageActive: () => true }));
let mockClipboard: { value: string; type?: string } | Error = { value: '', type: 'text/plain' };
jest.mock('@capacitor/clipboard', () => ({
  Clipboard: {
    read: async () => {
      if (mockClipboard instanceof Error) throw mockClipboard;
      return mockClipboard;
    }
  }
}));
jest.mock('components/NetworkModeBanner', () => ({
  NetworkModeBanner: () => null,
  NetworkNamedByShell: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));
jest.mock('components/PageHeader', () => ({
  PageHeader: ({ title, onBack, onClose }: { title: string; onBack?: () => void; onClose?: () => void }) => (
    <div data-testid="header">
      {title}
      {onBack && (
        <button type="button" onClick={onBack}>
          header-back
        </button>
      )}
      {onClose && (
        <button type="button" onClick={onClose}>
          header-close
        </button>
      )}
    </div>
  )
}));

let mockQuote: NearDepositQuote = { loading: false };
const mockQuoteInputs: NearDepositQuoteInput[] = [];
jest.mock('./useNearDepositQuote', () => ({
  useNearDepositQuote: (input: NearDepositQuoteInput) => {
    mockQuoteInputs.push(input);
    return mockQuote;
  }
}));
let mockCap: BridgeInBalanceCapVerdict = { state: 'none' };
jest.mock('./bridge-in-balance-cap', () => ({ useBridgeInBalanceCap: () => mockCap }));
let mockExpired = false;
jest.mock('screens/near-intents-flow/useNearIntentsQuote', () => ({ nearIntentsQuoteExpired: () => mockExpired }));

let amountProps: DepositAmountViewProps | undefined;
let reviewProps: DepositReviewViewProps | undefined;
let tokenSheetProps: DepositTokenSheetProps | undefined;
let routeSheetProps: DepositRouteSheetProps | undefined;
jest.mock('screens/deposit-flow/DepositAmountView', () => ({
  DepositAmountView: (props: DepositAmountViewProps) => {
    amountProps = props;
    return (
      <div data-testid="amount-view">
        {props.field}
        {props.notice}
        <button type="button" onClick={props.onReview} disabled={!props.isValidAmount}>
          review
        </button>
        <button type="button" onClick={props.onSelectToken}>
          token
        </button>
        <button type="button" onClick={props.onChangeRoute}>
          route
        </button>
      </div>
    );
  }
}));
jest.mock('screens/deposit-flow/DepositReviewView', () => ({
  DepositReviewView: (props: DepositReviewViewProps) => {
    reviewProps = props;
    return (
      <div data-testid="review-view">
        {props.notice}
        <button type="button" onClick={props.onConfirm} disabled={props.confirmDisabled}>
          slide
        </button>
      </div>
    );
  }
}));
jest.mock('screens/deposit-flow/DepositTokenSheet', () => ({
  DepositTokenSheet: (props: DepositTokenSheetProps) => {
    tokenSheetProps = props;
    return null;
  }
}));
jest.mock('screens/deposit-flow/DepositRouteSheet', () => ({
  DepositRouteSheet: (props: DepositRouteSheetProps) => {
    routeSheetProps = props;
    return null;
  }
}));

const RELAY = '0x1111111111111111111111111111111111111111';
const CONFIG: NearIntentsConfig = { serviceUrl: 'https://one-click.test', chains: [], midenAssets: [] };
const WSOL = { assetId: 'miden:wsol', blockchain: 'miden', symbol: 'wSOL', decimals: 8, faucetId: 'wsol' };
const USDCX = { assetId: 'miden:usdcx', blockchain: 'miden', symbol: 'USDCx', decimals: 6, faucetId: 'usdcx' };
const CATALOG: NearIntentsCatalog = {
  chains: [
    {
      id: 'sol',
      name: 'Solana',
      addressKind: 'solana',
      tokens: [
        {
          symbol: 'SOL',
          asset: { assetId: 'sol:SOL', blockchain: 'sol', symbol: 'SOL', decimals: 9 },
          outputs: [WSOL]
        }
      ]
    },
    {
      id: 'eth',
      name: 'Ethereum',
      addressKind: 'evm',
      tokens: [
        {
          symbol: 'USDC',
          asset: { assetId: 'eth:USDC', blockchain: 'eth', symbol: 'USDC', decimals: 6, contractAddress: '0xc1' },
          outputs: [USDCX]
        }
      ]
    },
    {
      id: 'btc',
      name: 'Bitcoin',
      addressKind: 'bitcoin',
      tokens: [
        {
          symbol: 'BTC',
          asset: { assetId: 'btc:BTC', blockchain: 'btc', symbol: 'BTC', decimals: 8 },
          outputs: [WSOL]
        }
      ]
    }
  ]
};
const SOLANA = { id: 'solana', name: 'Solana' };
const ETHEREUM = { id: 'ethereum', name: 'Ethereum' };
const SOL_ID = 'near:sol:sol:SOL:miden:wsol';
const BTC_ID = 'near:btc:btc:BTC:miden:wsol';
const PAIRS: DepositPairs = {
  networks: [ETHEREUM, SOLANA, { id: 'bitcoin', name: 'Bitcoin' }],
  pairs: [
    {
      option: {
        id: '1:CIRCLE_USDC',
        symbol: 'USDC',
        receivedSymbol: 'USDCx',
        logoFaucetId: 'usdcx',
        network: ETHEREUM
      },
      relay: {
        option: {
          id: '1:CIRCLE_USDC',
          symbol: 'USDC',
          receivedSymbol: 'USDCx',
          logoFaucetId: 'usdcx',
          network: ETHEREUM
        },
        chainId: 1,
        token: 'CIRCLE_USDC',
        address: '0xc1',
        routes: ['usdcx', 'epoch']
      },
      near: { chainId: 'eth', tokenAssetId: 'eth:USDC', outputAssetId: 'miden:usdcx' }
    },
    {
      option: { id: '1:ETH', symbol: 'ETH', receivedSymbol: 'ETH', logoFaucetId: undefined, network: ETHEREUM },
      relay: {
        option: { id: '1:ETH', symbol: 'ETH', receivedSymbol: 'ETH', logoFaucetId: undefined, network: ETHEREUM },
        chainId: 1,
        token: 'ETH',
        address: '0x0000000000000000000000000000000000000000',
        routes: ['agglayer']
      }
    },
    {
      option: { id: SOL_ID, symbol: 'SOL', receivedSymbol: 'wSOL', logoFaucetId: 'wsol', network: SOLANA },
      near: { chainId: 'sol', tokenAssetId: 'sol:SOL', outputAssetId: 'miden:wsol' }
    },
    {
      option: { id: BTC_ID, symbol: 'BTC', receivedSymbol: 'wSOL', logoFaucetId: 'wsol', network: SOLANA },
      near: { chainId: 'btc', tokenAssetId: 'btc:BTC', outputAssetId: 'miden:wsol' }
    }
  ]
};

function request(refundTo: string): OneClickQuoteRequest {
  return {
    amount: '2000000000',
    originAsset: { assetId: 'sol:SOL', blockchain: 'sol', symbol: 'SOL', decimals: 9 },
    destinationAsset: WSOL,
    refundTo,
    recipient: 'miden-account',
    deadline: '2026-11-27T00:05:00.000Z',
    slippageTolerance: 100
  };
}

function quote(refundTo: string, dry = true): OneClickQuoteResponse {
  return {
    correlationId: 'c',
    timestamp: '2026-11-27T00:00:00.000Z',
    signature: 's',
    quoteRequest: {
      dry,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: 'sol:SOL',
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'miden:wsol',
      amount: '2000000000',
      refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: 'miden-account',
      recipientType: 'DESTINATION_CHAIN',
      deadline: '2026-11-27T00:05:00.000Z'
    },
    quote: {
      amountIn: '2000000000',
      amountInFormatted: '2',
      amountInUsd: '360',
      minAmountIn: '2000000000',
      amountOut: '196000000',
      amountOutFormatted: '1.96',
      amountOutUsd: '352.8',
      minAmountOut: '195000000',
      timeEstimate: 120,
      ...(dry ? {} : { depositAddress: 'DepositAddr', deadline: '2026-11-27T00:30:00.000Z' })
    }
  };
}

// The wrapped SOL mint: 32 bytes in base58, a valid Solana refund address.
const SOL_REFUND = 'So11111111111111111111111111111111111111112';
const ACCOUNT: WalletAccount = {
  publicKey: 'miden-account',
  name: 'Account 1',
  isPublic: true,
  type: WalletType.Guardian,
  hdIndex: 0,
  authScheme: 'ecdsa',
  relayEvmAddress: RELAY
};

function props(overrides: Partial<NearDepositFlowProps> = {}): NearDepositFlowProps {
  return {
    config: CONFIG,
    catalog: CATALOG,
    midenAccount: ACCOUNT,
    pairs: PAIRS,
    initialPairId: SOL_ID,
    initialAmount: '2',
    onRelay: jest.fn(),
    onClose: jest.fn(),
    ...overrides
  };
}

function lastQuoteInput(): NearDepositQuoteInput | undefined {
  return mockQuoteInputs[mockQuoteInputs.length - 1];
}

function typeRefund(value: string) {
  fireEvent.change(screen.getByTestId('near-deposit-refund'), { target: { value } });
}

beforeEach(() => {
  mockQuote = { loading: false };
  mockQuoteInputs.length = 0;
  mockCap = { state: 'none' };
  mockExpired = false;
  mockMobile = false;
  mockBackHandler = undefined;
  amountProps = undefined;
  reviewProps = undefined;
  tokenSheetProps = undefined;
  routeSheetProps = undefined;
  jest.mocked(requestOneClickQuote).mockReset();
  jest.mocked(persistNearIntentsDeposit).mockReset();
  jest.mocked(navigate).mockReset();
  jest.mocked(reportUserVisibleError).mockReset();
});
afterEach(cleanup);

describe('NearDepositFlow amount step', () => {
  it('opens on the pair and amount it is given, with the NEAR Intents route and the quote values', () => {
    mockQuote = {
      loading: false,
      request: request(SOL_REFUND),
      quote: quote(SOL_REFUND),
      amountUnits: 2_000_000_000n
    };
    render(<NearDepositFlow {...props()} />);

    expect(screen.getByTestId('header')).toHaveTextContent('depositFlowTitle');
    expect(amountProps).toMatchObject({
      amount: '2',
      decimals: 9,
      amountUsd: 360,
      sourceToken: { symbol: 'SOL', logoFaucetId: 'wsol' },
      receivedToken: { symbol: 'wSOL', logoFaucetId: 'wsol' },
      network: SOLANA,
      routeName: 'depositFlowNearRoute',
      routeCount: 1,
      arrivesIn: 'depositFlowNearArrives',
      networkGas: 'depositFlowNearGasIncluded',
      received: { amount: 196_000_000n, decimals: 8 },
      receivedUsd: 352.8,
      bridgeFee: { kind: 'amount', value: { amount: 40_000_000n, decimals: 9 } }
    });
    expect(lastQuoteInput()).toMatchObject({ config: CONFIG, amount: '2', recipient: 'miden-account', active: true });
    expect(lastQuoteInput()?.route?.chain.id).toBe('sol');
  });

  it('opens on the first NEAR Intents pair when the pair it is given has none', () => {
    render(<NearDepositFlow {...props({ initialPairId: '1:ETH' })} />);
    expect(amountProps?.sourceToken.symbol).toBe('USDC');
  });

  it('draws nothing when no pair has a NEAR Intents route', () => {
    const { container } = render(
      <NearDepositFlow {...props({ pairs: { networks: [], pairs: [] }, initialPairId: undefined })} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the fee as loading while a quote is on its way, and a dash with no amount', () => {
    mockQuote = { loading: true, request: request(SOL_REFUND), amountUnits: 2_000_000_000n };
    const { rerender } = render(<NearDepositFlow {...props()} />);
    expect(amountProps?.bridgeFee).toEqual({ kind: 'rate', text: 'loading' });
    expect(amountProps?.received).toBeUndefined();
    expect(amountProps?.isValidAmount).toBe(false);

    mockQuote = { loading: false };
    rerender(<NearDepositFlow {...props({ initialAmount: '' })} />);
    expect(amountProps?.bridgeFee).toEqual({ kind: 'rate', text: '–' });
  });

  it('says a failed quote, and that 1Click has no liquidity for the amount', async () => {
    jest.useFakeTimers();
    try {
      mockQuote = { loading: false, request: request(SOL_REFUND), error: new Error('down') };
      const { rerender } = render(<NearDepositFlow {...props()} />);
      expect(screen.getByTestId('near-deposit-quote-failed')).toHaveTextContent('oneClickQuoteUnavailable');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1000);
      });
      expect(reportUserVisibleError).toHaveBeenCalledWith('oneClickQuoteUnavailable', 'notice');

      mockQuote = {
        loading: false,
        request: request(SOL_REFUND),
        error: Object.assign(new Error('none'), { code: 'no_liquidity' })
      };
      rerender(<NearDepositFlow {...props()} />);
      expect(screen.getByTestId('near-deposit-quote-failed')).toHaveTextContent('nearIntentsNoLiquidity');
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows the cap notice and holds Review over the cap', () => {
    mockQuote = { loading: false, request: request(SOL_REFUND), quote: quote(SOL_REFUND), amountUnits: 1n };
    mockCap = { state: 'exceeded', capUsd: 1232, heldUsd: 1000, depositUsd: 352.8 };
    const { rerender } = render(<NearDepositFlow {...props()} />);
    typeRefund(SOL_REFUND);
    expect(amountProps?.depositCapUsd).toBe(1232);
    expect(amountProps?.isValidAmount).toBe(false);

    mockCap = { state: 'unpriced', capUsd: 1232 };
    rerender(<NearDepositFlow {...props()} />);
    expect(amountProps?.depositCapUsd).toBeUndefined();
    expect(amountProps?.depositCapUnpriced).toContain('bridgeDepositBalanceCapUnpriced');
    expect(amountProps?.isValidAmount).toBe(false);
  });

  it('holds Review on an expired quote', () => {
    mockQuote = { loading: false, request: request(SOL_REFUND), quote: quote(SOL_REFUND), amountUnits: 1n };
    mockExpired = true;
    render(<NearDepositFlow {...props()} />);
    typeRefund(SOL_REFUND);
    expect(amountProps?.isValidAmount).toBe(false);
  });
});

describe('NearDepositFlow refund address', () => {
  it('gives the relay address on an EVM chain, with no field', () => {
    render(<NearDepositFlow {...props({ initialPairId: '1:CIRCLE_USDC' })} />);
    expect(screen.queryByTestId('near-deposit-refund')).not.toBeInTheDocument();
    expect(lastQuoteInput()?.refundTo).toBe(RELAY);
  });

  it('gives the EVM address of an account with no relay address', () => {
    const evmAddress = '0x2222222222222222222222222222222222222222';
    render(
      <NearDepositFlow
        {...props({
          initialPairId: '1:CIRCLE_USDC',
          midenAccount: { ...ACCOUNT, relayEvmAddress: undefined, evmAddress }
        })}
      />
    );
    expect(lastQuoteInput()?.refundTo).toBe(evmAddress);
  });

  it('asks for the address on an EVM chain when the account has no EVM address', () => {
    render(
      <NearDepositFlow
        {...props({ initialPairId: '1:CIRCLE_USDC', midenAccount: { ...ACCOUNT, relayEvmAddress: undefined } })}
      />
    );
    expect(screen.getByTestId('near-deposit-refund')).toBeInTheDocument();
    expect(lastQuoteInput()?.refundTo).toBeUndefined();
  });

  it('asks for the address on another chain, refuses one that is not valid, and quotes with a valid one', async () => {
    jest.useFakeTimers();
    try {
      mockQuote = { loading: false, request: request(SOL_REFUND), quote: quote(SOL_REFUND), amountUnits: 1n };
      render(<NearDepositFlow {...props()} />);
      expect(screen.getByTestId('near-deposit-refund-hint')).toHaveTextContent('nearIntentsRefundHint');
      expect(lastQuoteInput()?.refundTo).toBeUndefined();
      expect(amountProps?.isValidAmount).toBe(false);

      typeRefund('0xnot-solana');
      expect(screen.getByTestId('near-deposit-refund-error')).toHaveTextContent('nearIntentsRefundInvalid');
      expect(screen.getByTestId('near-deposit-refund')).toHaveAttribute('aria-invalid', 'true');
      expect(amountProps?.isValidAmount).toBe(false);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1000);
      });
      expect(reportUserVisibleError).toHaveBeenCalledWith('invalidAddress', 'field');

      typeRefund(` ${SOL_REFUND} `);
      expect(screen.queryByTestId('near-deposit-refund-error')).not.toBeInTheDocument();
      expect(lastQuoteInput()?.refundTo).toBe(SOL_REFUND);
      expect(amountProps?.isValidAmount).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('pastes the address from the clipboard on mobile', async () => {
    mockMobile = true;
    mockClipboard = { value: ` ${SOL_REFUND} `, type: 'text/plain' };
    render(<NearDepositFlow {...props()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('near-deposit-refund-paste'));
    });
    expect(screen.getByTestId('near-deposit-refund')).toHaveValue(SOL_REFUND);
    expect(screen.queryByTestId('near-deposit-refund-paste')).not.toBeInTheDocument();
  });

  it('keeps the field as it is when the clipboard has no text or cannot be read', async () => {
    mockMobile = true;
    mockClipboard = { value: 'image', type: 'image/png' };
    render(<NearDepositFlow {...props()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('near-deposit-refund-paste'));
    });
    expect(screen.getByTestId('near-deposit-refund')).toHaveValue('');
    mockClipboard = new Error('denied');
    await act(async () => {
      fireEvent.click(screen.getByTestId('near-deposit-refund-paste'));
    });
    expect(screen.getByTestId('near-deposit-refund')).toHaveValue('');
  });

  it('clears a typed address when the next pair is on a chain of another kind', () => {
    render(<NearDepositFlow {...props()} />);
    typeRefund(SOL_REFUND);
    act(() => tokenSheetProps?.onSelect(BTC_ID));
    expect(screen.getByTestId('near-deposit-refund')).toHaveValue('');
    expect(amountProps?.sourceToken.symbol).toBe('BTC');
  });
});

describe('NearDepositFlow review and slide', () => {
  function toReview() {
    mockQuote = {
      loading: false,
      request: request(SOL_REFUND),
      quote: quote(SOL_REFUND),
      amountUnits: 2_000_000_000n
    };
    const view = render(<NearDepositFlow {...props()} />);
    typeRefund(SOL_REFUND);
    fireEvent.click(screen.getByRole('button', { name: 'review' }));
    return view;
  }

  it('shows the review with the quote values and the fee share', () => {
    toReview();
    expect(screen.getByTestId('header')).toHaveTextContent('depositFlowReviewTitle');
    expect(reviewProps).toMatchObject({
      received: { amount: 196_000_000n, decimals: 8 },
      receivedUsd: 352.8,
      amount: { amount: 2_000_000_000n, decimals: 9 },
      routeName: 'depositFlowNearRoute',
      arrivesIn: 'depositFlowNearArrives',
      networkGas: 'depositFlowNearGasIncluded',
      confirmDisabled: false
    });
    expect(reviewProps?.feeShare).toBeCloseTo(0.02);
  });

  it('asks for the deposit quote, saves the row and opens its deposit page on the slide', async () => {
    toReview();
    const depositQuote = quote(SOL_REFUND, false);
    jest.mocked(requestOneClickQuote).mockResolvedValue(depositQuote);
    jest.mocked(persistNearIntentsDeposit).mockResolvedValue('row 1');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'slide' }));
    });

    const [config, sent, dry] = jest.mocked(requestOneClickQuote).mock.calls[0] ?? [];
    expect(config).toBe(CONFIG);
    expect(dry).toBe(false);
    expect(sent).toMatchObject({ amount: '2000000000', refundTo: SOL_REFUND, recipient: 'miden-account' });
    expect(persistNearIntentsDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        quote: depositQuote,
        config: CONFIG,
        network: 'mainnet',
        accountId: 'miden-account',
        accountAddress: 'miden-account',
        faucetId: 'wsol'
      })
    );
    expect(navigate).toHaveBeenCalledWith('/receive/near-intents/row%201');
  });

  it('says a failed deposit quote and puts the slide back', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    toReview();
    const resetKey = reviewProps?.confirmResetKey;
    jest.mocked(requestOneClickQuote).mockRejectedValue(new Error('expired'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'slide' }));
    });

    expect(screen.getByTestId('near-deposit-submit-failed')).toHaveTextContent('nearIntentsDepositAddressFailed');
    expect(reviewProps?.confirmResetKey).not.toBe(resetKey);
    expect(persistNearIntentsDeposit).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    jest.mocked(console.warn).mockRestore();
  });

  it('saves no row when the route changed while the deposit quote was on its way', async () => {
    const view = toReview();
    let answer: (value: OneClickQuoteResponse) => void = () => undefined;
    jest.mocked(requestOneClickQuote).mockReturnValue(new Promise(resolve => (answer = resolve)));

    fireEvent.click(screen.getByRole('button', { name: 'slide' }));
    expect(reviewProps?.confirmDisabled).toBe(true);
    mockQuote = { ...mockQuote, request: { ...request(SOL_REFUND), amount: '3000000000' } };
    view.rerender(<NearDepositFlow {...props()} />);
    await act(async () => {
      answer(quote(SOL_REFUND, false));
    });

    expect(persistNearIntentsDeposit).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(reviewProps?.confirmDisabled).toBe(false);
  });

  it('refuses a second slide and the back while a submit is out, and says a failed save', async () => {
    toReview();
    let answer: (value: OneClickQuoteResponse) => void = () => undefined;
    jest.mocked(requestOneClickQuote).mockReturnValue(new Promise(resolve => (answer = resolve)));
    fireEvent.click(screen.getByRole('button', { name: 'slide' }));
    // A second slide and the back are refused while the first is out.
    act(() => {
      reviewProps?.onConfirm();
      mockBackHandler?.();
    });
    expect(requestOneClickQuote).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('review-view')).toBeInTheDocument();
    jest.mocked(persistNearIntentsDeposit).mockRejectedValue(new Error('storage'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => {
      answer(quote(SOL_REFUND, false));
    });
    expect(screen.getByTestId('near-deposit-submit-failed')).toBeInTheDocument();
    jest.mocked(console.warn).mockRestore();
  });

  it('refuses a slide whose request carries a preview refund address', () => {
    mockQuote = {
      loading: false,
      request: request('ES452S7HwooFCN93gENCAzQ8oSywVFpjNHFGRv4kUgtx'),
      quote: quote(SOL_REFUND),
      amountUnits: 1n
    };
    render(<NearDepositFlow {...props()} />);
    typeRefund(SOL_REFUND);
    fireEvent.click(screen.getByRole('button', { name: 'review' }));
    act(() => {
      reviewProps?.onConfirm();
    });
    expect(requestOneClickQuote).not.toHaveBeenCalled();
  });

  it('goes back to the amount step from the review, and leaves from the amount step', () => {
    const onClose = jest.fn();
    mockQuote = { loading: false, request: request(SOL_REFUND), quote: quote(SOL_REFUND), amountUnits: 1n };
    render(<NearDepositFlow {...props({ onClose })} />);
    typeRefund(SOL_REFUND);
    fireEvent.click(screen.getByRole('button', { name: 'review' }));
    fireEvent.click(screen.getByRole('button', { name: 'header-close' }));
    expect(screen.getByTestId('amount-view')).toBeInTheDocument();
    act(() => {
      mockBackHandler?.();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'header-back' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('NearDepositFlow hand-over', () => {
  it('offers the union in the token sheet and hands a pair that the relay serves to the relay', () => {
    const onRelay = jest.fn();
    render(<NearDepositFlow {...props({ onRelay })} />);
    fireEvent.click(screen.getByRole('button', { name: 'token' }));
    expect(tokenSheetProps).toMatchObject({ open: true, networkId: 'solana', selectedId: SOL_ID });
    expect(tokenSheetProps?.tokens.map(token => token.id)).toEqual(['1:CIRCLE_USDC', '1:ETH', SOL_ID, BTC_ID]);
    expect(tokenSheetProps?.networks).toBe(PAIRS.networks);

    act(() => tokenSheetProps?.onSelect('1:ETH'));
    expect(onRelay).toHaveBeenCalledWith({ pairId: '1:ETH', amount: '2' });
    expect(tokenSheetProps?.open).toBe(false);
  });

  it('keeps the flow on a pick of the same row or of an unknown id', () => {
    const onRelay = jest.fn();
    render(<NearDepositFlow {...props({ onRelay })} />);
    act(() => tokenSheetProps?.onSelect(SOL_ID));
    act(() => tokenSheetProps?.onSelect('nothing'));
    expect(onRelay).not.toHaveBeenCalled();
    expect(amountProps?.sourceToken.symbol).toBe('SOL');
  });

  it('lists the relay routes of a pair that the relay also serves, and hands a relay route back with the amount', () => {
    const onRelay = jest.fn();
    const evmQuote = quote(RELAY);
    mockQuote = {
      loading: false,
      request: request(RELAY),
      // 2 USDC in, 1.96 USDCx out.
      quote: { ...evmQuote, quote: { ...evmQuote.quote, amountOut: '1960000' } },
      amountUnits: 2_000_000n
    };
    render(<NearDepositFlow {...props({ initialPairId: '1:CIRCLE_USDC', onRelay })} />);
    fireEvent.click(screen.getByRole('button', { name: 'route' }));

    expect(amountProps?.routeCount).toBe(3);
    expect(routeSheetProps?.open).toBe(true);
    expect(
      routeSheetProps?.routes.map(option => [option.id, option.best, option.fastest, option.selected, option.fee])
    ).toEqual([
      ['usdcx', true, false, false, undefined],
      ['epoch', false, true, false, undefined],
      ['near-intents', false, false, true, { kind: 'amount', value: { amount: 40_000_000n, decimals: 6 } }]
    ]);
    expect(routeSheetProps).toMatchObject({ receivedSymbol: 'USDCx', feeSymbol: 'USDC' });

    act(() => routeSheetProps?.onSelect('near-intents'));
    expect(onRelay).not.toHaveBeenCalled();
    act(() => routeSheetProps?.onSelect('epoch'));
    expect(onRelay).toHaveBeenCalledWith({ pairId: '1:CIRCLE_USDC', amount: '2', route: 'epoch' });
  });

  it('gives Agglayer no fee in the route sheet', () => {
    const pairs: DepositPairs = {
      ...PAIRS,
      pairs: PAIRS.pairs.map(pair =>
        pair.relay === undefined || pair.option.id !== '1:CIRCLE_USDC'
          ? pair
          : { ...pair, relay: { ...pair.relay, routes: ['agglayer'] } }
      )
    };
    render(<NearDepositFlow {...props({ pairs, initialPairId: '1:CIRCLE_USDC', initialAmount: '' })} />);
    expect(routeSheetProps?.routes[0]).toMatchObject({ id: 'agglayer', fee: { kind: 'none' }, received: undefined });
  });
});
