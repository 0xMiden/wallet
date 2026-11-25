import React, { useCallback, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { WaveDots } from 'components/ui';
import { deriveBridgeRoutes } from 'lib/bridge/catalog';
import { CommandAiClientError, compileCommandPrompt, type CommandAiErrorCode } from 'lib/command-ai/client';
import { executeLocalLedgerQuery, type LocalQueryResult } from 'lib/command-ai/local-query';
import {
  applyChipSelection,
  compileOutputToResolution,
  createClarificationSnapshot,
  type BridgeRouteSummary,
  type ClarificationChip,
  type EarnSubjectSummary,
  type HydratedIntentDraft,
  type OrchestratorResolution,
  type OrchestratorWalletContext
} from 'lib/command-ai/orchestrator';
import {
  DEFAULT_LIQUID_TICKERS,
  mergeRedactionMaps,
  redactPrompt,
  verifyProvenance,
  type RedactedKind,
  type RedactionContact,
  type RedactionMap
} from 'lib/command-ai/redactor';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { getSwapTokens } from 'lib/miden/swap/tokens';
import type { AccountScope } from 'lib/miden-chain/account-scope';
import { getNativeAssetIdSync, getVerificationBaseFeeSync } from 'lib/miden-chain/native-asset';
import type { TokenPrices } from 'lib/prices';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { selectEarnVaultCatalog, selectEarnVaults, selectMidenUsdcFaucetId } from 'lib/remote-config/values';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';

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
  const bridgeConfig = useBridgeConfigSnapshot({ load: false });
  const settingsContacts = useWalletStore(state => state.settings?.contacts);
  const accounts = useWalletStore(state => state.accounts);

  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<AiBarState>({ kind: 'idle' });
  const [turns, setTurns] = useState<BarTurn[]>([]);
  const activeAbortRef = useRef<AbortController | null>(null);

  const contacts = useMemo<RedactionContact[]>(() => {
    const seen = new Set<string>();
    const list: RedactionContact[] = [];
    for (const c of settingsContacts ?? []) {
      if (!c.address || !c.name) continue;
      seen.add(c.address.toLowerCase());
      list.push({ id: `contact:${c.address}`, name: c.name, address: c.address, network: c.network });
    }
    for (const acc of accounts ?? []) {
      if (!acc.publicKey || !acc.name || seen.has(acc.publicKey.toLowerCase())) continue;
      list.push({ id: `account:${acc.publicKey}`, name: acc.name, address: acc.publicKey });
    }
    return list;
  }, [settingsContacts, accounts]);

  const heldNicheTickers = useMemo(
    () =>
      assets
        .filter(a => a.metadata.symbol && !DEFAULT_LIQUID_TICKERS.has(a.metadata.symbol.trim().toUpperCase()))
        .map(a => ({ symbol: a.metadata.symbol, tokenId: a.tokenId })),
    [assets]
  );

  const getWalletContext = useCallback(
    (earnPositions: EarnSubjectSummary[] = []): OrchestratorWalletContext => {
      const bridgeRoutes: BridgeRouteSummary[] = deriveBridgeRoutes(bridgeConfig)
        .filter(r => !(r.provider === 'epoch' && r.mode === 'receive'))
        .map(r => ({
          id: r.id,
          provider: r.provider,
          mode: r.mode,
          sourceSymbol: r.source.symbol,
          sourceNetwork: r.source.network,
          destinationSymbol: r.destination.symbol,
          destinationNetwork: r.destination.network
        }));
      const catalog = selectEarnVaultCatalog(bridgeConfig);
      const earnCollateralId = selectMidenUsdcFaucetId(bridgeConfig);
      const earnVaults: EarnSubjectSummary[] = catalog
        ? catalog.map(v => ({
            id: v.listing.id,
            name: v.listing.name,
            symbol: v.underlying.symbol,
            ...(earnCollateralId ? { collateralFaucetId: earnCollateralId } : {})
          }))
        : selectEarnVaults(bridgeConfig).map(v => ({
            id: v.id,
            name: v.name,
            symbol: 'USDCx',
            ...(earnCollateralId ? { collateralFaucetId: earnCollateralId } : {})
          }));

      return {
        accountPublicKey: scope.accountId,
        networkName: scope.network,
        balances: assets,
        tokenPrices,
        contacts,
        swapTokens: getSwapTokens(),
        bridgeRoutes,
        earnVaults,
        earnPositions,
        nativeFaucetId: getNativeAssetIdSync(),
        verificationBaseFee: getVerificationBaseFeeSync()
      };
    },
    [scope.accountId, scope.network, assets, tokenPrices, contacts, bridgeConfig]
  );

  const applyResolution = useCallback(
    (resolution: OrchestratorResolution, redactedKinds: RedactedKind[]) => {
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
    [drafts, t]
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

        let earnPositions: EarnSubjectSummary[] = [];
        const isEarnWithdraw =
          (output.op === 'set_intent' && output.action === 'earn' && output.earn_op === 'withdraw') ||
          (output.op === 'patch_slots' &&
            (output.patch.earn_op === 'withdraw' || previousClarifying?.draft.earnOp === 'withdraw') &&
            (output.patch.action === 'earn' || previousClarifying?.draft.action === 'earn'));
        if (isEarnWithdraw) {
          try {
            const [{ fetchEarnPositions }, { mapEarnPosition }] = await Promise.all([
              import('lib/epoch'),
              import('screens/earn-flow/earn-mapping')
            ]);
            const res = await fetchEarnPositions({ owners: [scope.accountId] });
            if (controller.signal.aborted) return;
            const listed = selectEarnVaults(bridgeConfig);
            earnPositions = res.positions
              .map(pos => mapEarnPosition(pos, listed))
              .map(mapped => ({
                id: mapped.id,
                name: mapped.name ?? mapped.protocol,
                symbol: mapped.asset,
                withdrawable: mapped.withdrawable,
                decimals: mapped.decimals
              }));
          } catch {
            earnPositions = [];
          }
        }

        const effectiveMap = output.op === 'patch_slots' ? activeMap : redaction.map;
        const resolution = compileOutputToResolution(
          output,
          effectiveMap,
          getWalletContext(earnPositions),
          output.op === 'patch_slots' ? previousClarifying?.draft : undefined
        );
        applyResolution(resolution, redactedKinds);
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
      bridgeConfig,
      getWalletContext,
      applyResolution
    ]
  );

  const activeRedactedKinds = state.kind === 'idle' ? [] : state.redactedKinds;
  const busy = state.kind === 'compiling';

  return (
    <section aria-label={t('commandAiBarLabel')} data-testid="command-ai-bar" className="min-w-0 lg:col-span-12">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-2.5 rounded-3xl border border-hairline bg-fill/75 px-5 py-3 shadow-sm transition-colors focus-within:border-accent-primary/60 focus-within:ring-2 focus-within:ring-accent-primary/20"
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

      {state.kind === 'clarifying' && (
        <div
          data-testid="command-ai-clarification"
          role="region"
          aria-label={t(state.questionKey, state.questionParams)}
          className="mt-2.5 flex flex-col gap-2.5 rounded-2xl border border-accent-tint-ink/25 bg-fill/85 px-4 py-3"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-body-sm font-medium text-ink">{t(state.questionKey, state.questionParams)}</p>
            <button
              type="button"
              onClick={dismiss}
              aria-label={t('close')}
              className="grid size-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-fill-pressed hover:text-ink"
            >
              <Icon name={IconName.Close} size="xs" aria-hidden="true" />
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {state.chips.map(chip => (
              <button
                key={chip.id}
                type="button"
                data-testid={`command-ai-chip-${chip.id}`}
                onClick={() => handleChipClick(chip)}
                className="inline-flex items-center gap-2 rounded-xl border border-hairline bg-page px-3 py-1.5 text-body-sm text-ink transition-colors hover:border-accent-primary/60 hover:bg-accent-tint focus-visible:outline-2 focus-visible:outline-accent-primary"
              >
                <span className="font-medium">{chip.label}</span>
                {chip.subtitle && <span className="text-caption text-muted">{chip.subtitle}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {state.kind === 'query_result' && (
        <div
          data-testid="command-ai-query-result"
          role="status"
          className="mt-2.5 flex flex-col gap-2 rounded-2xl border border-hairline bg-fill/85 px-4 py-3"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-label text-muted">{t(state.result.titleKey)}</p>
              <p className="text-title-tab font-semibold text-ink tabular-nums">
                {state.result.empty ? t('commandAiQueryEmpty') : state.result.summaryText}
              </p>
            </div>
            <button
              type="button"
              onClick={dismiss}
              aria-label={t('close')}
              className="grid size-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-fill-pressed hover:text-ink"
            >
              <Icon name={IconName.Close} size="xs" aria-hidden="true" />
            </button>
          </div>
          {state.result.rows.length > 0 && (
            <ul className="flex flex-col gap-1 border-t border-hairline pt-2">
              {state.result.rows.map(row => (
                <li key={row.id} className="flex items-center justify-between gap-3 text-body-sm">
                  <span className="truncate text-ink">{row.primaryText}</span>
                  {row.secondaryText && (
                    <span className="shrink-0 text-caption text-muted tabular-nums">{row.secondaryText}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-caption text-muted">{t('commandAiLocalOnlyNote')}</p>
        </div>
      )}

      {state.kind === 'error' && (
        <div
          data-testid="command-ai-error"
          role="alert"
          className="mt-2.5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-negative-tint-ink/30 bg-fill/85 px-4 py-3"
        >
          <p className="text-body-sm text-ink">{t(state.messageKey, state.messageParams)}</p>
          <div className="flex items-center gap-2">
            {state.fallbackAction && (
              <button
                type="button"
                data-testid="command-ai-fallback-open"
                onClick={() => navigate(COMMAND_DESTINATIONS[state.fallbackAction!])}
                className="rounded-xl border border-hairline bg-page px-3 py-1.5 text-body-sm font-medium text-ink hover:bg-fill-pressed focus-visible:outline-2 focus-visible:outline-accent-primary"
              >
                {t('commandAiOpenNativeForm')}
              </button>
            )}
            <button
              type="button"
              onClick={dismiss}
              aria-label={t('close')}
              className="grid size-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-fill-pressed hover:text-ink"
            >
              <Icon name={IconName.Close} size="xs" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
