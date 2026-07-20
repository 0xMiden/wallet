import React, { FC, useCallback, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { Input } from 'components/Input';
import { useAccount } from 'lib/miden/front';
import { hapticLight } from 'lib/mobile/haptics';
import { isValidGuardianUrl, sanitizeGuardianUrl } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';

interface Props {
  className?: string;
}

/**
 * Out-of-band guardian switch that `resolveGuardianDrift` couldn't
 * auto-resolve against a built-in operator (a custom operator). Prompts the
 * user for the new guardian's URL and only persists it once
 * `applyUserGuardianEndpoint` confirms it matches the on-chain guardian
 * commitment, so a wrong or malicious URL never gets written to the account.
 *
 * Self-gates on `guardianSyncStatus === 'needs-user-input'`: once a verified
 * endpoint is applied, the backend flips status back to `'in-sync'`, the
 * reactive account selector picks that up, and this returns null on its own
 * (matching PromptCarousel's "falsy children are filtered out" contract, the
 * same way ActivateHotKeyBanner disappears once its rotation lands).
 */
export const GuardianNeedsUrlBanner: FC<Props> = ({ className }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const applyUserGuardianEndpoint = useWalletStore(s => s.applyUserGuardianEndpoint);
  const [urlInput, setUrlInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // No `submitting`-guard here: the submit `Button` below is `disabled` while
  // submitting, which already makes this unreachable while a request is in
  // flight — a second internal guard would just be dead code.
  const onSubmit = useCallback(async () => {
    hapticLight();

    const sanitized = sanitizeGuardianUrl(urlInput);
    if (!isValidGuardianUrl(sanitized)) {
      setError(t('invalidUrl'));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const applied = await applyUserGuardianEndpoint(account.publicKey, sanitized);
      if (!applied) {
        setError(t('guardianUrlMismatch'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [account.publicKey, applyUserGuardianEndpoint, t, urlInput]);

  if (account.guardianSyncStatus !== 'needs-user-input') return null;

  return (
    <div className={classNames('w-full bg-surface-input rounded-10 flex flex-col gap-3 px-4 py-3', className)}>
      <div className="text-black">
        <div className="text-base font-bold font-heading leading-tight">{t('guardianChangedTitle')}</div>
        <div className="text-xs font-normal mt-1">{t('guardianChangedBody')}</div>
      </div>
      <Input
        id="guardian-needs-url-input"
        value={urlInput}
        placeholder={t('guardianEndpoint')}
        onChange={event => setUrlInput(event.target.value)}
      />
      {error && <p className="text-red-500 text-xs">{error}</p>}
      <Button
        title={submitting ? t('loading') : t('continue')}
        onClick={onSubmit}
        disabled={submitting}
        className="h-10"
      />
    </div>
  );
};

export default GuardianNeedsUrlBanner;
