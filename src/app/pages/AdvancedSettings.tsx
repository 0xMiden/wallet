import React, { FC, useCallback, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { useAccount } from 'lib/miden/front';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { resolvePublicKeyCommitments } from 'lib/miden/sdk/resolve-public-key-commitments';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import { navigate } from 'lib/woozie';
import { WalletType } from 'screens/onboarding/types';

const AdvancedSettings: FC = () => {
  const { t } = useTranslation();
  const walletAccount = useAccount();
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const { fieldRef, copy, copied } = useCopyToClipboard();
  const isGuardianAccount = walletAccount.type === WalletType.Guardian;

  const fetchPublicKey = useCallback(async () => {
    // Wrap WASM client operations in a lock to prevent concurrent access
    const key = await withWasmClientLock(async () => {
      const midenClient = await getMidenClient();
      const account = await midenClient.getAccount(walletAccount.publicKey);
      if (!account) {
        return null;
      }
      const publicKeyCommitments = resolvePublicKeyCommitments(account);
      if (publicKeyCommitments.length === 0) {
        return null;
      }
      return publicKeyCommitments[0]!.toHex().slice(2);
    });
    setPublicKey(key);
  }, [walletAccount.publicKey]);

  useEffect(() => {
    fetchPublicKey();
  }, [fetchPublicKey]);

  // No haptic here: DetailRow's action fires one on every tap.
  const handleCopy = useCallback(() => {
    if (!publicKey) return;
    copy();
  }, [publicKey, copy]);

  // No haptic here: ListRow fires one on every tap.
  const handleExportAccountFile = useCallback(() => {
    navigate('/settings/export-account-file');
  }, []);

  // Truncate to a chip-friendly form: 0x + first 6 + ... + last 4.
  // Until the WASM client resolves the key we render a non-breaking space so
  // the row keeps its height and doesn't jump on first paint.
  const truncatedPublicKey = publicKey ? `0x${publicKey.slice(0, 6)}...${publicKey.slice(-4)}` : ' ';

  return (
    <SubPageLayout data-testid="advanced-settings">
      <SubPageSection>
        <DetailCard>
          <DetailRow
            label={t('accountPublicKey')}
            data-testid="advanced-public-key"
            // Offered only once there is a key to copy.
            action={publicKey ? { label: t(copied ? 'copied' : 'copy'), onClick: handleCopy } : undefined}
          >
            <span className="font-mono text-sm select-text">{truncatedPublicKey}</span>
          </DetailRow>
        </DetailCard>
      </SubPageSection>

      <SubPageSection>
        <ListGroup>
          <ListRow
            title={t('editMidenFaucetId')}
            onClick={() => navigate('/settings/edit-miden-faucet-id')}
            chevron
            data-testid="advanced-edit-faucet-id"
          />
          {/* A Guardian account can never be exported: its auth entry is a platform-wrapped hot
              ciphertext, and the vault refuses it outright. Do not offer the action rather than let
              the user acknowledge the warning and spend a credential to reach a certain refusal. */}
          {!isGuardianAccount && (
            <ListRow
              title={t('exportAccountFile')}
              onClick={handleExportAccountFile}
              chevron
              data-testid="advanced-export-account-file"
            />
          )}
        </ListGroup>
      </SubPageSection>

      <input ref={fieldRef} value={publicKey ?? ''} readOnly className="sr-only" tabIndex={-1} />
    </SubPageLayout>
  );
};

export default AdvancedSettings;
