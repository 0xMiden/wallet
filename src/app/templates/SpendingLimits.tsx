import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { StrictActionAuthentication } from 'components/StrictActionAuthentication';
import { EmptyState } from 'components/ui/EmptyState';
import { ErrorLine } from 'components/ui/ErrorLine';
import { Notice } from 'components/ui/Notice';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { TextField } from 'components/ui/TextField';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { classifySpendingLimitChange } from 'lib/miden/spending-limits/change';
import { canonicalSpendingLimitIdentity } from 'lib/miden/spending-limits/identity';
import type {
  SpendingLimitConfiguration,
  SpendingLimitDraft,
  SpendingLimitAssetSnapshot
} from 'lib/miden/spending-limits/types';
import { useWalletStore } from 'lib/store';

// Mirrors the SDK's documented fungible-asset maximum used by transaction construction.
export const MAX_SPENDING_LIMIT = (1n << 63n) - (1n << 31n);

/** Parse user-entered native units without passing the amount through Number. */
export function parseSpendingLimitInput(value: string, decimals: number): bigint | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError('Invalid asset decimals');
  const match = /^(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) throw new RangeError('Invalid spending limit');
  // The mandatory `(\d+)` group: a successful match always carries it, so this is an assertion
  // rather than a fallback - a `??` here would read as a case that can happen.
  const integer = match[1]!;
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) throw new RangeError('Spending limit exceeds asset precision');
  const amount = BigInt(integer) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (amount <= 0n || amount > MAX_SPENDING_LIMIT) throw new RangeError('Spending limit is out of range');
  return amount;
}

interface SpendingLimitAsset {
  faucetId: string;
  asset: SpendingLimitAssetSnapshot;
  scaleKnown: boolean;
  configuration?: SpendingLimitConfiguration;
}

const mergeAssets = (
  balances: TokenBalanceData[],
  configurations: SpendingLimitConfiguration[]
): SpendingLimitAsset[] => {
  const rows = new Map<string, SpendingLimitAsset>();
  for (const balance of balances) {
    rows.set(canonicalSpendingLimitIdentity(balance.tokenId), {
      faucetId: balance.tokenId,
      asset: {
        symbol: balance.metadata.symbol,
        name: balance.metadata.name,
        decimals: balance.metadata.decimals
      },
      scaleKnown: hasKnownScale(balance.metadata)
    });
  }
  for (const configuration of configurations) {
    // The saved snapshot keeps a zero-balance or temporarily unresolved asset editable.
    rows.set(canonicalSpendingLimitIdentity(configuration.faucetId), {
      faucetId: configuration.faucetId,
      asset: configuration.asset,
      scaleKnown: true,
      configuration
    });
  }
  return [...rows.values()].sort(
    (left, right) => left.asset.symbol.localeCompare(right.asset.symbol) || left.faucetId.localeCompare(right.faucetId)
  );
};

const initialValue = (value: bigint | undefined, decimals: number): string =>
  value === undefined ? '' : formatSpendingLimitInput(value, decimals);

/**
 * Format a base-unit limit as a canonical decimal input value without precision loss.
 *
 * Deliberately NOT delegated to `lib/i18n/numbers`, although that module formats the same shape.
 * The repo ships an automatic manual mock for it (`__mocks__/lib/i18n/numbers.ts`) whose
 * `stringToBigInt` rounds through `parseFloat`, so a limit codec routed through that module is
 * either untested or tested against a stand-in that cannot represent the precision a limit needs.
 * The display formatter and the limit codec have different contracts; keeping them apart is the
 * point, not an oversight.
 */
export function formatSpendingLimitInput(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 || value < 0n) {
    throw new RangeError('Invalid spending limit');
  }
  if (decimals === 0) return value.toString();
  const digits = value.toString().padStart(decimals + 1, '0');
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return fraction === '' ? digits.slice(0, -decimals) : `${digits.slice(0, -decimals)}.${fraction}`;
}

interface SpendingLimitRowProps {
  accountId: string;
  row: SpendingLimitAsset;
  isCurrent: (accountId: string, faucetId: string, revision: string | undefined) => boolean;
  onSave: (
    draft: SpendingLimitDraft,
    revision: string | undefined,
    strictlyAuthenticated: boolean
  ) => Promise<SpendingLimitConfiguration | undefined>;
  onSaved: (accountId: string, faucetId: string, configuration: SpendingLimitConfiguration | undefined) => void;
}

const SpendingLimitRow: FC<SpendingLimitRowProps> = ({ accountId, row, isCurrent, onSave, onSaved }) => {
  const { t } = useTranslation();
  const configuration = row.configuration;
  const revision = configuration?.revision;
  const [daily, setDaily] = useState(() => initialValue(configuration?.dailyLimit, row.asset.decimals));
  const [weekly, setWeekly] = useState(() => initialValue(configuration?.weeklyLimit, row.asset.decimals));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const pendingDraftRef = useRef<SpendingLimitDraft>();
  const savingRef = useRef(false);
  const mountedRef = useRef(true);

  const initialDaily = initialValue(configuration?.dailyLimit, row.asset.decimals);
  const initialWeekly = initialValue(configuration?.weeklyLimit, row.asset.decimals);
  const dirty = daily !== initialDaily || weekly !== initialWeekly;

  useEffect(() => {
    mountedRef.current = true;
    setDaily(initialDaily);
    setWeekly(initialWeekly);
    setError(null);
    setAuthenticating(false);
    pendingDraftRef.current = undefined;
    return () => {
      mountedRef.current = false;
      pendingDraftRef.current = undefined;
    };
  }, [accountId, initialDaily, initialWeekly, revision, row.faucetId]);

  const persist = useCallback(
    async (draft: SpendingLimitDraft, strictlyAuthenticated: boolean) => {
      if (savingRef.current || !isCurrent(accountId, row.faucetId, revision)) return;
      savingRef.current = true;
      setSaving(true);
      setError(null);
      try {
        const saved = await onSave(draft, revision, strictlyAuthenticated);
        if (mountedRef.current && isCurrent(accountId, row.faucetId, revision)) {
          onSaved(accountId, row.faucetId, saved);
        }
      } catch {
        if (mountedRef.current) setError(t('spendingLimitSaveFailed'));
      } finally {
        savingRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    },
    [accountId, isCurrent, onSave, onSaved, revision, row.faucetId, t]
  );

  const prepareSave = useCallback(() => {
    if (!dirty || savingRef.current || !row.scaleKnown) return;
    let draft: SpendingLimitDraft;
    try {
      draft = {
        accountId,
        faucetId: row.faucetId,
        asset: row.asset,
        dailyLimit: parseSpendingLimitInput(daily, row.asset.decimals),
        weeklyLimit: parseSpendingLimitInput(weekly, row.asset.decimals)
      };
    } catch {
      setError(t('spendingLimitInvalidAmount'));
      return;
    }
    setError(null);
    if (classifySpendingLimitChange(configuration, draft) === 'strict-authentication') {
      pendingDraftRef.current = draft;
      setAuthenticating(true);
      return;
    }
    void persist(draft, false);
  }, [accountId, configuration, daily, dirty, persist, row.asset, row.faucetId, row.scaleKnown, t, weekly]);

  const handleAuthentication = useCallback(
    (result: 'authenticated' | 'cancelled') => {
      const draft = pendingDraftRef.current;
      pendingDraftRef.current = undefined;
      setAuthenticating(false);
      if (result === 'authenticated' && draft !== undefined) void persist(draft, true);
    },
    [persist]
  );

  return (
    // One section per asset: its symbol is the section label, its name the line under it, and the
    // two fields, the reason it cannot be edited and the save action are its content.
    <SubPageSection
      className="gap-4"
      title={row.asset.symbol}
      description={row.asset.name && row.asset.name !== row.asset.symbol ? row.asset.name : undefined}
    >
      <TextField
        type="text"
        inputMode="decimal"
        label={t('spendingLimitDaily')}
        aria-label={`${row.asset.symbol} ${t('spendingLimitDaily')}`}
        trailing={<span className="text-body text-muted">{row.asset.symbol}</span>}
        value={daily}
        disabled={!row.scaleKnown || saving}
        onChange={event => {
          setDaily(event.target.value);
          setError(null);
        }}
      />
      <TextField
        type="text"
        inputMode="decimal"
        label={t('spendingLimitWeekly')}
        aria-label={`${row.asset.symbol} ${t('spendingLimitWeekly')}`}
        trailing={<span className="text-body text-muted">{row.asset.symbol}</span>}
        value={weekly}
        disabled={!row.scaleKnown || saving}
        onChange={event => {
          setWeekly(event.target.value);
          setError(null);
        }}
      />
      {/* A standing condition, not something that just went wrong, so it is a note and not an alert. */}
      {!row.scaleKnown && <ErrorLine role="note">{t('spendingLimitUnknownDecimals')}</ErrorLine>}
      <ErrorLine>{error}</ErrorLine>
      {authenticating ? (
        <StrictActionAuthentication reason={t('spendingLimitAuthenticationReason')} onResult={handleAuthentication} />
      ) : (
        <Button
          title={t('spendingLimitSave')}
          disabled={!dirty || !row.scaleKnown || saving}
          isLoading={saving}
          onClick={prepareSave}
        />
      )}
    </SubPageSection>
  );
};

const SpendingLimits: FC = () => {
  const { t } = useTranslation();
  const currentAccount = useWalletStore(state => state.currentAccount);
  const accountId = currentAccount?.publicKey;
  const balances = useWalletStore(state => (accountId === undefined ? [] : (state.balances[accountId] ?? [])));
  const balancesLoading = useWalletStore(state =>
    accountId === undefined ? false : (state.balancesLoading[accountId] ?? false)
  );
  const listSpendingLimits = useWalletStore(state => state.listSpendingLimits);
  const saveSpendingLimit = useWalletStore(state => state.saveSpendingLimit);
  const [configurations, setConfigurations] = useState<SpendingLimitConfiguration[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const loadGenerationRef = useRef(0);
  const accountRef = useRef(accountId);
  accountRef.current = accountId;
  const revisionsRef = useRef(new Map<string, string>());
  // Authentication may settle after a store update, so saving rechecks both identities.
  revisionsRef.current = new Map(configurations.map(configuration => [configuration.faucetId, configuration.revision]));

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    setConfigurations([]);
    setLoadError(false);
    if (accountId === undefined) {
      setLoading(false);
      setLoadError(true);
      return;
    }
    setLoading(true);
    void listSpendingLimits(accountId)
      .then(next => {
        if (loadGenerationRef.current !== generation || accountRef.current !== accountId) return;
        setConfigurations(next);
        setLoading(false);
      })
      .catch(() => {
        if (loadGenerationRef.current !== generation || accountRef.current !== accountId) return;
        setLoading(false);
        setLoadError(true);
      });
  }, [accountId, listSpendingLimits]);

  const rows = useMemo(() => mergeAssets(balances, configurations), [balances, configurations]);

  const isCurrent = useCallback((expectedAccount: string, faucetId: string, revision: string | undefined) => {
    return accountRef.current === expectedAccount && revisionsRef.current.get(faucetId) === revision;
  }, []);

  const handleSaved = useCallback(
    (expectedAccount: string, faucetId: string, saved: SpendingLimitConfiguration | undefined) => {
      if (accountRef.current !== expectedAccount) return;
      setConfigurations(current => {
        const remaining = current.filter(configuration => configuration.faucetId !== faucetId);
        return saved === undefined ? remaining : [...remaining, saved];
      });
    },
    []
  );

  return (
    <SubPageLayout data-testid="spending-limits-settings">
      <Notice tone="neutral">
        <span className="flex flex-col gap-2">
          <span>{t('spendingLimitLocalDisclosure')}</span>
          <span>{t('spendingLimitNotOnChain')}</span>
        </span>
      </Notice>
      {loading || balancesLoading ? (
        <Notice variant="inline" role="status">
          {t('loading')}
        </Notice>
      ) : loadError ? (
        <ErrorLine>{t('spendingLimitLoadFailed')}</ErrorLine>
      ) : rows.length === 0 || accountId === undefined ? (
        <EmptyState icon={IconName.Wallet} title={t('spendingLimitNoAssets')} />
      ) : (
        rows.map(row => (
          <SpendingLimitRow
            key={`${accountId}:${row.faucetId}`}
            accountId={accountId}
            row={row}
            isCurrent={isCurrent}
            onSave={saveSpendingLimit}
            onSaved={handleSaved}
          />
        ))
      )}
    </SubPageLayout>
  );
};

export default SpendingLimits;
