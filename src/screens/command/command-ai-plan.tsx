import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import {
  applyChipSelection,
  carryForwardAmount,
  formatPlanStepSummary,
  resolveDraftToAction,
  type ClarificationChip,
  type CommandPrefillHandoff,
  type HydratedIntentDraft,
  type OrchestratorResolution,
  type OrchestratorWalletContext
} from 'lib/command-ai/orchestrator';
import type { RedactedKind, RedactionMap } from 'lib/command-ai/redactor';
import type { AccountScope } from 'lib/miden-chain/account-scope';
import { navigate } from 'lib/woozie';

import { BreadMascot } from './BreadMascot';
import { useCommandAiWalletData } from './command-ai-context';
import { useOptionalCommandDrafts } from './command-drafts';
import type { CommandRoute } from './command-routes';
import { useCommandPortfolio } from './useCommandPortfolio';

export type PlanStepStatus = 'pending' | 'active' | 'done' | 'stopped';

export interface CommandAiPlanStep {
  index: number;
  draft: HydratedIntentDraft;
  status: PlanStepStatus;
}

export type PlanClarifyingState = Extract<OrchestratorResolution, { kind: 'clarifying' }>;

export interface CommandAiPlanState {
  id: string;
  steps: CommandAiPlanStep[];
  currentIndex: number;
  status: 'clarifying' | 'executing' | 'completed' | 'error';
  map: RedactionMap;
  redactedKinds: RedactedKind[];
  clarifying?: PlanClarifyingState;
  error?: { messageKey: string; messageParams?: Record<string, string> };
}

interface PlanContextValue {
  plan: CommandAiPlanState | null;
  startPlan: (
    steps: HydratedIntentDraft[],
    map: RedactionMap,
    redactedKinds: RedactedKind[],
    walletCtx: OrchestratorWalletContext
  ) => void;
  selectPlanChip: (chip: ClarificationChip, walletCtx: OrchestratorWalletContext) => void;
  advanceToNextStep: (walletCtx: OrchestratorWalletContext) => void;
  stopPlan: () => void;
  dismissPlan: () => void;
}

const Context = createContext<PlanContextValue | null>(null);

function extractHandoffAmount(handoff: CommandPrefillHandoff): string | undefined {
  switch (handoff.action) {
    case 'send':
    case 'bridge':
    case 'earn':
      return handoff.draft.amount || undefined;
    case 'swap':
      return handoff.draft.payAmount || undefined;
    case 'receive':
      return undefined;
  }
}

export function stepDisplayLabels(
  draft: HydratedIntentDraft,
  t: (key: string, params?: Record<string, string>) => string
): { actionLabel: string; summary: string; detail: string } {
  const raw = formatPlanStepSummary(draft);
  const actionLabel = t(draft.action);
  const qty = draft.amount
    ? draft.amount
    : draft.fiatUsdAmount
      ? `$${draft.fiatUsdAmount}`
      : draft.amountIsMax
        ? t('commandAiPlanMaxAmount')
        : draft.amountFromPrevious
          ? t('commandAiPlanPreviousOutput')
          : '';
  const asset = draft.assetQuery ? draft.assetQuery.toUpperCase() : '';
  const toAsset = draft.toAssetQuery ? draft.toAssetQuery.toUpperCase() : '';
  const left = [qty, asset].filter(Boolean).join(' ');
  const summary =
    draft.action === 'swap' && toAsset
      ? `${left || actionLabel} → ${toAsset}`
      : draft.action === 'bridge' && raw.detail
        ? `${left || actionLabel} (${raw.detail})`
        : left || actionLabel;
  return {
    actionLabel,
    summary,
    detail: draft.action === 'send' && raw.detail ? raw.detail : ''
  };
}

export function CommandAiPlanProvider({
  scope,
  children
}: {
  scope: AccountScope;
  children: React.ReactNode;
}): React.ReactElement {
  const drafts = useOptionalCommandDrafts();
  const scopeKey = useMemo(() => JSON.stringify([scope.accountId, scope.network, scope.rpcUrl]), [scope]);
  const [scopedPlan, setScopedPlan] = useState<{ scopeKey: string; state: CommandAiPlanState | null }>({
    scopeKey,
    state: null
  });

  const plan = scopedPlan.scopeKey === scopeKey ? scopedPlan.state : null;

  const setPlanState = useCallback(
    (next: CommandAiPlanState | null | ((prev: CommandAiPlanState | null) => CommandAiPlanState | null)) => {
      setScopedPlan(prev => {
        const current = prev.scopeKey === scopeKey ? prev.state : null;
        return {
          scopeKey,
          state: typeof next === 'function' ? next(current) : next
        };
      });
    },
    [scopeKey]
  );

  const commitHandoff = useCallback(
    (handoff: CommandPrefillHandoff) => {
      if (handoff.action === 'send') {
        drafts?.writeDraft('send', handoff.draft);
      } else if (handoff.action === 'swap') {
        drafts?.writeDraft('swap', handoff.draft);
      } else if (handoff.action === 'bridge') {
        drafts?.writeDraft('bridge', handoff.draft);
      } else if (handoff.action === 'earn') {
        drafts?.writeDraft('earn', handoff.draft);
      } else if (handoff.action === 'receive' && handoff.draft) {
        drafts?.writeDraft('receive', handoff.draft);
      }
      navigate(handoff.path);
    },
    [drafts]
  );

  const applyStepResolution = useCallback(
    (
      planId: string,
      steps: CommandAiPlanStep[],
      stepIndex: number,
      resolution: OrchestratorResolution,
      map: RedactionMap,
      redactedKinds: RedactedKind[]
    ) => {
      if (resolution.kind === 'clarifying') {
        setPlanState({
          id: planId,
          steps: steps.map((s, idx) => (idx === stepIndex ? { ...s, draft: resolution.draft, status: 'active' } : s)),
          currentIndex: stepIndex,
          status: 'clarifying',
          map,
          redactedKinds,
          clarifying: resolution
        });
        return;
      }

      if (resolution.kind === 'handoff') {
        const resolvedAmount = extractHandoffAmount(resolution.handoff);
        const updatedSteps = steps.map((s, idx) => {
          if (idx !== stepIndex) return s;
          return {
            ...s,
            status: 'active' as const,
            draft: resolvedAmount ? { ...s.draft, amount: resolvedAmount, amountFromPrevious: undefined } : s.draft
          };
        });
        setPlanState({
          id: planId,
          steps: updatedSteps,
          currentIndex: stepIndex,
          status: 'executing',
          map,
          redactedKinds
        });
        commitHandoff(resolution.handoff);
        return;
      }

      if (resolution.kind === 'error') {
        setPlanState({
          id: planId,
          steps,
          currentIndex: stepIndex,
          status: 'error',
          map,
          redactedKinds,
          error: {
            messageKey: resolution.messageKey,
            messageParams: resolution.messageParams
          }
        });
      }
    },
    [commitHandoff, setPlanState]
  );

  const startPlan = useCallback(
    (
      rawSteps: HydratedIntentDraft[],
      map: RedactionMap,
      redactedKinds: RedactedKind[],
      walletCtx: OrchestratorWalletContext
    ) => {
      if (rawSteps.length === 0) return;
      const planId = `plan-${Date.now()}`;
      const steps: CommandAiPlanStep[] = rawSteps.map((draft, index) => ({
        index,
        draft,
        status: index === 0 ? 'active' : 'pending'
      }));
      const firstResolution = resolveDraftToAction(steps[0]!.draft, map, walletCtx);
      applyStepResolution(planId, steps, 0, firstResolution, map, redactedKinds);
    },
    [applyStepResolution]
  );

  const selectPlanChip = useCallback(
    (chip: ClarificationChip, walletCtx: OrchestratorWalletContext) => {
      if (!plan || !plan.clarifying) return;
      const updatedDraft: HydratedIntentDraft = { ...plan.clarifying.draft, ...chip.patch };
      const updatedSteps = plan.steps.map((s, idx) => (idx === plan.currentIndex ? { ...s, draft: updatedDraft } : s));
      const nextRes = applyChipSelection(plan.clarifying, chip, walletCtx);
      applyStepResolution(plan.id, updatedSteps, plan.currentIndex, nextRes, plan.map, plan.redactedKinds);
    },
    [plan, applyStepResolution]
  );

  const advanceToNextStep = useCallback(
    (walletCtx: OrchestratorWalletContext) => {
      if (!plan) return;
      const nextIndex = plan.currentIndex + 1;
      const prevDraft = plan.steps[plan.currentIndex]?.draft;

      if (nextIndex >= plan.steps.length) {
        setPlanState(prev =>
          prev
            ? {
                ...prev,
                steps: prev.steps.map(s => ({ ...s, status: 'done' })),
                status: 'completed',
                clarifying: undefined,
                error: undefined
              }
            : null
        );
        navigate('/');
        return;
      }

      const carriedDraft = carryForwardAmount(plan.steps[nextIndex]!.draft, prevDraft);
      const updatedSteps: CommandAiPlanStep[] = plan.steps.map((s, idx) => {
        if (idx < nextIndex) return { ...s, status: 'done' };
        if (idx === nextIndex) return { ...s, status: 'active', draft: carriedDraft };
        return s;
      });
      const res = resolveDraftToAction(carriedDraft, plan.map, walletCtx);
      applyStepResolution(plan.id, updatedSteps, nextIndex, res, plan.map, plan.redactedKinds);
    },
    [plan, applyStepResolution, setPlanState]
  );

  const stopPlan = useCallback(() => {
    setPlanState(null);
    drafts?.clearDrafts();
    navigate('/');
  }, [drafts, setPlanState]);

  const dismissPlan = useCallback(() => {
    setPlanState(null);
  }, [setPlanState]);

  const value = useMemo<PlanContextValue>(
    () => ({ plan, startPlan, selectPlanChip, advanceToNextStep, stopPlan, dismissPlan }),
    [plan, startPlan, selectPlanChip, advanceToNextStep, stopPlan, dismissPlan]
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useOptionalCommandAiPlan(): PlanContextValue | null {
  return useContext(Context);
}

function ActivePlanBanner({
  plan,
  scope,
  route,
  selectPlanChip,
  advanceToNextStep,
  stopPlan
}: {
  plan: CommandAiPlanState;
  scope: AccountScope;
  route: Exclude<CommandRoute, { kind: 'dashboard' }>;
  selectPlanChip: (chip: ClarificationChip, walletCtx: OrchestratorWalletContext) => void;
  advanceToNextStep: (walletCtx: OrchestratorWalletContext) => void;
  stopPlan: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const portfolio = useCommandPortfolio(scope);
  const { getWalletContext, loadEarnPositions } = useCommandAiWalletData(
    scope,
    portfolio.assets,
    portfolio.tokenPrices
  );

  const isLastStep = plan.currentIndex >= plan.steps.length - 1;
  const isOperationView = route.kind === 'operation';

  const runWithCtx = async (fn: (ctx: OrchestratorWalletContext) => void) => {
    const nextStep = plan.steps[plan.currentIndex + 1]?.draft;
    const needsPositions = nextStep?.action === 'earn' && nextStep.earnOp === 'withdraw';
    const positions = needsPositions ? await loadEarnPositions() : [];
    fn(getWalletContext(positions));
  };

  return (
    <div
      data-testid="command-ai-plan-banner"
      role="region"
      aria-label={t('commandAiPlanTitle')}
      className="relative z-20 mx-auto w-full max-w-[66rem] px-3 pt-3 pb-1 sm:px-7"
    >
      <div className="flex min-h-[140px] flex-col justify-center gap-4 rounded-2xl border border-accent-tint-ink/30 bg-linear-to-r from-fill/95 via-fill/90 to-page/95 px-5 py-5 shadow-md backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3.5">
            <BreadMascot
              size="md"
              mood={plan.status === 'error' ? 'oops' : plan.status === 'clarifying' ? 'clarifying' : 'working'}
            />
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-caption font-semibold uppercase tracking-wide text-accent-tint-ink">
                  {t('commandAiPlanTitle')}
                </span>
                <span className="text-caption text-muted">
                  {t('commandAiPlanProgress', {
                    current: String(plan.currentIndex + 1),
                    total: String(plan.steps.length)
                  })}
                </span>
              </div>
              <p className="truncate text-body font-medium text-ink">
                {plan.status === 'clarifying' && plan.clarifying
                  ? t(plan.clarifying.questionKey, plan.clarifying.questionParams)
                  : plan.status === 'error' && plan.error
                    ? t(plan.error.messageKey, plan.error.messageParams)
                    : isOperationView
                      ? t('commandAiPlanStepSubmitted')
                      : t('commandAiPlanConfirmStep')}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2.5">
            {plan.status !== 'clarifying' && (
              <button
                type="button"
                data-testid="command-ai-plan-banner-next"
                onClick={() => void runWithCtx(ctx => advanceToNextStep(ctx))}
                className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-accent-primary px-4 text-body-sm font-medium text-page transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent-primary"
              >
                <span>{t(isLastStep ? 'commandAiPlanFinish' : 'commandAiPlanNextStep')}</span>
                <Icon name={IconName.ArrowRight} size="xs" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              data-testid="command-ai-plan-banner-stop"
              onClick={stopPlan}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-negative-tint-ink/35 bg-page/70 px-4 text-body-sm font-medium text-negative-tint-ink transition-colors hover:bg-negative-tint/15 focus-visible:outline-2 focus-visible:outline-accent-primary"
            >
              <span>{t('commandAiPlanStop')}</span>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {plan.steps.map(step => {
            const labels = stepDisplayLabels(step.draft, t);
            return (
              <span
                key={step.index}
                className={
                  step.status === 'active'
                    ? 'inline-flex items-center gap-1.5 rounded-xl border border-accent-primary/60 bg-accent-tint px-3 py-1.5 text-body-sm font-medium text-ink'
                    : step.status === 'done'
                      ? 'inline-flex items-center gap-1.5 rounded-xl border border-accent-receive-ink/35 bg-page/70 px-3 py-1.5 text-body-sm text-accent-receive-ink'
                      : 'inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-page/60 px-3 py-1.5 text-body-sm text-muted'
                }
              >
                <span className="font-semibold">{step.index + 1}.</span>
                <span>{labels.summary}</span>
              </span>
            );
          })}
        </div>

        {plan.status === 'clarifying' && plan.clarifying && (
          <div className="flex flex-wrap gap-2.5 pt-1">
            {plan.clarifying.chips.map(chip => (
              <button
                key={chip.id}
                type="button"
                data-testid={`command-ai-plan-chip-${chip.id}`}
                onClick={() => selectPlanChip(chip, getWalletContext())}
                className="inline-flex items-center gap-2 rounded-xl border border-hairline bg-page px-3.5 py-2 text-body-sm text-ink transition-colors hover:border-accent-primary/60 hover:bg-accent-tint focus-visible:outline-2 focus-visible:outline-accent-primary"
              >
                <span className="font-medium">{chip.label}</span>
                {chip.subtitle && <span className="text-caption text-muted">{chip.subtitle}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function CommandAiPlanBanner({
  scope,
  route
}: {
  scope: AccountScope;
  route: CommandRoute;
}): React.ReactElement | null {
  const ctx = useOptionalCommandAiPlan();
  if (!ctx?.plan || ctx.plan.status === 'completed' || route.kind === 'dashboard') {
    return null;
  }
  return (
    <ActivePlanBanner
      plan={ctx.plan}
      scope={scope}
      route={route}
      selectPlanChip={ctx.selectPlanChip}
      advanceToNextStep={ctx.advanceToNextStep}
      stopPlan={ctx.stopPlan}
    />
  );
}
