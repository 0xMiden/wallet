import React from 'react';

import classNames from 'clsx';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { ACCENT_CLASSES } from 'components/flow/accent';
import { FlowSpinner } from 'components/flow/FlowSpinner';
import { easings, springs, useMotion } from 'lib/animation';

import { PENDING_STEP_COLOR } from './constants';
import type {
  StatusIndicatorProps,
  TransactionHeroIconProps,
  TransactionHeroIconSize,
  TransactionStepRowProps
} from './types';

// The check/cross glyphs keep the same 44x44 viewBox at every size and scale by width/height
// alone, so the stroke stays proportional without a second path per size.
const HERO_ICON_BOX_CLASS: Record<TransactionHeroIconSize, string> = { 64: 'size-16', 96: 'size-24' };
const HERO_ICON_GLYPH_SIZE: Record<TransactionHeroIconSize, number> = { 64: 30, 96: 44 };
const HERO_ICON_SPINNER_SIZE: Record<TransactionHeroIconSize, number> = { 64: 35, 96: 52 };

export const TransactionHeroIcon: React.FC<TransactionHeroIconProps> = ({ state, accent = 'brand', size = 64 }) => {
  const reduceMotion = useReducedMotion();
  const entranceTransition = useMotion(springs.standard);
  const glyphTransition = useMotion({ duration: 0.32, ease: easings.easeOutCubic });
  const glyphSize = HERO_ICON_GLYPH_SIZE[size];

  return (
    // shrink-0: the hero sits in a scrolling flex column, which squashed a fixed-size circle into
    // a pill on a short screen.
    <div className={classNames('relative flex shrink-0 items-center justify-center', HERO_ICON_BOX_CLASS[size])}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={state}
          className={classNames(
            'absolute inset-0 flex items-center justify-center rounded-full',
            state === 'processing' && ACCENT_CLASSES[accent].tint,
            state === 'success' && 'bg-status-positive',
            state === 'failed' && 'bg-status-negative'
          )}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 1.04 }}
          transition={entranceTransition}
        >
          {state === 'processing' && (
            <FlowSpinner accent={accent} size={HERO_ICON_SPINNER_SIZE[size]} thickness={0.13} />
          )}
          {state === 'success' && (
            <svg width={glyphSize} height={glyphSize} viewBox="0 0 44 44" fill="none" aria-hidden="true">
              <motion.path
                d="M11 23L18.5 30.5L33 15"
                stroke="white"
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={reduceMotion ? undefined : { pathLength: 0 }}
                animate={reduceMotion ? undefined : { pathLength: 1 }}
                transition={glyphTransition}
              />
            </svg>
          )}
          {state === 'failed' && (
            <svg width={glyphSize} height={glyphSize} viewBox="0 0 44 44" fill="none" aria-hidden="true">
              <path d="M15 15L29 29M29 15L15 29" stroke="white" strokeWidth="5" strokeLinecap="round" />
            </svg>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
};

const StatusIndicator: React.FC<StatusIndicatorProps> = ({ state, accent = 'brand' }) => {
  const glyphTransition = useMotion({ duration: 0.28, ease: easings.easeInCubic });

  return (
    <span className="relative flex size-5 shrink-0 items-center justify-center">
      <AnimatePresence initial={false}>
        {state === 'complete' && (
          <motion.span
            key="complete"
            className="absolute inset-0 flex items-center justify-center rounded-full bg-status-positive"
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={glyphTransition}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M2.25 5.1L4.1 6.9L7.75 3.1"
                stroke="white"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </motion.span>
        )}
        {state === 'active' && (
          <motion.span
            key="active"
            className="absolute inset-0 flex items-center justify-center rounded-full"
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={glyphTransition}
          >
            <FlowSpinner accent={accent} size={20} thickness={0.14} />
          </motion.span>
        )}
        {state === 'pending' && (
          <motion.span
            key="pending"
            className="absolute inset-0 rounded-full border-2 bg-transparent"
            style={{ borderColor: PENDING_STEP_COLOR }}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={glyphTransition}
          />
        )}
        {state === 'failed' && (
          <motion.span
            key="failed"
            className="absolute inset-0 flex items-center justify-center rounded-full bg-status-negative"
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={glyphTransition}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
};

export const TransactionStepRow: React.FC<TransactionStepRowProps> = ({ step, state, isLast, label, meta, accent }) => {
  const { t } = useTranslation();
  const rowTransition = useMotion(springs.snappy);
  const resolvedLabel = label ?? t(step.labelKey, { defaultValue: step.defaultLabel });

  return (
    <motion.div
      key={step.id}
      className={classNames(
        'flex items-center justify-between gap-3 px-4 py-3',
        !isLast && 'border-b border-rule-default'
      )}
      data-transaction-step={step.id}
      data-state={state}
      layout
      transition={rowTransition}
    >
      <div className="flex gap-3 items-center">
        <StatusIndicator state={state} accent={accent} />
        <span
          className={classNames(
            'min-w-0 truncate font-heading text-base font-bold leading-none',
            state === 'pending' ? 'text-[#8E8A84] dark:text-[#9B968D]' : 'text-[#161513] dark:text-pure-white'
          )}
        >
          {resolvedLabel}
        </span>
      </div>
      {meta && (
        <span className="shrink-0 font-heading text-base font-medium leading-none text-[#8E8A84] dark:text-[#9B968D]">
          {meta}
        </span>
      )}
    </motion.div>
  );
};
