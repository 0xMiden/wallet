import React from 'react';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type {
  NearIntentsCatalog,
  NearIntentsConfig,
  OneClickAsset,
  OneClickQuoteRequest,
  OneClickQuoteResponse
} from 'lib/one-click/types';

import { NearIntentsForm } from './NearIntentsForm';
import { previewRefundAddress } from './preview-refund';
import { PREVIEW_DEBOUNCE_MS } from './useNearIntentsQuote';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key)
  })
}));

// The shared manual mock of this module has no `toLocalFormat`; the form needs the real helpers.
jest.mock('lib/i18n/numbers', () => jest.requireActual('lib/i18n/numbers'));
jest.mock('lib/telemetry/use-user-visible-error', () => ({ useUserVisibleError: jest.fn() }));
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn(),
  hapticSelection: jest.fn()
}));
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { read: jest.fn(), write: jest.fn() } }));
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ symbol }: { symbol: string }) => <span data-testid={`token-logo-${symbol}`} />
}));

const mockRequestQuote = jest.fn<Promise<OneClickQuoteResponse>, [NearIntentsConfig, OneClickQuoteRequest, boolean]>();
jest.mock('lib/one-click/client', () => ({
  requestOneClickQuote: (config: NearIntentsConfig, request: OneClickQuoteRequest, dry: boolean) =>
    mockRequestQuote(config, request, dry)
}));
jest.mock('lib/one-click/address', () => ({
  isValidNearIntentsRefundAddress: (kind: string, value: string) =>
    kind === 'evm' ? /^0x[0-9a-fA-F]{40}$/.test(value) : value.length > 20
}));
const mockPersist = jest.fn<Promise<string>, [unknown]>();
jest.mock('lib/one-click/tracking', () => ({
  persistNearIntentsDeposit: (input: unknown) => mockPersist(input)
}));
jest.mock('lib/miden/front', () => ({ useAccount: () => ({ publicKey: 'mm1account' }) }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'mainnet' }));
const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({
  ...jest.requireActual('lib/woozie'),
  navigate: (path: string) => mockNavigate(path)
}));

const usdc: OneClickAsset = {
  assetId: 'nep141:eth-usdc',
  blockchain: 'eth',
  symbol: 'USDC',
  decimals: 6,
  contractAddress: '0x2222222222222222222222222222222222222222'
};
const usdt: OneClickAsset = { ...usdc, assetId: 'nep141:eth-usdt', symbol: 'USDT' };
const sol: OneClickAsset = { assetId: 'nep141:sol', blockchain: 'sol', symbol: 'SOL', decimals: 9 };
const usdcx: OneClickAsset = {
  assetId: 'miden:usdcx',
  blockchain: 'miden',
  symbol: 'USDCx',
  decimals: 6,
  faucetId: 'mm1faucetusdcx'
};
const midenToken: OneClickAsset = { ...usdcx, assetId: 'miden:other', symbol: 'MIDEN', faucetId: 'mm1faucetmiden' };

const catalog: NearIntentsCatalog = {
  chains: [
    {
      id: 'eth',
      name: 'Ethereum',
      addressKind: 'evm',
      tokens: [
        { symbol: 'USDC', asset: usdc, outputs: [usdcx, midenToken] },
        { symbol: 'USDT', asset: usdt, outputs: [usdcx] }
      ]
    },
    {
      id: 'sol',
      name: 'Solana',
      addressKind: 'solana',
      tokens: [{ symbol: 'SOL', asset: sol, outputs: [midenToken] }]
    }
  ]
};

const config: NearIntentsConfig = {
  serviceUrl: 'https://1click.example',
  chains: [],
  midenAssets: []
};

const REFUND = '0x91b2000000000000000000000000000000007f0a';

function quoteFor(request: OneClickQuoteRequest, dry: boolean): OneClickQuoteResponse {
  return {
    correlationId: 'c',
    timestamp: '2026-11-10T00:00:00Z',
    signature: 's',
    quoteRequest: {
      dry,
      swapType: 'EXACT_INPUT',
      slippageTolerance: request.slippageTolerance,
      originAsset: request.originAsset.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: request.destinationAsset.assetId,
      amount: request.amount,
      refundTo: request.refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: request.recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: request.deadline
    },
    quote: {
      depositAddress: dry ? undefined : '0xdeposit',
      amountIn: request.amount,
      amountInFormatted: '46',
      amountInUsd: '45.99',
      minAmountIn: request.amount,
      amountOut: '45910000',
      amountOutFormatted: '45.91',
      amountOutUsd: '45.91',
      minAmountOut: '45000000',
      deadline: request.deadline,
      timeEstimate: 110
    }
  };
}

const renderForm = () => render(<NearIntentsForm config={config} catalog={catalog} />);

const typeAmount = (value: string) =>
  fireEvent.change(screen.getByTestId('near-intents-amount'), { target: { value } });
const typeRefund = (value: string) =>
  fireEvent.change(screen.getByTestId('near-intents-refund-address'), { target: { value } });

const flushQuote = async () => {
  await act(async () => {
    jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
  });
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  mockRequestQuote.mockReset();
  mockRequestQuote.mockImplementation(async (_config, request, dry) => quoteFor(request, dry));
  mockPersist.mockReset();
  mockPersist.mockResolvedValue('row-1');
  mockNavigate.mockReset();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe('NearIntentsForm', () => {
  it('selects the first chain, its first token and that token’s first output', () => {
    renderForm();
    expect(screen.getByTestId('near-intents-send-token-pill')).toHaveTextContent('USDC');
    expect(screen.getByTestId('near-intents-receive-token-pill')).toHaveTextContent('USDCx');
    expect(screen.getByTestId('near-intents-send-card')).toHaveTextContent('nearIntentsOnChain:{"chain":"Ethereum"}');
  });

  it('selects the first token of a new chain, and the first output of a new token', () => {
    renderForm();
    fireEvent.click(screen.getByTestId('near-intents-send-token-pill'));
    fireEvent.click(screen.getByTestId('near-intents-network-filter'));
    fireEvent.click(screen.getByTestId('near-intents-network-sol'));
    fireEvent.click(screen.getByTestId('near-intents-token-nep141:sol'));

    expect(screen.getByTestId('near-intents-send-token-pill')).toHaveTextContent('SOL');
    expect(screen.getByTestId('near-intents-receive-token-pill')).toHaveTextContent('MIDEN');
    expect(screen.getByTestId('near-intents-send-card')).toHaveTextContent('nearIntentsOnChain:{"chain":"Solana"}');
  });

  it('opens the receive drawer with one output and selects another output of the token', () => {
    renderForm();
    fireEvent.click(screen.getByTestId('near-intents-receive-token-pill'));
    expect(screen.getByTestId('near-intents-receive-token-drawer')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('near-intents-output-miden:other'));
    expect(screen.getByTestId('near-intents-receive-token-pill')).toHaveTextContent('MIDEN');

    // A new token selects its first output again.
    fireEvent.click(screen.getByTestId('near-intents-send-token-pill'));
    fireEvent.click(screen.getByTestId('near-intents-token-nep141:eth-usdt'));
    expect(screen.getByTestId('near-intents-send-token-pill')).toHaveTextContent('USDT');
    expect(screen.getByTestId('near-intents-receive-token-pill')).toHaveTextContent('USDCx');
  });

  it('names a missing-liquidity refusal and shows the general text for any other quote failure', async () => {
    mockRequestQuote.mockRejectedValue(
      Object.assign(new Error('1Click request failed (400)'), { code: 'no_liquidity' })
    );
    renderForm();
    typeAmount('46');
    await flushQuote();
    expect(screen.getByTestId('near-intents-quote-error')).toHaveTextContent('nearIntentsNoLiquidity');

    mockRequestQuote.mockRejectedValue(new Error('1Click request failed (400)'));
    typeAmount('47');
    await flushQuote();
    expect(screen.getByTestId('near-intents-quote-error')).toHaveTextContent('oneClickQuoteUnavailable');
  });

  it('shows a dry quote from the amount alone with a placeholder refund address, and keeps the button disabled', async () => {
    renderForm();
    const button = screen.getByTestId('near-intents-get-deposit-address');
    expect(button).toBeDisabled();
    expect(mockRequestQuote).not.toHaveBeenCalled();

    typeAmount('46');
    await flushQuote();
    expect(mockRequestQuote).toHaveBeenCalledTimes(1);
    const [, request, dry] = mockRequestQuote.mock.calls[0]!;
    expect(dry).toBe(true);
    expect(request.refundTo).toBe(previewRefundAddress('evm'));
    expect(button).toBeDisabled();

    typeRefund('not-an-address');
    await flushQuote();
    expect(screen.getByTestId('near-intents-refund-error')).toHaveTextContent('nearIntentsRefundInvalid');
    expect(button).toBeDisabled();

    // The placeholder itself is refused as a refund address, so it can never go into a deposit quote.
    typeRefund(previewRefundAddress('evm'));
    await flushQuote();
    expect(screen.getByTestId('near-intents-refund-error')).toBeInTheDocument();
    expect(button).toBeDisabled();
    fireEvent.click(button);
    await flushQuote();
    expect(mockRequestQuote.mock.calls.every(call => call[2] === true)).toBe(true);
  });

  it('shows the dry quote, its rate and its time once the inputs are valid, then enables the button', async () => {
    renderForm();
    typeAmount('46');
    typeRefund(REFUND);
    await flushQuote();

    expect(mockRequestQuote).toHaveBeenCalledTimes(1);
    const [, request, dry] = mockRequestQuote.mock.calls[0]!;
    expect(dry).toBe(true);
    expect(request).toMatchObject({
      amount: '46000000',
      originAsset: usdc,
      destinationAsset: usdcx,
      refundTo: REFUND,
      recipient: 'mm1account',
      slippageTolerance: 100
    });
    expect(Date.parse(request.deadline) - Date.now()).toBeGreaterThan(4 * 60_000);

    expect(screen.getByTestId('near-intents-quoted-amount')).toHaveValue('45.91');
    expect(screen.getByTestId('near-intents-send-usd')).toHaveTextContent('$45.99');
    expect(screen.getByTestId('near-intents-rate')).toHaveTextContent(
      'nearIntentsRate:{"from":"USDC","rate":"0.998043","to":"USDCx"}'
    );
    expect(screen.getByTestId('near-intents-time-estimate')).toHaveTextContent(
      'nearIntentsTimeEstimate:{"minutes":"2"}'
    );
    expect(screen.getByTestId('near-intents-get-deposit-address')).toBeEnabled();
  });

  it('asks for the deposit quote, saves the row and opens its deposit page', async () => {
    renderForm();
    typeAmount('46');
    typeRefund(REFUND);
    await flushQuote();

    await act(async () => {
      fireEvent.click(screen.getByTestId('near-intents-get-deposit-address'));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const wet = mockRequestQuote.mock.calls.find(call => call[2] === false);
    expect(wet).toBeDefined();
    expect(mockPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        network: 'mainnet',
        accountId: 'mm1account',
        accountAddress: 'mm1account',
        originAsset: usdc,
        destinationAsset: usdcx,
        faucetId: 'mm1faucetusdcx',
        request: expect.objectContaining({ amount: '46000000', refundTo: REFUND })
      })
    );
    expect(mockNavigate).toHaveBeenCalledWith('/receive/near-intents/row-1');
  });

  it('shows an inline error and stays on the form when the deposit quote fails', async () => {
    renderForm();
    typeAmount('46');
    typeRefund(REFUND);
    await flushQuote();
    mockRequestQuote.mockImplementation(async (_config, request, dry) => {
      if (!dry) throw new Error('quote refused');
      return quoteFor(request, dry);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('near-intents-get-deposit-address'));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId('near-intents-submit-error')).toBeInTheDocument();
    expect(mockPersist).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('reports an unavailable quote inline', async () => {
    mockRequestQuote.mockRejectedValue(new Error('no route'));
    renderForm();
    typeAmount('46');
    typeRefund(REFUND);
    await flushQuote();

    expect(screen.getByTestId('near-intents-quote-error')).toHaveTextContent('oneClickQuoteUnavailable');
    expect(screen.getByTestId('near-intents-get-deposit-address')).toBeDisabled();
  });
});
