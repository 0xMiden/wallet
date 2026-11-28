import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { CommandAiClientError, compileCommandPrompt, type CommandAiErrorCode } from 'lib/command-ai/client';
import { COMMAND_HELP_TOPICS, containsCommandSecret } from 'lib/command-ai/help';
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
import { COMMAND_AI_MAX_TEXT_CHARS, commandHelpTopicIds, type AiCompilerOutput } from 'lib/command-ai/schema';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import type { AccountScope } from 'lib/miden-chain/account-scope';
import type { TokenPrices } from 'lib/prices';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { navigate } from 'lib/woozie';

import { BreadMascot, type BreadMascotMood } from './BreadMascot';
import { useCommandAiWalletData } from './command-ai-context';
import { stepDisplayLabels, useOptionalCommandAiPlan } from './command-ai-plan';
import { useOptionalCommandDrafts } from './command-drafts';
import type { CommandAction } from './command-routes';
import { CommandAiChip } from './CommandAiChip';
import { COMMAND_DESTINATIONS } from './CommandDock';

type BarTurn = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

type AiBarState =
  | { kind: 'idle' }
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
  dismissDisabled,
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
  dismissDisabled?: boolean;
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
              disabled={dismissDisabled}
              aria-label={t('close')}
              className="grid size-8 shrink-0 place-items-center rounded-full border border-hairline bg-page/70 text-muted transition-colors hover:bg-fill-pressed hover:text-ink focus-visible:outline-2 focus-visible:outline-accent-primary"
            >
              <Icon name={IconName.Close} size="xs" fill="currentColor" aria-hidden="true" />
            </button>
          </div>
        </div>

        {children}
      </div>
    </div>
  );
}

type TypingPhase = 'typing' | 'holding' | 'erasing' | 'pausing';

function useTypingPlaceholder(phrases: readonly string[], active: boolean, fallback: string): string {
  const reducedMotion = useReducedMotion();
  const [cursor, setCursor] = useState<{ phraseIndex: number; charCount: number; phase: TypingPhase }>({
    phraseIndex: 0,
    charCount: 0,
    phase: 'typing'
  });

  useEffect(() => {
    if (!active || reducedMotion || phrases.length === 0) return;

    const delay =
      cursor.phase === 'typing' ? 48 : cursor.phase === 'holding' ? 2_200 : cursor.phase === 'erasing' ? 24 : 450;

    const timer = window.setTimeout(() => {
      setCursor(prev => {
        const text = phrases[prev.phraseIndex % phrases.length] ?? '';
        if (prev.phase === 'typing') {
          const nextChars = prev.charCount + 1;
          if (nextChars >= text.length) {
            return { ...prev, charCount: text.length, phase: 'holding' };
          }
          return { ...prev, charCount: nextChars };
        }
        if (prev.phase === 'holding') {
          return { ...prev, phase: 'erasing' };
        }
        if (prev.phase === 'erasing') {
          const nextChars = prev.charCount - 1;
          if (nextChars <= 0) {
            return {
              phraseIndex: (prev.phraseIndex + 1) % phrases.length,
              charCount: 0,
              phase: 'pausing'
            };
          }
          return { ...prev, charCount: nextChars };
        }
        return { ...prev, phase: 'typing' };
      });
    }, delay);

    return () => window.clearTimeout(timer);
  }, [active, cursor, phrases, reducedMotion]);

  if (!active || reducedMotion || phrases.length === 0) return fallback;
  const activePhrase = phrases[cursor.phraseIndex % phrases.length] ?? '';
  const visibleText = activePhrase.slice(0, cursor.charCount);
  return visibleText ? `${visibleText}|` : '';
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
  const samplePrompt1 = t('commandAiSamplePrompt1');
  const samplePrompt2 = t('commandAiSamplePrompt2');
  const samplePrompt3 = t('commandAiSamplePrompt3');
  const samplePrompt4 = t('commandAiSamplePrompt4');
  const samplePrompt5 = t('commandAiSamplePrompt5');
  const samplePrompt6 = t('commandAiSamplePrompt6');
  const samplePrompts = useMemo(
    () => [samplePrompt1, samplePrompt2, samplePrompt3, samplePrompt4, samplePrompt5, samplePrompt6],
    [samplePrompt1, samplePrompt2, samplePrompt3, samplePrompt4, samplePrompt5, samplePrompt6]
  );
  const drafts = useOptionalCommandDrafts();
  const planCtx = useOptionalCommandAiPlan();
  const { contacts, heldNicheTickers, getWalletContext, loadEarnPositions } = useCommandAiWalletData(
    scope,
    assets,
    tokenPrices
  );

  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  const [state, setState] = useState<AiBarState>({ kind: 'idle' });
  const [pendingKinds, setPendingKinds] = useState<RedactedKind[] | null>(null);
  const [helpAnswer, setHelpAnswer] = useState<Extract<AiCompilerOutput, { op: 'explain' }> | 'topics' | null>(null);
  const plan = planCtx?.plan;
  const [requestFailure, setRequestFailure] = useState<{
    error: Extract<AiBarState, { kind: 'error' }>;
    state: AiBarState;
    plan: typeof plan;
  } | null>(null);
  const requestError = requestFailure?.state === state && requestFailure.plan === plan ? requestFailure.error : null;
  const errorState = requestError ?? (state.kind === 'error' ? state : null);
  useUserVisibleError(errorState ? 'raw_command_ai_failed' : null, 'inline');
  const [turns, setTurns] = useState<BarTurn[]>([]);
  const activeAbortRef = useRef<AbortController | null>(null);
  // A request that outlives the view must not apply its result or navigate.
  useEffect(() => () => activeAbortRef.current?.abort(), []);

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
    setPendingKinds(null);
    setState({ kind: 'idle' });
  }, []);

  const handleChipClick = useCallback(
    (chip: ClarificationChip) => {
      if (state.kind !== 'clarifying' || pendingKinds !== null) return;
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
    [state, pendingKinds, getWalletContext, applyResolution]
  );

  const submitPrompt = useCallback(
    async (prompt: string, topic?: keyof typeof COMMAND_HELP_TOPICS) => {
      if (!prompt || activeAbortRef.current) return;
      const helpOnly = topic !== undefined;
      const setRequestError = (error: Extract<AiBarState, { kind: 'error' }> | null) => {
        const nextState: AiBarState = error && state.kind === 'error' ? { kind: 'idle' } : state;
        if (nextState !== state) setState(nextState);
        setRequestFailure(error && { error, state: nextState, plan: planCtx?.plan });
      };
      if (prompt.length > COMMAND_AI_MAX_TEXT_CHARS) {
        setRequestError({
          kind: 'error',
          messageKey: 'commandAiInputTooLong',
          messageParams: { limit: String(COMMAND_AI_MAX_TEXT_CHARS) },
          redactedKinds: []
        });
        return;
      }
      const raw = prompt.trim();
      if (!raw) return;
      if (containsCommandSecret(raw)) {
        setRequestError({ kind: 'error', messageKey: 'commandAiHelpSecret', redactedKinds: [] });
        setInput('');
        return;
      }

      const previousClarifying = state.kind === 'clarifying' ? state : undefined;
      const controller = new AbortController();
      activeAbortRef.current = controller;

      const redaction = redactPrompt(raw, { contacts, heldNicheTickers });
      const activeMap = previousClarifying ? mergeRedactionMaps(previousClarifying.map, redaction.map) : redaction.map;
      const redactedKinds = redaction.redactedTokensSummary;

      setTurns(prev => [...prev.slice(-7), { id: `u-${Date.now()}`, role: 'user', text: raw }]);
      setPendingKinds(redactedKinds);

      try {
        const helpContext = topic ?? (helpAnswer === 'topics' ? null : (helpAnswer?.topic ?? null));
        let output = await compileCommandPrompt({
          redactedText: redaction.redactedText,
          helpContext,
          signal: controller.signal
        });
        if (controller.signal.aborted) return;
        setRequestError(null);
        if (output.op === 'explain') {
          if (topic !== undefined && output.topic !== topic) {
            throw new CommandAiClientError('invalid_response', 'The service returned a different help topic');
          }
          if (state.kind === 'error') setState({ kind: 'idle' });
          setHelpAnswer(output);
          if (!helpOnly) setInput(current => (current.trim() === raw ? '' : current));
          return;
        }
        if (helpOnly) throw new CommandAiClientError('invalid_response', 'The service did not return an explanation');

        if (previousClarifying) {
          output = await compileCommandPrompt({
            redactedText: redaction.redactedText,
            snapshot: createClarificationSnapshot(
              previousClarifying.draft,
              previousClarifying.slot,
              previousClarifying.allowedOptionIds
            ),
            signal: controller.signal
          });
          if (controller.signal.aborted) return;
          if (output.op === 'explain') throw new CommandAiClientError('invalid_response', 'Unexpected explanation');
        }
        if (previousClarifying && output.op === 'unsupported') {
          setRequestError({ kind: 'error', messageKey: 'commandAiUnsupported', redactedKinds });
          return;
        }

        if (output.op === 'query_ledger') {
          if (!verifyProvenance(output, redaction.map)) {
            setHelpAnswer(null);
            setState({
              kind: 'error',
              messageKey: 'commandAiInvalidModelOutput',
              redactedKinds
            });
            return;
          }
          const result = await executeLocalLedgerQuery(output, {
            accountId: scope.accountId,
            balances: assets,
            tokenPrices,
            map: redaction.map
          });
          if (controller.signal.aborted) return;
          planCtx?.dismissPlan();
          setHelpAnswer(null);
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
        setHelpAnswer(null);

        const effectiveMap = output.op === 'patch_slots' ? activeMap : redaction.map;
        const resolution = compileOutputToResolution(
          output,
          effectiveMap,
          getWalletContext(earnPositions),
          output.op === 'patch_slots' ? previousClarifying?.draft : undefined
        );
        applyResolution(resolution, redactedKinds, earnPositions);
        if (output.op !== 'set_plan' && resolution.kind !== 'cancelled') {
          planCtx?.dismissPlan();
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const messageKey =
          error instanceof CommandAiClientError ? clientErrorToMessageKey(error.code) : 'commandAiServiceUnavailable';
        setRequestError({
          kind: 'error',
          messageKey,
          fallbackAction: helpOnly ? undefined : previousClarifying?.draft.action,
          redactedKinds
        });
      } finally {
        if (activeAbortRef.current === controller) {
          activeAbortRef.current = null;
          setPendingKinds(null);
        }
      }
    },
    [
      state,
      helpAnswer,
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

  const handleSubmit = (event?: React.FormEvent) => {
    event?.preventDefault();
    void submitPrompt(input);
  };

  const activeRedactedKinds = pendingKinds ?? (state.kind === 'idle' ? [] : state.redactedKinds);
  const busy = pendingKinds !== null;
  const activePlan = state.kind === 'idle' ? planCtx?.plan : null;
  const answer = helpAnswer === 'topics' ? null : helpAnswer;
  const help = answer ? COMMAND_HELP_TOPICS[answer.topic] : null;
  const animatedPlaceholder = useTypingPlaceholder(
    samplePrompts,
    input.length === 0 && !busy && !focused && state.kind === 'idle' && helpAnswer === null,
    t('commandAiPlaceholder')
  );
  const effectivePlaceholder = focused ? '' : animatedPlaceholder;

  return (
    <section aria-label={t('commandAiBarLabel')} data-testid="command-ai-bar" className="min-w-0 lg:col-span-12">
      <form
        onSubmit={handleSubmit}
        aria-busy={busy}
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
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={effectivePlaceholder}
              className="min-h-28 min-w-0 flex-1 resize-y bg-transparent py-2 text-xl leading-relaxed text-ink outline-none placeholder:text-muted sm:text-2xl"
            />
          ) : (
            <input
              data-testid="command-ai-input"
              type="text"
              aria-label={t('commandAiBarLabel')}
              value={input}
              onChange={event => setInput(event.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={effectivePlaceholder}
              className="h-18 min-w-0 flex-1 bg-transparent text-xl text-ink outline-none placeholder:text-muted sm:text-2xl"
            />
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
            <Icon
              name={expanded ? IconName.ChevronUp : IconName.ChevronDown}
              size="sm"
              fill="currentColor"
              aria-hidden="true"
            />
          </button>

          <button
            type="submit"
            data-testid="command-ai-submit"
            disabled={busy || input.trim().length === 0}
            aria-busy={busy}
            className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-2xl bg-accent-primary px-4 text-body font-medium text-page transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 aria-busy:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
          >
            <span>{t('commandAiSendButton')}</span>
            <Icon name={IconName.ArrowRight} size="sm" aria-hidden="true" />
          </button>
        </div>
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 text-caption">
          <button
            type="button"
            onClick={() => setHelpAnswer('topics')}
            disabled={busy}
            aria-expanded={helpAnswer !== null}
            aria-controls="command-ai-help"
            className="py-1.5 font-medium text-accent-tint-ink hover:underline focus-visible:outline-2 focus-visible:outline-accent-primary"
          >
            {t('commandAiHelpBrowse')}
          </button>
          {activeRedactedKinds.length > 0 && (
            <span
              data-testid="command-ai-privacy-badge"
              className="hidden items-center gap-1 text-muted sm:inline-flex"
            >
              <Icon name={IconName.ShieldCheck} size="xs" className="text-accent-receive-ink" aria-hidden="true" />
              {t('commandAiRedactedBadge', { kinds: activeRedactedKinds.join(', ') })}
            </span>
          )}
        </div>
      </form>
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {busy ? t('commandAiWorking') : ''}
      </span>

      <div id="command-ai-help">
        {helpAnswer !== null && (
          <AnswerCardShell
            testId={help ? 'command-ai-help-answer' : 'command-ai-help-topics'}
            role="region"
            ariaLabel={t('commandAiHelpBrowse')}
            mood="happy"
            eyebrow={t('commandAiAssistantName')}
            title={answer ? t(`commandAiHelp${answer.topic}Title`) : t('commandAiHelpBrowse')}
            onDismiss={() => setHelpAnswer(null)}
            dismissDisabled={busy}
          >
            {help && answer ? (
              <>
                <p className="text-body leading-relaxed text-ink" aria-live="polite">
                  {answer.answer}
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-body-sm">
                  <a
                    href={help.source}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent-tint-ink underline underline-offset-2 focus-visible:outline-2"
                  >
                    {t(answer.topic === 'Bridge' ? 'commandAiHelpBridgeSource' : 'commandAiHelpSource')}
                  </a>
                  {'next' in help && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void submitPrompt(t(`commandAiHelp${help.next}Title`), help.next)}
                      className="text-accent-tint-ink underline underline-offset-2 focus-visible:outline-2"
                    >
                      {t(`commandAiHelp${help.next}Title`)}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="text-body-sm text-muted">{t('commandAiHelpDisclosure')}</p>
                <ul className="flex flex-wrap gap-2">
                  {commandHelpTopicIds.map(topic => (
                    <li key={topic}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void submitPrompt(t(`commandAiHelp${topic}Title`), topic)}
                        className="rounded-xl border border-hairline bg-page px-3 py-2 text-body-sm text-ink hover:bg-fill-pressed focus-visible:outline-2"
                      >
                        {t(`commandAiHelp${topic}Title`)}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </AnswerCardShell>
        )}
      </div>

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
          dismissDisabled={busy}
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
                      <p className="break-words text-body-sm font-semibold text-ink">{labels.summary}</p>
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
                <CommandAiChip
                  key={chip.id}
                  chip={chip}
                  labelClassName="font-semibold"
                  data-testid={`command-ai-chip-${chip.id}`}
                  disabled={busy}
                  onClick={() => planCtx.selectPlanChip(chip, getWalletContext())}
                  className="inline-flex items-center gap-2 rounded-2xl border border-hairline bg-page/85 px-4 py-2.5 text-body-sm text-ink shadow-xs transition-all hover:border-accent-primary/70 hover:bg-accent-tint focus-visible:outline-2 focus-visible:outline-accent-primary"
                />
              ))}
            </div>
          )}

          {activePlan.status !== 'completed' && (
            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-1">
              <button
                type="button"
                data-testid="command-ai-plan-stop"
                onClick={planCtx.stopPlan}
                disabled={busy}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-negative-tint-ink/35 bg-page/75 px-3.5 text-body-sm font-medium text-negative-tint-ink transition-colors hover:bg-negative-tint/15 focus-visible:outline-2 focus-visible:outline-accent-primary"
              >
                {t('commandAiPlanStop')}
              </button>
              {activePlan.status === 'executing' && (
                <button
                  type="button"
                  data-testid="command-ai-plan-continue"
                  onClick={() => planCtx.advanceToNextStep(getWalletContext())}
                  disabled={busy}
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
              <CommandAiChip
                key={chip.id}
                chip={chip}
                labelClassName="font-semibold"
                data-testid={`command-ai-chip-${chip.id}`}
                disabled={busy}
                onClick={() => handleChipClick(chip)}
                className="inline-flex items-center gap-2 rounded-2xl border border-hairline bg-page/85 px-4 py-2.5 text-body-sm text-ink shadow-xs transition-all hover:border-accent-primary/70 hover:bg-accent-tint focus-visible:outline-2 focus-visible:outline-accent-primary"
              />
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

      {errorState && (
        <AnswerCardShell
          testId="command-ai-error"
          role="alert"
          mood="oops"
          eyebrow={t('commandAiAssistantName')}
          title={t(errorState.messageKey, errorState.messageParams)}
          redactedKinds={errorState.redactedKinds}
          onDismiss={requestError ? () => setRequestFailure(null) : dismiss}
          tone="error"
        >
          {errorState.fallbackAction && (
            <div className="flex justify-end">
              <button
                type="button"
                data-testid="command-ai-fallback-open"
                onClick={() => navigate(COMMAND_DESTINATIONS[errorState.fallbackAction!])}
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
