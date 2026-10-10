import { useCallback, useEffect, useRef, useState } from 'react';

import { formatUnits, parseUnits } from 'viem';

import { useAccount } from 'lib/miden/front';
import { BackendOrder, getOrder } from 'lib/onramp/buy-api';
import { midenAccountIdToHex, SELL_RELAY_AMOUNT_DIVISOR } from 'lib/onramp/buy-batch';
import { SellSignRefusal, SellSignRefusedError, signSellOrder } from 'lib/onramp/sell-signer';
import { clickPaidButton, readDepositFromWidget, WidgetDeposit } from 'lib/onramp/sell-widget';
import type { TransactionStepState } from 'screens/generating-transaction/types';

/** The time between two backend reads of the order. */
export const SELL_ORDER_POLL_MS = 3_000;
/** The time that the backend has to prepare the relay values. */
export const SELL_PREPARE_TIMEOUT_MS = 5 * 60_000;
/** The time that the relay has to be mined. Transak expires an unpaid order in about an hour. */
export const SELL_RELAY_TIMEOUT_MS = 15 * 60_000;
/** TEMPORARY: the time of the mock bridge-out, until the real USDCx burn is in place. */
export const SELL_MOCK_BRIDGE_MS = 1_500;

/** Circle's USDC on Sepolia has 6 decimals. */
const RELAY_TOKEN_DECIMALS = 6;

/**
 * - `idle`: no sell order. The provider page shows.
 * - `reading`: the order exists; the wallet waits for the widget to name the deposit (its `TRANSAK_WALLET_REDIRECTION`
 *   event, or its deposit page as the fallback) under the visible widget.
 * - `unreadable`: the widget did not name the deposit in time.
 * - `confirm`: the widget is docked under the notification; the user confirms the widget values while the backend
 *   check runs.
 * - `running`: the steps run.
 * - `success` / `failed`: the steps stopped.
 */
export type SellRelayPhase = 'idle' | 'reading' | 'unreadable' | 'confirm' | 'running' | 'success' | 'failed';

/** The backend check of the deposit address that the page showed. */
export type SellBackendCheck = 'pending' | 'verified' | 'mismatch';

export type SellStepId = 'bridge' | 'prepare' | 'relay' | 'paid';

export interface SellStep {
  id: SellStepId;
  state: TransactionStepState;
}

export type SellRelayError =
  | { kind: 'refused'; reason: SellSignRefusal }
  | { kind: 'order'; state: EndedState; message: string | null }
  | { kind: 'timeout' }
  | { kind: 'unexpected' };

export interface SellRelayResult {
  relayTxHash: string | null;
  /**
   * False when the wallet did not find the "Yes, I have paid" button: the user must tap it. Always true when the
   * widget named the deposit in its event, because that widget has no such button.
   */
  paidClicked: boolean;
}

export interface SellRelay {
  phase: SellRelayPhase;
  pageDeposit: WidgetDeposit | null;
  backendCheck: SellBackendCheck;
  steps: SellStep[];
  error: SellRelayError | null;
  result: SellRelayResult | null;
  /** Start the overlay for a sell order that the widget created. */
  start: (orderId: string) => void;
  /**
   * Give the deposit that the widget named in its `TRANSAK_WALLET_REDIRECTION` event. Call it before `start` when the
   * event comes first. It is ignored once the overlay has a deposit.
   */
  offerDeposit: (deposit: WidgetDeposit) => void;
  confirm: () => void;
  /** Stop before the steps run. The widget gets the full screen again. */
  cancel: () => void;
  /** Close the notification after the steps stopped. The widget stays open. */
  dismiss: () => void;
  /** Tell the hook that the widget closed. */
  widgetClosed: () => void;
  /** The mobile back press. Give true when the overlay used it. */
  back: () => boolean;
}

/** Where the deposit came from: the widget's `TRANSAK_WALLET_REDIRECTION` event, or its deposit page. */
type DepositSource = 'event' | 'page';

/** The `paid` step clicks a button of the deposit page. A widget that sent the event draws no such page. */
const stepIds = (source: DepositSource): SellStepId[] => {
  switch (source) {
    case 'event':
      return ['bridge', 'prepare', 'relay'];
    case 'page':
      return ['bridge', 'prepare', 'relay', 'paid'];
  }
};

const pendingSteps = (source: DepositSource = 'page'): SellStep[] =>
  stepIds(source).map(id => ({ id, state: 'pending' }));

/** The backend states in which a sell order stops for good before its relay is mined. */
export type EndedState = 'failed' | 'expired' | 'cancelled';

function endedState(order: BackendOrder): EndedState | null {
  switch (order.state) {
    case 'failed':
    case 'expired':
    case 'cancelled':
      return order.state;
    default:
      return null;
  }
}

type PollOutcome = { kind: 'match'; order: BackendOrder } | { kind: 'ended'; order: BackendOrder; state: EndedState };

/** Thrown when the run stopped (cancel, close or unmount). The flow then sets no state. */
class SellRunStopped extends Error {}

class SellRunTimeout extends Error {}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * TEMPORARY test aid: the USDC amount the test relay sends for `amount`, as the backend scales it
 * (`SELL_RELAY_AMOUNT_DIVISOR`). Null for an amount that is not a decimal number.
 */
export function sellRelayTestAmount(amount: string): string | null {
  try {
    return formatUnits(parseUnits(amount, RELAY_TOKEN_DECIMALS) / SELL_RELAY_AMOUNT_DIVISOR, RELAY_TOKEN_DECIMALS);
  } catch {
    return null;
  }
}

/**
 * The state machine of the Transak sell overlay: read the deposit page, check its address with the backend, then
 * bridge out (mock), sign the relay, wait for the relay and tell Transak that the transfer is paid.
 *
 * Each start makes a new run. A cancel, a close or an unmount ends the run, and each async step checks its run
 * before it sets state, so no state changes after the page closes.
 */
export function useSellRelay(): SellRelay {
  const account = useAccount();
  const [phase, setPhase] = useState<SellRelayPhase>('idle');
  const [pageDeposit, setPageDeposit] = useState<WidgetDeposit | null>(null);
  const [backendCheck, setBackendCheck] = useState<SellBackendCheck>('pending');
  const [steps, setSteps] = useState<SellStep[]>(pendingSteps);
  const [error, setError] = useState<SellRelayError | null>(null);
  const [result, setResult] = useState<SellRelayResult | null>(null);

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
  const depositSource = useRef<DepositSource>('page');
  // The current values for the callbacks, which outlive a render.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const accountRef = useRef(account);
  accountRef.current = account;
  const depositRef = useRef(pageDeposit);
  depositRef.current = pageDeposit;
  const checkRef = useRef(backendCheck);
  checkRef.current = backendCheck;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      run.current += 1;
    };
  }, []);

  const isLive = (token: number) => mounted.current && run.current === token;

  const ensureLive = (token: number) => {
    if (!isLive(token)) throw new SellRunStopped();
  };

  const setStep = (id: SellStepId, state: TransactionStepState) =>
    setSteps(current => current.map(step => (step.id === id ? { ...step, state } : step)));

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
    setSteps(pendingSteps());
    setError(null);
    setResult(null);
  };

  /** Read the order until `accept` takes it or it ends. A failed read is retried at the next poll. */
  const pollOrder = async (
    token: number,
    id: string,
    accept: (order: BackendOrder) => boolean,
    timeoutMs: number
  ): Promise<PollOutcome> => {
    const attempts = Math.ceil(timeoutMs / SELL_ORDER_POLL_MS);
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await wait(SELL_ORDER_POLL_MS);
      ensureLive(token);
      let order: BackendOrder;
      try {
        order = await getOrder(id);
      } catch {
        continue;
      }
      ensureLive(token);
      if (accept(order)) return { kind: 'match', order };
      const ended = endedState(order);
      if (ended !== null) return { kind: 'ended', order, state: ended };
    }
    throw new SellRunTimeout();
  };

  const checkBackendAddress = async (token: number, id: string, deposit: WidgetDeposit) => {
    // Until the backend names an address. The page is the source of truth: a different address keeps Confirm off.
    for (;;) {
      if (!isLive(token)) return;
      try {
        const order = await getOrder(id);
        if (!isLive(token)) return;
        const named = order.depositAddress;
        if (named !== null && named !== undefined) {
          setBackendCheck(named.toLowerCase() === deposit.address.toLowerCase() ? 'verified' : 'mismatch');
          return;
        }
      } catch {
        // Try again at the next poll.
      }
      await wait(SELL_ORDER_POLL_MS);
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
    setSteps(pendingSteps());
    setError(null);
    setResult(null);

    (async () => {
      const deposit = await readDeposit();
      if (!isLive(token)) return;
      // The widget stays open: the page docks it under the notification.
      if (deposit === null) {
        setPhase('unreadable');
        return;
      }
      setPageDeposit(deposit);
      setSteps(pendingSteps(depositSource.current));
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

  const fail = (token: number, step: SellStepId, cause: SellRelayError) => {
    if (!isLive(token)) return;
    setStep(step, 'failed');
    setError(cause);
    setPhase('failed');
  };

  const runSteps = async (token: number, id: string, deposit: WidgetDeposit) => {
    let step: SellStepId = 'bridge';
    try {
      setStep('bridge', 'active');
      // TODO(sell): burn the USDCx here (the real bridge-out to Sepolia through xReserve). This wait is a mock.
      await wait(SELL_MOCK_BRIDGE_MS);
      ensureLive(token);
      setStep('bridge', 'complete');

      step = 'prepare';
      setStep('prepare', 'active');
      const prepared = await pollOrder(
        token,
        id,
        order => order.state === 'awaiting_signature' && order.prepare !== null,
        SELL_PREPARE_TIMEOUT_MS
      );
      if (prepared.kind === 'ended') {
        fail(token, step, { kind: 'order', state: prepared.state, message: prepared.order.error });
        return;
      }
      const { publicKey, evmAddress } = accountRef.current;
      await signSellOrder({
        account: { publicKey, evmAddress: evmAddress ?? '', midenAccountHex: midenAccountIdToHex(publicKey) },
        // The PAGE values, not the backend values: `signSellOrder` refuses a backend that disagrees with them.
        depositAddress: deposit.address,
        cryptoAmount: deposit.amount,
        order: prepared.order
      });
      ensureLive(token);
      setStep('prepare', 'complete');

      step = 'relay';
      setStep('relay', 'active');
      const relayed = await pollOrder(token, id, order => order.state === 'deposited', SELL_RELAY_TIMEOUT_MS);
      if (relayed.kind === 'ended') {
        fail(token, step, { kind: 'order', state: relayed.state, message: relayed.order.error });
        return;
      }
      setStep('relay', 'complete');

      if (depositSource.current === 'event') {
        // The widget has no "Yes, I have paid" button here: Transak finds the deposit on the chain.
        setResult({ relayTxHash: relayed.order.relayTxHash, paidClicked: true });
        setPhase('success');
        return;
      }

      step = 'paid';
      setStep('paid', 'active');
      // Best effort: the relay is mined, so the sale stands even when the click does not land.
      const paidClicked = await clickPaidButton();
      ensureLive(token);
      setStep('paid', 'complete');
      setResult({ relayTxHash: relayed.order.relayTxHash, paidClicked });
      setPhase('success');
    } catch (cause) {
      switch (true) {
        case cause instanceof SellRunStopped:
          return;
        case cause instanceof SellSignRefusedError:
          fail(token, step, { kind: 'refused', reason: cause.reason });
          return;
        case cause instanceof SellRunTimeout:
          fail(token, step, { kind: 'timeout' });
          return;
        default:
          console.warn('[transak]', 'sell relay failed', cause);
          fail(token, step, { kind: 'unexpected' });
      }
    }
  };

  const confirm = useCallback(() => {
    const id = orderId.current;
    const deposit = depositRef.current;
    if (phaseRef.current !== 'confirm' || checkRef.current !== 'verified' || id === null || deposit === null) return;
    const token = run.current;
    setPhase('running');
    runSteps(token, id, deposit);
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
    switch (phaseRef.current) {
      case 'success':
      case 'failed':
        reset();
        return;
      default:
        return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const widgetClosed = useCallback(() => {
    // Only the read stops. A run that signed goes on: the relay and its result still matter.
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
      case 'running':
        // The steps cannot stop after the signature. Stay on the overlay.
        return true;
      case 'success':
      case 'failed':
        dismiss();
        return true;
    }
  }, [cancel, dismiss]);

  return {
    phase,
    pageDeposit,
    backendCheck,
    steps,
    error,
    result,
    start,
    offerDeposit,
    confirm,
    cancel,
    dismiss,
    widgetClosed,
    back
  };
}
