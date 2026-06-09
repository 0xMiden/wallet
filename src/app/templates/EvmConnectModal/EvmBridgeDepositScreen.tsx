import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppKitProvider } from '@reown/appkit/react';
import classNames from 'clsx';
import CurrencyInput from 'react-currency-input-field';
import { useTranslation } from 'react-i18next';
import { useDebounce } from 'use-debounce';
import { decodeFunctionResult, encodeFunctionData, EIP1193Provider, formatUnits, parseUnits, toHex } from 'viem';
import { useWriteContract } from 'wagmi';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { ScreenHeader } from 'components/ScreenHeader';
import { TokenLogo } from 'components/TokenLogo';
import { AGGLAYER_BRIDGE_ABI, AGGLAYER_CONTRACT_ADDRESS, MIDEN_CHAIN_ID, midenAddrToEvmAddr } from 'lib/agglayer';
import { MIDEN_DESTINATION_CHAIN_ID, useEpochStore } from 'lib/epoch';
import { BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS, BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS } from 'lib/epoch/bridgeable-token';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { WalletAccount } from 'lib/shared/types';
import { DEFAULT_CHAIN_ID, getChain } from 'lib/walletconnect/config';
import { isNativeReownAvailable, NativeReown } from 'lib/walletconnect/native';

import { shortenAddress } from './shared';

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

type BridgeRoute = 'epoch' | 'agglayer';
type BridgeTokenSymbol = 'USDC' | 'ETH';
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

function amountTextSize(value: string): string {
  const len = value.length || 4;
  if (len >= 13) return 'text-3xl';
  if (len >= 10) return 'text-4xl';
  if (len >= 7) return 'text-5xl';
  return 'text-6xl';
}

export const EvmBridgeDepositScreen: React.FC<EvmBridgeDepositScreenProps> = ({
  evmAddress,
  midenAccount,
  onDisconnect,
  onClose
}) => {
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
  const [step, setStep] = useState<'form' | 'confirm'>('form');

  const token = routeToken[route];
  const selectedBalance = route === 'epoch' ? usdcBalance : ethBalance;
  const [debouncedAmount] = useDebounce(route === 'epoch' && isValidAmount(amount) ? amount.trim() : '', 500);

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
      setStep('form');
      setSlowStatus('idle');
      setSlowError(null);
      resetEpoch();
    },
    [resetEpoch, route]
  );

  const handleMax = useCallback(() => {
    if (!selectedBalance.value) return;
    hapticLight();
    setStep('form');
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

  const handleContinue = useCallback(() => {
    if (!canContinue) return;
    hapticMedium();
    setStep('confirm');
  }, [canContinue]);

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

  if (step === 'confirm') {
    return (
      <div className="flex h-full min-h-0 flex-col bg-app-bg text-heading-gray">
        <div className="shrink-0 px-4">
          <ScreenHeader title="Miden Bridge" closeLabel={t('close')} onBack={() => setStep('form')} onClose={onClose} />
        </div>

        <div className="flex flex-1 min-h-0 flex-col px-6 py-6">
          <div className="flex-1 overflow-y-auto">
            <div className="text-center">
              <h2 className="text-[32px] font-semibold leading-tight text-black">Confirm your deposit</h2>
              <p className="mt-2 text-base leading-6 text-text-tertiary-token">
                Your wallet will open to approve the exact amount and sign on Sepolia.
              </p>
            </div>

            <div className="mt-7 rounded-2xl border border-border-light bg-white px-5 py-2">
              <ConfirmRow label="Amount" value={`${amount || '0'} ${token.symbol}`} />
              {route === 'epoch' && receiveLabel && <ConfirmRow label="You receive" value={receiveLabel} />}
              <ConfirmRow label="From" value="Sepolia" />
              <ConfirmRow label="To" value={`Miden · ${midenAccount.name}`} />
              <ConfirmRow label="Bridge option" value={routeLabel} isLast />
            </div>

            <div className="mt-5 rounded-2xl bg-surface-interactive px-6 py-5 text-[#5D3A0B]">
              <p className="text-sm font-bold uppercase tracking-[0.12em]">What you're approving</p>
              <p className="mt-3 text-base leading-6">
                Your wallet will ask to approve {token.symbol} and sign the deposit on Sepolia. Funds arrive on Miden
                after confirmation.
              </p>
            </div>

            {statusMessage && <p className="mt-4 text-center text-sm text-text-tertiary-token">{statusMessage}</p>}
            {error && (
              <div className="mt-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-500" role="alert">
                {error}
              </div>
            )}
          </div>

          <div className="shrink-0 pt-4">
            <Button
              variant={ButtonVariant.Primary}
              onClick={handleConfirm}
              disabled={!canContinue || slowStatus === 'submitted' || epochStatus === 'done'}
              className="w-full"
            >
              {getConfirmLabel(route, epochStatus, epochFlow, slowStatus)}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-bg text-heading-gray">
      <div className="shrink-0 px-6 pt-4">
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border-light bg-white px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-text-tertiary-token">Connected wallet</p>
            <p className="truncate text-sm font-semibold text-heading-gray">{shortenAddress(evmAddress)}</p>
          </div>
          <button
            type="button"
            onClick={onDisconnect}
            className="shrink-0 rounded-xl border border-border-button px-3 py-2 text-sm font-semibold text-heading-gray"
          >
            {t('disconnect')}
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 flex-col px-6 py-6">
        <div className="flex-1 overflow-y-auto">
          <div className="mt-8 text-center">
            <p className="text-lg font-semibold text-heading-gray">Choose Amount</p>
            <CurrencyInput
              value={amount}
              onValueChange={handleAmountChange}
              inputMode="decimal"
              placeholder="0"
              aria-label="Bridge amount"
              className={classNames(
                'mt-5 h-24 w-full bg-transparent p-0 text-center text-[72px] font-semibold leading-none outline-none placeholder:text-grey-300',
                amount ? 'text-heading-gray' : 'text-grey-300',
                amountTextSize(amount)
              )}
              disableGroupSeparators
              decimalSeparator="."
              decimalsLimit={6}
              allowNegativeValue={false}
              maxLength={16}
            />
            <p className="mt-4 text-base text-text-tertiary-token">{subtitle}</p>
          </div>

          <div className="mt-5 flex items-center justify-between rounded-2xl bg-surface-interactive px-5 py-5">
            <div className="flex flex-1 items-center justify-center gap-3">
              <TokenLogo symbol={token.symbol} size="sm" />
              <span className="text-xl font-semibold text-black">{token.symbol}</span>
              <Icon name={IconName.ChevronDown} size="xs" className="text-heading-gray" />
            </div>
            <button
              type="button"
              onClick={handleMax}
              disabled={!selectedBalance.value}
              className="rounded-xl bg-accent-primary px-4 py-2 text-sm font-bold text-pure-white disabled:opacity-50"
            >
              MAX
            </button>
          </div>

          <div className="mt-7">
            <p className="mb-3 text-sm font-semibold text-heading-gray">From chain</p>
            <div className="flex items-center gap-3 rounded-2xl bg-surface-interactive px-5 py-5">
              <TokenLogo symbol="ETH" size="sm" />
              <span className="text-xl font-medium text-heading-gray">Sepolia</span>
            </div>
          </div>

          <div className="mt-7">
            <p className="mb-3 text-sm font-semibold text-heading-gray">Choose bridge option</p>
            <div className="flex flex-col gap-4">
              <RouteOption
                active={route === 'epoch'}
                title="Instant"
                description="In a few minutes - $0.47 fee"
                icon={<Icon name={IconName.ArrowRightDownFill} size="md" />}
                onClick={() => handleRouteChange('epoch')}
              />
              <RouteOption
                active={route === 'agglayer'}
                title="Slow"
                description="Est. 30-90 min - No fee"
                icon={<Icon name={IconName.Time} size="md" />}
                onClick={() => handleRouteChange('agglayer')}
              />
            </div>
          </div>

          {route === 'epoch' && (epochStatus === 'quoting' || receiveLabel) && (
            <p className="mt-4 text-center text-sm font-semibold text-heading-gray">
              {receiveLabel ? `You receive ${receiveLabel}` : 'Getting return quote...'}
            </p>
          )}
          {statusMessage && <p className="mt-4 text-center text-sm text-text-tertiary-token">{statusMessage}</p>}
          {error && (
            <div className="mt-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-500" role="alert">
              {error}
            </div>
          )}
          {selectedBalance.error && (
            <div className="mt-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-500" role="alert">
              {selectedBalance.error}
            </div>
          )}
        </div>

        <div className="shrink-0 pt-4">
          <Button
            variant={ButtonVariant.Primary}
            onClick={handleContinue}
            disabled={!canContinue || slowStatus === 'submitted' || epochStatus === 'done'}
            className="w-full"
          >
            {getContinueLabel(route, epochStatus, epochFlow, slowStatus)}
          </Button>
        </div>
      </div>
    </div>
  );
};

interface RouteOptionProps {
  active: boolean;
  title: string;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
}

const RouteOption: React.FC<RouteOptionProps> = ({ active, title, description, icon, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={classNames(
      'flex w-full items-center gap-5 rounded-2xl border p-5 text-left',
      active
        ? 'border-accent-primary bg-accent-primary text-pure-white'
        : 'border-border-light bg-white text-heading-gray'
    )}
  >
    <span
      className={classNames(
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl',
        active ? 'bg-white text-accent-primary' : 'bg-[#111827] text-[#E4B56D]'
      )}
    >
      {icon}
    </span>
    <span className="min-w-0">
      <span className={classNames('block text-base font-bold leading-none', active ? 'text-pure-white' : 'text-black')}>
        {title}
      </span>
      <span className={classNames('text-sm leading-none', active ? 'text-pure-white' : 'text-text-tertiary-token')}>
        {description}
      </span>
    </span>
  </button>
);

interface ConfirmRowProps {
  label: string;
  value: string;
  isLast?: boolean;
}

const ConfirmRow: React.FC<ConfirmRowProps> = ({ label, value, isLast }) => (
  <div
    className={classNames('flex items-center justify-between gap-4 py-3', !isLast && 'border-b border-border-faint')}
  >
    <span className="min-w-0 text-base text-text-tertiary-token">{label}</span>
    <span className="min-w-0 truncate text-right text-base font-semibold text-black">{value}</span>
  </div>
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
