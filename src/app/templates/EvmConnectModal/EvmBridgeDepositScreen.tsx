import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppKitProvider } from '@reown/appkit/react';
import { useTranslation } from 'react-i18next';
import { useDebounce } from 'use-debounce';
import { decodeFunctionResult, encodeFunctionData, EIP1193Provider, formatUnits, parseUnits, toHex } from 'viem';
import { useWriteContract } from 'wagmi';

import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { AGGLAYER_BRIDGE_ABI, AGGLAYER_CONTRACT_ADDRESS, MIDEN_CHAIN_ID, midenAddrToEvmAddr } from 'lib/agglayer';
import { MIDEN_DESTINATION_CHAIN_ID, useEpochStore } from 'lib/epoch';
import { BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS, BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS } from 'lib/epoch/bridgeable-token';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { WalletAccount } from 'lib/shared/types';
import { DEFAULT_CHAIN_ID, getChain } from 'lib/walletconnect/config';
import { isNativeReownAvailable, NativeReown } from 'lib/walletconnect/native';

import { EvmBridgeDepositConfirm } from './EvmBridgeDepositConfirm';
import { BridgeRoute, EvmBridgeDepositForm } from './EvmBridgeDepositForm';

const MIDEN_USDC_FAUCET_ID = '0x0a7d175ed63ec5200fb2ced86f6aa5';
const MIDEN_USDC_FAUCET_DECIMALS = 6;

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

type BridgeTokenSymbol = 'USDC' | 'ETH';
type SlowBridgeStatus = 'idle' | 'signing' | 'submitted' | 'failed';
enum EvmBridgeDepositStep {
  Form = 'form',
  Confirm = 'confirm'
}

const ROUTES: Route[] = [
  {
    name: EvmBridgeDepositStep.Form,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: EvmBridgeDepositStep.Confirm,
    animationIn: 'push',
    animationOut: 'pop'
  }
];

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

const routeToken: Record<BridgeRoute, { symbol: BridgeTokenSymbol; decimals: number; address?: string }> = {
  epoch: {
    symbol: 'USDC',
    decimals: BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS,
    address: BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS
  },
  agglayer: { symbol: 'ETH', decimals: 18 }
};

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

function formatQuoteAmount(raw: string | undefined, decimals: number): string | null {
  if (!raw || raw === '0') return null;
  try {
    const human = /^\d+\.\d+$/.test(raw) ? raw : formatUnits(BigInt(raw), decimals);
    const [whole = '0', rawFraction = ''] = human.split('.');
    const fraction = rawFraction.slice(0, decimals).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
  } catch {
    return raw;
  }
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

const EvmBridgeDepositManager: React.FC<EvmBridgeDepositScreenProps> = ({
  evmAddress,
  midenAccount,
  onDisconnect,
  onClose
}) => {
  const { navigateTo, goBack, cardStack } = useNavigator();
  const { t } = useTranslation();
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

  const [route, setRoute] = useState<BridgeRoute>('epoch');
  const [amount, setAmount] = useState('');
  const [usdcBalance, setUsdcBalance] = useState<BridgeBalance>(EMPTY_BALANCE);
  const [ethBalance, setEthBalance] = useState<BridgeBalance>(EMPTY_BALANCE);
  const [slowStatus, setSlowStatus] = useState<SlowBridgeStatus>('idle');
  const [slowError, setSlowError] = useState<string | null>(null);

  const token = routeToken[route];
  const selectedBalance = route === 'epoch' ? usdcBalance : ethBalance;
  const [debouncedAmount] = useDebounce(route === 'epoch' && isValidAmount(amount) ? amount.trim() : '', 500);

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
    if (route !== 'epoch') return;
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
  }, [debouncedAmount, evmAddress, midenAccount.publicKey, quoteEVMToMiden, resetEpoch, route]);

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

  const handleMax = useCallback(() => {
    if (!selectedBalance.value) return;
    hapticLight();
    setAmount(formatUnits(selectedBalance.value, token.decimals));
  }, [selectedBalance.value, token.decimals]);

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

  const fastReady = route === 'epoch' && epochFlow === 'evm-to-miden' && epochStatus === 'quoted' && !!epochQuote;
  const slowReady = route === 'agglayer' && isValidAmount(amount) && slowStatus !== 'signing';
  const canContinue = route === 'epoch' ? fastReady : slowReady;
  const statusMessage = getStatusMessage(route, epochStatus, epochFlow, slowStatus);
  const error = route === 'epoch' && epochFlow === 'evm-to-miden' ? epochError : slowError;
  const routeLabel = route === 'epoch' ? 'Instant' : 'Slow';
  const epochReturnAmount = useMemo(() => {
    if (route !== 'epoch' || epochFlow !== 'evm-to-miden') return null;
    return formatQuoteAmount(String(epochQuote?.quoteResult.tokenOut ?? ''), MIDEN_USDC_FAUCET_DECIMALS);
  }, [epochFlow, epochQuote?.quoteResult.tokenOut, route]);
  const receiveLabel = epochReturnAmount ? `~${epochReturnAmount} USDC` : null;
  const quoteHint =
    route === 'epoch' && (epochStatus === 'quoting' || receiveLabel)
      ? receiveLabel
        ? `You receive ${receiveLabel}`
        : 'Getting return quote...'
      : null;

  const handleContinue = useCallback(() => {
    if (!canContinue) return;
    hapticMedium();
    navigateTo(EvmBridgeDepositStep.Confirm);
  }, [canContinue, navigateTo]);

  const handleConfirm = useCallback(() => {
    if (!canContinue) return;
    if (route === 'agglayer') {
      handleSlowBridge();
      return;
    }
    hapticMedium();
    executeEVMToMiden().catch(err => console.error('[EvmBridgeDepositScreen] execute failed', err));
  }, [canContinue, executeEVMToMiden, handleSlowBridge, route]);

  const subtitle = useMemo(
    () =>
      selectedBalance.loading
        ? `~ $0.00 - Loading ${token.symbol} balance`
        : `~ $0.00 - Available ${selectedBalance.formatted} ${token.symbol}`,
    [selectedBalance.formatted, selectedBalance.loading, token.symbol]
  );

  const renderStep = useCallback(
    (activeRoute: Route) => {
      switch (activeRoute.name) {
        case EvmBridgeDepositStep.Confirm:
          return (
            <EvmBridgeDepositConfirm
              amount={amount}
              tokenSymbol={token.symbol}
              midenAccountName={midenAccount.name}
              routeLabel={routeLabel}
              receiveLabel={receiveLabel}
              statusMessage={statusMessage}
              error={error}
              confirmLabel={getConfirmLabel(route, epochStatus, epochFlow, slowStatus)}
              confirmDisabled={!canContinue || slowStatus === 'submitted' || epochStatus === 'done'}
              closeLabel={t('close')}
              onBack={goBack}
              onClose={onClose}
              onConfirm={handleConfirm}
            />
          );
        case EvmBridgeDepositStep.Form:
        default:
          return (
            <EvmBridgeDepositForm
              evmAddress={evmAddress}
              amount={amount}
              tokenSymbol={token.symbol}
              subtitle={subtitle}
              route={route}
              quoteHint={quoteHint}
              statusMessage={statusMessage}
              error={error}
              balanceError={selectedBalance.error}
              maxDisabled={!selectedBalance.value}
              continueLabel={getContinueLabel(route, epochStatus, epochFlow, slowStatus)}
              continueDisabled={!canContinue || slowStatus === 'submitted' || epochStatus === 'done'}
              closeLabel={t('close')}
              disconnectLabel={t('disconnect')}
              onAmountChange={handleAmountChange}
              onMax={handleMax}
              onRouteChange={handleRouteChange}
              onContinue={handleContinue}
              onDisconnect={onDisconnect}
              onClose={onClose}
            />
          );
      }
    },
    [
      amount,
      canContinue,
      error,
      epochFlow,
      epochStatus,
      evmAddress,
      goBack,
      handleAmountChange,
      handleConfirm,
      handleContinue,
      handleMax,
      handleRouteChange,
      midenAccount.name,
      onClose,
      onDisconnect,
      quoteHint,
      receiveLabel,
      route,
      routeLabel,
      selectedBalance.error,
      selectedBalance.value,
      slowStatus,
      statusMessage,
      subtitle,
      t,
      token.symbol
    ]
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-app-bg text-heading-gray">
      <Navigator renderRoute={renderStep} />
    </div>
  );
};

export const EvmBridgeDepositScreen: React.FC<EvmBridgeDepositScreenProps> = props => (
  <NavigatorProvider routes={ROUTES} initialRouteName={EvmBridgeDepositStep.Form}>
    <EvmBridgeDepositManager {...props} />
  </NavigatorProvider>
);

function getStatusMessage(
  route: BridgeRoute,
  epochStatus: ReturnType<typeof useEpochStore.getState>['status'],
  epochFlow: ReturnType<typeof useEpochStore.getState>['flow'],
  slowStatus: SlowBridgeStatus
): string | null {
  if (route === 'agglayer') {
    if (slowStatus === 'signing') return 'Approve the bridge in your wallet.';
    if (slowStatus === 'submitted') return 'Bridge submitted. Track progress in Activity.';
    return null;
  }

  if (epochFlow !== 'evm-to-miden') return null;
  if (epochStatus === 'quoting') return 'Getting quote...';
  if (epochStatus === 'signing') return 'Approve the bridge in your wallet.';
  if (epochStatus === 'pending') return 'Bridge in progress...';
  if (epochStatus === 'done') return 'Bridge complete.';
  return null;
}

function getContinueLabel(
  route: BridgeRoute,
  epochStatus: ReturnType<typeof useEpochStore.getState>['status'],
  epochFlow: ReturnType<typeof useEpochStore.getState>['flow'],
  slowStatus: SlowBridgeStatus
): string {
  if (route === 'agglayer') {
    if (slowStatus === 'signing') return 'Approving...';
    if (slowStatus === 'submitted') return 'Submitted';
    return 'Continue';
  }

  if (epochFlow === 'evm-to-miden') {
    if (epochStatus === 'quoting') return 'Getting quote...';
    if (epochStatus === 'signing') return 'Approving...';
    if (epochStatus === 'pending') return 'Bridging...';
    if (epochStatus === 'done') return 'Done';
  }
  return 'Continue';
}

function getConfirmLabel(
  route: BridgeRoute,
  epochStatus: ReturnType<typeof useEpochStore.getState>['status'],
  epochFlow: ReturnType<typeof useEpochStore.getState>['flow'],
  slowStatus: SlowBridgeStatus
): string {
  if (route === 'agglayer') {
    if (slowStatus === 'signing') return 'Approving...';
    if (slowStatus === 'submitted') return 'Submitted';
    return 'Confirm & Bridge';
  }

  if (epochFlow === 'evm-to-miden') {
    if (epochStatus === 'signing') return 'Approving...';
    if (epochStatus === 'pending') return 'Bridging...';
    if (epochStatus === 'done') return 'Done';
  }
  return 'Confirm & Bridge';
}

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
