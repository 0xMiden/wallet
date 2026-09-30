import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { AmountInput } from 'components/AmountInput';
import { Button } from 'components/Button';
import { StrictActionAuthentication } from 'components/StrictActionAuthentication';
import { ErrorLine } from 'components/ui/ErrorLine';
import { FactRow, IconCircle } from 'components/ui/FactRow';
import { ListGroup } from 'components/ui/ListGroup';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { SegmentedControl, SegmentedControlItem } from 'components/ui/SegmentedControl';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { formatUsd } from 'lib/i18n/numbers';
import { classifySpendingLimitChange } from 'lib/miden/spending-limits/change';
import type { SpendingLimitConfiguration, SpendingLimitDraft } from 'lib/miden/spending-limits/types';
import { useWalletStore } from 'lib/store';

// Mirrors the SDK's documented fungible-asset maximum used by transaction construction.
export const MAX_SPENDING_LIMIT = (1n << 63n) - (1n << 31n);

/** Dollars carry two decimal places on screen and six in storage. */
const USD_INPUT_DECIMALS = 2;
const USD_STORAGE_DECIMALS = 6;

/** Parse a user-entered dollar amount into micro-dollars without passing it through Number. */
export function parseUsdLimitInput(value: string): bigint | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const match = /^(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) throw new RangeError('Invalid spending limit');
  // The mandatory `(\d+)` group: a successful match always carries it, so this is an assertion
  // rather than a fallback - a `??` here would read as a case that can happen.
  const integer = match[1]!;
  const fraction = match[2] ?? '';
  if (fraction.length > USD_INPUT_DECIMALS) throw new RangeError('Spending limit exceeds cent precision');
  const scale = 10n ** BigInt(USD_STORAGE_DECIMALS);
  const amount = BigInt(integer) * scale + BigInt(fraction.padEnd(USD_STORAGE_DECIMALS, '0') || '0');
  if (amount <= 0n || amount > MAX_SPENDING_LIMIT) throw new RangeError('Spending limit is out of range');
  return amount;
}

const initialValue = (value: bigint | undefined): string => (value === undefined ? '' : formatUsdLimitInput(value));

/**
 * Format a micro-dollar limit as a canonical two-decimal input value without precision loss.
 *
 * Deliberately NOT delegated to `lib/i18n/numbers`, although that module formats the same shape.
 * The repo ships an automatic manual mock for it (`__mocks__/lib/i18n/numbers.ts`) whose
 * `stringToBigInt` rounds through `parseFloat`, so a limit codec routed through that module is
 * either untested or tested against a stand-in that cannot represent the precision a limit needs.
 * The display formatter and the limit codec have different contracts; keeping them apart is the
 * point, not an oversight.
 */
export function formatUsdLimitInput(value: bigint): string {
  if (value < 0n) throw new RangeError('Invalid spending limit');
  const digits = value.toString().padStart(USD_STORAGE_DECIMALS + 1, '0');
  const integerPart = digits.slice(0, -USD_STORAGE_DECIMALS);
  const fraction = digits.slice(-USD_STORAGE_DECIMALS, digits.length - USD_STORAGE_DECIMALS + USD_INPUT_DECIMALS);
  const trimmedFraction = fraction.replace(/0+$/, '');
  return trimmedFraction === '' ? integerPart : `${integerPart}.${trimmedFraction}`;
}

/** Whole-dollar limits offered as one-tap choices; typing any other amount leaves none selected. */
const PRESET_LIMITS = ['100', '500', '1000', '5000'] as const;

/** A limit as the page shows it: whole dollars without cents ("$1,000"), a fractional one with them. */
const formatLimitUsd = (amount: string): string =>
  amount.includes('.') ? formatUsd(Number(amount)) : `$${Number(amount).toLocaleString('en-US')}`;

interface PendingSave {
  draft: SpendingLimitDraft;
  expectedAccount: string;
  expectedRevision: string | undefined;
}

const SpendingLimits: FC = () => {
  const { t } = useTranslation();
  const currentAccount = useWalletStore(state => state.currentAccount);
  const accountId = currentAccount?.publicKey;
  const readSpendingLimit = useWalletStore(state => state.readSpendingLimit);
  const saveSpendingLimit = useWalletStore(state => state.saveSpendingLimit);

  const [configuration, setConfiguration] = useState<SpendingLimitConfiguration | undefined>(undefined);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const loadGenerationRef = useRef(0);
  const accountRef = useRef(accountId);
  accountRef.current = accountId;
  const revisionRef = useRef<string | undefined>(undefined);
  // Authentication may settle after a store update, so saving rechecks both identities.
  revisionRef.current = configuration?.revision;
  const pendingSaveRef = useRef<PendingSave>();
  const savingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    setConfiguration(undefined);
    setValue('');
    setError(null);
    setAuthenticating(false);
    setLoadError(false);
    pendingSaveRef.current = undefined;
    if (accountId === undefined) {
      setLoading(false);
      setLoadError(true);
      return;
    }
    setLoading(true);
    void readSpendingLimit(accountId)
      .then(next => {
        if (loadGenerationRef.current !== generation || accountRef.current !== accountId) return;
        setConfiguration(next);
        setValue(initialValue(next?.limit));
        setLoading(false);
      })
      .catch(() => {
        if (loadGenerationRef.current !== generation || accountRef.current !== accountId) return;
        setLoading(false);
        setLoadError(true);
      });
  }, [accountId, readSpendingLimit]);

  const isCurrent = useCallback(
    (expectedAccount: string, expectedRevision: string | undefined) =>
      accountRef.current === expectedAccount && revisionRef.current === expectedRevision,
    []
  );

  const persist = useCallback(
    async (
      draft: SpendingLimitDraft,
      expectedAccount: string,
      expectedRevision: string | undefined,
      strictlyAuthenticated: boolean
    ) => {
      if (savingRef.current || !isCurrent(expectedAccount, expectedRevision)) return;
      savingRef.current = true;
      setSaving(true);
      setError(null);
      try {
        const saved = await saveSpendingLimit(draft, expectedRevision, strictlyAuthenticated);
        if (mountedRef.current && isCurrent(expectedAccount, expectedRevision)) {
          setConfiguration(saved);
          setValue(initialValue(saved?.limit));
        }
      } catch {
        if (mountedRef.current) setError(t('spendingLimitSaveFailed'));
      } finally {
        savingRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    },
    [isCurrent, saveSpendingLimit, t]
  );

  const dirty = value !== initialValue(configuration?.limit);

  const presetItems = useMemo<SegmentedControlItem[]>(
    () => PRESET_LIMITS.map(preset => ({ id: preset, label: formatLimitUsd(preset) })),
    []
  );

  const prepareSave = useCallback(() => {
    if (!dirty || savingRef.current || accountId === undefined) return;
    const expectedAccount = accountId;
    const expectedRevision = configuration?.revision;
    if (!isCurrent(expectedAccount, expectedRevision)) return;
    let limit: bigint | undefined;
    try {
      limit = parseUsdLimitInput(value);
    } catch {
      setError(t('spendingLimitInvalidAmount'));
      return;
    }
    setError(null);
    const draft: SpendingLimitDraft = { accountId: expectedAccount, limit };
    if (classifySpendingLimitChange(configuration, draft) === 'strict-authentication') {
      pendingSaveRef.current = { draft, expectedAccount, expectedRevision };
      setAuthenticating(true);
      return;
    }
    void persist(draft, expectedAccount, expectedRevision, false);
  }, [accountId, configuration, dirty, isCurrent, persist, t, value]);

  const handleAuthentication = useCallback(
    (result: 'authenticated' | 'cancelled') => {
      const pending = pendingSaveRef.current;
      pendingSaveRef.current = undefined;
      setAuthenticating(false);
      if (result === 'authenticated' && pending !== undefined) {
        void persist(pending.draft, pending.expectedAccount, pending.expectedRevision, true);
      }
    },
    [persist]
  );

  const ready = !loading && !loadError;
  const currentLimit = configuration === undefined ? undefined : formatLimitUsd(initialValue(configuration.limit));

  return (
    <SubPageLayout
      data-testid="spending-limits-settings"
      footer={
        ready && !authenticating ? (
          <Button
            title={t('spendingLimitSave')}
            className="max-w-none"
            disabled={!dirty || saving}
            isLoading={saving}
            onClick={prepareSave}
          />
        ) : undefined
      }
    >
      {loading ? (
        <Notice variant="inline" role="status">
          {t('loading')}
        </Notice>
      ) : loadError ? (
        <ErrorLine>{t('spendingLimitLoadFailed')}</ErrorLine>
      ) : (
        <SubPageSection className="gap-4">
          <AmountInput
            align="center"
            showDivider={false}
            className="pt-4"
            prefix="$"
            placeholder="0"
            aria-label={t('spendingLimitUsdCap')}
            helper={<span className="text-body-sm text-muted">{t('spendingLimitUsdCap')}</span>}
            value={value}
            invalid={!!error}
            disabled={saving}
            onValueChange={next => {
              setValue(next ?? '');
              setError(null);
            }}
          />
          <ErrorLine>{error}</ErrorLine>
          <Pill
            className="self-center"
            tone={currentLimit !== undefined ? 'positive' : 'neutral'}
            icon={currentLimit !== undefined && <Icon name={IconName.Checkmark} size="xs" fill="currentColor" />}
          >
            {currentLimit !== undefined ? t('spendingLimitCurrent', { amount: currentLimit }) : t('spendingLimitNone')}
          </Pill>
          {authenticating ? (
            <StrictActionAuthentication
              reason={t('spendingLimitAuthenticationReason')}
              onResult={handleAuthentication}
            />
          ) : (
            <SegmentedControl
              aria-label={t('spendingLimitPresets')}
              layout="fill"
              items={presetItems}
              value={value}
              onChange={preset => {
                setValue(preset);
                setError(null);
              }}
            />
          )}
        </SubPageSection>
      )}
      {!authenticating && (
        <SubPageSection title={t('spendingLimitHowItWorks')} titleSize="md">
          <ListGroup surface="plain" insetHairlines>
            <FactRow
              leading={
                <IconCircle>
                  <Icon name={IconName.Lock} size="xs" fill="currentColor" />
                </IconCircle>
              }
              title={t('spendingLimitStoredOnDevice')}
              description={t('spendingLimitLocalDisclosure')}
            />
            <FactRow
              leading={
                <IconCircle>
                  <Icon name={IconName.Key} size="xs" fill="currentColor" />
                </IconCircle>
              }
              title={t('spendingLimitLocalSafetyCheck')}
              description={t('spendingLimitNotOnChain')}
            />
            <FactRow
              leading={
                <IconCircle>
                  <Icon name={IconName.Coins} size="xs" fill="currentColor" />
                </IconCircle>
              }
              title={t('spendingLimitPricedAssetsOnly')}
              description={t('spendingLimitCoverage')}
            />
          </ListGroup>
        </SubPageSection>
      )}
    </SubPageLayout>
  );
};

export default SpendingLimits;
