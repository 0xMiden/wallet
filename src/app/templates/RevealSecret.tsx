import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SubmitHandler, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { PasscodeEntry } from 'components/PasscodeEntry';
import { PrivateKeyPair } from 'components/PrivateKeyPair';
import { CheckboxConsent } from 'components/ui/Checkbox';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Notice } from 'components/ui/Notice';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { TextField } from 'components/ui/TextField';
import { Vault } from 'lib/miden/back/vault';
import { useAccount, useSecretState, useMidenContext } from 'lib/miden/front';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { resolvePublicKeyCommitments } from 'lib/miden/sdk/resolve-public-key-commitments';
import { useScreenshotGuard } from 'lib/mobile/screenshot-guard';
import { useHideDappBubblesWhileOpen } from 'lib/mobile/useHideDappBubblesWhileOpen';
import { isMobile } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import { truncateAddress } from 'utils/string';

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

// `font-sans` on every secret field below. Preflight sets `font: inherit` on
// form controls, so a textarea with no font of its own picks up whatever the
// page around it sets — and this page is rendered inside Settings' `font-heading`.
const secretFieldClassName = 'notranslate font-sans';

const RevealSecret: FC<RevealSecretProps> = ({ reveal }) => {
  const { t } = useTranslation();
  const secretGeneration = useRef(0);
  const seedStatus = useWalletStore(s => s.seedPhraseStatus);
  const revealUnavailable = Boolean(seedStatus && seedStatus !== 'stored' && reveal !== 'hot-key');
  useEffect(
    () => () => {
      secretGeneration.current += 1;
    },
    [seedStatus]
  );
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
  useEffect(() => {
    if (revealUnavailable) {
      setSecret(null);
      setGuardianBundle(null);
    }
  }, [revealUnavailable, setSecret]);
  // Block screenshots / screen recordings while raw key material is on screen
  // (#417) — the same protection `RevealSeedPhrase` already has, for material of
  // equal sensitivity: a private key, a Guardian COLD private key (the account's
  // recovery material) or a hot key all confer spending authority. `FormField`'s
  // `secret` prop only blurs the value while the field is unfocused; once tapped
  // the plaintext sits in an ordinary DOM textarea, which is exactly what a
  // screenshot, an Android task-switcher thumbnail or a live screen recording
  // captures. The hook withholds `true` until the native guard is actually
  // enabled, so the unprotected first frames are never rendered.
  const isGuardReady = useScreenshotGuard(secret !== null || guardianBundle !== null);
  const [hasHardwareProtector, setHasHardwareProtector] = useState<boolean | null>(null);
  // Keep parked dApp trays out of the way while the reveal screen is mounted.
  useHideDappBubblesWhileOpen(true);
  // Private-key + guardian-keys reveals require the user to tick an "I
  // understand" checkbox before the Continue button enables. The warning
  // banner alone is passive; this gate forces one deliberate interaction
  // before handing out recovery material. Hot-key reveal skips the gate
  // because hot keys rotate from Settings → Rotate Device Key.
  const [privateKeyAcknowledged, setPrivateKeyAcknowledged] = useState(false);
  const requiresAcknowledge = reveal === 'private-key' || reveal === 'guardian-keys';
  // Non-hardware mobile wallets are protected by the 6-digit passcode set
  // during onboarding, so prompt with the numpad; extension/desktop vault
  // secrets are typed passwords.
  const usePasscodeEntry = isMobile() && hasHardwareProtector === false;

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

  // `hasHardwareProtector` is a dependency because this component renders `null`
  // until it resolves. Without it the effect ran once, against that first empty
  // commit where `formRef.current` was still null, and never again — its only
  // other dependency being a `useCallback` with an empty dep list. So the field
  // was never actually focused on desktop.
  //
  // A passive effect rather than a layout effect, so that it lands AFTER the host
  // page's title focus rather than before it. Ordered the other way round, the
  // title focus clobbered the caret, which is why Settings had to suppress its
  // own title focus for these routes — and that suppression was wrong whenever
  // there is no field to focus: on desktop with a hardware protector this form
  // renders no password input at all, so nothing took focus and the page went
  // unannounced. Now the title is focused first and the field takes over only if
  // it exists, so both cases end up somewhere sensible without the host having to
  // predict which one it is.
  useEffect(() => {
    if (!isMobile()) {
      focusPasswordField();
    }
  }, [focusPasswordField, hasHardwareProtector]);

  const onSubmit = useCallback<SubmitHandler<FormData>>(
    async ({ password }) => {
      if (isSubmitting || revealUnavailable) return;

      clearErrors('password');
      const generation = secretGeneration.current;
      try {
        const setCurrentSecret = (value: string) => {
          if (generation === secretGeneration.current) setSecret(value);
        };
        const unlockPassword = hasHardwareProtector ? undefined : password;
        if (reveal === 'private-key') {
          const pubKeyCommitment = await getAccountPublicKeyCommitment(account.publicKey);
          setCurrentSecret(await revealPrivateKey(pubKeyCommitment, unlockPassword));
        } else if (reveal === 'hot-key') {
          setCurrentSecret(await revealHotKey(account.publicKey, unlockPassword));
        } else if (reveal === 'guardian-keys') {
          const bundle = await revealGuardianKeys(account.publicKey, unlockPassword);
          if (generation === secretGeneration.current) setGuardianBundle(bundle);
        } else {
          setCurrentSecret(await revealMnemonic(unlockPassword));
        }
      } catch (err) {
        // Human delay.
        await new Promise(res => setTimeout(res, 300));
        if (generation !== secretGeneration.current) return;
        setError('password', {
          type: SUBMIT_ERROR_TYPE,
          message: err instanceof Error ? err.message : t('smthWentWrong')
        });
        if (!hasHardwareProtector) focusPasswordField();
      }
    },
    [
      isSubmitting,
      revealUnavailable,
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
      account.publicKey,
      t
    ]
  );

  const texts = useMemo(() => {
    switch (reveal) {
      case 'private-key':
        return {
          name: t('privateKey'),
          // Which account's key this is: a plain row, like every other account row.
          accountBanner: (
            <ListGroup>
              <ListRow
                icon={<Icon name={IconName.Wallet} fill="currentColor" size="sm" />}
                title={account.name}
                subtitle={truncateAddress(account.publicKey, false, 8)}
                data-testid="reveal-secret-account"
              />
            </ListGroup>
          ),
          fieldDesc: t('privateKeyFieldDescription')
        };

      case 'seed-phrase':
        return {
          name: t('seedPhrase'),
          accountBanner: null,
          fieldDesc: (
            <div className="flex flex-col gap-3">
              <p>{t('seedPhraseDescription')}</p>
              <p className="font-bold">{t('doNotShareWithAnyone')}</p>
              <p>
                {t('anyoneCanTakeAssets')} <span className="font-bold">{t('keepSeedPhraseSecret')}</span>
              </p>
            </div>
          )
        };

      case 'hot-key':
        return {
          name: t('privateKey'),
          accountBanner: null,
          fieldDesc: t('revealHotKeyDescription')
        };

      case 'guardian-keys':
        return {
          name: t('coldPrivateKey'),
          accountBanner: null,
          fieldDesc: t('guardianKeysRevealDescription')
        };
    }
  }, [reveal, t, account]);

  const mainContent = useMemo(() => {
    if (guardianBundle) {
      // Withhold until the native guard reports the screen is protected — an
      // in-progress screen recording would otherwise capture the first frames.
      if (!isGuardReady) return null;
      return (
        <SubPageSection className="gap-5" description={texts.fieldDesc}>
          <TextField
            ref={secretFieldRef}
            secret
            multiline
            rows={3}
            readOnly
            label={t('coldPrivateKey')}
            id="reveal-guardian-cold-private"
            spellCheck={false}
            className={secretFieldClassName}
            value={guardianBundle.coldPrivateKey}
          />
          <TextField
            multiline
            rows={2}
            readOnly
            label={t('coldPublicKeyLabel')}
            id="reveal-guardian-cold-public"
            spellCheck={false}
            className={secretFieldClassName}
            value={guardianBundle.coldPublicKey}
          />
          {guardianBundle.hotPublicKey && (
            <TextField
              multiline
              rows={2}
              readOnly
              label={t('hotPublicKeyLabel')}
              id="reveal-guardian-hot-public"
              spellCheck={false}
              className={secretFieldClassName}
              value={guardianBundle.hotPublicKey}
            />
          )}
        </SubPageSection>
      );
    }

    if (secret) {
      if (!isGuardReady) return null;
      if (reveal === 'hot-key') return <PrivateKeyPair payload={secret} />;
      return (
        <SubPageSection description={texts.fieldDesc}>
          <TextField
            ref={secretFieldRef}
            secret
            multiline
            rows={4}
            readOnly
            label={texts.name}
            id="reveal-secret-secret"
            spellCheck={false}
            className={secretFieldClassName}
            value={secret}
          />
        </SubPageSection>
      );
    }

    return (
      <form ref={formRef} onSubmit={handleSubmit(onSubmit)}>
        {hasHardwareProtector ? (
          <SubPageSection description={t('revealSecretUnlockDescription', { secretName: texts.name })}>
            {errors.password && (
              <Notice tone="negative" role="alert" title={t('error')}>
                {errors.password.message || ''}
              </Notice>
            )}
          </SubPageSection>
        ) : usePasscodeEntry ? (
          <PasscodeEntry
            onSubmit={code => onSubmit({ password: code })}
            onChange={() => clearErrors()}
            error={errors.password?.message ?? null}
            subtitle={t('revealSecretPasscodeInputDescription', { secretName: texts.name })}
            disabled={requiresAcknowledge && !privateKeyAcknowledged}
            isSubmitting={isSubmitting}
          />
        ) : (
          <TextField
            {...register('password', { required: t('required') })}
            label={t('password')}
            hint={t('revealSecretPasswordInputDescription', { secretName: texts.name })}
            error={errors.password?.message}
            id="reveal-secret-password"
            type="password"
            placeholder="********"
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
    isGuardReady,
    onSubmit,
    register,
    secret,
    guardianBundle,
    texts,
    clearErrors,
    secretFieldRef,
    t,
    hasHardwareProtector,
    handleSubmit,
    usePasscodeEntry,
    requiresAcknowledge,
    privateKeyAcknowledged,
    isSubmitting,
    reveal
  ]);

  const showButton = !secret && !guardianBundle;

  if (revealUnavailable) return null;

  // The frame renders while the protector check runs, so the header (and the title
  // focus that announces the page) is there from the first frame; the body waits.
  if (hasHardwareProtector === null) {
    return <SubPageLayout data-testid="reveal-secret">{null}</SubPageLayout>;
  }

  return (
    <SubPageLayout
      data-testid="reveal-secret"
      footer={
        showButton &&
        !usePasscodeEntry && (
          <Button
            className="flex-1 max-w-none"
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
        )
      }
    >
      {texts.accountBanner}

      {requiresAcknowledge && showButton && (
        <SubPageSection>
          <Notice tone="warning" title={t('privateKeyRevealWarningTitle')}>
            {t('privateKeyRevealWarningBody')}
          </Notice>
          <CheckboxConsent
            className="mt-3"
            checked={privateKeyAcknowledged}
            onCheckedChange={setPrivateKeyAcknowledged}
          >
            {t('privateKeyRevealAcknowledge')}
          </CheckboxConsent>
        </SubPageSection>
      )}

      {reveal === 'hot-key' && showButton && (
        <Notice tone="warning" title={t('hotKeyRevealWarningTitle')}>
          {t('hotKeyRevealWarningBody')}
        </Notice>
      )}

      {mainContent}
    </SubPageLayout>
  );
};

// Remount before paint when the account or reveal route changes. Cleanup also
// invalidates requests still waiting for authentication from the old account.
const AccountRevealSecret: FC<RevealSecretProps> = props => {
  const account = useAccount();
  return <RevealSecret key={`${account.publicKey}:${props.reveal}`} {...props} />;
};

export default AccountRevealSecret;

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
    const commitments = resolvePublicKeyCommitments(account);
    if (commitments.length === 0) {
      throw new Error('Account has no public key');
    }
    return commitments[0]!.toHex();
  });
  return commitmentHex.startsWith('0x') ? commitmentHex.slice(2) : commitmentHex;
};
