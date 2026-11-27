import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import type { UserErrorId } from 'lib/telemetry/user-visible-error-contract';
import { cn } from 'lib/ui/util';
import { TransactionHeroIcon } from 'screens/generating-transaction/components';

import { DepositAmount, DepositNotice, type DepositRounding } from './parts';
import * as s from './styles';
import type { DepositAmountValue } from './types';

/** The step that is in progress: 0 detected, 1 bridging, 2 arrived. The steps before it are done. */
export type DepositProcessingStep = 0 | 1 | 2;

/** One side of the badge: an amount and its symbol. Without an amount, the side shows the symbol only. */
export interface DepositBadgeSide {
  value?: DepositAmountValue;
  symbol: string;
  rounding: DepositRounding | 'exact';
}

/** A failed deposit: the row's message and the id that reports it. */
export interface DepositProcessingFailure {
  message: string;
  errorId: UserErrorId;
}

export interface DepositProcessingViewProps {
  /** What the user sent, on the left of the badge. */
  sent: DepositBadgeSide;
  /** What arrives, on the right of the badge. */
  received: DepositBadgeSide;
  /** The step in progress. */
  activeStep: DepositProcessingStep;
  /** The route takes about 30 minutes (Agglayer): the note says so. */
  slow: boolean;
  /** The deposit failed: the view shows the failure in the place of the steps. */
  failure?: DepositProcessingFailure;
}

/** The mock-up's arrow glyph in the badge disc. It is decoration: the disc is hidden from assistive technology. */
const BADGE_ARROW_GLYPH = '→';

/** `.badge`: what was sent, an arrow, what arrives. */
export const DepositBadge: React.FC<{ sent: DepositBadgeSide; received: DepositBadgeSide }> = ({ sent, received }) => (
  <div className={s.BADGE} data-testid="deposit-badge">
    <span className={s.BADGE_FROM} data-testid="deposit-badge-sent">
      <BadgeSide side={sent} />
    </span>
    <i aria-hidden="true" className={s.BADGE_ARROW}>
      {BADGE_ARROW_GLYPH}
    </i>
    <span data-testid="deposit-badge-received">
      <BadgeSide side={received} />
    </span>
  </div>
);

const BadgeSide: React.FC<{ side: DepositBadgeSide }> = ({ side }) =>
  side.value === undefined ? (
    <>{side.symbol}</>
  ) : (
    <DepositAmount value={side.value} symbol={side.symbol} rounding={side.rounding} />
  );

type StepState = 'done' | 'now' | 'wait';

function stepStateOf(index: number, active: DepositProcessingStep): StepState {
  if (index < active) return 'done';
  return index === active ? 'now' : 'wait';
}

/**
 * The processing screen of a deposit (mock-up `viewProcessing`): the turning ring, "Bridging to Miden", the badge, the
 * three steps and the note. A failed deposit shows the failure mark, the failure title and the row's message in the
 * place of the ring and the steps. The caller draws the page header ("Processing", with a close) above it.
 */
export const DepositProcessingView: React.FC<DepositProcessingViewProps> = ({
  sent,
  received,
  activeStep,
  slow,
  failure
}) => {
  const { t } = useTranslation();
  useUserVisibleError(failure?.errorId ?? null, 'status_screen');
  // The three steps of a deposit, in order: detected, bridging, arrived.
  const steps = [t('depositFlowStepDetected'), t('depositFlowBridgingToMiden'), t('depositFlowStepArrived')];

  return (
    <HomeGroupPaneBody top="header">
      <div className={cn(s.BASE, s.STATUS_STACK, s.TOP_AFTER_HEADER.processing)} data-testid="deposit-processing">
        {failure ? (
          <div className="flex justify-center">
            <TransactionHeroIcon state="failed" accent="send" size={64} />
          </div>
        ) : (
          <span aria-hidden="true" className={s.SPIN} data-testid="deposit-processing-spinner" />
        )}
        <p className={s.T24} role={failure ? undefined : 'status'}>
          {failure ? t('bridgeDepositFailed') : t('depositFlowBridgingToMiden')}
        </p>
        <DepositBadge sent={sent} received={received} />
        {failure ? (
          <DepositNotice kind="negative" role="alert" data-testid="deposit-processing-failed">
            <span className="select-text [overflow-wrap:anywhere]">{failure.message}</span>
          </DepositNotice>
        ) : (
          <>
            <ol className={s.LGROUP} data-testid="deposit-processing-steps">
              {steps.map((label, index) => {
                const state = stepStateOf(index, activeStep);
                return (
                  <li
                    key={label}
                    data-state={state}
                    className={cn(s.PS, state === 'wait' && s.PS_WAIT)}
                    data-testid={`deposit-processing-step-${index}`}
                  >
                    <i
                      aria-hidden="true"
                      className={cn(s.PS_MARK, state === 'done' && s.PS_MARK_DONE, state === 'now' && s.PS_MARK_NOW)}
                    >
                      {state === 'done' && <Icon name={IconName.Checkmark} fill="currentColor" className={s.ICON_14} />}
                    </i>
                    {label}
                  </li>
                );
              })}
            </ol>
            <p className={s.NOTE} data-testid="deposit-processing-note">
              {slow ? t('depositFlowProcessingSlowNote') : t('depositFlowProcessingNote')}
            </p>
          </>
        )}
      </div>
    </HomeGroupPaneBody>
  );
};
