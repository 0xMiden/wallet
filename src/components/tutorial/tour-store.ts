import { create } from 'zustand';

import { holdAutoConsumeForTutorial, releaseTutorialAutoConsumeHold } from 'lib/settings/helpers';

/**
 * The tour's step sequence:
 *   balance    → spotlight the balance card (Next)
 *   fund       → spotlight the Fund-now action; after the tap, a waiting card
 *                until the faucet's MIDEN note lands in claimable notes
 *   notes      → explainer: what notes are + that MIDEN gas normally
 *                auto-claims (paused once for this walkthrough) (Next)
 *   go-claim   → spotlight the pending-notes prompt card (user taps through)
 *   claim      → on /pending-notes, spotlight Claim All
 *   await-return → claim running (generating-transaction screen); tour hidden
 *   finish     → back home, spotlight the updated balance (Done)
 */
export type TourStep = 'balance' | 'fund' | 'notes' | 'go-claim' | 'claim' | 'await-return' | 'finish';

interface TourState {
  status: 'idle' | 'active';
  step: TourStep;
  fundStarted: boolean;
  start: () => void;
  setStep: (step: TourStep) => void;
  notifyFundStarted: () => void;
  end: () => void;
}

export const useTourStore = create<TourState>(set => ({
  status: 'idle',
  step: 'balance',
  fundStarted: false,
  start: () => set({ status: 'active', step: 'balance', fundStarted: false }),
  setStep: step => {
    // The hold must be in place BEFORE the faucet call can be made — the
    // auto-consume consumers react to the first claimable-notes tick that
    // contains the note — so entering the fund step (not the tap) arms it.
    // Released as soon as the manual claim starts; the TTL heals a tour that
    // dies mid-way.
    if (step === 'fund') holdAutoConsumeForTutorial();
    if (step === 'await-return') releaseTutorialAutoConsumeHold();
    set({ step });
  },
  notifyFundStarted: () => set(state => (state.status === 'active' ? { fundStarted: true } : state)),
  end: () => {
    releaseTutorialAutoConsumeHold();
    set({ status: 'idle', step: 'balance', fundStarted: false });
  }
}));

export function startTutorialTour() {
  useTourStore.getState().start();
}

/** Called by HomePrompts when the Fund-now action fires; no-op when idle. */
export function notifyTutorialFundStarted() {
  useTourStore.getState().notifyFundStarted();
}
