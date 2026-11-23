import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';

import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import type { SwapPairs } from '../../../src/lib/remote-config/swap-pairs';
import { TEST_CONSUME_AUTHORIZATION_KEY } from '../../../src/lib/miden/sdk/test-consume-authorization';
import { TEST_SEND_AUTHORIZATION_KEY } from '../../../src/lib/miden/sdk/test-send-authorization';
import { nightlyAmount, type ObserveNightly } from '../reporting/nightly-observation';
import {
  walletCanarySourceFromEnvironment,
  writeWalletCanaryReport,
  type WalletCanaryObservation,
  type WalletCanarySlot,
  type WalletCanarySource
} from '../reporting/wallet-canary-report';
import {
  saveMainnetSwapCheckpoint,
  type MainnetSwapCheckpoint,
  type SavedSwapHolding,
  type SwapOrderEvidence
} from './mainnet-swap-checkpoint';
import type { MainnetSwapBalances } from './mainnet-swap-claim';
import { realizedSwapLoss } from './mainnet-swap-plan';
import { readLiveSwapLeg } from './mainnet-swap-ui';
import { MainnetWalletCanaryLedger, type CanarySlot } from './mainnet-wallet-canary-ledger';
import {
  CanaryBudgetError,
  CanaryQuoteError,
  canaryHolding,
  canaryInteger,
  canarySlotEnd,
  planCanarySwap
} from './mainnet-wallet-canary-plan';
import { setAutoConsume } from './test-dapp';

export type CanaryBrowser = {
  checkpointPath: string;
  slotEnd: number;
  save: (state: MainnetSwapCheckpoint) => void;
  beforeRelease: (state: MainnetSwapCheckpoint) => void;
  beforeSpend: () => void;
  observe: ObserveNightly;
  unspent: () => void;
  markPartialFill: () => void;
  markPaybackTimeout: () => void;
};

type CanarySwapBrowser = {
  registry: (wallet: GuardianAwareWalletPage) => Promise<{
    service: string;
    tokens: SavedSwapHolding[];
    native: SavedSwapHolding;
    baseFee: bigint;
    pairs: SwapPairs['pairs'];
    prices: { pricesUpdatedAt: string };
  }>;
  evidence: (wallet: GuardianAwareWalletPage) => Promise<{ orders: SwapOrderEvidence[] }>;
  submit: (
    wallet: GuardianAwareWalletPage,
    state: MainnetSwapCheckpoint,
    leg: 'forward',
    control: CanaryBrowser
  ) => Promise<unknown>;
  settle: (
    wallet: GuardianAwareWalletPage,
    state: MainnetSwapCheckpoint,
    leg: 'forward',
    control: CanaryBrowser
  ) => Promise<{
    refunded: bigint;
    fees: bigint;
    now: MainnetSwapBalances;
  }>;
};

type CanaryMode = 'canary' | 'canary-recover';

export function isCanaryMode(mode: string | undefined): mode is CanaryMode {
  return mode === 'canary' || mode === 'canary-recover';
}

function canaryReport(
  target: string,
  source: WalletCanarySource,
  state: CanarySlot,
  observedBefore: CanarySlot['observed'] = {}
) {
  if (!state.runId || !state.runAttempt || !state.lineageId || state.status === 'missed') return;
  const recovered = state.runId !== source.runId || state.runAttempt !== source.runAttempt;
  const observations: WalletCanaryObservation[] = [];
  if (!recovered && state.admittedAt) observations.push({ stage: 'admission', at: state.admittedAt });
  for (const [stage, at] of Object.entries(state.observed)) {
    if (
      at &&
      stage !== 'approval' &&
      (!recovered ||
        (stage !== 'authorization_released' && at !== observedBefore[stage as keyof CanarySlot['observed']]))
    ) {
      observations.push({ stage: stage as WalletCanaryObservation['stage'], at });
    }
  }
  observations.sort((left, right) => left.at.localeCompare(right.at));
  const status = state.status === 'cancelled' ? (state.submittedAt ? 'submitted' : 'blocked') : state.status;
  let reason: WalletCanarySlot['reason'] = null;
  if (status === 'blocked') {
    reason =
      state.reason === 'busy_wallet' || state.reason === 'budget_exhausted' || state.reason === 'quote_unavailable'
        ? state.reason
        : 'confirmed_not_submitted';
  } else if (status === 'unknown' && state.reason === 'submission_unconfirmed') {
    reason = state.reason;
  }
  const checkpoint = state.checkpoint;
  const offered = checkpoint && nightlyAmount(checkpoint.offer, BigInt(checkpoint.principal));
  const minimum =
    checkpoint &&
    nightlyAmount(
      checkpoint.request,
      BigInt(checkpoint.forwardRequestAuthority?.minimumReceive ?? checkpoint.forwardMinimum)
    );
  writeWalletCanaryReport(target, {
    source,
    original: {
      runId: state.runId,
      runAttempt: state.runAttempt,
      slotStart: state.slotStart,
      lineageId: state.lineageId
    },
    slot: {
      slotStart: state.slotStart,
      status,
      reason,
      admittedAt: state.admittedAt ?? null,
      submittedAt: state.submittedAt ?? null,
      usableReceiptAt: state.usableReceiptAt ?? null,
      claimMode: state.admittedAt ? 'manual' : null,
      runId: state.runId,
      runAttempt: state.runAttempt
    },
    observations,
    pair: offered && minimum ? { offered: offered.asset, requested: minimum.asset } : null,
    terms:
      offered && minimum
        ? {
            offeredBaseUnits: offered.baseUnits,
            minimumBaseUnits: minimum.baseUnits,
            offeredDecimals: offered.decimals,
            requestedDecimals: minimum.decimals
          }
        : null
  });
}

function canaryObserver(ledger: MainnetWalletCanaryLedger, slot: string): ObserveNightly {
  return (outcome, stage) => {
    if (stage?.status !== 'passed') return;
    if (outcome?.outcome === 'authorization_released') ledger.recordObservation(slot, 'authorization_released');
    if (stage.key === 'inclusion' && stage.origin === 'sdk_read') {
      // The RPC verified the exact original order under a canonical header.
      ledger.recordSubmission(slot);
      ledger.recordObservation(slot, 'inclusion');
    }
    if (stage.key === 'payback') ledger.recordObservation(slot, 'payback');
    if (outcome?.outcome === 'fully_filled') ledger.recordObservation(slot, 'full_fill');
    if (stage.key === 'claim') ledger.recordObservation(slot, 'claim');
  };
}

export async function closeCanaryWalletGates(page: Pick<Page, 'evaluate'>, state?: MainnetSwapCheckpoint) {
  const fingerprint = (authority?: { nonce?: string; noteId: string; sha256: string; canonicalSha256: string }) =>
    authority && {
      nonce: authority.nonce,
      noteId: authority.noteId,
      sha256: authority.sha256,
      canonicalSha256: authority.canonicalSha256
    };
  await page.evaluate(
    async gates => {
      const keys = gates.flatMap(({ key }) => [key, `${key}_required`]);
      const stored = await chrome.storage.local.get(keys);
      for (const { key, expected } of gates) {
        const marker = stored[`${key}_required`];
        const held = stored[key];
        const blocked = marker?.status === 'blocked' && Object.keys(marker).length === 1;
        if (held === undefined && (marker === undefined || blocked)) continue;
        const belongsToGate =
          typeof held?.accountId === 'string' &&
          typeof held?.nonce === 'string' &&
          (blocked || (marker?.accountId === held.accountId && marker?.nonce === held.nonce));
        const matchesCheckpoint =
          expected && Object.entries(expected).every(([field, value]) => held?.[field] === value);
        // A held request without a recorded release intent cannot have reached the signing gate.
        const safeToClose = expected
          ? matchesCheckpoint && ['waiting', 'released', 'spent'].includes(held?.status)
          : ['armed', 'waiting'].includes(held?.status);
        if (!belongsToGate || !safeToClose) throw new Error('Wallet canary profile has an unexplained authorization');
      }
      await chrome.storage.local.set(
        Object.fromEntries(gates.map(({ key }) => [`${key}_required`, { status: 'blocked' }]))
      );
      await chrome.storage.local.remove(gates.map(({ key }) => key));
    },
    [
      { key: TEST_SEND_AUTHORIZATION_KEY, expected: fingerprint(state?.forwardRequestAuthority) },
      { key: TEST_CONSUME_AUTHORIZATION_KEY, expected: fingerprint(state?.forwardClaimAuthority) }
    ]
  );
}

async function openCanaryWallet(wallet: GuardianAwareWalletPage, account: string, state?: MainnetSwapCheckpoint) {
  await closeCanaryWalletGates(wallet.page, state);
  const unlock = wallet.page.getByTestId('unlock-password');
  const home = wallet.page.getByTestId('command-shell');
  await home.or(unlock).first().waitFor({ timeout: 90_000 });
  if (await unlock.isVisible()) await wallet.unlockWallet();
  if ((await wallet.getAccountAddress()) !== account) throw new Error('Unexpected wallet canary account');
  await setAutoConsume(wallet, false);
  await wallet.triggerSync(true);
}

export async function runCanary(wallet: GuardianAwareWalletPage, mode: CanaryMode, swap: CanarySwapBrowser) {
  const env = process.env;
  const slot = env.MAINNET_CANARY_SLOT;
  const directory = env.MAINNET_CANARY_STATE_DIR;
  const checkpointPath = env.MAINNET_CANARY_CHECKPOINT_PATH;
  const reportDirectory = env.MAINNET_CANARY_REPORT_DIR;
  const account = env.MAINNET_CANARY_ACCOUNT;
  if (
    env.MAINNET_CANARY_LOCK_HELD !== 'true' ||
    !slot ||
    !directory ||
    !checkpointPath ||
    !reportDirectory ||
    !account ||
    !env.MAINNET_SWAP_SDK_GATE ||
    env.GITHUB_RUN_ATTEMPT !== '1' ||
    !env.E2E_WALLET_B_PROFILE ||
    resolve(env.E2E_WALLET_B_PROFILE) !== join(resolve(directory), 'profile')
  ) {
    throw new Error('Wallet canary requires its dedicated locked runner and private profile');
  }
  const source = walletCanarySourceFromEnvironment();
  const slotEnd = canarySlotEnd(slot);
  const maxPrincipal = canaryInteger(env.MAINNET_CANARY_MAX_PRINCIPAL_USD_MICROS, 'canary principal ceiling');
  const ledger = new MainnetWalletCanaryLedger({
    directory,
    account,
    dailyFeeBaseUnits: canaryInteger(env.MAINNET_CANARY_DAILY_FEE_BASE_UNITS, 'daily canary fee ceiling'),
    dailyLossUsdMicros: canaryInteger(env.MAINNET_CANARY_DAILY_LOSS_USD_MICROS, 'daily canary loss ceiling'),
    maxPrincipalUsdMicros: maxPrincipal
  });
  const observe = canaryObserver(ledger, slot);
  const snapshot = (state: MainnetSwapCheckpoint) => saveMainnetSwapCheckpoint(checkpointPath, state);
  const browser: CanaryBrowser = {
    checkpointPath,
    slotEnd,
    observe,
    beforeSpend: () => {
      if (Date.now() >= slotEnd) throw new Error('Canary slot expired before authorization');
    },
    save: state => {
      state.updatedAt = new Date().toISOString();
      ledger.saveCheckpoint(slot, state);
      snapshot(state);
    },
    beforeRelease: state => {
      state.updatedAt = new Date().toISOString();
      ledger.armSend(slot, state);
      snapshot(state);
    },
    unspent: () => ledger.abortBeforeSend(slot, 'preflight_failed'),
    markPartialFill: () => ledger.recordObservation(slot, 'partial_fill'),
    markPaybackTimeout: () => ledger.recordObservation(slot, 'timed_out')
  };
  let observedBefore: CanarySlot['observed'] = {};
  let recoveryAccepted = false;
  try {
    ledger.advance();
    const prior = ledger.get(slot);
    let state: MainnetSwapCheckpoint;
    if (mode === 'canary-recover') {
      if (!prior || ledger.active()?.slotStart !== slot || prior.runId === source.runId)
        throw new Error('Canary recovery needs the original open slot and a distinct run');
      recoveryAccepted = true;
      observedBefore = prior.observed;
      if (prior.status === 'admitted') {
        ledger.abortBeforeSend(slot, 'confirmed_not_submitted');
        return;
      }
      if (!prior.checkpoint?.forwardRequestAuthority) throw new Error('Missing exact original canary authorization');
      state = prior.checkpoint;
      await openCanaryWallet(wallet, account, state);
    } else {
      if (prior || Date.now() < slotEnd - 300_000 || Date.now() >= slotEnd) return;
      if (ledger.active()) {
        ledger.recordRunnerBusy(slot, source.runId, source.runAttempt);
        return;
      }
      try {
        const offerFaucet = env.MAINNET_CANARY_OFFER_FAUCET;
        const requestFaucet = env.MAINNET_CANARY_REQUEST_FAUCET;
        if (!offerFaucet || !requestFaucet || offerFaucet === requestFaucet)
          throw new Error('Canary requires one explicit direction');
        const principal = canaryInteger(env.MAINNET_CANARY_PRINCIPAL_BASE_UNITS, 'canary principal');
        await openCanaryWallet(wallet, account);
        const live = await swap.registry(wallet);
        const offer = live.tokens.find(token => token.hex === offerFaucet);
        const request = live.tokens.find(token => token.hex === requestFaucet);
        if (
          !offer ||
          !request ||
          !live.pairs.some(pair => pair.faucetIds.includes(offer.hex) && pair.faucetIds.includes(request.hex))
        )
          throw new Error('Selected canary direction is not in the wallet solver registry');
        const plan = planCanarySwap({
          account,
          runId: source.runId,
          offer,
          request,
          native: live.native,
          principal,
          baseFee: live.baseFee,
          pricedAt: live.prices.pricesUpdatedAt,
          now: Date.now(),
          maxPrincipalUsdMicros: maxPrincipal,
          maxFeeBaseUnits: canaryInteger(env.MAINNET_CANARY_MAX_ORDER_FEE_BASE_UNITS, 'canary fee ceiling'),
          maxLossUsdMicros: canaryInteger(env.MAINNET_CANARY_MAX_ORDER_LOSS_USD_MICROS, 'canary loss ceiling')
        });
        const admission = ledger.admit({
          slotStart: slot,
          runId: source.runId,
          runAttempt: source.runAttempt,
          offerFaucetId: offer.hex,
          requestFaucetId: request.hex,
          principalBaseUnits: principal,
          principalUsdMicros: plan.principalUsdMicros,
          feeReserveBaseUnits: plan.feeReserveBaseUnits,
          lossReserveUsdMicros: plan.lossReserveUsdMicros
        });
        if (admission.kind !== 'admitted') return;
        const quoted = await readLiveSwapLeg(live.service, offer, request, principal, observe).catch(error => {
          ledger.abortBeforeSend(slot, 'quote_unavailable');
          throw error;
        });
        try {
          const known = await swap.evidence(wallet);
          state = plan.checkpoint(
            quoted.minimumReceive,
            known.orders.map(row => row.orderId)
          );
          browser.save(state);
        } catch (error) {
          ledger.abortBeforeSend(slot, error instanceof CanaryQuoteError ? 'quote_unavailable' : 'preflight_failed');
          throw error;
        }
        await swap.submit(wallet, state, 'forward', browser);
      } catch (error) {
        if (!ledger.get(slot)) {
          const reason =
            error instanceof CanaryBudgetError
              ? 'budget_exhausted'
              : error instanceof CanaryQuoteError
                ? 'quote_unavailable'
                : 'preflight_failed';
          ledger.recordPreflightBlock({ slotStart: slot, runId: source.runId, runAttempt: source.runAttempt, reason });
        }
        throw error;
      }
    }

    const result = await swap.settle(wallet, state, 'forward', browser);
    const loss = realizedSwapLoss([
      { before: canaryHolding(state.offer), after: result.now.offer },
      { before: canaryHolding(state.request), after: result.now.request },
      { before: canaryHolding(state.native), after: result.now.native }
    ]);
    const costs = { feeBaseUnits: result.fees, lossUsdMicros: loss };
    await closeCanaryWalletGates(wallet.page, state);
    if (result.refunded > 0n) ledger.finishCancellation(slot, costs, 'reclaimed');
    else ledger.finishReceipt(slot, costs);
  } finally {
    try {
      const state = ledger.get(slot);
      if (state && (mode === 'canary' ? state.runId === source.runId : recoveryAccepted))
        canaryReport(reportDirectory, source, state, observedBefore);
    } finally {
      ledger.close();
    }
  }
}
