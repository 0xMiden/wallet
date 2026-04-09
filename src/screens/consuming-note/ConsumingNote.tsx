import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import { useConsume } from '@miden-sdk/react';
import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import CircularProgress from 'app/atoms/CircularProgress';
import { useAppEnv } from 'app/env';
import { Icon, IconName } from 'app/icons/v2';
import { Alert, AlertVariant } from 'components/Alert';
import { Button, ButtonVariant } from 'components/Button';
import { useAccount } from 'lib/miden/front';
import { isMobile } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { truncateHash } from 'utils/string';

const AUTO_CLOSE_TIMEOUT = 5_000;

const enum ConsumingNoteStatus {
  Processing,
  Completed,
  Failed
}

export interface ConsumingNotePageProps {
  noteId: string;
}

export const ConsumingNotePage: FC<ConsumingNotePageProps> = ({ noteId }) => {
  const [status, setStatus] = useState(ConsumingNoteStatus.Processing);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const account = useAccount();
  const { consume } = useConsume();

  const onClose = useCallback(() => {
    const { hash } = window.location;
    if (!hash.includes('consuming-note')) {
      return;
    }
    useWalletStore.getState().closeTransactionModal();
  }, []);

  // Consume the note via SDK (guarded to prevent double-execution if consume ref changes)
  const hasStartedConsume = useRef(false);
  useEffect(() => {
    if (hasStartedConsume.current) return;
    hasStartedConsume.current = true;

    let cancelled = false;

    const doConsume = async () => {
      try {
        await consume({
          accountId: account.publicKey,
          notes: [noteId]
        });
        if (!cancelled) {
          setStatus(ConsumingNoteStatus.Completed);
        }
      } catch (e: any) {
        if (!cancelled) {
          setStatus(ConsumingNoteStatus.Failed);
          setErrorMessage(e.message || 'Unknown error');
        }
        console.error('[ConsumingNote] Failed to consume note:', e);
      }
    };

    doConsume();
    return () => {
      cancelled = true;
    };
  }, [account.publicKey, noteId, consume]);

  // Auto-close after completion/failure
  useEffect(() => {
    if (status === ConsumingNoteStatus.Completed || status === ConsumingNoteStatus.Failed) {
      const timeoutId = setTimeout(() => {
        onClose();
      }, AUTO_CLOSE_TIMEOUT);
      return () => clearTimeout(timeoutId);
    }
    return undefined;
  }, [status, onClose]);

  const { sidePanel } = useAppEnv();
  const containerClass =
    isMobile() || sidePanel ? 'h-full w-full' : 'h-[640px] max-h-[640px] w-[600px] max-w-[600px] border rounded-3xl';

  return (
    <div
      className={classNames(
        containerClass,
        'mx-auto overflow-hidden ',
        'flex flex-1',
        'flex-col bg-app-bg p-6',
        'overflow-hidden relative'
      )}
    >
      <div className={classNames('flex flex-1 flex-col w-full')}>
        <ConsumingNote noteId={noteId} onDoneClick={onClose} status={status} errorMessage={errorMessage} />
      </div>
    </div>
  );
};

export interface ConsumingNoteProps {
  noteId: string;
  onDoneClick: () => void;
  status: ConsumingNoteStatus;
  errorMessage?: string | null;
}

export const ConsumingNote: React.FC<ConsumingNoteProps> = ({ noteId, onDoneClick, status, errorMessage }) => {
  const { t } = useTranslation();

  const renderIcon = useCallback(() => {
    if (status === ConsumingNoteStatus.Completed) {
      return <Icon name={IconName.Success} size="3xl" />;
    }
    if (status === ConsumingNoteStatus.Failed) {
      return <Icon name={IconName.Failed} size="3xl" />;
    }

    return (
      <div className="flex items-center justify-center">
        <Icon name={IconName.InProgress} className="absolute" size="3xl" />
        <CircularProgress borderWeight={2} progress={50} circleColor="black" circleSize={55} spin={true} />
      </div>
    );
  }, [status]);

  const headerText = useCallback(() => {
    switch (status) {
      case ConsumingNoteStatus.Completed:
        return `Note Consumed: ${truncateHash(noteId)}`;
      case ConsumingNoteStatus.Failed:
        return 'Note Consumption Failed';
      case ConsumingNoteStatus.Processing:
      default:
        return `Consuming Note: ${truncateHash(noteId)}`;
    }
  }, [status, noteId]);

  const alertText = 'Do not close this window. Window will auto-close after the note is consumed';

  return (
    <>
      {status === ConsumingNoteStatus.Processing && <Alert variant={AlertVariant.Warning} title={alertText} />}
      <div className="flex-1 flex flex-col justify-center md:w-[460px] md:mx-auto">
        <div className="flex flex-col justify-center items-center">
          <div className={classNames('w-40 aspect-square flex items-center justify-center mb-8')}>{renderIcon()}</div>
          <div className="flex flex-col items-center">
            <h1 className="font-semibold text-2xl lh-title">{headerText()}</h1>
            <p className="text-base text-center lh-title">
              {status === ConsumingNoteStatus.Completed && t('noteConsumedSuccessfully')}
              {status === ConsumingNoteStatus.Failed && (errorMessage || t('noteConsumptionError'))}
            </p>
          </div>
        </div>
        <div className="mt-8 flex flex-col gap-y-4">
          <Button
            title={t('done')}
            variant={ButtonVariant.Primary}
            onClick={onDoneClick}
            disabled={status === ConsumingNoteStatus.Processing}
          />
        </div>
      </div>
    </>
  );
};
