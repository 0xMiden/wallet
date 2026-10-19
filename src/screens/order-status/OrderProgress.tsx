import React, { useEffect, useState } from 'react';

import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { ACCENT_CLASSES, FlowAccent } from 'components/flow/accent';
import { springs, useMotion, usePreset } from 'lib/animation';
import { cn } from 'lib/ui/util';
import { TransactionStepRow } from 'screens/generating-transaction/components';

import {
  isPhaseTerminal,
  phaseActiveIndex,
  phaseProgressFraction,
  phaseStepDurationsMs,
  phaseStepState,
  PhaseState,
  PhaseTrack
} from './phase-progress';

const TICK_MS = 1_000;
const MINUTE_MS = 60_000;

/** Give the current time, and update it each second while `ticking` is true. */
export const useNow = (ticking: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
};

interface OrderProgressProps<P extends string> {
  track: PhaseTrack<P>;
  state: PhaseState<P>;
  accent: FlowAccent;
  /** The prefix of the test ids: `<prefix>-progress`, `<prefix>-progress-fill`, `<prefix>-progress-pulse`. */
  testIdPrefix: string;
}

/**
 * The progress of an order as one bar with one segment for each step.
 *
 * The fill moves with a spring when the phase changes. While a step is in progress, its half
 * segment pulses. Under reduced motion the fill moves instantly and the pulse does not run.
 * A failed order shows the fill in the negative colour.
 */
export const OrderProgressBar = <P extends string>({ track, state, accent, testIdPrefix }: OrderProgressProps<P>) => {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const fillTransition = useMotion(springs.standard);
  const pulse = usePreset('pulse');
  const fraction = phaseProgressFraction(track, state);
  const index = phaseActiveIndex(track, state);
  const failed = state.phase === track.failed;
  const inProgress = !isPhaseTerminal(track, state.phase);
  // The share of the fill that is the active half segment.
  const activeShare = inProgress ? 0.5 / (index + 0.5) : 0;
  const total = track.phases.length;

  return (
    <div className="flex w-full flex-col gap-2">
      <div
        role="progressbar"
        aria-label={t('buyStatusProgressLabel')}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={state.phase === track.completed ? total : index}
        aria-valuetext={t('buyStatusStepOf', { current: index + 1, total })}
        className="relative h-2 w-full overflow-hidden rounded-full bg-fill"
        data-testid={`${testIdPrefix}-progress`}
        data-progress={fraction.toFixed(4)}
      >
        <motion.div
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            failed ? 'bg-status-negative' : ACCENT_CLASSES[accent].bg
          )}
          initial={false}
          animate={{ width: `${fraction * 100}%` }}
          transition={fillTransition}
          data-testid={`${testIdPrefix}-progress-fill`}
          data-failed={failed}
        >
          {inProgress && !reduceMotion && (
            <motion.span
              aria-hidden="true"
              className="absolute inset-y-0 right-0 bg-page"
              style={{ width: `${activeShare * 100}%` }}
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 0.45, 0] }}
              transition={pulse.transition}
              data-testid={`${testIdPrefix}-progress-pulse`}
            />
          )}
        </motion.div>
        {/* Hairlines between the segments, so the bar reads as one segment for each step. */}
        {track.phases.slice(1).map((phase, i) => (
          <span
            key={phase}
            aria-hidden="true"
            className="absolute inset-y-0 w-0.5 bg-page"
            style={{ left: `${((i + 1) / total) * 100}%` }}
          />
        ))}
      </div>
      <p className="text-center text-caption text-muted" aria-hidden="true">
        {t('buyStatusStepOf', { current: index + 1, total })}
      </p>
    </div>
  );
};

interface OrderStepsProps<P extends string> {
  track: PhaseTrack<P>;
  state: PhaseState<P>;
  accent: FlowAccent;
  /** The i18n key of the step row of a phase. */
  labelKeyOf: (phase: P) => string;
  /** The current time, from `useNow`: the active step counts up to it. */
  now: number;
}

/** The step rows of an order, one for each phase, each with the time it took. */
export const OrderSteps = <P extends string>({ track, state, accent, labelKeyOf, now }: OrderStepsProps<P>) => {
  const { t } = useTranslation();
  const durations = phaseStepDurationsMs(track, state, now);

  const durationLabel = (ms: number | undefined): string | undefined => {
    if (ms === undefined) return undefined;
    if (ms < MINUTE_MS) return t('transactionStepDurationSec', { seconds: Math.round(ms / 1000) });
    return t('buyStepDurationMin', { minutes: Math.floor(ms / MINUTE_MS) });
  };

  return (
    <div className="w-full overflow-hidden rounded-2xl bg-fill">
      {track.phases.map((phase, index) => {
        const stepState = phaseStepState(track, state, index);
        const labelKey = labelKeyOf(phase);
        return (
          <TransactionStepRow
            key={phase}
            step={{ id: phase, labelKey, defaultLabel: labelKey }}
            label={t(labelKey)}
            state={stepState}
            accent={accent}
            isLast={index === track.phases.length - 1}
            meta={stepState === 'pending' ? undefined : durationLabel(durations[index])}
          />
        );
      })}
    </div>
  );
};
