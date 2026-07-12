import React from 'react';

import classNames from 'clsx';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { easings, springs, useMotion } from 'lib/animation';
import { PRIMARY_HEX } from 'utils/brand-colors';

import { PENDING_STEP_COLOR, PROCESSING_ORANGE, SUCCESS_GREEN } from './constants';
import type { StatusIndicatorProps, TransactionHeroIconProps, TransactionStepRowProps } from './types';

export const TransactionHeroIcon: React.FC<TransactionHeroIconProps> = ({ state }) => {
  const reduceMotion = useReducedMotion();
  const entranceTransition = useMotion(springs.standard);
  const glyphTransition = useMotion({ duration: 0.32, ease: easings.easeOutCubic });

  return (
    <motion.div
      className="flex size-30 items-center justify-center"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={entranceTransition}
    >
      {state === 'failed' && (
        <svg viewBox="0 0 142 142" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="71" cy="71" r="52" fill="rgba(197, 26, 10, 0.12)" />
          <circle cx="71" cy="71" r="36" fill="var(--status-negative)" />
          <path
            d="M57 57L85 85M85 57L57 85"
            stroke="white"
            strokeWidth="6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}

      {state === 'success' && (
        <svg viewBox="0 0 142 142" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="71" cy="71" r="52" fill="rgba(144, 186, 137, 0.12)" />
          <circle cx="71" cy="71" r="36" fill={SUCCESS_GREEN} />
          <motion.path
            d="M56 72L67 83L88 60"
            stroke="white"
            strokeWidth="6"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={reduceMotion ? undefined : { pathLength: 0 }}
            animate={reduceMotion ? undefined : { pathLength: 1 }}
            transition={glyphTransition}
          />
        </svg>
      )}

      {state === 'processing' && (
        <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="60" cy="60" r="60" fill={PROCESSING_ORANGE} />
          <circle cx="60" cy="60" r="27" stroke="rgba(255,255,255,0.22)" strokeWidth="16" />
          <motion.circle
            cx="60"
            cy="60"
            r="27"
            stroke="white"
            strokeWidth="16"
            strokeLinecap="butt"
            strokeDasharray="56 170"
            animate={reduceMotion ? undefined : { rotate: 360 }}
            transition={reduceMotion ? undefined : { duration: 1.4, ease: 'linear', repeat: Infinity }}
            style={{ transformOrigin: '60px 60px' }}
          />
          <circle cx="60" cy="60" r="19" fill={PROCESSING_ORANGE} />
        </svg>
      )}
    </motion.div>
  );
};

const StatusIndicator: React.FC<StatusIndicatorProps> = ({ state }) => {
  const reduceMotion = useReducedMotion();
  const glyphTransition = useMotion({ duration: 0.28, ease: easings.easeInCubic });

  return (
    <span className="relative flex size-5 shrink-0 items-center justify-center">
      <AnimatePresence initial={false}>
        {state === 'complete' && (
          <motion.span
            key="complete"
            className="absolute inset-0 flex items-center justify-center rounded-full"
            style={{ backgroundColor: SUCCESS_GREEN }}
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
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className={classNames(!reduceMotion && 'animate-spin')}
            >
              <circle cx="10" cy="10" r="8" stroke={PRIMARY_HEX} strokeWidth="2.5" strokeLinecap="round" />
              <path d="M10 2A8 8 0 0 1 18 10" stroke="white" strokeWidth="3.5" strokeLinecap="round" />
            </svg>
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

export const TransactionStepRow: React.FC<TransactionStepRowProps> = ({ step, state, isLast, label, meta }) => {
  const { t } = useTranslation();
  const rowTransition = useMotion(springs.snappy);
  const resolvedLabel = label ?? t(step.labelKey, { defaultValue: step.defaultLabel });

  return (
    <motion.div
      key={step.id}
      className={classNames(
        'flex items-center justify-between gap-3 mx-6 py-3.5',
        !isLast && 'border-b border-[#ECEBE8]'
      )}
      data-transaction-step={step.id}
      data-state={state}
      layout
      transition={rowTransition}
    >
      <div className="flex gap-3 items-center">
        <StatusIndicator state={state} />
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
