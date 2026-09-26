import React, { FC, useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { ErrorLine } from 'components/ui/ErrorLine';
import { SubPageSection } from 'components/ui/SubPageLayout';
import { initiateReplaceHotKeyTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';

/**
 * Proactive hot-key rotation. Cold-signed (recovery key); the on-chain proposal
 * swaps the hot signer commitment in-place via update_signers. The recovery
 * phrase is needed only when the wallet no longer stores it (removed, or a
 * hot-key-only Guardian import): the vault then asks for it before signing.
 *
 * A section of the Keys page rather than its footer: Keys is a list of places to
 * go, and this is one maintenance action among them (Guardian accounts only), so
 * it takes a compact `secondary` button under its own explanation instead of the
 * page's one primary CTA.
 */
const GuardianReplaceHotKey: FC = () => {
  const { t } = useTranslation();
  const currentAccount = useWalletStore(s => s.currentAccount);
  const seedPhraseStatus = useWalletStore(s => s.seedPhraseStatus);

  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = useCallback(async () => {
    if (!currentAccount) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const txId = await initiateReplaceHotKeyTransaction(
        currentAccount.publicKey,
        isDelegateProofEnabled(),
        zustandProvider
      );
      if (isExtension()) requestSWTransactionProcessing();
      navigate(`/generating-transaction-full/${encodeURIComponent(txId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [confirming, currentAccount]);

  return (
    <SubPageSection
      title={t('replaceHotKey')}
      data-testid="replace-hot-key-section"
      description={
        <>
          <p className="select-text">{t('replaceHotKeyDescription')}</p>
          {/* Ink, not muted: it is the question the second tap answers. */}
          {/* Same test as Vault.prepareRecoveryTransaction: anything but a stored phrase is prompted for. */}
          {confirming && (
            <p className="mt-2 select-text text-ink">
              {t(seedPhraseStatus === 'stored' ? 'replaceHotKeyConfirmation' : 'replaceHotKeyConfirmationSeedRequired')}
            </p>
          )}
        </>
      }
    >
      <Button
        type="button"
        variant={ButtonVariant.Ghost}
        size="sm"
        onClick={onClick}
        isLoading={submitting}
        disabled={!currentAccount || submitting}
        className="self-start"
        data-testid="replace-hot-key"
      >
        {confirming ? t('confirmReplaceHotKey') : t('replaceHotKey')}
      </Button>

      <ErrorLine className="mt-3">{error}</ErrorLine>
    </SubPageSection>
  );
};

export default GuardianReplaceHotKey;
