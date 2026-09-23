import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { initiateBridgedReceiveTransaction } from 'lib/miden/activity';
import { USDCX_FAUCET_ID_HEX, USDCX_STANDIN_RECIPIENT } from 'lib/usdcx/constant';
import { runUsdcxDeposit } from 'lib/usdcx/deposit';

import { EvmBridgeDepositScreen } from './EvmBridgeDepositScreen';

// Covers the USDCx (Circle xReserve) path of the deposit screen: a USDC deposit
// has one route, auto-selected, and confirming it creates a `usdcx` tracking row
// and hands the EVM leg to `runUsdcxDeposit` with the encoded Miden recipient.
// ETH keeps the Fast/Slow picker. The bridge itself is stubbed.

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('@reown/appkit/react', () => ({
  useAppKitProvider: () => ({ walletProvider: { request: jest.fn() } })
}));

jest.mock('wagmi', () => ({
  useWriteContract: () => ({ mutateAsync: jest.fn() })
}));

jest.mock('use-debounce', () => ({
  useDebounce: (value: unknown) => [value]
}));

const epochState = {
  status: 'idle',
  flow: null,
  quote: null,
  error: null,
  quoteEVMToMiden: jest.fn(),
  executeEVMToMiden: jest.fn(),
  poll: jest.fn(),
  reset: jest.fn()
};

jest.mock('lib/epoch', () => ({
  MIDEN_DESTINATION_CHAIN_ID: 1,
  evmToMidenMinTokenOut: (amount: string) => (Number(amount) > 0 ? '1000000' : undefined),
  useEpochStore: (selector: (s: typeof epochState) => unknown) => selector(epochState)
}));

jest.mock('lib/miden/activity', () => ({
  initiateBridgedReceiveTransaction: jest.fn(),
  updateBridgedReceivePhase: jest.fn().mockResolvedValue(undefined)
}));

// The SDK is stubbed globally, so the account id parser is replaced with one
// that returns the guide's first test vector in hex form.
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: () => ({ toString: () => '0xb64e1827414584510723cad8e145a4' })
}));

jest.mock('lib/usdcx/deposit', () => ({
  runUsdcxDeposit: jest.fn().mockResolvedValue(`0x${'2'.repeat(64)}`),
  isUsdcxDomainNotRegisteredError: () => false
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn()
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: () => undefined
}));

jest.mock('lib/walletconnect/native', () => ({
  isNativeReownAvailable: () => false,
  NativeReown: { sendTransaction: jest.fn() },
  unwrapNativeResult: (value: unknown) => value
}));

jest.mock('lib/walletconnect/receipt', () => ({
  waitForSepoliaReceipt: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('lib/walletconnect/config', () => ({
  DEFAULT_CHAIN_ID: 11155111,
  getChain: () => ({ rpcUrl: 'https://rpc.test', name: 'Sepolia' })
}));

jest.mock('./EvmBridgeDepositForm', () => ({
  EvmBridgeDepositForm: ({
    onAmountChange,
    onContinue,
    onSelectToken
  }: {
    onAmountChange: (value?: string) => void;
    onContinue: () => void;
    onSelectToken: () => void;
  }) => (
    <div>
      <button data-testid="set-amount" onClick={() => onAmountChange('1.5')}>
        amount
      </button>
      <button data-testid="open-token-drawer" onClick={onSelectToken}>
        token
      </button>
      <button data-testid="continue" onClick={onContinue}>
        continue
      </button>
    </div>
  )
}));

jest.mock('./EvmBridgeDepositReview', () => ({
  EvmBridgeDepositReview: ({
    onConfirm,
    symbol,
    outputSymbol
  }: {
    onConfirm: () => void;
    symbol: string;
    outputSymbol?: string;
  }) => (
    <div>
      <span data-testid="review-symbols">{`${symbol}->${outputSymbol ?? ''}`}</span>
      <button data-testid="confirm-deposit" onClick={onConfirm}>
        confirm
      </button>
    </div>
  )
}));

jest.mock('./EvmBridgeDepositStatus', () => ({
  EvmBridgeDepositStatus: () => <div data-testid="deposit-status" />
}));

jest.mock('./EvmBridgeTokenDrawer', () => ({
  EvmBridgeTokenDrawer: ({ open, onSelect }: { open: boolean; onSelect: (token: string) => void }) =>
    open ? (
      <div>
        <button data-testid="pick-eth" onClick={() => onSelect('ETH')}>
          ETH
        </button>
        <button data-testid="pick-usdc" onClick={() => onSelect('USDC')}>
          USDC
        </button>
      </div>
    ) : null
}));

jest.mock('./EvmSwitchWalletDrawer', () => ({
  EvmSwitchWalletDrawer: () => null
}));

jest.mock('./EvmBridgeUsdcxRoute', () => ({
  EvmBridgeUsdcxRoute: ({ confirmDisabled, onConfirm }: { confirmDisabled?: boolean; onConfirm: () => void }) => (
    <button data-testid="usdcx-route-confirm" disabled={confirmDisabled} onClick={onConfirm}>
      usdcx
    </button>
  )
}));

jest.mock('screens/send-flow/Route', () => ({
  Route: ({ onConfirm }: { onConfirm: () => void }) => (
    <button data-testid="fast-slow-route-confirm" onClick={onConfirm}>
      fast/slow
    </button>
  )
}));

const midenAccount = { publicKey: 'mtst1azmyuxp8g9zcg5g8y09d3c295s3n6fl4' };

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

const renderScreen = () =>
  render(
    <EvmBridgeDepositScreen
      evmAddress="0x1111111111111111111111111111111111111111"
      midenAccount={midenAccount as never}
      onConnectAnother={jest.fn()}
      onClose={jest.fn()}
    />
  );

/** USDC is the default token: amount, continue, and the route step is up. */
const reachUsdcxRoute = async () => {
  fireEvent.click(screen.getByTestId('set-amount'));
  await settle();
  fireEvent.click(screen.getByTestId('continue'));
  await settle();
};

describe('EvmBridgeDepositScreen USDCx route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(initiateBridgedReceiveTransaction).mockResolvedValue('bridge-tx');
    // balanceOf and isRemoteDomainRegistered reads; a zero word is fine for both.
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ result: `0x${'0'.repeat(64)}` }) }) as never;
  });

  it('offers only the xReserve route for a USDC deposit, already selected', async () => {
    renderScreen();

    await reachUsdcxRoute();

    expect(screen.getByTestId('usdcx-route-confirm')).toBeEnabled();
    expect(screen.queryByTestId('fast-slow-route-confirm')).not.toBeInTheDocument();
  });

  it('shows the Fast/Slow picker again once ETH is chosen', async () => {
    renderScreen();

    fireEvent.click(screen.getByTestId('open-token-drawer'));
    await settle();
    fireEvent.click(screen.getByTestId('pick-eth'));
    await settle();
    await reachUsdcxRoute();

    expect(screen.getByTestId('fast-slow-route-confirm')).toBeInTheDocument();
    expect(screen.queryByTestId('usdcx-route-confirm')).not.toBeInTheDocument();
  });

  it('reviews a USDC deposit as arriving in USDCx', async () => {
    renderScreen();

    await reachUsdcxRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();

    expect(screen.getByTestId('review-symbols')).toHaveTextContent('USDC->USDCx');
  });

  it('creates a usdcx tracking row and runs the EVM leg with the encoded recipient', async () => {
    renderScreen();

    await reachUsdcxRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledTimes(1);
    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'usdcx',
        faucetId: USDCX_FAUCET_ID_HEX,
        amount: 1_500_000n,
        sourceAmount: '1.5',
        sourceSymbol: 'USDC',
        outputAmount: '1.5',
        outputSymbol: 'USDCx'
      })
    );
    expect(runUsdcxDeposit).toHaveBeenCalledTimes(1);
    // While a stand-in domain is configured the deposit goes to its test
    // recipient; otherwise it goes to the encoded Miden account id.
    expect(runUsdcxDeposit).toHaveBeenCalledWith(
      'bridge-tx',
      '1.5',
      USDCX_STANDIN_RECIPIENT ?? '0x00000000000000000000000000000000b64e1827414584510723cad8e145a400',
      expect.objectContaining({
        signer: expect.objectContaining({ approve: expect.any(Function), depositToRemote: expect.any(Function) }),
        isRemoteDomainRegistered: expect.any(Function),
        waitForReceipt: expect.any(Function),
        updatePhase: expect.any(Function)
      })
    );
  });
});
