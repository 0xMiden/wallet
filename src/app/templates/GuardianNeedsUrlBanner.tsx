import React, { FC, useCallback, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useGuardianPresentation } from 'app/hooks/useGuardianPresentation';
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
  // The render gate reads the shared derivation, not the raw field — the drift
  // prompt fires exactly when `deriveGuardianPresentation` says it should, on
  // every surface that offers it.
  const presentation = useGuardianPresentation();
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
      // Only `'mismatch'` is evidence against the URL the user just typed. An
      // operator that never answered — cold-starting, self-hosted, briefly down
      // — is indistinguishable from a correct URL, and telling that user they
      // named the wrong operator sends them away from the one prompt that can
      // repair this account. `'no-onchain-guardian'` is not about the URL at
      // all: the account has no guardian commitment to check anything against.
      const outcome = await applyUserGuardianEndpoint(account.publicKey, sanitized);
      if (outcome === 'mismatch') {
        setError(t('guardianUrlMismatch'));
      } else if (outcome === 'unreachable') {
        setError(t('guardianUrlUnreachable'));
      } else if (outcome === 'no-onchain-guardian') {
        setError(t('guardianUrlNoOnChainGuardian'));
      }
    } catch (e) {
      // Shape-based, then localized — same reasoning as RotateGuardianReview's
      // catch. `applyUserGuardianEndpoint` crosses the intercom boundary, which
      // may serialize the rejection and drop its prototype: an `instanceof Error`
      // gate sends a perfectly good `message` to `String(e)`, and a rejection
      // with no message at all renders "[object Object]" into the one line the
      // user has to work out why their recovery attempt failed.
      setError(
        typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string'
          ? e.message
          : typeof e === 'string'
            ? e
            : t('smthWentWrong')
      );
    } finally {
      setSubmitting(false);
    }
  }, [account.publicKey, applyUserGuardianEndpoint, t, urlInput]);

  if (presentation.prompt !== 'needs-user-input') return null;

  return (
    <div className={classNames('w-full bg-surface-input rounded-10 flex flex-col gap-3 px-4 py-3', className)}>
      <div className="text-black">
        <div className="text-base font-bold font-heading leading-tight">{t('guardianChangedTitle')}</div>
        <div className="text-xs font-normal mt-1">{t('guardianChangedBody')}</div>
      </div>
      <Input
        id="guardian-needs-url-input"
        value={urlInput}
        inputMode="url"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder={t('guardianEndpoint')}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
        onChange={event => setUrlInput(event.target.value)}
      />
      {/* `role="alert"` because this line is the only feedback the recovery path
          has, and it appears AFTER a submit rather than being present at render:
          without a live region a screen-reader user gets silence and a button
          that just re-enabled itself. Matches the rotate-review error block. */}
      {error && (
        <p role="alert" className="text-red-500 text-xs wrap-break-word">
          {error}
        </p>
      )}
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
