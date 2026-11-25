import React, { useCallback, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { WaveDots } from 'components/ui';
import { CommandAiClientError, compileCommandPrompt, type CommandAiErrorCode } from 'lib/command-ai/client';
import { executeLocalLedgerQuery, type LocalQueryResult } from 'lib/command-ai/local-query';
import {
  applyChipSelection,
  compileOutputToResolution,
  createClarificationSnapshot,
  resolveDraftToAction,
  type ClarificationChip,
  type EarnSubjectSummary,
  type HydratedIntentDraft,
  type OrchestratorResolution
} from 'lib/command-ai/orchestrator';
import {
  mergeRedactionMaps,
  redactPrompt,
  verifyProvenance,
  type RedactedKind,
  type RedactionMap
} from 'lib/command-ai/redactor';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import type { AccountScope } from 'lib/miden-chain/account-scope';
import type { TokenPrices } from 'lib/prices';
import { navigate } from 'lib/woozie';

import { BreadMascot, type BreadMascotMood } from './BreadMascot';
import { useCommandAiWalletData } from './command-ai-context';
import { stepDisplayLabels, useOptionalCommandAiPlan } from './command-ai-plan';
import { useOptionalCommandDrafts } from './command-drafts';
import type { CommandAction } from './command-routes';
import { COMMAND_DESTINATIONS } from './CommandDock';

type BarTurn = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

type AiBarState =
  | { kind: 'idle' }
  | { kind: 'compiling'; redactedKinds: RedactedKind[] }
  | {
      kind: 'clarifying';
      slot: string;
      questionKey: string;
      questionParams?: Record<string, string>;
      chips: ClarificationChip[];
      draft: HydratedIntentDraft;
      map: RedactionMap;
      allowedOptionIds: string[];
      redactedKinds: RedactedKind[];
    }
  | { kind: 'query_result'; result: LocalQueryResult; redactedKinds: RedactedKind[] }
  | {
      kind: 'error';
      messageKey: string;
      messageParams?: Record<string, string>;
      fallbackAction?: CommandAction;
      redactedKinds: RedactedKind[];
    };

function clientErrorToMessageKey(code: CommandAiErrorCode): string {
  switch (code) {
    case 'unconfigured':
      return 'commandAiUnconfigured';
    case 'rate_limited':
      return 'commandAiRateLimited';
    case 'invalid_response':
      return 'commandAiInvalidModelOutput';
    default:
      return 'commandAiServiceUnavailable';
  }
}

function AnswerCardShell({
  testId,
  role,
  ariaLabel,
  mood,
  eyebrow,
  title,
  redactedKinds,
  onDismiss,
  tone = 'default',
  children
}: {
  testId: string;
  role: 'region' | 'status' | 'alert';
  ariaLabel?: string;
  mood: BreadMascotMood;
  eyebrow: string;
  title: string;
  redactedKinds?: RedactedKind[];
  onDismiss: () => void;
  tone?: 'default' | 'accent' | 'error';
  children: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  const borderClass =
    tone === 'error'
      ? 'border-negative-tint-ink/35'
      : tone === 'accent'
        ? 'border-accent-tint-ink/35'
        : 'border-hairline';

  return (
    <div
      data-testid={testId}
      role={role}
      aria-label={ariaLabel}
      className={`relative mt-3 overflow-hidden rounded-3xl border ${borderClass} bg-linear-to-b from-fill/95 via-fill/85 to-page p-5 shadow-lg`}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(251,146,60,0.12),transparent_58%)]"
      />
      <div className="relative flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3.5">
            <div className="grid size-13 shrink-0 place-items-center rounded-2xl border border-hairline bg-page/70 shadow-xs">
              <BreadMascot mood={mood} size="md" />
            </div>
            <div className="min-w-0">
              <p className="text-caption font-semibold uppercase tracking-wider text-accent-tint-ink">{eyebrow}</p>
              <h3 className="text-body-lg font-semibold leading-snug text-ink">{title}</h3>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {redactedKinds && redactedKinds.length > 0 && (
              <span
                data-testid="command-ai-answer-privacy"
                className="hidden items-center gap-1 rounded-xl border border-hairline bg-page/75 px-2.5 py-1 text-caption text-muted sm:inline-flex"
              >
                <Icon name={IconName.ShieldCheck} size="xs" className="text-accent-receive-ink" aria-hidden="true" />
                {t('commandAiRedactedBadge', { kinds: redactedKinds.join(', ') })}
              </span>
            )}
            <button
              type="button"
              onClick={onDismiss}
              aria-label={t('close')}
              className="grid size-8 shrink-0 place-items-center rounded-full border border-hairline bg-page/70 text-muted transition-colors hover:bg-fill-pressed hover:text-ink focus-visible:outline-2 focus-visible:outline-accent-primary"
            >
              <Icon name={IconName.Close} size="xs" aria-hidden="true" />
            </button>
          </div>
        </div>

        {children}
      </div>
    </div>
  );
}

export function CommandAiBar({
  scope,
  assets,
  tokenPrices
}: {
  scope: AccountScope;
  assets: readonly TokenBalanceData[];
  tokenPrices: TokenPrices;
}): React.ReactElement {
  const { t } = useTranslation();
  const drafts = useOptionalCommandDrafts();
  const planCtx = useOptionalCommandAiPlan();
  const { contacts, heldNicheTickers, getWalletContext, loadEarnPositions } = useCommandAiWalletData(
    scope,
    assets,
    tokenPrices
  );

  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<AiBarState>({ kind: 'idle' });
  const [turns, setTurns] = useState<BarTurn[]>([]);
  const activeAbortRef = useRef<AbortController | null>(null);

  const applyResolution = useCallback(
    (resolution: OrchestratorResolution, redactedKinds: RedactedKind[], earnPositions: EarnSubjectSummary[] = []) => {
      if (resolution.kind === 'plan') {
        setState({ kind: 'idle' });
        setInput('');
        if (planCtx) {
          planCtx.startPlan(resolution.steps, resolution.map, redactedKinds, getWalletContext(earnPositions));
          return;
        }
        const firstStep = resolution.steps[0];
        if (firstStep) {
          applyResolution(
            resolveDraftToAction(firstStep, resolution.map, getWalletContext(earnPositions)),
            redactedKinds
          );
        }
        return;
      }

      if (resolution.kind === 'handoff') {
        const { handoff } = resolution;
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
        setState({ kind: 'idle' });
        setInput('');
        navigate(handoff.path);
        return;
      }

      if (resolution.kind === 'clarifying') {
        const questionText = t(resolution.questionKey, resolution.questionParams);
        setTurns(prev => [...prev.slice(-7), { id: `a-${Date.now()}`, role: 'assistant', text: questionText }]);
        setState({
          kind: 'clarifying',
          slot: resolution.slot,
          questionKey: resolution.questionKey,
          questionParams: resolution.questionParams,
          chips: resolution.chips,
          draft: resolution.draft,
          map: resolution.map,
          allowedOptionIds: resolution.allowedOptionIds,
          redactedKinds
        });
        setInput('');
        return;
      }

      if (resolution.kind === 'cancelled') {
        planCtx?.dismissPlan();
        setState({ kind: 'idle' });
        setInput('');
        return;
      }

      if (resolution.kind === 'error') {
        const msg = t(resolution.messageKey, resolution.messageParams);
        setTurns(prev => [...prev.slice(-7), { id: `e-${Date.now()}`, role: 'assistant', text: msg }]);
        setState({
          kind: 'error',
          messageKey: resolution.messageKey,
          messageParams: resolution.messageParams,
          fallbackAction: resolution.fallbackAction,
          redactedKinds
        });
      }
    },
    [drafts, getWalletContext, planCtx, t]
  );

  const dismiss = useCallback(() => {
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;
    setState({ kind: 'idle' });
  }, []);

  const handleChipClick = useCallback(
    (chip: ClarificationChip) => {
      if (state.kind !== 'clarifying') return;
      const nextResolution = applyChipSelection(
        {
          kind: 'clarifying',
          slot: state.slot,
          questionKey: state.questionKey,
          questionParams: state.questionParams,
          chips: state.chips,
          draft: state.draft,
          map: state.map,
          allowedOptionIds: state.allowedOptionIds
        },
        chip,
        getWalletContext()
      );
      applyResolution(nextResolution, state.redactedKinds);
    },
    [state, getWalletContext, applyResolution]
  );

  const handleSubmit = useCallback(
    async (event?: React.FormEvent) => {
      event?.preventDefault();
      const raw = input.trim();
      if (!raw || state.kind === 'compiling') return;

      const previousClarifying = state.kind === 'clarifying' ? state : undefined;
      activeAbortRef.current?.abort();
      const controller = new AbortController();
      activeAbortRef.current = controller;

      const redaction = redactPrompt(raw, { contacts, heldNicheTickers });
      const activeMap = previousClarifying ? mergeRedactionMaps(previousClarifying.map, redaction.map) : redaction.map;
      const redactedKinds = redaction.redactedTokensSummary;

      setTurns(prev => [...prev.slice(-7), { id: `u-${Date.now()}`, role: 'user', text: raw }]);
      setState({ kind: 'compiling', redactedKinds });

      try {
        const snapshot = previousClarifying
          ? createClarificationSnapshot(
              previousClarifying.draft,
              previousClarifying.slot,
              previousClarifying.allowedOptionIds
            )
          : undefined;
        const output = await compileCommandPrompt({
          redactedText: redaction.redactedText,
          snapshot,
          signal: controller.signal
        });
        if (controller.signal.aborted) return;

        if (output.op === 'query_ledger') {
          if (!verifyProvenance(output, redaction.map)) {
            setState({
              kind: 'error',
              messageKey: 'commandAiInvalidModelOutput',
              redactedKinds
            });
            return;
          }
          planCtx?.dismissPlan();
          const result = await executeLocalLedgerQuery(output, {
            accountId: scope.accountId,
            balances: assets,
            tokenPrices,
            map: redaction.map
          });
          if (controller.signal.aborted) return;
          setTurns(prev => [...prev.slice(-7), { id: `q-${Date.now()}`, role: 'assistant', text: result.summaryText }]);
          setState({ kind: 'query_result', result, redactedKinds });
          setInput('');
          return;
        }

        const isEarnWithdraw =
          (output.op === 'set_intent' && output.action === 'earn' && output.earn_op === 'withdraw') ||
          (output.op === 'set_plan' && output.steps.some(s => s.action === 'earn' && s.earn_op === 'withdraw')) ||
          (output.op === 'patch_slots' &&
            (output.patch.earn_op === 'withdraw' || previousClarifying?.draft.earnOp === 'withdraw') &&
            (output.patch.action === 'earn' || previousClarifying?.draft.action === 'earn'));
        const earnPositions = isEarnWithdraw ? await loadEarnPositions() : [];
        if (controller.signal.aborted) return;

        if (output.op !== 'set_plan') {
          planCtx?.dismissPlan();
        }

        const effectiveMap = output.op === 'patch_slots' ? activeMap : redaction.map;
        const resolution = compileOutputToResolution(
          output,
          effectiveMap,
          getWalletContext(earnPositions),
          output.op === 'patch_slots' ? previousClarifying?.draft : undefined
        );
        applyResolution(resolution, redactedKinds, earnPositions);
      } catch (error) {
        if (controller.signal.aborted) return;
        const messageKey =
          error instanceof CommandAiClientError ? clientErrorToMessageKey(error.code) : 'commandAiServiceUnavailable';
        setState({
          kind: 'error',
          messageKey,
          fallbackAction: previousClarifying?.draft.action,
          redactedKinds
        });
      }
    },
    [
      input,
      state,
      contacts,
      heldNicheTickers,
      scope.accountId,
      assets,
      tokenPrices,
      loadEarnPositions,
      planCtx,
      getWalletContext,
      applyResolution
    ]
  );

  const activeRedactedKinds = state.kind === 'idle' ? [] : state.redactedKinds;
  const busy = state.kind === 'compiling';
  const activePlan = state.kind === 'idle' ? planCtx?.plan : null;

  return (
    <section aria-label={t('commandAiBarLabel')} data-testid="command-ai-bar" className="min-w-0 lg:col-span-12">
      <form
        onSubmit={handleSubmit}
        className={`relative flex flex-col gap-2.5 overflow-hidden rounded-3xl border border-hairline bg-fill/75 px-5 py-3 shadow-sm transition-colors focus-within:border-accent-primary/60 focus-within:ring-2 focus-within:ring-accent-primary/20 command-ai-wave${busy ? ' command-ai-wave-busy' : ''}`}
      >
        {expanded && turns.length > 0 && (
          <div
            data-testid="command-ai-thread"
            aria-label={t('commandAiRecentTurns')}
            className="flex max-h-48 flex-col gap-2 overflow-y-auto border-b border-hairline pb-3 pt-1 text-body"
          >
            {turns.map(turn => (
              <div
                key={turn.id}
                className={
                  turn.role === 'user'
                    ? 'self-end rounded-xl bg-accent-tint px-3.5 py-2 text-ink'
                    : 'self-start rounded-xl border border-hairline bg-page px-3.5 py-2 text-muted'
                }
              >
                {turn.text}
              </div>
            ))}
          </div>
        )}

        <div className="flex min-w-0 items-center gap-3.5">
          <Icon name={IconName.Bolt} size="md" className="shrink-0 text-accent-tint-ink" aria-hidden="true" />

          {expanded ? (
            <textarea
              data-testid="command-ai-input"
              aria-label={t('commandAiBarLabel')}
              rows={3}
              value={input}
              onChange={event => setInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
              placeholder={t('commandAiPlaceholder')}
              className="min-h-28 min-w-0 flex-1 resize-y bg-transparent py-2 text-xl leading-relaxed text-ink outline-none placeholder:text-muted sm:text-2xl"
            />
          ) : (
            <input
              data-testid="command-ai-input"
              type="text"
              aria-label={t('commandAiBarLabel')}
              value={input}
              onChange={event => setInput(event.target.value)}
              placeholder={t('commandAiPlaceholder')}
              className="h-18 min-w-0 flex-1 bg-transparent text-xl text-ink outline-none placeholder:text-muted sm:text-2xl"
            />
          )}

          {activeRedactedKinds.length > 0 && (
            <span
              data-testid="command-ai-privacy-badge"
              className="hidden shrink-0 items-center gap-1 rounded-lg border border-hairline bg-page px-2.5 py-1.5 text-caption text-muted sm:inline-flex"
            >
              <Icon name={IconName.ShieldCheck} size="xs" className="text-accent-receive-ink" aria-hidden="true" />
              {t('commandAiRedactedBadge', { kinds: activeRedactedKinds.join(', ') })}
            </span>
          )}

          <button
            type="button"
            data-testid="command-ai-morph-toggle"
            aria-expanded={expanded}
            aria-label={t(expanded ? 'commandAiCollapse' : 'commandAiExpand')}
            title={t(expanded ? 'commandAiCollapse' : 'commandAiExpand')}
            onClick={() => setExpanded(prev => !prev)}
            className="grid size-10 shrink-0 place-items-center rounded-xl text-muted hover:bg-fill-pressed hover:text-ink focus-visible:outline-2 focus-visible:outline-accent-primary"
          >
            <Icon name={expanded ? IconName.ChevronUp : IconName.ChevronDown} size="sm" aria-hidden="true" />
          </button>

          <button
            type="submit"
            data-testid="command-ai-submit"
            disabled={busy || input.trim().length === 0}
            className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-2xl bg-accent-primary px-4 text-body font-medium text-page transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
          >
            {busy ? (
              <WaveDots label={t('commandAiWorking')} />
            ) : (
              <>
                <span>{t('commandAiSendButton')}</span>
                <Icon name={IconName.ArrowRight} size="sm" aria-hidden="true" />
              </>
            )}
          </button>
        </div>
      </form>

      {activePlan && planCtx && (
        <AnswerCardShell
          testId="command-ai-plan-card"
          role="region"
          ariaLabel={t('commandAiPlanTitle')}
          mood={
            activePlan.status === 'completed'
              ? 'happy'
              : activePlan.status === 'clarifying'
                ? 'clarifying'
                : activePlan.status === 'error'
                  ? 'oops'
                  : 'working'
          }
          eyebrow={t('commandAiPlanTitle')}
          title={
            activePlan.status === 'completed'
              ? t('commandAiPlanCompletedTitle')
              : activePlan.status === 'clarifying' && activePlan.clarifying
                ? t(activePlan.clarifying.questionKey, activePlan.clarifying.questionParams)
                : activePlan.status === 'error' && activePlan.error
                  ? t(activePlan.error.messageKey, activePlan.error.messageParams)
                  : t('commandAiPlanProgress', {
                      current: String(activePlan.currentIndex + 1),
                      total: String(activePlan.steps.length)
                    })
          }
          redactedKinds={activePlan.redactedKinds}
          onDismiss={activePlan.status === 'completed' ? planCtx.dismissPlan : planCtx.stopPlan}
          tone={activePlan.status === 'error' ? 'error' : activePlan.status === 'clarifying' ? 'accent' : 'default'}
        >
          <ol className="flex flex-col gap-2">
            {activePlan.steps.map(step => {
              const labels = stepDisplayLabels(step.draft, t);
              const isActive = step.status === 'active';
              const isDone = step.status === 'done';
              return (
                <li
                  key={step.index}
                  data-testid={`command-ai-plan-step-${step.index}`}
                  className={`flex items-center justify-between gap-3 rounded-2xl border px-3.5 py-2.5 ${
                    isActive
                      ? 'border-accent-primary/60 bg-accent-tint/55'
                      : isDone
                        ? 'border-accent-receive-ink/30 bg-page/65'
                        : 'border-hairline bg-page/55'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={`grid size-7 shrink-0 place-items-center rounded-full text-caption font-bold ${
                        isActive
                          ? 'bg-accent-primary text-page'
                          : isDone
                            ? 'bg-accent-receive-ink text-page'
                            : 'border border-hairline bg-fill text-muted'
                      }`}
                    >
                      {step.index + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-body-sm font-semibold text-ink">{labels.summary}</p>
                      {labels.detail && <p className="truncate text-caption text-muted">{labels.detail}</p>}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-lg px-2 py-0.5 text-caption font-medium ${
                      isActive ? 'bg-page/80 text-accent-tint-ink' : isDone ? 'text-accent-receive-ink' : 'text-muted'
                    }`}
                  >
                    {t(
                      isDone
                        ? 'commandAiPlanStatusDone'
                        : isActive
                          ? 'commandAiPlanStatusActive'
                          : 'commandAiPlanStatusPending'
                    )}
                  </span>
                </li>
              );
            })}
          </ol>

          {activePlan.status === 'clarifying' && activePlan.clarifying && (
            <div className="flex flex-wrap gap-2">
              {activePlan.clarifying.chips.map(chip => (
                <button
                  key={chip.id}
                  type="button"
                  data-testid={`command-ai-chip-${chip.id}`}
                  onClick={() => planCtx.selectPlanChip(chip, getWalletContext())}
                  className="inline-flex items-center gap-2 rounded-2xl border border-hairline bg-page/85 px-4 py-2.5 text-body-sm text-ink shadow-xs transition-all hover:border-accent-primary/70 hover:bg-accent-tint focus-visible:outline-2 focus-visible:outline-accent-primary"
                >
                  <span className="font-semibold">{chip.label}</span>
                  {chip.subtitle && <span className="text-caption text-muted">{chip.subtitle}</span>}
                </button>
              ))}
            </div>
          )}

          {activePlan.status !== 'completed' && (
            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-1">
              <button
                type="button"
                data-testid="command-ai-plan-stop"
                onClick={planCtx.stopPlan}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-negative-tint-ink/35 bg-page/75 px-3.5 text-body-sm font-medium text-negative-tint-ink transition-colors hover:bg-negative-tint/15 focus-visible:outline-2 focus-visible:outline-accent-primary"
              >
                {t('commandAiPlanStop')}
              </button>
              {activePlan.status === 'executing' && (
                <button
                  type="button"
                  data-testid="command-ai-plan-continue"
                  onClick={() => planCtx.advanceToNextStep(getWalletContext())}
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-accent-primary px-4 text-body-sm font-medium text-page transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent-primary"
                >
                  <span>
                    {t(
                      activePlan.currentIndex >= activePlan.steps.length - 1
                        ? 'commandAiPlanFinish'
                        : 'commandAiPlanNextStep'
                    )}
                  </span>
                  <Icon name={IconName.ArrowRight} size="xs" aria-hidden="true" />
                </button>
              )}
            </div>
          )}
        </AnswerCardShell>
      )}

      {state.kind === 'clarifying' && (
        <AnswerCardShell
          testId="command-ai-clarification"
          role="region"
          ariaLabel={t(state.questionKey, state.questionParams)}
          mood="clarifying"
          eyebrow={t('commandAiAssistantName')}
          title={t(state.questionKey, state.questionParams)}
          redactedKinds={state.redactedKinds}
          onDismiss={dismiss}
          tone="accent"
        >
          <div className="flex flex-wrap gap-2">
            {state.chips.map(chip => (
              <button
                key={chip.id}
                type="button"
                data-testid={`command-ai-chip-${chip.id}`}
                onClick={() => handleChipClick(chip)}
                className="inline-flex items-center gap-2 rounded-2xl border border-hairline bg-page/85 px-4 py-2.5 text-body-sm text-ink shadow-xs transition-all hover:border-accent-primary/70 hover:bg-accent-tint focus-visible:outline-2 focus-visible:outline-accent-primary"
              >
                <span className="font-semibold">{chip.label}</span>
                {chip.subtitle && <span className="text-caption text-muted">{chip.subtitle}</span>}
              </button>
            ))}
          </div>
        </AnswerCardShell>
      )}

      {state.kind === 'query_result' && (
        <AnswerCardShell
          testId="command-ai-query-result"
          role="status"
          mood="happy"
          eyebrow={t('commandAiAssistantName')}
          title={t(state.result.titleKey)}
          redactedKinds={state.redactedKinds}
          onDismiss={dismiss}
        >
          <div className="rounded-2xl border border-hairline bg-page/80 px-4 py-3.5 shadow-xs">
            <p className="text-xl font-semibold text-ink tabular-nums">
              {state.result.empty ? t('commandAiQueryEmpty') : state.result.summaryText}
            </p>
          </div>
          {state.result.rows.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {state.result.rows.map(row => (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-hairline/70 bg-page/55 px-3.5 py-2 text-body-sm"
                >
                  <span className="truncate font-medium text-ink">{row.primaryText}</span>
                  {row.secondaryText && (
                    <span className="shrink-0 text-caption text-muted tabular-nums">{row.secondaryText}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-1.5 text-caption text-muted">
            <Icon name={IconName.ShieldCheck} size="xs" className="text-accent-receive-ink" aria-hidden="true" />
            <span>{t('commandAiLocalOnlyNote')}</span>
          </div>
        </AnswerCardShell>
      )}

      {state.kind === 'error' && (
        <AnswerCardShell
          testId="command-ai-error"
          role="alert"
          mood="oops"
          eyebrow={t('commandAiAssistantName')}
          title={t(state.messageKey, state.messageParams)}
          redactedKinds={state.redactedKinds}
          onDismiss={dismiss}
          tone="error"
        >
          {state.fallbackAction && (
            <div className="flex justify-end">
              <button
                type="button"
                data-testid="command-ai-fallback-open"
                onClick={() => navigate(COMMAND_DESTINATIONS[state.fallbackAction!])}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-hairline bg-page/85 px-3.5 text-body-sm font-medium text-ink transition-colors hover:bg-fill-pressed focus-visible:outline-2 focus-visible:outline-accent-primary"
              >
                <span>{t('commandAiOpenNativeForm')}</span>
                <Icon name={IconName.ArrowRight} size="xs" aria-hidden="true" />
              </button>
            </div>
          )}
        </AnswerCardShell>
      )}
    </section>
  );
}
