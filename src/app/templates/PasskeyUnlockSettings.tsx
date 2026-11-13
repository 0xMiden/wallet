import React, { useEffect, useId, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { usePlatformUnlock } from 'app/hooks/usePlatformUnlock';
import { Button, ButtonVariant } from 'components/Button';
import { ErrorLine } from 'components/ui/ErrorLine';
import { Notice } from 'components/ui/Notice';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { TextField } from 'components/ui/TextField';
import { openSidePanelToWallet } from 'lib/extension/side-panel-handoff';
import { useMidenContext } from 'lib/miden/front';
import { createPlatformCredential } from 'lib/platform-auth/webauthn';
import { useConfirm } from 'lib/ui/dialog';

const PasskeyUnlockSettings = () => {
  const { t } = useTranslation();
  const { sidePanel, confirmWindow } = useAppEnv();
  const { state, refresh } = usePlatformUnlock();
  const { platformUnlock } = useMidenContext();
  const confirm = useConfirm();
  const formId = useId();
  const [password, setPassword] = useState('');
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<'enrolling' | 'saving' | 'removing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const flight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const available = state.available && state.hasPassword;
  const canManage = available && sidePanel && !confirmWindow;
  const enrolling = canManage && (editing || state.credential === null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  const enroll = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enrolling || !password || flight.current) return;
    flight.current = true;
    const attempt = new AbortController();
    controller.current = attempt;
    setMode('enrolling');
    setError(null);
    let enrollmentId: string | undefined;
    let committed = false;
    try {
      const begin = await platformUnlock({
        action: 'begin',
        expectedCredentialId: state.credential?.credentialId ?? null
      });
      if (begin.action !== 'begin') throw new Error('Invalid platform enrollment response');
      enrollmentId = begin.enrollmentId;
      attempt.signal.throwIfAborted();
      const token = enrollmentId;
      const credential = await createPlatformCredential(
        state.credential?.credentialId ?? null,
        async (credentialId, prfSalt, backupEligible) => {
          // Even an aborted attempt must journal any ID its provider actually returned.
          await platformUnlock({
            action: 'track',
            enrollmentId: token,
            credential: { credentialId, prfSalt, backupEligible }
          });
        },
        attempt.signal
      );
      attempt.signal.throwIfAborted();
      if (!mounted.current) return;
      setMode('saving');
      await platformUnlock({ action: 'commit', enrollmentId, password, prfSecret: credential.prfSecret });
      committed = true;
      if (mounted.current) setEditing(false);
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof DOMException && ['AbortError', 'NotAllowedError'].includes(cause.name)
            ? 'passkeyCanceled'
            : 'passkeySetupFailed'
        );
      }
    } finally {
      if (enrollmentId && !committed) {
        await platformUnlock({ action: 'abandon', enrollmentId }).catch(() => undefined);
      }
      if (mounted.current) {
        await refresh().catch(() => undefined);
        if (mounted.current) {
          setPassword('');
          setMode(null);
        }
      }
      controller.current = null;
      flight.current = false;
    }
  };

  const remove = async () => {
    if (!canManage || !state.credential || flight.current) return;
    flight.current = true;
    setMode('removing');
    setError(null);
    try {
      if (
        !(await confirm({
          title: t('passkeyRemove'),
          children: t('passkeyProviderRemoval'),
          confirmLabel: t('passkeyRemove'),
          destructive: true
        })) ||
        !mounted.current
      )
        return;
      await platformUnlock({ action: 'remove', expectedCredentialId: state.credential.credentialId });
      await refresh();
    } catch {
      if (mounted.current) setError('passkeyRemoveFailed');
    } finally {
      flight.current = false;
      if (mounted.current) setMode(null);
    }
  };

  const openPanel = async () => {
    if (!(await openSidePanelToWallet()) && mounted.current) setError('passkeySidePanelFailed');
  };

  let footer: React.ReactNode;
  if (enrolling) {
    footer = (
      <>
        <Button
          type="submit"
          form={formId}
          title={t(state.credential ? 'passkeyReplace' : 'passkeyEnable')}
          disabled={!password || mode !== null}
          isLoading={mode === 'enrolling' || mode === 'saving'}
        />
        <Button
          variant={ButtonVariant.Secondary}
          title={t('cancel')}
          disabled={mode === 'saving' || mode === 'removing'}
          onClick={() => {
            controller.current?.abort();
            setEditing(false);
            setPassword('');
          }}
        />
      </>
    );
  } else if (canManage) {
    footer = (
      <>
        <Button
          variant={ButtonVariant.Secondary}
          title={t('passkeyReplace')}
          disabled={mode !== null}
          onClick={() => {
            setEditing(true);
            setError(null);
          }}
        />
        <Button
          variant={ButtonVariant.Destructive}
          title={t('passkeyRemove')}
          disabled={mode !== null}
          isLoading={mode === 'removing'}
          onClick={remove}
        />
      </>
    );
  } else if (available) {
    footer = <Button title={t('openWallet')} onClick={openPanel} />;
  }

  return (
    <SubPageLayout
      data-testid="passkey-unlock-settings"
      onSubmit={enrolling ? enroll : undefined}
      formId={formId}
      footer={footer}
      footerLayout="stack"
    >
      <Notice role="status" tone={available && state.credential ? 'positive' : 'neutral'}>
        {t(
          !available
            ? 'passkeyUnlockUnavailable'
            : state.credential
              ? 'passkeyUnlockEnabled'
              : 'passkeyUnlockDescription'
        )}
      </Notice>
      {state.credential && (
        <Notice variant="inline">
          {t(state.credential.backupEligible ? 'passkeySyncCapable' : 'passkeyDeviceBound')}
        </Notice>
      )}
      {enrolling && (
        <TextField
          type="password"
          autoComplete="current-password"
          label={t('password')}
          value={password}
          disabled={mode !== null}
          onChange={event => setPassword(event.target.value)}
        />
      )}
      {available && !canManage && <Notice>{t('passkeySidePanelOnly')}</Notice>}
      <Notice>{t('passkeyProviderRemoval')}</Notice>
      <ErrorLine>{error && t(error)}</ErrorLine>
    </SubPageLayout>
  );
};

export default PasskeyUnlockSettings;
