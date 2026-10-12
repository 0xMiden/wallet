import type { TransactionStepState } from 'screens/generating-transaction/types';

/**
 * The progress of a tracked order (a fiat buy, a fiat sell) whose row keeps one phase and the time of each phase.
 * The buy and the sell status screens share these functions, so that both read a phase the same way.
 */

/** The phases of one kind of order. */
export interface PhaseTrack<P extends string> {
  /** The forward order of the phases. It is also the order of the step rows. `failed` is not in it. */
  phases: readonly P[];
  /** The last phase of `phases`: the order is done. */
  completed: P;
  /** The phase of an order that stopped. It can follow any phase before `completed`. */
  failed: P;
}

/** The part of a row that the progress reads. */
export interface PhaseState<P extends string> {
  phase: P;
  /** First time the row reached each phase, in Unix milliseconds. */
  phaseTimestamps?: Partial<Record<P, number>>;
}

/** True when the order cannot change any more. */
export const isPhaseTerminal = <P extends string>(track: PhaseTrack<P>, phase: P): boolean =>
  phase === track.completed || phase === track.failed;

/**
 * Get the index in `track.phases` of the step that shows as active.
 *
 * A failed order has no index of its own. Its step is the last phase that has a timestamp, because
 * that phase is where the order stopped.
 */
export const phaseActiveIndex = <P extends string>(track: PhaseTrack<P>, state: PhaseState<P>): number => {
  if (state.phase !== track.failed) return Math.max(0, track.phases.indexOf(state.phase));
  let last = 0;
  track.phases.forEach((phase, index) => {
    if (state.phaseTimestamps?.[phase] !== undefined) last = index;
  });
  return last;
};

/**
 * Get the filled part of the progress bar, from 0 to 1.
 *
 * A step that is in progress fills half of its segment. The completed order fills the full bar.
 */
export const phaseProgressFraction = <P extends string>(track: PhaseTrack<P>, state: PhaseState<P>): number => {
  const index = phaseActiveIndex(track, state);
  const segment = state.phase === track.completed ? 1 : 0.5;
  return Math.min(1, (index + segment) / track.phases.length);
};

/** Get the state of the step at `index`. */
export const phaseStepState = <P extends string>(
  track: PhaseTrack<P>,
  state: PhaseState<P>,
  index: number
): TransactionStepState => {
  const active = phaseActiveIndex(track, state);
  if (index < active) return 'complete';
  if (index > active) return 'pending';
  switch (state.phase) {
    case track.completed:
      return 'complete';
    case track.failed:
      return 'failed';
    default:
      return 'active';
  }
};

/**
 * Get the duration of each step in milliseconds, or `undefined` when it is not known.
 *
 * A step starts at its own timestamp. It stops at the next timestamp of a later phase, or at the
 * `failed` timestamp. The active step stops at `now`, so its value increases while the screen is
 * open. The last step (`completed`) has no duration.
 */
export const phaseStepDurationsMs = <P extends string>(
  track: PhaseTrack<P>,
  state: PhaseState<P>,
  now: number
): (number | undefined)[] => {
  const stamps: Partial<Record<P, number>> = state.phaseTimestamps ?? {};
  const active = phaseActiveIndex(track, state);
  return track.phases.map((phase, index) => {
    if (phase === track.completed) return undefined;
    const start = stamps[phase];
    if (start === undefined) return undefined;
    const nextStamp = track.phases
      .slice(index + 1)
      .map(later => stamps[later])
      .find(stamp => stamp !== undefined);
    const inProgress = index === active && !isPhaseTerminal(track, state.phase);
    const end = nextStamp ?? stamps[track.failed] ?? (inProgress ? now : undefined);
    if (end === undefined || end < start) return undefined;
    return end - start;
  });
};
