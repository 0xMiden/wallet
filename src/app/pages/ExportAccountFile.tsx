import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Buffer } from 'buffer';
import { useTranslation } from 'react-i18next';

import Alert from 'app/atoms/Alert';
import FormField from 'app/atoms/FormField';
import AccountBanner from 'app/templates/AccountBanner';
import { Button, ButtonVariant } from 'components/Button';
import { PasscodeEntry } from 'components/PasscodeEntry';
import { Vault } from 'lib/miden/back/vault';
import { useAccount, useMidenContext } from 'lib/miden/front';
import { hapticMedium } from 'lib/mobile/haptics';
import { isShareCancellation } from 'lib/mobile/share-cancellation';
import { useHideDappBubblesWhileOpen } from 'lib/mobile/useHideDappBubblesWhileOpen';
import { isMobile } from 'lib/platform';
import { WalletType } from 'screens/onboarding/types';

const ACCOUNT_FILE_EXTENSION = '.mac';

type AccountFileSaveResult = 'download-started' | 'shared' | 'cancelled' | 'abandoned';
type AccountFileSaved = Exclude<AccountFileSaveResult, 'cancelled' | 'abandoned'>;

async function saveAccountFile(
  bytes: Uint8Array,
  fileName: string,
  dialogTitle: string,
  isLive: () => boolean
): Promise<AccountFileSaveResult> {
  if (isMobile()) {
    // Encoded before the first suspension point below. The caller zeroes `bytes` in its own
    // `finally`, which cannot run until this function returns, so the ordering is defensive rather
    // than load-bearing - but it is also what makes the liveness re-check below free, since after
    // this line the array's contents are no longer the source of truth.
    // Through a VIEW, not Buffer.from(bytes), which would copy: every copy is another live
    // plaintext of the auth key that the screen's own fill(0) can never reach.
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');

    // A process killed while the share sheet is up never reaches the finally below, so a previous
    // export can have left plaintext key material in Cache. Reclaim any before writing the next
    // one - best effort, because failing to tidy up must never block the export the user asked for.
    await Filesystem.readdir({ directory: Directory.Cache, path: '' })
      .then(({ files }) =>
        Promise.all(
          files
            .filter(entry => entry.name.endsWith(ACCOUNT_FILE_EXTENSION))
            .map(entry => Filesystem.deleteFile({ path: entry.name, directory: Directory.Cache }))
        )
      )
      .catch(sweepError => console.error('[exportAccountFile] could not sweep stale exports:', sweepError));

    const { uri } = await Filesystem.writeFile({ path: fileName, data, directory: Directory.Cache });
    // Re-read immediately before the delivering side effect. The sweep and the write are each a
    // bridge round trip, so the screen can be gone by now and a share sheet would open over
    // whatever replaced it. The finally below still deletes the plaintext cache copy.
    if (!isLive()) {
      await Filesystem.deleteFile({ path: fileName, directory: Directory.Cache }).catch(deleteError =>
        console.error('[exportAccountFile] could not delete the temporary account file:', deleteError)
      );
      return 'abandoned';
    }

    let cancelled = false;
    try {
      await Share.share({ title: fileName, files: [uri], dialogTitle });
    } catch (error: unknown) {
      // Dismissing the sheet rejects too, and that is the user declining delivery, not a
      // failed export. Report it apart so the caller can re-offer the sheet instead of
      // claiming nothing was saved and making them authenticate again.
      if (!isShareCancellation(error)) throw error;
      cancelled = true;
    } finally {
      // The cache copy is plaintext key material, so it goes whatever the sheet did - but a
      // failure to delete it must not stand in for the reason the share itself ended.
      await Filesystem.deleteFile({ path: fileName, directory: Directory.Cache }).catch(deleteError =>
        console.error('[exportAccountFile] could not delete the temporary account file:', deleteError)
      );
    }
    return cancelled ? 'cancelled' : 'shared';
  }

  // Blob's TS signature wants an ArrayBuffer-backed view, so this branch cannot pass `bytes`
  // directly and must copy. That copy is zeroed below: revokeObjectURL releases the URL mapping,
  // NOT this array, so without the fill(0) it would outlive every other plaintext here. The
  // browser-owned copy inside the Blob is out of JS reach and is the download itself.
  const downloadCopy = new Uint8Array(bytes);
  const url = URL.createObjectURL(new Blob([downloadCopy], { type: 'application/octet-stream' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    downloadCopy.fill(0);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return 'download-started';
}

interface ExportAccountFileForAccountProps {
  account: ReturnType<typeof useAccount>;
}

const ExportAccountFileForAccount: FC<ExportAccountFileForAccountProps> = ({ account }) => {
  const { t } = useTranslation();
  const { exportAccountFile } = useMidenContext();
  const [hasHardwareProtector, setHasHardwareProtector] = useState<boolean | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [password, setPassword] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<AccountFileSaved | null>(null);
  // Remount token for PasscodeEntry. It guarantees exactly one submit per completed code and clears
  // its digits only when `error` turns non-null; a dismissed sheet is deliberately neither. Bumping
  // the key gives the user a fresh keypad to retry with, without inventing an error to show them.
  const [passcodeAttempt, setPasscodeAttempt] = useState(0);
  const usePasscodeEntry = isMobile() && hasHardwareProtector === false;
  useHideDappBubblesWhileOpen(true);

  // Delivery only, nothing else: the bytes are zeroed in `finally` whatever happens, so this exists
  // purely so an unmount mid-export cannot open a share sheet over an unrelated screen.
  const isLiveRef = useRef(true);
  useEffect(() => {
    isLiveRef.current = true;
    return () => {
      isLiveRef.current = false;
    };
  }, []);

  useEffect(() => {
    // This screen renders null until the probe resolves, so a rejection with no handler is a
    // permanently blank page. Fall back to the password step-up, as VerifySeedPhraseFlow and
    // RotateGuardianReview already do, so the export stays reachable.
    Vault.hasHardwareProtector()
      .then(setHasHardwareProtector)
      .catch(() => setHasHardwareProtector(false));
  }, []);

  // Same shape as RevealSecret's: `hasHardwareProtector` is a dependency because this screen
  // renders null until it resolves, so an effect without it runs once against a commit where
  // formRef is still null and the field never gets focus. Passive, not layout, so it lands
  // after the host page's title focus rather than being clobbered by it.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!isMobile()) {
      formRef.current?.querySelector<HTMLInputElement>("input[name='password']")?.focus();
    }
  }, [hasHardwareProtector]);

  const runExport = useCallback(
    async (stepUpSecret?: string) => {
      if (isExporting || !acknowledged) return;
      setIsExporting(true);
      setError(null);
      setSaveResult(null);
      // The decrypted account file never outlives this call. An earlier revision cached it across a
      // dismissed share sheet to save one re-authentication; holding key material across an async
      // gap in a screen this route does not remount on an account switch caused five of this
      // review's findings, so the bytes are now zeroed on every path out, without exception.
      let bytes: Uint8Array | null = null;
      try {
        bytes = await exportAccountFile(account.publicKey, stepUpSecret);
        if (!isLiveRef.current) return;
        // Deliberately NOT canonicalWalletAccountId: this is the file NAME, and that helper
        // returns AccountId.toString(), the canonical hex. The user only ever sees the bech32
        // address, so a hex name would not match the account they picked.
        const accountId = account.publicKey.split('_')[0] ?? account.publicKey;
        const result = await saveAccountFile(
          bytes,
          `${accountId}${ACCOUNT_FILE_EXTENSION}`,
          t('saveAccountFile'),
          () => isLiveRef.current
        );
        if (result === 'abandoned') return;
        // A dismissed sheet is the user declining delivery, not a failure: no error, no success,
        // and the next attempt authenticates again like any other.
        if (result === 'cancelled') {
          setPasscodeAttempt(attempt => attempt + 1);
        } else {
          setSaveResult(result);
        }
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        bytes?.fill(0);
        setIsExporting(false);
      }
    },
    [account.publicKey, acknowledged, exportAccountFile, isExporting, t]
  );

  // Decided before anything is asked of the user. The vault refuses a Guardian export outright, so
  // rendering the warning, the acknowledgement and a credential step-up would spend a password or a
  // device-security prompt to reach a refusal that was certain from the account's type alone.
  if (account.type === WalletType.Guardian) {
    return (
      <div className="w-full max-w-sm mx-auto flex flex-col flex-1 min-h-0">
        <AccountBanner account={account} className="mb-6 text-ink" />
        <Alert
          type="warn"
          title={t('exportAccountFile')}
          description={<p>{t('exportAccountFileGuardianUnavailable')}</p>}
          className="mb-4 rounded-lg"
        />
      </div>
    );
  }

  if (hasHardwareProtector === null) return null;

  const canSubmit = acknowledged && !isExporting && (hasHardwareProtector || password.length > 0);

  return (
    <form
      ref={formRef}
      className="w-full max-w-sm mx-auto flex flex-col flex-1 min-h-0"
      onSubmit={event => {
        event.preventDefault();
        if (usePasscodeEntry || !canSubmit) return;
        runExport(hasHardwareProtector ? undefined : password);
      }}
    >
      <AccountBanner account={account} className="mb-6 text-ink" />

      <Alert
        type="warn"
        title={t('exportAccountFileWarningTitle')}
        description={<p>{t('exportAccountFileWarningBody')}</p>}
        className="mb-4 rounded-lg"
      />

      <label className="mb-6 flex items-start gap-2 text-sm text-black cursor-pointer select-none">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={acknowledged}
          onChange={event => {
            hapticMedium();
            setAcknowledged(event.target.checked);
          }}
        />
        <span>{t('exportAccountFileAcknowledge')}</span>
      </label>

      {/* Suppressed on the passcode branch: PasscodeEntry paints the same string as its own hint,
          so rendering both duplicates the failure and displaces the passcode description. */}
      {error && !usePasscodeEntry && (
        <Alert type="error" title={t('error')} description={error} className="mb-4 rounded-lg text-black" />
      )}
      {saveResult && (
        <Alert
          type="success"
          description={t(saveResult === 'shared' ? 'accountFileShareSuccess' : 'accountFileDownloadStarted')}
          className="mb-4 rounded-lg"
        />
      )}

      {hasHardwareProtector ? (
        <p className="text-sm text-ink">{t('exportAccountFileHardwareDescription')}</p>
      ) : usePasscodeEntry ? (
        <PasscodeEntry
          key={passcodeAttempt}
          onSubmit={code => runExport(code)}
          onChange={() => setError(null)}
          error={error}
          subtitle={t('exportAccountFilePasscodeDescription')}
          disabled={!acknowledged}
          isSubmitting={isExporting}
        />
      ) : (
        <FormField
          label={t('password')}
          labelDescription={t('exportAccountFilePasswordDescription')}
          id="export-account-file-password"
          name="password"
          type="password"
          value={password}
          onChange={event => {
            setPassword(event.target.value);
            setError(null);
          }}
          containerClassName="mb-4"
        />
      )}

      {!usePasscodeEntry && (
        <div className="mt-auto pb-8 pt-6">
          <Button
            className="w-full justify-center"
            variant={ButtonVariant.Primary}
            title={t('saveAccountFile')}
            disabled={!canSubmit}
            isLoading={isExporting}
            onClick={() => runExport(hasHardwareProtector ? undefined : password)}
          />
        </div>
      )}
    </form>
  );
};

/**
 * Keyed by account, so a change of the active account REMOUNTS the screen.
 *
 * That is the whole guard, and it is deliberately structural rather than a list of resets.
 * `useAccount()` is the globally shared `currentAccount`, which the backend pushes to every open
 * surface, and this Settings route keys its sub-pages by tab slug alone - so without a key here an
 * account switch made in another window leaves this screen mounted with the previous account's
 * acknowledgement, typed password, success banner and in-flight export still live. Remounting
 * makes an account switch indistinguishable from an unmount, which every guard in the component
 * already handles: consent is demanded again, and a pending export's delivery is suppressed by the
 * liveness ref. A per-field reset would have to be remembered for every field added later.
 */
const ExportAccountFile: FC = () => {
  const account = useAccount();

  return <ExportAccountFileForAccount key={account.publicKey} account={account} />;
};

export default ExportAccountFile;
