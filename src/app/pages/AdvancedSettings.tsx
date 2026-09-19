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

const AdvancedSettings: FC = () => {
  const { t } = useTranslation();
  const walletAccount = useAccount();
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const { fieldRef, copy, copied } = useCopyToClipboard();

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
        </ListGroup>
      </SubPageSection>

      <input ref={fieldRef} value={publicKey ?? ''} readOnly className="sr-only" tabIndex={-1} />
    </SubPageLayout>
  );
};

export default AdvancedSettings;
