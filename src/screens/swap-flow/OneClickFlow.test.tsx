import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { SpendingLimitChallengeProps } from 'components/SpendingLimitChallenge';
import { confirmSensitiveAction } from 'lib/biometric';
import { IOneClickTrackingData } from 'lib/miden/db/types';
import { SpendingLimitAssessment } from 'lib/miden/spending-limits/types';
import { requestOneClickQuote } from 'lib/one-click/client';
import { submitEvmOneClickDeposit } from 'lib/one-click/evm';
import {
  initiateOneClickMidenDeposit,
  persistOneClickTrackingRow,
  recordOneClickOriginTransactionHash
} from 'lib/one-click/tracking';
import { OneClickAsset, OneClickConfig, OneClickQuoteRequest, OneClickQuoteResponse } from 'lib/one-click/types';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';

import { OneClickFlow } from './OneClickFlow';
import { OneClickNetworkOption } from './OneClickPickers';

let mockAccountId = '0x111111111111111111111111111111';
let mockConfirmResult: Promise<boolean> = Promise.resolve(true);
const mockOriginAddress = '0x2222222222222222222222222222222222222222';
const mockMidenAddress = '0x333333333333333333333333333333';
const mockTxHash = `0x${'4'.repeat(64)}`;
let mockEvmConnected = true;
let mockSpendingLimitAssessment: SpendingLimitAssessment | undefined;
const mockConnectExternal = jest.fn(async () => undefined);
let mockEvmBalanceSnapshot = {
  chainId: 1,
  account: mockOriginAddress,
  assetId: 'eth:token',
  tokenBalance: 10_000_000n,
  nativeBalance: 10_000_000_000_000_000n,
  gasReserve: 1_000_000_000_000n,
  spendableTokenBalance: 10_000_000n,
  spendableNativeBalance: 9_999_000_000_000_000n,
  requiredTokenAmount: 1_000_000n,
  tokenSufficient: true,
  gasSufficient: true,
  canDeposit: true,
  estimatedGas: 21_000n,
  maxFeePerGas: 1_000_000n,
  updatedAt: Date.now()
};

jest.mock('app/hooks/useNativeFeeFaucetId', () => ({
  __esModule: true,
  default: () => '0x111111111111111111111111111111'
}));
jest.mock('app/hooks/useVerificationBaseFee', () => ({ __esModule: true, default: () => 1 }));
jest.mock('app/hooks/useNetworkFeeEstimate', () => ({ useNetworkFeeEstimate: () => '0.01 MIDEN' }));
jest.mock('lib/biometric', () => ({ confirmSensitiveAction: jest.fn(() => mockConfirmResult) }));
jest.mock('lib/miden/back/protector-probe', () => ({ probeHardwareProtector: jest.fn() }));
jest.mock('lib/miden/fees/spendable', () => ({
  hasNoFeeAsset: () => false,
  maxSendableNative: (balance: number) => balance
}));
jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: mockAccountId }),
  useAllBalances: () => ({
    data: [{ tokenId: '0x111111111111111111111111111111', balance: 100, metadata: { decimals: 6 } }]
  }),
  useAllTokensBaseMetadata: () => ({})
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'mainnet' }));
jest.mock('lib/miden/front/use-filtered-contacts.hook', () => ({ useFilteredContacts: () => ({ contacts: [] }) }));
jest.mock('lib/miden/spending-limits/types', () => ({
  spendingLimitAssessmentFromError: () => undefined
}));
jest.mock('lib/miden/swap/faucet-ids', () => ({ normalizedFaucetId: (value: string) => value }));
jest.mock('lib/mobile/useMobileBackHandler', () => ({ useMobileBackHandler: jest.fn() }));
jest.mock('lib/platform', () => ({ isExtension: () => false }));
jest.mock('lib/miden/activity', () => ({ requestSWTransactionProcessing: jest.fn() }));
jest.mock('lib/one-click/client', () => ({
  ONE_CLICK_EVM_CHAIN_IDS: { eth: 1 },
  isSameOneClickUnderlyingAsset: (left: OneClickAsset, right: OneClickAsset) =>
    left.assetId === right.assetId || (!!left.coingeckoId && left.coingeckoId === right.coingeckoId),
  requestOneClickQuote: jest.fn()
}));
jest.mock('lib/telemetry/use-user-visible-error', () => ({ useUserVisibleError: jest.fn() }));
jest.mock('lib/one-click/tracking', () => ({
  initiateOneClickMidenDeposit: jest.fn(async () => 'miden-transaction'),
  persistOneClickTrackingRow: jest.fn(async () => 'one-click-row'),
  recordOneClickOriginTransactionHash: jest.fn(async () => undefined),
  updateOneClickTrackingPhase: jest.fn()
}));
jest.mock('lib/one-click/evm', () => {
  class OneClickDepositBroadcastError extends Error {
    constructor(
      public transactionHash: string,
      cause: unknown
    ) {
      super('The EVM transaction was broadcast, but its submission could not be fully recorded');
      this.name = 'OneClickDepositBroadcastError';
      Object.assign(this, { cause });
    }
  }
  return {
    OneClickDepositBroadcastError,
    submitEvmOneClickDeposit: jest.fn(async ({ onSubmitted }: { onSubmitted?: (hash: string) => Promise<void> }) => {
      if (onSubmitted) {
        try {
          await onSubmitted(mockTxHash);
        } catch (cause) {
          throw new OneClickDepositBroadcastError(mockTxHash, cause);
        }
      }
      return mockTxHash;
    })
  };
});
jest.mock('lib/walletconnect/useEvmWalletProvider', () => ({
  useEvmWalletProvider: () => ({
    provider: { request: jest.fn() },
    address: mockEvmConnected ? mockOriginAddress : undefined,
    isConnected: mockEvmConnected,
    connect: mockConnectExternal
  })
}));
jest.mock('./useOneClickEvmBalance', () => ({
  useOneClickEvmBalance: () => ({ status: 'ready', snapshot: mockEvmBalanceSnapshot, refresh: jest.fn() })
}));
jest.mock('lib/woozie', () => ({ navigate: jest.fn(), HistoryAction: { Replace: 'replace' } }));
jest.mock('lib/store', () => ({
  useWalletStore: (
    selector: (state: {
      assessSpendingLimit: () => Promise<SpendingLimitAssessment | undefined>;
      readSpendingLimit: () => Promise<undefined>;
    }) => unknown
  ) =>
    selector({
      assessSpendingLimit: async () => mockSpendingLimitAssessment,
      readSpendingLimit: async () => undefined
    })
}));
jest.mock('./OneClickAmounts', () => ({
  OneClickAmounts: (props: {
    canContinue: boolean;
    onOfferAmountChange: (amount: string) => void;
    onExternalAddressChange: (address: string) => void;
    onConnectExternal?: () => void;
    connectedExternalAddress?: string;
    evmBalance?: { snapshot?: typeof mockEvmBalanceSnapshot };
    routeError?: string;
    routeErrorId?: string | null;
    onContinue: () => void;
  }) => (
    <div>
      {props.routeError && <span data-testid="one-click-amounts-error">{props.routeError}</span>}
      {props.routeErrorId && <span data-testid="one-click-amounts-error-id">{props.routeErrorId}</span>}
      <input aria-label="amount" onChange={event => props.onOfferAmountChange(event.target.value)} />
      <input aria-label="external address" onChange={event => props.onExternalAddressChange(event.target.value)} />
      {props.onConnectExternal && (
        <button type="button" onClick={props.onConnectExternal}>
          Connect wallet
        </button>
      )}
      {props.connectedExternalAddress && <span>{props.connectedExternalAddress}</span>}
      {props.evmBalance?.snapshot && <span>{props.evmBalance.snapshot.tokenBalance.toString()}</span>}
      <button type="button" disabled={!props.canContinue} onClick={props.onContinue}>
        Review route
      </button>
    </div>
  )
}));
jest.mock('./OneClickReview', () => ({
  OneClickReview: (props: {
    onConfirm: () => void;
    onRefresh: () => void;
    error?: string;
    errorId?: string | null;
    submitting?: boolean;
    confirmDisabled?: boolean;
    fundingError?: string;
    recoveryNotice?: boolean;
  }) => (
    <div>
      {props.error && <span data-testid="one-click-review-error">{props.error}</span>}
      {props.errorId && <span data-testid="one-click-review-error-id">{props.errorId}</span>}
      {props.recoveryNotice && <p>Quote refreshed after the previous quote expired</p>}
      {props.fundingError && <p>{props.fundingError}</p>}
      <button type="button" disabled={props.submitting || props.confirmDisabled} onClick={props.onConfirm}>
        Confirm route
      </button>
      <button type="button" onClick={props.onRefresh}>
        Refresh route
      </button>
    </div>
  )
}));
jest.mock('components/SpendingLimitChallenge', () => ({
  SpendingLimitChallenge: (props: SpendingLimitChallengeProps) => (
    <div data-testid="spending-limit-challenge">
      <button
        type="button"
        onClick={() =>
          props.onResult({
            kind: 'usd',
            id: 'test-authorization',
            accountId: mockAccountId,
            usdAmount: 1n,
            spendsDigest: 'test-spend',
            revision: 'test-revision',
            issuedAt: 1,
            expiresAt: 120
          })
        }
      >
        Authorize limit
      </button>
    </div>
  )
}));

const config: OneClickConfig = { serviceUrl: 'https://quotes.example', midenAssets: [] };
const midenAsset: OneClickAsset = {
  assetId: 'miden:token',
  blockchain: 'miden',
  symbol: 'MIDEN',
  decimals: 6,
  faucetId: '0x111111111111111111111111111111'
};
const ethereumAsset: OneClickAsset = {
  assetId: 'eth:token',
  blockchain: 'eth',
  symbol: 'USDC',
  decimals: 6,
  contractAddress: '0x5555555555555555555555555555555555555555',
  chainId: 1
};
const manualAsset: OneClickAsset = { assetId: 'sol:token', blockchain: 'sol', symbol: 'SOL', decimals: 9 };
const networks: OneClickNetworkOption[] = [
  { id: 'miden', name: 'Miden', kind: 'miden' },
  { id: 'eth', name: 'Ethereum', kind: 'ethereum' },
  { id: 'sol', name: 'Solana', kind: 'ethereum' }
];
const networkFor = (id: string): OneClickNetworkOption => {
  const network = networks.find(candidate => candidate.id === id);
  if (!network) throw new Error(`Missing test network ${id}`);
  return network;
};

function quoteFor(request: OneClickQuoteRequest, dry: boolean, expired = false): OneClickQuoteResponse {
  const deadline = new Date(Date.now() + (expired ? -1_000 : 60_000)).toISOString();
  return {
    correlationId: 'test-correlation',
    timestamp: new Date().toISOString(),
    signature: `signature-${dry}`,
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
      deadline
    },
    quote: {
      ...(dry ? {} : { depositAddress: '0x6666666666666666666666666666666666666666' }),
      amountIn: request.amount,
      amountInFormatted: '1 MIDEN',
      amountInUsd: '1',
      minAmountIn: request.amount,
      amountOut: '900000',
      amountOutFormatted: '0.9 USDC',
      amountOutUsd: '0.9',
      minAmountOut: '850000',
      deadline,
      timeEstimate: 120,
      refundFee: '1000',
      withdrawFee: '2000'
    }
  };
}

function renderFlow(originAsset: OneClickAsset, destinationAsset: OneClickAsset) {
  return render(
    <OneClickFlow
      config={config}
      assets={[midenAsset, ethereumAsset, manualAsset]}
      networks={networks}
      offerNetwork={networkFor(originAsset.blockchain)}
      requestNetwork={networkFor(destinationAsset.blockchain)}
      midenAddress={mockMidenAddress}
      onBackToSwap={jest.fn()}
    />
  );
}

async function setAmountAndReview(address?: string): Promise<void> {
  fireEvent.change(screen.getByLabelText('amount'), { target: { value: '1' } });
  if (address) fireEvent.change(screen.getByLabelText('external address'), { target: { value: address } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review route' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Review route' }));
  await screen.findByRole('button', { name: 'Confirm route' });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAccountId = '0x111111111111111111111111111111';
  mockConfirmResult = Promise.resolve(true);
  mockEvmConnected = true;
  mockSpendingLimitAssessment = undefined;
  mockEvmBalanceSnapshot = {
    chainId: 1,
    account: mockOriginAddress,
    assetId: 'eth:token',
    tokenBalance: 10_000_000n,
    nativeBalance: 10_000_000_000_000_000n,
    gasReserve: 1_000_000_000_000n,
    spendableTokenBalance: 10_000_000n,
    spendableNativeBalance: 9_999_000_000_000_000n,
    requiredTokenAmount: 1_000_000n,
    tokenSufficient: true,
    gasSufficient: true,
    canDeposit: true,
    estimatedGas: 21_000n,
    maxFeePerGas: 1_000_000n,
    updatedAt: Date.now()
  };
  mockConnectExternal.mockReset();
  jest
    .mocked(requestOneClickQuote)
    .mockImplementation(async (_config, request, dry = true) => quoteFor(request, dry, !dry && nextWetQuoteExpired));
  nextWetQuoteExpired = false;
});

let nextWetQuoteExpired = false;

describe('OneClickFlow', () => {
  it('allows outbound review for a dry quote without provider expiry while its signed request is live', async () => {
    jest.mocked(requestOneClickQuote).mockImplementationOnce(async (_config, request, dry = true) => {
      const quote = quoteFor(request, dry);
      delete quote.quote.deadline;
      return quote;
    });
    renderFlow(midenAsset, ethereumAsset);

    await setAmountAndReview(mockOriginAddress);

    expect(screen.getByRole('button', { name: 'Confirm route' })).toBeInTheDocument();
    expect(jest.mocked(requestOneClickQuote).mock.calls.some(([, , dry]) => dry === true)).toBe(true);
  });

  it('localizes an outbound Miden deposit failure with a fixed ID and no exception detail', async () => {
    const privateFailure = 'private account 0x1234 rejected';
    jest.mocked(initiateOneClickMidenDeposit).mockRejectedValueOnce(new Error(privateFailure));
    renderFlow(midenAsset, ethereumAsset);
    await setAmountAndReview(mockOriginAddress);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm route' }));

    expect(await screen.findByTestId('one-click-review-error')).toHaveTextContent('oneClickSubmitFailed');
    expect(await screen.findByTestId('one-click-review-error-id')).toHaveTextContent('oneClickSubmitFailed');
    expect(screen.queryByText(privateFailure)).not.toBeInTheDocument();
    expect(jest.mocked(useUserVisibleError).mock.calls.filter(([id]) => id !== null && id !== undefined)).toEqual([]);
  });

  it('localizes an initial wet quote failure and keeps its exception detail out of Amounts', async () => {
    const privateFailure = 'private initial quote failure token-71';
    jest.mocked(requestOneClickQuote).mockImplementation(async (_config, request, dry = true) => {
      if (!dry) throw new Error(privateFailure);
      return quoteFor(request, dry);
    });
    renderFlow(midenAsset, ethereumAsset);
    fireEvent.change(screen.getByLabelText('amount'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('external address'), { target: { value: mockOriginAddress } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review route' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Review route' }));

    expect(await screen.findByTestId('one-click-amounts-error')).toHaveTextContent('oneClickQuoteUnavailable');
    expect(screen.getByTestId('one-click-amounts-error-id')).toHaveTextContent('oneClickQuoteUnavailable');
    expect(screen.queryByText(privateFailure)).not.toBeInTheDocument();
  });

  it('localizes a refreshed wet quote failure and keeps its exception detail out of Review', async () => {
    const privateFailure = 'private refreshed quote failure token-82';
    let wetQuoteCalls = 0;
    jest.mocked(requestOneClickQuote).mockImplementation(async (_config, request, dry = true) => {
      if (!dry && wetQuoteCalls++ > 0) throw new Error(privateFailure);
      return quoteFor(request, dry);
    });
    renderFlow(midenAsset, ethereumAsset);
    await setAmountAndReview(mockOriginAddress);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh route' }));

    expect(await screen.findByTestId('one-click-review-error')).toHaveTextContent('oneClickQuoteUnavailable');
    expect(screen.getByTestId('one-click-review-error-id')).toHaveTextContent('oneClickQuoteUnavailable');
    expect(screen.queryByText(privateFailure)).not.toBeInTheDocument();
  });

  it('localizes a native confirmation failure without exposing its exception detail', async () => {
    const privateFailure = 'native protector secret token-93';
    jest.mocked(confirmSensitiveAction).mockRejectedValueOnce(new Error(privateFailure));
    renderFlow(midenAsset, ethereumAsset);
    await setAmountAndReview(mockOriginAddress);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm route' }));

    expect(await screen.findByTestId('one-click-review-error')).toHaveTextContent('oneClickSubmitFailed');
    expect(screen.getByTestId('one-click-review-error-id')).toHaveTextContent('oneClickSubmitFailed');
    expect(screen.queryByText(privateFailure)).not.toBeInTheDocument();
    expect(initiateOneClickMidenDeposit).not.toHaveBeenCalled();
  });

  it('localizes an inbound EVM submission failure without exposing its exception detail', async () => {
    const privateFailure = 'private EVM rpc response token-14';
    jest.mocked(submitEvmOneClickDeposit).mockRejectedValueOnce(new Error(privateFailure));
    renderFlow(ethereumAsset, midenAsset);
    await setAmountAndReview();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm route' }));

    expect(await screen.findByTestId('one-click-deposit-instructions')).toHaveTextContent(
      'oneClickSubmitFailed'
    );
    expect(jest.mocked(useUserVisibleError)).toHaveBeenCalledWith('oneClickSubmitFailed', 'notice');
    expect(screen.queryByText(privateFailure)).not.toBeInTheDocument();
  });

  it('localizes a failure after authorized spending-limit challenge without exposing its detail', async () => {
    const privateFailure = 'private authorized submit token-25';
    mockSpendingLimitAssessment = {
      accountId: mockAccountId,
      usdAmount: 2_000_000n,
      revision: 'test-revision',
      assessedAt: 1,
      breach: {
        spent: 2_000_000n,
        proposedTotal: 4_000_000n,
        limit: 3_000_000n,
        overBy: 1_000_000n,
        resetAt: null
      }
    };
    jest.mocked(initiateOneClickMidenDeposit).mockRejectedValueOnce(new Error(privateFailure));
    renderFlow(midenAsset, ethereumAsset);
    await setAmountAndReview(mockOriginAddress);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm route' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Authorize limit' }));

    expect(await screen.findByTestId('one-click-review-error')).toHaveTextContent('oneClickSubmitFailed');
    expect(screen.getByTestId('one-click-review-error-id')).toHaveTextContent('oneClickSubmitFailed');
    expect(screen.queryByText(privateFailure)).not.toBeInTheDocument();
  });

  it('does not report route-selection guidance as an error', async () => {
    const sameMidenAsset: OneClickAsset = { ...midenAsset, coingeckoId: 'usd-coin' };
    const sameEthereumAsset: OneClickAsset = { ...ethereumAsset, coingeckoId: 'usd-coin' };
    render(
      <OneClickFlow
        config={config}
        assets={[sameMidenAsset, sameEthereumAsset]}
        networks={networks.slice(0, 2)}
        offerNetwork={networkFor('miden')}
        requestNetwork={networkFor('eth')}
        midenAddress={mockMidenAddress}
        onBackToSwap={jest.fn()}
      />
    );
    await new Promise(resolve => setTimeout(resolve, 1100));

    expect(jest.mocked(useUserVisibleError).mock.calls.filter(([id]) => id !== null && id !== undefined)).toEqual([]);
  });

  it('requests a signed wet quote, confirms the exact Miden-to-Ethereum route, then queues the ordinary Miden send', async () => {
    renderFlow(midenAsset, ethereumAsset);
    await setAmountAndReview(mockOriginAddress);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm route' }));

    await waitFor(() => expect(initiateOneClickMidenDeposit).toHaveBeenCalledTimes(1));
    expect(confirmSensitiveAction).toHaveBeenCalledTimes(1);
    const calls = jest.mocked(requestOneClickQuote).mock.calls;
    expect(calls.some(([, , dry]) => dry === false)).toBe(true);
  });

  it('persists inbound EVM tracking before transfer and stores the accepted origin hash immediately', async () => {
    renderFlow(ethereumAsset, midenAsset);
    await setAmountAndReview();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm route' }));

    await waitFor(() => expect(recordOneClickOriginTransactionHash).toHaveBeenCalledWith('one-click-row', mockTxHash));
    expect(persistOneClickTrackingRow).toHaveBeenCalledTimes(1);
    expect(submitEvmOneClickDeposit).toHaveBeenCalledTimes(1);
    const persistOrder = jest.mocked(persistOneClickTrackingRow).mock.invocationCallOrder[0];
    const depositOrder = jest.mocked(submitEvmOneClickDeposit).mock.invocationCallOrder[0];
    if (persistOrder === undefined || depositOrder === undefined)
      throw new Error('Expected both inbound route operations');
    expect(persistOrder).toBeLessThan(depositOrder);
  });

  it('keeps the connected WalletConnect session while editing the inbound amount and sends only after confirm', async () => {
    mockEvmConnected = false;
    mockConnectExternal.mockImplementation(async () => {
      mockEvmConnected = true;
    });
    const view = renderFlow(ethereumAsset, midenAsset);
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    view.rerender(
      <OneClickFlow
        config={config}
        assets={[midenAsset, ethereumAsset, manualAsset]}
        networks={networks}
        offerNetwork={networkFor('eth')}
        requestNetwork={networkFor('miden')}
        midenAddress={mockMidenAddress}
        onBackToSwap={jest.fn()}
      />
    );
    expect(screen.getByText(mockOriginAddress)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('amount'), { target: { value: '1.25' } });
    await waitFor(() =>
      expect(
        jest
          .mocked(requestOneClickQuote)
          .mock.calls.some(([, request, dry]) => dry === true && request.amount === '1250000')
      ).toBe(true)
    );
    expect(mockConnectExternal).toHaveBeenCalledTimes(1);
    expect(submitEvmOneClickDeposit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review route' }));
    await screen.findByRole('button', { name: 'Confirm route' });
    expect(submitEvmOneClickDeposit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm route' }));
    await waitFor(() => expect(submitEvmOneClickDeposit).toHaveBeenCalledTimes(1));
    expect(
      jest
        .mocked(requestOneClickQuote)
        .mock.calls.some(([, request, dry]) => dry === false && request.amount === '1250000')
    ).toBe(true);
    expect(mockConnectExternal).toHaveBeenCalledTimes(1);
  });

  it('blocks inbound review when the connected wallet lacks token balance or gas', async () => {
    mockEvmBalanceSnapshot = {
      ...mockEvmBalanceSnapshot,
      tokenSufficient: false,
      gasSufficient: false,
      canDeposit: false
    };
    renderFlow(ethereumAsset, midenAsset);
    fireEvent.change(screen.getByLabelText('amount'), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Review route' })).toBeDisabled();
    expect(submitEvmOneClickDeposit).not.toHaveBeenCalled();
  });

  it('keeps a known EVM broadcast pending and prevents another funding attempt when hash persistence fails', async () => {
    jest
      .mocked(recordOneClickOriginTransactionHash)
      .mockRejectedValueOnce(new Error('database temporarily unavailable'))
      .mockRejectedValueOnce(new Error('database temporarily unavailable'));
    renderFlow(ethereumAsset, midenAsset);
    await setAmountAndReview();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm route' }));

    expect(await screen.findByText('oneClickBroadcastTrackingPending')).toBeInTheDocument();
    expect(screen.getByText(mockTxHash)).toBeInTheDocument();
    expect(submitEvmOneClickDeposit).toHaveBeenCalledTimes(1);
    expect(recordOneClickOriginTransactionHash).toHaveBeenCalledTimes(2);
    expect(useUserVisibleError).toHaveBeenCalledWith('oneClickBroadcastTrackingPending', 'notice');
  });

  it('refreshes an expired outbound quote into review and waits for explicit confirmation', async () => {
    const request: OneClickQuoteRequest = {
      amount: '1000000',
      originAsset: midenAsset,
      destinationAsset: ethereumAsset,
      refundTo: mockMidenAddress,
      recipient: mockOriginAddress,
      deadline: '2000-01-01T00:00:00.000Z',
      slippageTolerance: 100
    };
    const recovery: IOneClickTrackingData = {
      direction: 'miden-to-evm',
      request,
      quote: quoteFor(request, false, true),
      config,
      network: 'mainnet',
      accountId: mockAccountId,
      accountAddress: mockMidenAddress,
      originAsset: midenAsset,
      destinationAsset: ethereumAsset,
      faucetId: midenAsset.faucetId!,
      amount: request.amount,
      phase: 'failed'
    };
    render(
      <OneClickFlow
        config={config}
        assets={[midenAsset, ethereumAsset]}
        networks={networks.slice(0, 2)}
        offerNetwork={networkFor('miden')}
        requestNetwork={networkFor('eth')}
        midenAddress={mockMidenAddress}
        initialRecovery={recovery}
        onBackToSwap={jest.fn()}
      />
    );

    expect(await screen.findByText('Quote refreshed after the previous quote expired')).toBeInTheDocument();
    expect(jest.mocked(requestOneClickQuote).mock.calls.some(([, , dry]) => dry === false)).toBe(true);
    expect(initiateOneClickMidenDeposit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm route' }));
    await waitFor(() => expect(initiateOneClickMidenDeposit).toHaveBeenCalledTimes(1));
  });

  it('requires a manual refund address and shows instructions for a non-EVM origin', async () => {
    renderFlow(manualAsset, midenAsset);
    await setAmountAndReview('manual-refund-address');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm route' }));

    expect(await screen.findByTestId('one-click-deposit-instructions')).toBeInTheDocument();
    expect(submitEvmOneClickDeposit).not.toHaveBeenCalled();
  });

  it('keeps identical provider assets out of 1Click so the existing bridge route handles them', async () => {
    const sameMidenAsset: OneClickAsset = { ...midenAsset, coingeckoId: 'usd-coin' };
    const sameEthereumAsset: OneClickAsset = { ...ethereumAsset, coingeckoId: 'usd-coin' };
    render(
      <OneClickFlow
        config={config}
        assets={[sameMidenAsset, sameEthereumAsset]}
        networks={networks.slice(0, 2)}
        offerNetwork={networkFor('miden')}
        requestNetwork={networkFor('eth')}
        midenAddress={mockMidenAddress}
        onBackToSwap={jest.fn()}
      />
    );
    fireEvent.change(screen.getByLabelText('amount'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('external address'), { target: { value: mockOriginAddress } });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(jest.mocked(requestOneClickQuote)).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Review route' })).toBeDisabled();
  });

  it('refreshes an expired wet quote and does not fund until a second explicit confirmation', async () => {
    nextWetQuoteExpired = true;
    renderFlow(midenAsset, ethereumAsset);
    await setAmountAndReview(mockOriginAddress);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm route' }));

    await waitFor(() =>
      expect(jest.mocked(requestOneClickQuote).mock.calls.filter(([, , dry]) => dry === false)).toHaveLength(2)
    );
    expect(initiateOneClickMidenDeposit).not.toHaveBeenCalled();
  });

  it('ignores duplicate confirmation and invalidates consent when the account changes during biometric approval', async () => {
    let resolveApproval: (confirmed: boolean) => void = () => undefined;
    mockConfirmResult = new Promise(resolve => {
      resolveApproval = resolve;
    });
    const view = renderFlow(midenAsset, ethereumAsset);
    await setAmountAndReview(mockOriginAddress);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm route' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm route' }));
    await waitFor(() => expect(confirmSensitiveAction).toHaveBeenCalledTimes(1));

    mockAccountId = '0x777777777777777777777777777777';
    view.rerender(
      <OneClickFlow
        config={config}
        assets={[midenAsset, ethereumAsset, manualAsset]}
        networks={networks}
        offerNetwork={networkFor('miden')}
        requestNetwork={networkFor('eth')}
        midenAddress={mockMidenAddress}
        onBackToSwap={jest.fn()}
      />
    );
    await act(async () => resolveApproval(true));
    await waitFor(() => expect(initiateOneClickMidenDeposit).not.toHaveBeenCalled());
  });
});
