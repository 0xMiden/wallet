import React, { FC, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { SubmitHandler, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import Alert from 'app/atoms/Alert';
import FormField from 'app/atoms/FormField';
import AccountBanner from 'app/templates/AccountBanner';
import { Button, ButtonVariant } from 'components/Button';
import { Vault } from 'lib/miden/back/vault';
import { useAccount, useSecretState, useMidenContext } from 'lib/miden/front';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';
import { isMobile } from 'lib/platform';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';

const SUBMIT_ERROR_TYPE = 'submit-error';

type FormData = {
  password: string;
};

type RevealSecretProps = {
  reveal: 'private-key' | 'seed-phrase' | 'hot-key' | 'guardian-keys';
};

type GuardianKeysBundle = {
  coldPrivateKey: string;
  coldPublicKey: string;
  hotPublicKey?: string;
};

const RevealSecret: FC<RevealSecretProps> = ({ reveal }) => {
  const { t } = useTranslation();
  const { revealMnemonic, revealPrivateKey, revealHotKey, revealGuardianKeys } = useMidenContext();
  const account = useAccount();
  const { fieldRef: secretFieldRef } = useCopyToClipboard();

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    watch,
    formState: { errors, isSubmitting }
  } = useForm<FormData>();

  const passwordValue = watch('password');
  const [secret, setSecret] = useSecretState();
  const [guardianBundle, setGuardianBundle] = useState<GuardianKeysBundle | null>(null);
  const [hasHardwareProtector, setHasHardwareProtector] = useState<boolean | null>(null);
  // The native iOS / Android navbar pill renders in a separate UIWindow / Dialog
  // above the WebView, so any content at the bottom of this page (notably the
  // Unlock button on hardware-protected wallets, where there's no password
  // input to push the button up) gets z-covered and becomes unclickable.
  // Morph the pill out while the reveal screen is mounted; restores on unmount.
  useHideNavbarWhileOpen(true);
  // Private-key + guardian-keys reveals require the user to tick an "I
  // understand" checkbox before the Continue button enables. The warning
  // banner alone is passive; this gate forces one deliberate interaction
  // before handing out recovery material. Hot-key reveal skips the gate
  // because hot keys rotate from Settings → Rotate Device Key.
  const [privateKeyAcknowledged, setPrivateKeyAcknowledged] = useState(false);
  const requiresAcknowledge = reveal === 'private-key' || reveal === 'guardian-keys';

  useEffect(() => {
    Vault.hasHardwareProtector().then(setHasHardwareProtector);
  }, []);

  useEffect(() => {
    if (account.publicKey) {
      return () => {
        setSecret(null);
        setGuardianBundle(null);
      };
    }
    return undefined;
  }, [account.publicKey, setSecret]);

  useEffect(() => {
    if (secret && !isMobile()) {
      secretFieldRef.current?.focus();
      secretFieldRef.current?.select();
    }
  }, [secret, secretFieldRef]);

  const formRef = useRef<HTMLFormElement>(null);

  const focusPasswordField = useCallback(() => {
    formRef.current?.querySelector<HTMLInputElement>("input[name='password']")?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!isMobile()) {
      focusPasswordField();
    }
  }, [focusPasswordField]);

  const onSubmit = useCallback<SubmitHandler<FormData>>(
    async ({ password }) => {
      if (isSubmitting) return;

      clearErrors('password');
      try {
        const unlockPassword = hasHardwareProtector ? undefined : password;
        if (reveal === 'private-key') {
          const pubKeyCommitment = await getAccountPublicKeyCommitment(account.publicKey);
          setSecret(await revealPrivateKey(pubKeyCommitment, unlockPassword));
        } else if (reveal === 'hot-key') {
          setSecret(await revealHotKey(account.publicKey, unlockPassword));
        } else if (reveal === 'guardian-keys') {
          setGuardianBundle(await revealGuardianKeys(account.publicKey, unlockPassword));
        } else {
          setSecret(await revealMnemonic(unlockPassword));
        }
      } catch (err: any) {
        console.error(err);

        // Human delay.
        await new Promise(res => setTimeout(res, 300));
        setError('password', { type: SUBMIT_ERROR_TYPE, message: err.message });
        if (!hasHardwareProtector) focusPasswordField();
      }
    },
    [
      isSubmitting,
      clearErrors,
      setError,
      revealMnemonic,
      revealPrivateKey,
      revealHotKey,
      revealGuardianKeys,
      setSecret,
      focusPasswordField,
      hasHardwareProtector,
      reveal,
      account.publicKey
    ]
  );

  const texts = useMemo(() => {
    switch (reveal) {
      case 'private-key':
        return {
          name: t('privateKey'),
          accountBanner: (
            <AccountBanner labelDescription={t('ifYouWantToRevealPrivateKeyFromOtherAccount')} className="mb-6" />
          ),
          attention: (
            <div className="flex flex-col text-left text-black">
              <span className="font-medium" style={{ fontSize: '14px', lineHeight: '20px', marginBottom: '4px' }}>
                {t('doNotSharePrivateKey1')} <br />
              </span>
              <span className="text-xs">{t('doNotSharePrivateKey2')}</span>
            </div>
          ),
          fieldDesc: t('privateKeyFieldDescription')
        };

      case 'seed-phrase':
        return {
          name: t('seedPhrase'),
          accountBanner: null,
          attention: null,
          fieldDesc: (
            <div className="flex flex-col text-heading-gray text-sm gap-3">
              <p className="">{t('seedPhraseDescription')}</p>
              <p className="font-bold">{t('doNotShareWithAnyone')}</p>
              <p className="">
                {t('anyoneCanTakeAssets')} <span className="font-bold">{t('keepSeedPhraseSecret')}</span>
              </p>
            </div>
          )
        };

      case 'hot-key':
        return {
          name: t('hotPrivateKey'),
          accountBanner: null,
          attention: null,
          fieldDesc: <div className="text-heading-gray text-sm">{t('revealHotKeyDescription')}</div>
        };

      case 'guardian-keys':
        return {
          name: t('coldPrivateKey'),
          accountBanner: null,
          attention: null,
          fieldDesc: <div className="text-heading-gray text-sm">{t('guardianKeysRevealDescription')}</div>
        };
    }
  }, [reveal, t]);

  const mainContent = useMemo(() => {
    if (guardianBundle) {
      return (
        <div className="pt-8 flex flex-col gap-6">
          <FormField
            ref={secretFieldRef}
            secret
            textarea
            rows={3}
            readOnly
            label={t('coldPrivateKey')}
            labelClassName="text-base/[20px] font-semibold text-heading-gray mb-0"
            labelDescription={<div className="mb-3">{texts.fieldDesc}</div>}
            id="reveal-guardian-cold-private"
            spellCheck={false}
            className="resize-none notranslate"
            value={guardianBundle.coldPrivateKey}
          />
          <FormField
            textarea
            rows={2}
            readOnly
            label={t('coldPublicKeyLabel')}
            labelClassName="text-base/[20px] font-semibold text-heading-gray mb-0"
            id="reveal-guardian-cold-public"
            spellCheck={false}
            className="resize-none notranslate"
            value={guardianBundle.coldPublicKey}
          />
          {guardianBundle.hotPublicKey && (
            <FormField
              textarea
              rows={2}
              readOnly
              label={t('hotPublicKeyLabel')}
              labelClassName="text-base/[20px] font-semibold text-heading-gray mb-0"
              id="reveal-guardian-hot-public"
              spellCheck={false}
              className="resize-none notranslate"
              value={guardianBundle.hotPublicKey}
            />
          )}
        </div>
      );
    }

    if (secret) {
      return (
        <div className="pt-8">
          <FormField
            ref={secretFieldRef}
            secret
            textarea
            rows={4}
            readOnly
            label={texts.name}
            labelClassName="text-base/[20px] font-semibold text-heading-gray mb-t0"
            labelDescription={<div className="mb-3">{texts.fieldDesc}</div>}
            id="reveal-secret-secret"
            spellCheck={false}
            className="resize-none notranslate"
            value={secret}
          />
        </div>
      );
    }

    return (
      <form ref={formRef} onSubmit={handleSubmit(onSubmit)}>
        {hasHardwareProtector ? (
          <>
            <p className="text-sm text-heading-gray pt-8 mb-4">
              {t('revealSecretUnlockDescription', { secretName: texts.name })}
            </p>
            {errors.password && (
              <Alert
                type="error"
                title={t('error')}
                description={errors.password.message || ''}
                className="mb-4 rounded-lg text-black"
              />
            )}
          </>
        ) : (
          <FormField
            {...register('password', { required: t('required') })}
            label={t('password')}
            labelDescription={t('revealSecretPasswordInputDescription', { secretName: texts.name })}
            id="reveal-secret-password"
            type="password"
            name="password"
            placeholder="********"
            errorCaption={errors.password?.message}
            containerClassName="mb-4 pt-8"
            onChange={e => {
              register('password').onChange(e);
              clearErrors();
            }}
          />
        )}
      </form>
    );
  }, [
    errors,
    onSubmit,
    register,
    secret,
    guardianBundle,
    texts,
    clearErrors,
    secretFieldRef,
    t,
    hasHardwareProtector,
    handleSubmit
  ]);

  const showButton = !secret && !guardianBundle;

  if (hasHardwareProtector === null) {
    return null;
  }

  return (
    <div className="w-full max-w-sm mx-auto flex flex-col flex-1 min-h-0">
      {texts.accountBanner}

      {requiresAcknowledge && showButton && (
        <>
          <Alert
            type="warn"
            title={t('privateKeyRevealWarningTitle')}
            description={<p>{t('privateKeyRevealWarningBody')}</p>}
            className="mb-4 rounded-lg"
          />
          <label className="mb-4 flex items-start gap-2 text-sm text-black cursor-pointer select-none">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={privateKeyAcknowledged}
              onChange={e => setPrivateKeyAcknowledged(e.target.checked)}
            />
            <span>{t('privateKeyRevealAcknowledge')}</span>
          </label>
        </>
      )}

      {reveal === 'hot-key' && showButton && (
        <Alert
          type="warn"
          title={t('hotKeyRevealWarningTitle')}
          description={<p>{t('hotKeyRevealWarningBody')}</p>}
          className="mb-4 rounded-lg"
        />
      )}

      {mainContent}

      {showButton && (
        <div className="mt-auto pb-8">
          <Button
            className="w-full justify-center"
            variant={ButtonVariant.Primary}
            title={t(hasHardwareProtector ? 'unlock' : 'continue')}
            disabled={
              isSubmitting ||
              (requiresAcknowledge && !privateKeyAcknowledged) ||
              (hasHardwareProtector ? false : !passwordValue)
            }
            isLoading={isSubmitting}
            onClick={hasHardwareProtector ? () => onSubmit({ password: '' }) : handleSubmit(onSubmit)}
          />
        </div>
      )}
    </div>
  );
};

export default RevealSecret;

// Returns the hex-encoded auth public-key commitment for an account.
// This is the key under which the vault stores the matching secret key —
// distinct from the account's bech32 id (`WalletAccount.publicKey`), which
// identifies the account on-chain.
const getAccountPublicKeyCommitment = async (accPublicKey: string): Promise<string> => {
  const commitmentHex = await withWasmClientLock(async () => {
    const client = await getMidenClient();
    const account = await client.getAccount(accPublicKey);
    if (!account) {
      throw new Error('Account not found');
    }
    const commitments = account.getPublicKeyCommitments();
    if (commitments.length === 0) {
      throw new Error('Account has no public key');
    }
    return commitments[0]!.toHex();
  });
  return commitmentHex.startsWith('0x') ? commitmentHex.slice(2) : commitmentHex;
};
