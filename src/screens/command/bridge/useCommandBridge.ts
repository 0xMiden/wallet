import { useCallback, useEffect, useRef, useState } from 'react';

import { useAppKitNetwork, useDisconnect } from '@reown/appkit/react';
import { isAddress } from 'viem';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import { deriveBridgeRoutes } from 'lib/bridge/catalog';
import { sameAsset } from 'lib/bridge/core/assets';
import type { TransferQuote } from 'lib/bridge/core/quote';
import { assertReviewedBridge, type BridgeReviewContext, type ReviewedTransfer } from 'lib/bridge/core/review';
import { configKey } from 'lib/bridge/core/routes';
import { validateTransferAmount } from 'lib/bridge/core/rules';
import { submitReviewedBridge, walletBridgeBalanceCap } from 'lib/bridge/wallet-submit';
import { quoteBridgeTransfer } from 'lib/bridge/wallet-transport';
import { buildEpochWalletClient, getEvmConnection, switchWebWalletChain } from 'lib/epoch/client';
import { EpochReviewChangedError } from 'lib/epoch/review-error';
import { useAllBalances, useAllTokensBaseMetadata, useMidenContext } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { useQuoteClock } from 'lib/prices/use-quote-clock';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { ensureNativeSessionChain } from 'lib/walletconnect/native';
import { useEvmWalletConnection } from 'lib/walletconnect/useEvmWalletConnection';

import { type CommandDrafts, useCommandDrafts } from '../command-drafts';

export function useCommandBridge() {
  const drafts = useCommandDrafts();
  const account = useWalletStore(state => state.currentAccount);
  const { locked, signTransaction } = useMidenContext();
  const snapshot = useBridgeConfigSnapshot();
  useNativeFeeFaucetId();
  const metadata = useAllTokensBaseMetadata();
  useAllBalances(account?.publicKey ?? '', metadata);
  // Subscribe through the existing balance/price owners; submission rereads these same authoritative snapshots.
  useWalletStore(state => state.balances);
  useWalletStore(state => state.balancesLoading);
  useWalletStore(state => state.balanceReadFailed);
  useWalletStore(state => state.tokenPrices);
  useWalletStore(state => state.tokenPricesStatus);
  const wallet = useEvmWalletConnection();
  const { chainId } = useAppKitNetwork();
  const { disconnect } = useDisconnect();
  const exit = useBackWithFallback();
  const clearDraft = drafts.clearDraft;
  useEffect(() => {
    if (locked) clearDraft('bridge');
  }, [locked, clearDraft]);
  const scope = configKey([account?.publicKey, getEffectiveNetworkName(), getEffectiveRpcUrl(), locked]);
  const [selection, setSelection] = useState<CommandDrafts['bridge']>(
    () =>
      drafts.readDraft('bridge') ?? {
        direction: 'in',
        route: '',
        amount: '',
        externalAccountId: ''
      }
  );
  const selected = useRef(selection);
  const scopeRef = useRef(scope);
  const scopeLifetime = useRef(0);
  const generation = useRef(0);
  const alive = useRef(true);
  const consent = useRef<ReviewedTransfer>();
  const [review, setReview] = useState<ReviewedTransfer>();
  const [quote, setQuote] = useState<TransferQuote | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [operationId, setOperationId] = useState<string>();
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const invalidate = useCallback(() => {
    generation.current++;
    consent.current = undefined;
    setReview(undefined);
    setError(false);
  }, []);
  if (scopeRef.current !== scope) {
    scopeRef.current = scope;
    scopeLifetime.current++;
    selected.current = { direction: 'in', route: '', amount: '', externalAccountId: '' };
    setSelection(selected.current);
    invalidate();
    setQuote(null);
    setOperationId(undefined);
  }
  const lifetimeAtRender = scopeLifetime.current;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      consent.current = undefined;
    };
  }, []);
  const routes = locked
    ? []
    : deriveBridgeRoutes(snapshot).filter(route => route.mode === (selection.direction === 'in' ? 'receive' : 'send'));
  const route =
    routes.find(item => item.id === selection.route) ??
    routes.find(item => !(item.provider === 'epoch' && item.mode === 'receive')) ??
    routes[0];
  const externalAccountId = selection.direction === 'in' ? (wallet.address ?? '') : selection.externalAccountId;
  const context: BridgeReviewContext | undefined =
    route && account && !locked
      ? {
          route,
          amount: selection.amount,
          accounts: { midenAccount: account.publicKey, evmAddress: externalAccountId }
        }
      : undefined;
  const current = useRef(context);
  current.current = context;
  const material = configKey([
    scope,
    route,
    externalAccountId,
    wallet.connected,
    chainId,
    wallet.nativeReown.state?.chainIds
  ]);
  const materialRef = useRef(material);
  if (materialRef.current !== material) {
    materialRef.current = material;
    invalidate();
    setQuote(null);
  }
  const change = (next: Partial<CommandDrafts['bridge']>) => {
    if (!alive.current || scopeLifetime.current !== lifetimeAtRender || locked || pending.current || operationId)
      return;
    invalidate();
    setQuote(null);
    selected.current = { ...selected.current, ...next };
    setSelection(selected.current);
    drafts.writeDraft('bridge', selected.current);
    setRevision(value => value + 1);
  };
  const selectRoute = (id: string) => {
    const next = routes.find(item => item.id === id);
    if (!next) return;
    change({ route: id, amount: route && sameAsset(route.source, next.source) ? selected.current.amount : '' });
  };
  const sourceChain = route && route.recovery.config.supportedEvmChains[route.source.network]?.chainId;
  const sourceReady =
    selection.direction === 'out' ||
    Boolean(
      wallet.connected &&
      wallet.address &&
      sourceChain &&
      (wallet.useNativeReownWallet
        ? wallet.nativeReown.state.chainIds?.includes(sourceChain)
        : Number(chainId) === sourceChain)
    );
  const blocked = route?.provider === 'epoch' && route.mode === 'receive';
  const cap = context
    ? walletBridgeBalanceCap(context.route, context.amount, context.accounts.midenAccount)
    : { status: 'unavailable' };
  const quoteKey = configKey([material, selection.amount, revision]);
  useEffect(() => {
    const abort = new AbortController();
    const original = generation.current;
    const captured = current.current;
    setQuote(null);
    setIsQuoting(false);
    if (!captured || !sourceReady || !isAddress(captured.accounts.evmAddress) || blocked) return;
    try {
      validateTransferAmount(captured.route, captured.amount);
    } catch {
      return;
    }
    setIsQuoting(true);
    void quoteBridgeTransfer({ route: captured.route, amount: captured.amount, ...captured.accounts }, abort.signal)
      .then(
        result => {
          if (!abort.signal.aborted && alive.current && original === generation.current) setQuote(result);
        },
        () => {
          if (!abort.signal.aborted && alive.current && original === generation.current) setError(true);
        }
      )
      .finally(() => {
        if (!abort.signal.aborted && alive.current && original === generation.current) setIsQuoting(false);
      });
    return () => abort.abort();
  }, [quoteKey, sourceReady, blocked]);
  const quoteDeadline =
    quote?.validity.kind === 'time'
      ? quote.validity.expiresAt
      : quote?.kind === 'cctp' && quote.authorization.expiresAt !== undefined
        ? quote.authorization.expiresAt * 1000
        : undefined;
  useQuoteClock(quoteDeadline);
  let canReview = false;
  if (context && sourceReady && !blocked && !isSubmitting && !operationId && cap.status === 'allowed') {
    try {
      assertReviewedBridge({ ...context, quote: quote ?? undefined }, context, Date.now());
      canReview = true;
    } catch {
      /* An incomplete quote or selection is not consent. */
    }
  }
  const reviewTransfer = () => {
    if (!canReview || !current.current || pending.current) return;
    const captured: ReviewedTransfer = structuredClone({ ...current.current, quote: quote ?? undefined });
    try {
      assertReviewedBridge(captured, current.current, Date.now());
    } catch {
      setError(true);
      return;
    }
    consent.current = captured;
    setReview(captured);
  };
  const back = useCallback(() => {
    if (operationId || pending.current) {
      invalidate();
      exit();
      return;
    }
    if (review) invalidate();
    else {
      invalidate();
      exit();
    }
  }, [review, operationId, invalidate, exit]);
  const connectWallet = async () => {
    invalidate();
    try {
      if (wallet.useNativeReownWallet) {
        if (wallet.connected) await wallet.nativeReown.disconnect();
        await wallet.nativeReown.present();
      } else {
        if (wallet.connected) await disconnect();
        const appkit = await import('lib/walletconnect/appkit');
        await appkit.prepareAppKitConnection();
        await appkit.openConnectModal();
      }
    } catch {
      if (alive.current) setError(true);
    }
  };
  const switchSource = async () => {
    const captured = current.current;
    if (!captured || captured.route.mode !== 'receive' || pending.current || operationId) return;
    invalidate();
    const chain = captured.route.recovery.config.supportedEvmChains[captured.route.source.network];
    if (!chain) return;
    try {
      if (wallet.useNativeReownWallet) await ensureNativeSessionChain(wallet.nativeReown.state, chain.chainId);
      else await switchWebWalletChain(chain.chainId);
      if (alive.current) setRevision(value => value + 1);
    } catch {
      if (alive.current) setError(true);
    }
  };
  const submit = async () => {
    const captured = consent.current;
    if (!captured || captured !== review || pending.current || operationId) return;
    const originalGeneration = generation.current;
    const originalScope = scopeRef.current;
    const getContext = (): BridgeReviewContext => {
      const live = current.current;
      const state = useWalletStore.getState();
      const latestRoute = live && deriveBridgeRoutes(getBridgeConfigSnapshot()).find(item => item.id === live.route.id);
      if (
        !alive.current ||
        consent.current !== captured ||
        originalGeneration !== generation.current ||
        scopeRef.current !== originalScope ||
        !live ||
        !latestRoute ||
        state.status === WalletStatus.Locked ||
        state.currentAccount?.publicKey !== live.accounts.midenAccount
      )
        throw new EpochReviewChangedError();
      return { ...live, route: latestRoute };
    };
    pending.current = true;
    setIsSubmitting(true);
    setError(false);
    try {
      const outcome = await submitReviewedBridge(captured, {
        signTransaction,
        guardianProvider: zustandProvider,
        getContext,
        getEvmWallet: async () => {
          const live = getContext();
          const connection = await getEvmConnection();
          getContext();
          const chain = live.route.recovery.config.supportedEvmChains[live.route.source.network];
          if (
            !chain ||
            !connection.address ||
            connection.address.toLowerCase() !== live.accounts.evmAddress.toLowerCase() ||
            (!connection.isNative && connection.chainId !== chain.chainId)
          )
            throw new EpochReviewChangedError();
          return buildEpochWalletClient(`0x${connection.address.slice(2)}`, { chainOverride: chain.chainId });
        },
        onOperation: id => {
          if (alive.current && consent.current === captured) {
            setOperationId(id);
            drafts.clearDraft('bridge');
          }
        }
      });
      if (alive.current && consent.current === captured && outcome.kind === 'rejected') {
        invalidate();
        setError(true);
      }
    } finally {
      pending.current = false;
      if (alive.current) setIsSubmitting(false);
    }
  };
  return {
    ...selection,
    externalAccountId,
    routes,
    route,
    quote,
    review,
    cap,
    error,
    blocked,
    operationId,
    isQuoting,
    isSubmitting,
    canReview,
    sourceReady,
    connected: wallet.connected,
    environment: getEffectiveNetworkName(),
    setAmount: (amount: string) => change({ amount, route: route?.id ?? '' }),
    setExternalAccountId: (externalAccountId: string) => change({ externalAccountId }),
    setDirection: (direction: 'in' | 'out') => change({ direction, route: '', amount: '' }),
    selectRoute,
    reviewTransfer,
    submit,
    back,
    connectWallet,
    switchSource
  };
}
