import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { Input } from 'components/Input';
import { StrictActionAuthentication } from 'components/StrictActionAuthentication';
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

  return (
    <div className="w-full flex flex-col gap-4 pb-6" data-testid="spending-limits-settings">
      <div className="rounded-xl bg-fill p-4 flex flex-col gap-2">
        <p className="text-sm text-muted">{t('spendingLimitLocalDisclosure')}</p>
        <p className="text-sm text-muted">{t('spendingLimitNotOnChain')}</p>
        <p className="text-sm text-muted">{t('spendingLimitCoverage')}</p>
      </div>
      {loading ? (
        <p role="status" className="text-sm text-text-secondary-token">
          {t('loading')}
        </p>
      ) : loadError ? (
        <p role="alert" className="text-sm text-status-negative">
          {t('spendingLimitLoadFailed')}
        </p>
      ) : (
        <section className="rounded-xl border border-border-faint bg-white p-4 flex flex-col gap-4">
          <Input
            type="text"
            inputMode="decimal"
            label={t('spendingLimitUsdCap')}
            aria-label={t('spendingLimitUsdCap')}
            prefix="$"
            value={value}
            disabled={saving}
            onChange={event => {
              setValue(event.target.value);
              setError(null);
            }}
          />
          {error && (
            <p role="alert" className="text-sm text-status-negative">
              {error}
            </p>
          )}
          {authenticating ? (
            <StrictActionAuthentication
              reason={t('spendingLimitAuthenticationReason')}
              onResult={handleAuthentication}
            />
          ) : (
            <Button
              title={t('spendingLimitSave')}
              disabled={!dirty || saving}
              isLoading={saving}
              onClick={prepareSave}
            />
          )}
        </section>
      )}
    </div>
  );
};

export default SpendingLimits;
