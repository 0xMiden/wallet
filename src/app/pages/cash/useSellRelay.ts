import { useCallback, useEffect, useRef, useState } from 'react';

import { isEvmAddress } from 'lib/epoch/evm-address';
import { requestSWTransactionProcessing, startBackgroundTransactionProcessing } from 'lib/miden/activity';
import {
  SellEndedState,
  SELL_START_POLL_MS,
  setSellPaidClick,
  SellStartError,
  SellStartFailure,
  startSellOrder
} from 'lib/miden/activity/sell-order';
import type { ISellDepositSource } from 'lib/miden/db/types';
import { useAccount, useMidenContext } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { getOrder } from 'lib/onramp/buy-api';
import { SELL_RELAY_TOKEN, SellSignRefusal } from 'lib/onramp/sell-signer';
import { resolveSellToken, SellTokenBlock, SellTokenResolution } from 'lib/onramp/sell-token';
import { keepWidgetForPaidClick, readDepositFromWidget, settleKeptWidget, WidgetDeposit } from 'lib/onramp/sell-widget';
import { isExtension } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';

/**
 * - `idle`: no sell order. The provider page shows.
 * - `reading`: the order exists; the wallet waits for the widget to name the deposit (its `TRANSAK_WALLET_REDIRECTION`
 *   event, or its deposit page as the fallback) under the visible widget.
 * - `unreadable`: the widget did not name the deposit in time.
 * - `confirm`: the user approves the deposit while the backend check and the token check run.
 * - `starting`: the wallet signs the relay and queues the bridge-out. When that is done, the status page opens and
 *   the tracking row owns the progress.
 * - `failed`: the sale did not start. Nothing left the wallet.
 */
export type SellRelayPhase = 'idle' | 'reading' | 'unreadable' | 'confirm' | 'starting' | 'failed';

/** The backend check of the deposit address that the widget named. */
export type SellBackendCheck = 'pending' | 'verified' | 'mismatch';

/** The check of the token to sell: in progress, ready, or the reason the sale cannot start. */
export type SellTokenCheck = { kind: 'pending' } | { kind: 'ready' } | { kind: 'blocked'; reason: SellTokenBlock };

export type SellRelayError =
  | { kind: 'refused'; reason: SellSignRefusal }
  | { kind: 'order'; state: SellEndedState; message: string | null }
  | { kind: 'timeout' }
  | { kind: 'bridge'; message: string }
  | { kind: 'unexpected' };

export interface SellRelay {
  phase: SellRelayPhase;
  pageDeposit: WidgetDeposit | null;
  backendCheck: SellBackendCheck;
  tokenCheck: SellTokenCheck;
  /** The symbol of the Miden token that the sale really sends. */
  tokenSymbol: string;
  /** Unix seconds at which Transak expires the unpaid order, when the backend gave it. */
  expiresAt: number | null;
  error: SellRelayError | null;
  /** True when Confirm can start the sale. */
  canConfirm: boolean;
  /** Start the overlay for a sell order that the widget created. */
  start: (orderId: string) => void;
  /**
   * Give the deposit that the widget named in its `TRANSAK_WALLET_REDIRECTION` event. Call it before `start` when the
   * event comes first. It is ignored once the overlay has a deposit.
   */
  offerDeposit: (deposit: WidgetDeposit) => void;
  confirm: () => void;
  /** Stop before the sale starts. The widget gets the full screen again. */
  cancel: () => void;
  /** Close the notification after a failed start. */
  dismiss: () => void;
  /** Tell the hook that the widget closed. */
  widgetClosed: () => void;
  /** The mobile back press. Give true when the overlay used it. */
  back: () => boolean;
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function errorOf(failure: SellStartFailure): SellRelayError | null {
  switch (failure.kind) {
    case 'stopped':
      return null;
    case 'refused':
      return { kind: 'refused', reason: failure.reason };
    case 'order':
      return { kind: 'order', state: failure.state, message: failure.message };
    case 'timeout':
      return { kind: 'timeout' };
    case 'bridge':
      return { kind: 'bridge', message: failure.message };
  }
}

const tokenCheckOf = (resolution: SellTokenResolution | null): SellTokenCheck => {
  switch (resolution?.kind) {
    case undefined:
      return { kind: 'pending' };
    case 'ready':
      return { kind: 'ready' };
    case 'blocked':
      return { kind: 'blocked', reason: resolution.reason };
  }
};

const symbolOf = (resolution: SellTokenResolution | null): string => {
  switch (resolution?.kind) {
    case undefined:
      return SELL_RELAY_TOKEN.symbol;
    case 'ready':
      return resolution.token.symbol;
    case 'blocked':
      return resolution.symbol;
  }
};

/**
 * The state machine of the Transak sell overlay: take the deposit that the widget names, check its address with the
 * backend and find the token to sell, then on Confirm hand the sale to `startSellOrder` and open its status page.
 * From there the sale is a tracked row (`SellOrderWatcher`), not state of this hook.
 *
 * Each start makes a new run. A cancel, a close or an unmount ends the run, and each async step checks its run
 * before it sets state, so no state changes after the page closes.
 */
export function useSellRelay(): SellRelay {
  const account = useAccount();
  const { signTransaction } = useMidenContext();
  const balances = useWalletStore(state => state.balances[account.publicKey]);
  const [phase, setPhaseState] = useState<SellRelayPhase>('idle');
  const [pageDeposit, setPageDeposit] = useState<WidgetDeposit | null>(null);
  const [backendCheck, setBackendCheck] = useState<SellBackendCheck>('pending');
  const [resolution, setResolution] = useState<SellTokenResolution | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<SellRelayError | null>(null);

  const mounted = useRef(true);
  const run = useRef(0);
  const orderId = useRef<string | null>(null);
  // The deposit the widget event named, until a read takes it.
  const offeredDeposit = useRef<WidgetDeposit | null>(null);
  // Set while a read waits: an offer settles the read at once.
  const takeOffer = useRef<((deposit: WidgetDeposit) => void) | null>(null);
  // The page read of the run, stopped by an offer or a reset.
  const pageRead = useRef<AbortController | null>(null);
  // Where the deposit of the run came from.
  const depositSource = useRef<ISellDepositSource>('page');
  // The phase, written in the same call that sets the state: a widget callback can come before the next render.
  const phaseRef = useRef<SellRelayPhase>('idle');
  // The current values for the callbacks, which outlive a render.
  const accountRef = useRef(account);
  accountRef.current = account;
  const signRef = useRef(signTransaction);
  signRef.current = signTransaction;
  const depositRef = useRef(pageDeposit);
  depositRef.current = pageDeposit;
  const checkRef = useRef(backendCheck);
  checkRef.current = backendCheck;
  const resolutionRef = useRef(resolution);
  resolutionRef.current = resolution;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      run.current += 1;
    };
  }, []);

  const isLive = (token: number) => mounted.current && run.current === token;

  const setPhase = (next: SellRelayPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  };

  const reset = () => {
    run.current += 1;
    orderId.current = null;
    offeredDeposit.current = null;
    takeOffer.current = null;
    pageRead.current?.abort();
    pageRead.current = null;
    setPhase('idle');
    setPageDeposit(null);
    setBackendCheck('pending');
    setResolution(null);
    setExpiresAt(null);
    setError(null);
  };

  const checkBackendAddress = async (token: number, id: string, deposit: WidgetDeposit) => {
    // Until the backend names an address. The widget is the source of truth: a different address keeps Confirm off.
    for (;;) {
      if (!isLive(token)) return;
      try {
        const order = await getOrder(id);
        if (!isLive(token)) return;
        if (typeof order.autoExpiresAt === 'number') setExpiresAt(order.autoExpiresAt);
        const named = order.depositAddress;
        if (named !== null && named !== undefined) {
          setBackendCheck(named.toLowerCase() === deposit.address.toLowerCase() ? 'verified' : 'mismatch');
          return;
        }
      } catch {
        // Try again at the next poll.
      }
      await wait(SELL_START_POLL_MS);
    }
  };

  /**
   * The deposit the widget names: the one its event offered, or the first of a later offer and the page read. The
   * page read stops when an offer wins.
   */
  const readDeposit = (): Promise<WidgetDeposit | null> => {
    const offered = offeredDeposit.current;
    if (offered !== null) {
      depositSource.current = 'event';
      return Promise.resolve(offered);
    }
    depositSource.current = 'page';
    return new Promise(resolve => {
      let settled = false;
      const controller = new AbortController();
      pageRead.current = controller;
      const take = (deposit: WidgetDeposit) => {
        if (settled) return;
        settled = true;
        takeOffer.current = null;
        depositSource.current = 'event';
        controller.abort();
        resolve(deposit);
      };
      takeOffer.current = take;
      readDepositFromWidget({ signal: controller.signal }).then(fromPage => {
        if (settled) return;
        settled = true;
        if (takeOffer.current === take) takeOffer.current = null;
        resolve(fromPage);
      });
    });
  };

  const start = useCallback((id: string) => {
    if (phaseRef.current !== 'idle') return;
    run.current += 1;
    const token = run.current;
    orderId.current = id;
    setPhase('reading');
    setPageDeposit(null);
    setBackendCheck('pending');
    setResolution(null);
    setExpiresAt(null);
    setError(null);

    (async () => {
      const deposit = await readDeposit();
      if (!isLive(token)) return;
      if (deposit === null) {
        setPhase('unreadable');
        return;
      }
      depositRef.current = deposit;
      setPageDeposit(deposit);
      setPhase('confirm');
      await checkBackendAddress(token, id, deposit);
    })();
    // The callbacks read refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const offerDeposit = useCallback((deposit: WidgetDeposit) => {
    switch (phaseRef.current) {
      case 'idle':
      case 'reading': {
        // A read that waits takes the offer now. Else the next `start` takes it.
        const take = takeOffer.current;
        if (take !== null) {
          take(deposit);
          return;
        }
        offeredDeposit.current = deposit;
        return;
      }
      default:
        return;
    }
  }, []);

  // Find the token to sell while the user reads the card, and again when the balances change.
  const cryptoAmount = pageDeposit?.amount;
  useEffect(() => {
    if (phase !== 'confirm' || cryptoAmount === undefined) return;
    const token = run.current;
    let stale = false;
    resolveSellToken({ cryptoAmount, balances: balances ?? [] })
      .then(result => {
        if (!stale && isLive(token)) setResolution(result);
      })
      .catch(cause => {
        console.warn('[transak]', 'sell token check failed', cause);
        if (stale || !isLive(token)) return;
        setResolution({ kind: 'blocked', reason: 'unavailable', symbol: SELL_RELAY_TOKEN.symbol });
      });
    return () => {
      stale = true;
    };
    // `isLive` reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, cryptoAmount, balances]);

  const kickTransactions = () => {
    if (isExtension()) {
      requestSWTransactionProcessing();
      return;
    }
    startBackgroundTransactionProcessing(signRef.current, false, zustandProvider);
  };

  const confirm = useCallback(() => {
    const id = orderId.current;
    const deposit = depositRef.current;
    const resolved = resolutionRef.current;
    const { publicKey, evmAddress } = accountRef.current;
    if (
      phaseRef.current !== 'confirm' ||
      checkRef.current !== 'verified' ||
      resolved?.kind !== 'ready' ||
      id === null ||
      deposit === null ||
      !isEvmAddress(evmAddress)
    ) {
      return;
    }
    const token = run.current;
    const source = depositSource.current;
    setPhase('starting');

    (async () => {
      try {
        const txId = await startSellOrder({
          account: { publicKey, evmAddress },
          orderId: id,
          deposit,
          depositSource: source,
          token: resolved.token,
          guardianProvider: zustandProvider,
          kickTransactions,
          isLive: () => isLive(token)
        });
        // The sale is a tracked row from here, also when this page closed in the meantime.
        // A widget that drew its deposit page stays open, hidden, for its "Yes, I have paid" click after the relay.
        if (source === 'page') {
          setSellPaidClick(settleKeptWidget);
          await keepWidgetForPaidClick(id);
        }
        if (!isLive(token)) return;
        navigate(`/sell-status/${encodeURIComponent(txId)}`);
        reset();
      } catch (cause) {
        if (!isLive(token)) return;
        const unexpected: SellRelayError = { kind: 'unexpected' };
        const failure = cause instanceof SellStartError ? errorOf(cause.failure) : unexpected;
        if (!(cause instanceof SellStartError)) console.warn('[transak]', 'sell start failed', cause);
        if (failure === null) return;
        setError(failure);
        setPhase('failed');
      }
    })();
    // The callbacks read refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = useCallback(() => {
    switch (phaseRef.current) {
      case 'confirm':
      case 'unreadable':
        reset();
        return;
      default:
        return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = useCallback(() => {
    if (phaseRef.current === 'failed') reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const widgetClosed = useCallback(() => {
    // Only the read stops. An approval goes on: the wallet closes the widget itself after its event.
    if (phaseRef.current === 'reading') reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const back = useCallback((): boolean => {
    switch (phaseRef.current) {
      case 'idle':
      case 'reading':
        return false;
      case 'confirm':
      case 'unreadable':
        cancel();
        return true;
      case 'starting':
        // The start cannot stop after the signature. Stay on the overlay.
        return true;
      case 'failed':
        dismiss();
        return true;
    }
  }, [cancel, dismiss]);

  const tokenCheck = tokenCheckOf(resolution);

  return {
    phase,
    pageDeposit,
    backendCheck,
    tokenCheck,
    tokenSymbol: symbolOf(resolution),
    expiresAt,
    error,
    canConfirm: phase === 'confirm' && backendCheck === 'verified' && tokenCheck.kind === 'ready',
    start,
    offerDeposit,
    confirm,
    cancel,
    dismiss,
    widgetClosed,
    back
  };
}
