import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { buildEvmOneClickTransaction } from 'lib/one-click/evm';
import { readOneClickEvmBalance } from 'lib/one-click/evm-balance';
import type { OneClickEvmBalanceSnapshot } from 'lib/one-click/evm-balance';
import type { OneClickAsset } from 'lib/one-click/types';
import { getChain } from 'lib/walletconnect/config';

const REFRESH_INTERVAL_MS = 30_000;
const INPUT_REFRESH_DEBOUNCE_MS = 350;
const ESTIMATE_DESTINATION = '0x0000000000000000000000000000000000000001';

export interface UseOneClickEvmBalanceInput {
  active: boolean;
  submitted?: boolean;
  account?: string;
  asset?: OneClickAsset;
  amountIn?: string;
  depositAddress?: string;
}

export interface UseOneClickEvmBalanceResult {
  status: 'idle' | 'loading' | 'ready' | 'error';
  snapshot?: OneClickEvmBalanceSnapshot;
  error?: string;
  gasSymbol?: string;
  refresh(): Promise<void>;
}

export function useOneClickEvmBalance(input: UseOneClickEvmBalanceInput): UseOneClickEvmBalanceResult {
  const { active, submitted = false, account, asset, amountIn, depositAddress } = input;
  const gasSymbol = asset?.chainId ? getChain(asset.chainId)?.nativeCurrency.symbol : undefined;
  const coreIdentity = useMemo(
    () =>
      JSON.stringify({
        account: account?.toLowerCase(),
        asset: asset && {
          assetId: asset.assetId,
          blockchain: asset.blockchain,
          chainId: asset.chainId,
          contractAddress: asset.contractAddress?.toLowerCase(),
          decimals: asset.decimals
        }
      }),
    [account, asset]
  );
  const identity = useMemo(
    () =>
      JSON.stringify({
        account: account?.toLowerCase(),
        asset: asset && {
          assetId: asset.assetId,
          blockchain: asset.blockchain,
          chainId: asset.chainId,
          contractAddress: asset.contractAddress?.toLowerCase(),
          decimals: asset.decimals
        },
        amountIn,
        depositAddress: depositAddress?.toLowerCase()
      }),
    [account, asset, amountIn, depositAddress]
  );
  const sequence = useRef(0);
  const previousCoreIdentity = useRef<string | undefined>(undefined);
  const [state, setState] = useState<{
    identity: string;
    status: 'idle' | 'loading' | 'ready' | 'error';
    snapshot?: OneClickEvmBalanceSnapshot;
    error?: string;
  }>({
    identity,
    status: 'idle'
  });

  const refresh = useCallback(async () => {
    if (!active || submitted || !account || !asset) {
      setState({ identity, status: 'idle' });
      return;
    }
    const current = ++sequence.current;
    setState({ identity, status: 'loading' });
    try {
      const transaction = amountIn
        ? buildEvmOneClickTransaction(asset, depositAddress ?? ESTIMATE_DESTINATION, amountIn, account)
        : undefined;
      const snapshot = await readOneClickEvmBalance({ asset, account, amountIn, depositAddress, transaction });
      if (current === sequence.current) setState({ identity, status: 'ready', snapshot });
    } catch (error) {
      if (current === sequence.current)
        setState({
          identity,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unable to verify EVM balance'
        });
    }
  }, [active, submitted, account, asset, amountIn, depositAddress, identity]);

  useEffect(() => {
    if (!active || submitted || !account || !asset) {
      sequence.current += 1;
      previousCoreIdentity.current = undefined;
      setState({ identity, status: 'idle' });
      return;
    }
    const identityChanged = previousCoreIdentity.current !== coreIdentity;
    previousCoreIdentity.current = coreIdentity;
    const refreshTimer = identityChanged
      ? undefined
      : window.setTimeout(() => void refresh(), INPUT_REFRESH_DEBOUNCE_MS);
    if (identityChanged) void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      sequence.current += 1;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [active, submitted, account, asset, coreIdentity, identity, refresh]);

  if (!active || submitted || !account || !asset) return { status: 'idle', gasSymbol, refresh };
  if (state.identity !== identity) return { status: 'loading', gasSymbol, refresh };
  return { status: state.status, snapshot: state.snapshot, error: state.error, gasSymbol, refresh };
}
