import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppKitProvider } from '@reown/appkit/react';
import { useTranslation } from 'react-i18next';
import { useDebounce } from 'use-debounce';
import { decodeFunctionResult, encodeFunctionData, EIP1193Provider, formatUnits, parseUnits, toHex } from 'viem';
import { useWriteContract } from 'wagmi';

import { ReceiveStep } from 'app/pages/Receive/steps';
import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { AGGLAYER_BRIDGE_ABI, AGGLAYER_CONTRACT_ADDRESS, MIDEN_CHAIN_ID, midenAddrToEvmAddr } from 'lib/agglayer';
import { MIDEN_DESTINATION_CHAIN_ID, useEpochStore } from 'lib/epoch';
import {
  BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS,
  BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS,
  BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL
} from 'lib/epoch/bridgeable-token';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { WalletAccount } from 'lib/shared/types';
import { DEFAULT_CHAIN_ID, getChain } from 'lib/walletconnect/config';
import { isNativeReownAvailable, NativeReown } from 'lib/walletconnect/native';
import { Route as RouteStep } from 'screens/send-flow/Route';
import { BridgeRoute, UIToken } from 'screens/send-flow/types';

import { EvmBridgeDepositForm } from './EvmBridgeDepositForm';
import { EvmBridgeDepositReview } from './EvmBridgeDepositReview';
import { EvmBridgeTokenDrawer, type DepositToken } from './EvmBridgeTokenDrawer';

const MIDEN_USDC_FAUCET_ID = '0x0a7d175ed63ec5200fb2ced86f6aa5';

/** Native-ETH source token symbol/decimals (the non-USDC deposit option). */
const ETH_SYMBOL = 'ETH';
const ETH_DECIMALS = 18;

const MOCK_USDC_GET_BALANCE_ABI = [
  {
    type: 'function',
    name: 'getBalance',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

type SlowBridgeStatus = 'idle' | 'signing' | 'submitted' | 'failed';

interface BridgeBalance {
  value: bigint | null;
  formatted: string;
  loading: boolean;
  error: string | null;
}

interface EvmBridgeDepositScreenProps {
  evmAddress: string;
  midenAccount: WalletAccount;
  onDisconnect: () => void;
  onClose: () => void;
}

interface RpcResponse {
  result?: unknown;
  error?: { message?: string };
}

const EMPTY_BALANCE: BridgeBalance = { value: null, formatted: '0', loading: true, error: null };

async function rpcRequest(method: string, params: unknown[]): Promise<unknown> {
  const chain = getChain(DEFAULT_CHAIN_ID);
  if (!chain) {
    throw new Error('Sepolia RPC is not configured');
  }

  const response = await fetch(chain.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const payload = (await response.json()) as RpcResponse;
  if (payload.error) {
    throw new Error(payload.error.message ?? `RPC ${method} failed`);
  }
  return payload.result;
}

function formatBalance(value: bigint, decimals: number): string {
  const [whole = '0', rawFraction = ''] = formatUnits(value, decimals).split('.');
  const fraction = rawFraction.slice(0, 4).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

async function readMockUsdcBalance(evmAddress: string): Promise<bigint> {
  const account = evmAddress as `0x${string}`;
  const contract = BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS as `0x${string}`;

  try {
    const data = encodeFunctionData({
      abi: MOCK_USDC_GET_BALANCE_ABI,
      functionName: 'getBalance',
      args: [account]
    });
    const result = await rpcRequest('eth_call', [{ to: contract, data }, 'latest']);
    return decodeFunctionResult({
      abi: MOCK_USDC_GET_BALANCE_ABI,
      functionName: 'getBalance',
      data: result as `0x${string}`
    }) as bigint;
  } catch (err) {
    console.warn('[EvmBridgeDepositScreen] USDC getBalance failed, falling back to balanceOf', err);
    const data = encodeFunctionData({
      abi: ERC20_BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [account]
    });
    const result = await rpcRequest('eth_call', [{ to: contract, data }, 'latest']);
    return decodeFunctionResult({
      abi: ERC20_BALANCE_OF_ABI,
      functionName: 'balanceOf',
      data: result as `0x${string}`
    }) as bigint;
  }
}

async function readEthBalance(evmAddress: string): Promise<bigint> {
  const result = await rpcRequest('eth_getBalance', [evmAddress, 'latest']);
  return BigInt(result as string);
}

function isValidAmount(amount: string): boolean {
  const parsed = Number(amount);
  return Number.isFinite(parsed) && parsed > 0;
}

// Bridge sub-flow steps. These run on a navigator nested inside this screen
// (not the outer Receive navigator) so the manager below stays mounted across
// the amount → route transition and keeps its state (amount, quote, route).
const BRIDGE_ROUTES: Route[] = [
  {
    name: ReceiveStep.ShowBridgePageTakeAmount,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: ReceiveStep.ShowBridgePageRoute,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: ReceiveStep.ShowBridgePageReview,
    animationIn: 'push',
    animationOut: 'pop'
  }
];

const EvmBridgeDepositManager: React.FC<EvmBridgeDepositScreenProps> = ({ evmAddress, midenAccount, onClose }) => {
  const { t } = useTranslation();
  const { navigateTo, goBack, cardStack } = useNavigator();
  const { walletProvider } = useAppKitProvider<EIP1193Provider>('eip155');
  const nativeReownAvailable = isNativeReownAvailable();
  const writeContract = useWriteContract();

  const epochStatus = useEpochStore(s => s.status);
  const epochFlow = useEpochStore(s => s.flow);
  const epochQuote = useEpochStore(s => s.quote);
  const epochError = useEpochStore(s => s.error);
  const quoteEVMToMiden = useEpochStore(s => s.quoteEVMToMiden);
  const executeEVMToMiden = useEpochStore(s => s.executeEVMToMiden);
  const poll = useEpochStore(s => s.poll);
  const resetEpoch = useEpochStore(s => s.reset);

  const [token, setToken] = useState<DepositToken>('USDC');
  const [tokenDrawerOpen, setTokenDrawerOpen] = useState(false);
  const [route, setRoute] = useState<BridgeRoute>('epoch');
  const [amount, setAmount] = useState('');
  const [usdcBalance, setUsdcBalance] = useState<BridgeBalance>(EMPTY_BALANCE);
  const [ethBalance, setEthBalance] = useState<BridgeBalance>(EMPTY_BALANCE);
  const [slowStatus, setSlowStatus] = useState<SlowBridgeStatus>('idle');
  const [slowError, setSlowError] = useState<string | null>(null);

  const selectedBalance = token === 'ETH' ? ethBalance : usdcBalance;
  // Only USDC on the Fast (Epoch) route is quotable today; ETH-fast wraps to WETH
  // (not implemented yet) and Slow (Agglayer) needs no quote.
  const [debouncedAmount] = useDebounce(
    token === 'USDC' && route === 'epoch' && isValidAmount(amount) ? amount.trim() : '',
    500
  );

  useMobileBackHandler(() => {
    if (cardStack.length > 1) {
      goBack();
      return true;
    }
    onClose();
    return true;
  }, [cardStack.length, goBack, onClose]);

  useEffect(() => {
    resetEpoch();
  }, [resetEpoch]);

  useEffect(() => {
    let cancelled = false;

    setUsdcBalance(EMPTY_BALANCE);
    setEthBalance(EMPTY_BALANCE);

    readMockUsdcBalance(evmAddress)
      .then(value => {
        if (cancelled) return;
        setUsdcBalance({
          value,
          formatted: formatBalance(value, BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS),
          loading: false,
          error: null
        });
      })
      .catch(err => {
        if (cancelled) return;
        setUsdcBalance({ value: null, formatted: '0', loading: false, error: errorMessage(err) });
      });

    readEthBalance(evmAddress)
      .then(value => {
        if (cancelled) return;
        setEthBalance({ value, formatted: formatBalance(value, 18), loading: false, error: null });
      })
      .catch(err => {
        if (cancelled) return;
        setEthBalance({ value: null, formatted: '0', loading: false, error: errorMessage(err) });
      });

    return () => {
      cancelled = true;
    };
  }, [evmAddress]);

  useEffect(() => {
    if (route !== 'epoch' || token !== 'USDC') return;
    if (!debouncedAmount) {
      resetEpoch();
      return;
    }

    quoteEVMToMiden(
      {
        sourceChainId: DEFAULT_CHAIN_ID,
        destinationChainId: MIDEN_DESTINATION_CHAIN_ID,
        evmSourceAddress: evmAddress,
        evmTokenAddress: BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS,
        evmAmount: debouncedAmount,
        evmTokenDecimals: BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS,
        midenRecipientId: midenAccount.publicKey,
        midenFaucetId: MIDEN_USDC_FAUCET_ID,
        minTokenOut: '0'
      },
      evmAddress
    ).catch(err => console.error('[EvmBridgeDepositScreen] quote failed', err));
  }, [debouncedAmount, evmAddress, midenAccount.publicKey, quoteEVMToMiden, resetEpoch, route, token]);

  useEffect(() => {
    if (epochStatus !== 'pending' || epochFlow !== 'evm-to-miden') return;
    const id = setInterval(() => {
      poll().catch(err => console.error('[EvmBridgeDepositScreen] poll failed', err));
    }, 3000);
    return () => clearInterval(id);
  }, [epochFlow, epochStatus, poll]);

  const handleAmountChange = useCallback((value?: string) => {
    setAmount(value ?? '');
  }, []);

  const handleTokenSelect = useCallback(
    (next: DepositToken) => {
      setToken(next);
      setTokenDrawerOpen(false);
      resetEpoch();
      setSlowStatus('idle');
      setSlowError(null);
      // USDC can't use the native-only Slow (Agglayer) route — fall back to Fast.
      if (next === 'USDC') setRoute('epoch');
    },
    [resetEpoch]
  );

  const handleRouteChange = useCallback(
    (next: BridgeRoute) => {
      if (next === route) return;
      hapticLight();
      setRoute(next);
      setSlowStatus('idle');
      setSlowError(null);
      resetEpoch();
    },
    [resetEpoch, route]
  );

  const handleSlowBridge = useCallback(async () => {
    if (!isValidAmount(amount)) return;
    if (!nativeReownAvailable && !walletProvider) return;

    hapticMedium();
    setSlowStatus('signing');
    setSlowError(null);

    try {
      const amountInBaseUnits = parseUnits(amount.trim(), 18);
      const contractAddress = AGGLAYER_CONTRACT_ADDRESS.get('sepolia')! as `0x${string}`;
      const args = [
        MIDEN_CHAIN_ID,
        midenAddrToEvmAddr(midenAccount.publicKey),
        amountInBaseUnits,
        '0x0000000000000000000000000000000000000000',
        true,
        '0x'
      ] as const;

      if (nativeReownAvailable) {
        const data = encodeFunctionData({
          abi: AGGLAYER_BRIDGE_ABI,
          functionName: 'bridgeAsset',
          args
        });
        await NativeReown.sendTransaction({
          chainId: DEFAULT_CHAIN_ID,
          from: evmAddress,
          to: contractAddress,
          value: toHex(amountInBaseUnits),
          data
        });
      } else {
        await writeContract.mutateAsync({
          abi: AGGLAYER_BRIDGE_ABI,
          address: contractAddress,
          functionName: 'bridgeAsset',
          args,
          value: amountInBaseUnits
        });
      }

      setSlowStatus('submitted');
    } catch (err) {
      console.error('[EvmBridgeDepositScreen] Agglayer bridge failed', err);
      setSlowError(errorMessage(err));
      setSlowStatus('failed');
    }
  }, [amount, evmAddress, midenAccount.publicKey, nativeReownAvailable, walletProvider, writeContract]);

  const setupReady = isValidAmount(amount);
  const setupToken: UIToken = useMemo(() => {
    if (token === 'ETH') {
      return {
        id: ETH_SYMBOL,
        name: ETH_SYMBOL,
        decimals: ETH_DECIMALS,
        balance: ethBalance.value === null ? 0 : Number(formatUnits(ethBalance.value, ETH_DECIMALS)),
        // No reliable testnet ETH price; fiatPrice 0 keeps the review from showing a bogus ≈USD.
        fiatPrice: 0
      };
    }
    return {
      id: BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS,
      name: BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL,
      decimals: BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS,
      balance:
        usdcBalance.value === null ? 0 : Number(formatUnits(usdcBalance.value, BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS)),
      fiatPrice: 1
    };
  }, [token, ethBalance.value, usdcBalance.value]);

  // Route availability is token-driven: Fast (Epoch) only bridges USDC today
  // (ETH-fast needs WETH wrapping — not built), and Slow (Agglayer) only bridges
  // native ETH on testnet.
  const slowEnabled = token === 'ETH';
  const fastReady =
    route === 'epoch' && token === 'USDC' && epochFlow === 'evm-to-miden' && epochStatus === 'quoted' && !!epochQuote;
  const slowReady = route === 'agglayer' && token === 'ETH' && isValidAmount(amount) && slowStatus !== 'signing';
  const canConfirmRoute = route === 'epoch' ? fastReady : slowReady;
  const fastFeeUsd = useMemo(() => {
    if (!amount || !epochQuote?.quoteResult.tokenOut) return undefined;
    try {
      const input = parseFloat(amount);
      const output = parseFloat(
        formatUnits(BigInt(epochQuote.quoteResult.tokenOut), BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS)
      );
      if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
      return Math.max(0, input - output);
    } catch {
      return undefined;
    }
  }, [amount, epochQuote?.quoteResult.tokenOut]);
  const error = route === 'epoch' && epochFlow === 'evm-to-miden' ? epochError : slowError;

  // Forward-quoted output the recipient receives on Miden, shown on the Review
  // step. Fast (Epoch) reads the solver quote's tokenOut; Slow (Agglayer) bridges
  // the dedicated token 1:1.
  const outputAmount = useMemo(() => {
    if (route === 'agglayer') return isValidAmount(amount) ? amount : undefined;
    const raw = epochQuote?.quoteResult.tokenOut;
    if (raw == null) return undefined;
    try {
      const human = formatUnits(BigInt(String(raw)), BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS);
      const n = Number(human);
      return Number.isFinite(n) ? n.toFixed(2) : human;
    } catch {
      return undefined;
    }
  }, [route, amount, epochQuote?.quoteResult.tokenOut]);

  const networkName = getChain(DEFAULT_CHAIN_ID)?.name ?? '';

  // Route-screen hint below the cards: for USDC explain why Slow is disabled;
  // for ETH+Fast inform that it wraps to WETH (and isn't available yet).
  const routeNotice =
    token === 'USDC' ? t('slowNeedsNativeEth') : route === 'epoch' ? t('fastEthWrapNotice') : undefined;

  // Review-step confirm state: spin while the submit is signing, and block
  // re-submits once it's in flight / done.
  const submitting = route === 'epoch' ? epochStatus === 'signing' : slowStatus === 'signing';
  const submitted =
    route === 'epoch' ? epochStatus === 'pending' || epochStatus === 'done' : slowStatus === 'submitted';
  const reviewCanConfirm = canConfirmRoute && !submitting && !submitted;

  const handleContinue = useCallback(() => {
    if (!setupReady) return;
    hapticMedium();
    navigateTo(ReceiveStep.ShowBridgePageRoute);
  }, [navigateTo, setupReady]);

  // From the Route step: proceed to Review (once the route is confirmable) rather
  // than submitting directly. The Review step's Confirm runs handleConfirm.
  const handleContinueToReview = useCallback(() => {
    if (!canConfirmRoute) return;
    hapticMedium();
    navigateTo(ReceiveStep.ShowBridgePageReview);
  }, [canConfirmRoute, navigateTo]);

  const handleConfirm = useCallback(() => {
    if (!canConfirmRoute) return;
    if (route === 'agglayer') {
      handleSlowBridge();
      return;
    }
    hapticMedium();
    executeEVMToMiden().catch(err => console.error('[EvmBridgeDepositScreen] execute failed', err));
  }, [canConfirmRoute, executeEVMToMiden, handleSlowBridge, route]);

  const renderStep = useCallback(
    (activeRoute: Route) => {
      switch (activeRoute.name) {
        case ReceiveStep.ShowBridgePageReview:
          return (
            <EvmBridgeDepositReview
              amount={amount}
              symbol={token === 'ETH' ? ETH_SYMBOL : BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL}
              fiat={token === 'USDC' ? Number(amount) : undefined}
              route={route}
              outputAmount={outputAmount}
              networkName={networkName}
              youReceiveLoading={route === 'epoch' && epochStatus === 'quoting'}
              isSubmitting={submitting}
              canConfirm={reviewCanConfirm}
              error={error ?? undefined}
              onConfirm={handleConfirm}
              onBack={goBack}
            />
          );
        case ReceiveStep.ShowBridgePageRoute:
          return (
            <RouteStep
              route={route}
              onRouteChange={handleRouteChange}
              fastFeeUsd={fastFeeUsd}
              fastQuoteLoading={route === 'epoch' && epochStatus === 'quoting'}
              slowEnabled={slowEnabled}
              notice={routeNotice}
              confirmDisabled={!canConfirmRoute}
              onConfirm={handleContinueToReview}
            />
          );
        case ReceiveStep.ShowBridgePageTakeAmount:
        default:
          return (
            <EvmBridgeDepositForm
              token={setupToken}
              amount={amount}
              isValidAmount={setupReady}
              error={error ?? selectedBalance.error ?? undefined}
              onAmountChange={handleAmountChange}
              onSelectToken={() => setTokenDrawerOpen(true)}
              onContinue={handleContinue}
            />
          );
      }
    },
    [
      amount,
      error,
      epochStatus,
      fastFeeUsd,
      handleAmountChange,
      handleConfirm,
      handleContinue,
      handleContinueToReview,
      handleRouteChange,
      route,
      token,
      slowEnabled,
      routeNotice,
      canConfirmRoute,
      outputAmount,
      networkName,
      submitting,
      reviewCanConfirm,
      goBack,
      setupToken,
      selectedBalance.error,
      setupReady
    ]
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-app-bg text-heading-gray">
      <Navigator renderRoute={renderStep} />
      <EvmBridgeTokenDrawer
        open={tokenDrawerOpen}
        onOpenChange={setTokenDrawerOpen}
        selected={token}
        ethBalance={ethBalance.formatted}
        usdcBalance={usdcBalance.formatted}
        ethLoading={ethBalance.loading}
        usdcLoading={usdcBalance.loading}
        onSelect={handleTokenSelect}
      />
    </div>
  );
};

export const EvmBridgeDepositScreen: React.FC<EvmBridgeDepositScreenProps> = props => (
  <NavigatorProvider routes={BRIDGE_ROUTES} initialRouteName={ReceiveStep.ShowBridgePageTakeAmount}>
    <EvmBridgeDepositManager {...props} />
  </NavigatorProvider>
);

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const walk = Reflect.get(err, 'walk');
    if (typeof walk === 'function') {
      const root = Reflect.apply(walk, err, []);
      const rootMessage = firstString(root, ['details', 'shortMessage', 'message']);
      if (rootMessage) return rootMessage;
    }

    const message = firstString(err, ['details', 'shortMessage', 'message']);
    if (message) return message;
  }

  return err instanceof Error ? err.message : 'Unknown error';
}

function firstString(source: unknown, keys: string[]): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = Reflect.get(source, key);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}
