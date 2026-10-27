import React, { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import { Clipboard } from '@capacitor/clipboard';
import { useTranslation } from 'react-i18next';

import { CodeInput } from 'components/ui/CodeInput';
import { ErrorLine } from 'components/ui/ErrorLine';
import { TextAction } from 'components/ui/TextAction';
import { isMainnetAccessCodeComplete, MAINNET_ACCESS_CODE_LENGTH, type MainnetAccessOutcome } from 'lib/mainnet-access';
import { isMobile } from 'lib/platform';
import { UserErrorId } from 'lib/telemetry/user-visible-error';
import { cn } from 'lib/ui/util';

/** Why the last try did not unlock mainnet: the code was refused, or the check did not complete. */
export type MainnetCodeFailure = 'rejected' | 'unchecked' | 'clipboard';

const FAILURE_IDS: Record<MainnetCodeFailure, UserErrorId> = {
  rejected: 'mainnetAccessCodeRejected',
  unchecked: 'mainnetAccessCheckFailed',
  clipboard: 'mainnetAccessPasteFailed'
};

export interface MainnetCodeEntryOptions {
  /** Asks a node whether a complete code can register an account. */
  check: (code: string) => Promise<MainnetAccessOutcome>;
  /** The node accepted the code. The entry stays busy until it settles. */
  onGranted?: (code: string) => void | Promise<void>;
  /** The node refused the code a registration carried: the entry opens with the refusal. */
  rejected?: boolean;
  /** False once the entry is closed while still mounted (a sheet's exit): it takes no code and drops any check. */
  active?: boolean;
}

export interface MainnetCodeEntry {
  code: string;
  complete: boolean;
  failure: MainnetCodeFailure | null;
  submitting: boolean;
  pasting: boolean;
  changeCode: (next: string) => void;
  /** Fills in a code the user did not type, unless they already have. */
  offerCode: (offered: string) => void;
  pasteCode: () => Promise<void>;
  submit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}

/**
 * The mainnet access code entry: the invite-only onboarding step and the switch of a test-network
 * wallet to mainnet share it, each with its own node to ask and its own next step.
 */
export function useMainnetCodeEntry({
  check,
  onGranted,
  rejected = false,
  active = true
}: MainnetCodeEntryOptions): MainnetCodeEntry {
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<MainnetCodeFailure | null>(rejected ? 'rejected' : null);
  const [submitting, setSubmitting] = useState(false);
  const [pasting, setPasting] = useState(false);
  // A check answers for the code it was asked about, here: closing the entry (a sheet keeps it mounted through its
  // exit), unmounting it, or a new code drops it, and a reopened entry does not take it back.
  const closings = useRef(0);
  const codeGeneration = useRef(0);
  useEffect(() => {
    if (!active) return undefined;
    return () => {
      closings.current += 1;
    };
  }, [active]);

  const complete = isMainnetAccessCodeComplete(code);

  const changeCode = useCallback((next: string) => {
    codeGeneration.current += 1;
    setCode(next);
    setFailure(null);
  }, []);

  const offerCode = useCallback((offered: string) => {
    if (codeGeneration.current === 0) setCode(offered);
  }, []);

  const pasteCode = async () => {
    if (pasting || submitting) return;
    setPasting(true);
    try {
      const { value, type } = await Clipboard.read();
      if (type !== 'text/plain' || !value) return;
      changeCode(value.replace(/[^A-Za-z0-9]/g, '').slice(0, MAINNET_ACCESS_CODE_LENGTH));
    } catch {
      setFailure('clipboard');
    } finally {
      setPasting(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!active || !complete || submitting || pasting) return;
    setSubmitting(true);
    setFailure(null);
    const generation = codeGeneration.current;
    const opening = closings.current;
    const current = () => closings.current === opening && codeGeneration.current === generation;
    try {
      let outcome: MainnetAccessOutcome;
      try {
        outcome = await check(code);
      } catch {
        if (current()) setFailure('unchecked');
        return;
      }
      if (!current()) return;
      switch (outcome) {
        case 'granted':
          await onGranted?.(code);
          break;
        case 'rejected':
          setFailure('rejected');
          break;
      }
    } finally {
      setSubmitting(false);
    }
  };

  return { code, complete, failure, submitting, pasting, changeCode, offerCode, pasteCode, submit };
}

export interface MainnetCodeEntryFieldsProps {
  entry: MainnetCodeEntry;
  /** Prefixes the test ids: `<prefix>-code`, `<prefix>-paste`, `<prefix>-error`. */
  testIdPrefix: string;
  className?: string;
}

/** The code cells with their label, Paste, hint and failure line. The host places the submit button. */
export const MainnetCodeEntryFields: React.FC<MainnetCodeEntryFieldsProps> = ({ entry, testIdPrefix, className }) => {
  const { t } = useTranslation();
  const { code, failure, submitting, pasting, changeCode, pasteCode } = entry;

  // Literal keys, so the key-coverage test can find them.
  const failureMessage = (): string | null => {
    switch (failure) {
      case 'rejected':
        return t('mainnetAccessCodeRejected');
      case 'unchecked':
        return t('mainnetAccessCheckFailed');
      case 'clipboard':
        return t('mainnetAccessPasteFailed');
      case null:
        return null;
    }
  };

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center justify-between px-1">
        <span className="text-label text-muted">{t('mainnetAccessCodeLabel')}</span>
        {isMobile() && (
          <TextAction onClick={pasteCode} disabled={submitting || pasting} data-testid={`${testIdPrefix}-paste`}>
            {t('paste')}
          </TextAction>
        )}
      </div>
      <CodeInput
        value={code}
        onChange={changeCode}
        length={MAINNET_ACCESS_CODE_LENGTH}
        layout="vertical"
        groupSize={6}
        format="alphanumeric"
        label={t('mainnetAccessCodeLabel')}
        invalid={failure !== null}
        disabled={submitting || pasting}
        data-testid={`${testIdPrefix}-code`}
      />
      <span className="px-1 text-caption text-muted">{t('mainnetAccessHint')}</span>
      <ErrorLine errorId={failure === null ? null : FAILURE_IDS[failure]} data-testid={`${testIdPrefix}-error`}>
        {failureMessage()}
      </ErrorLine>
    </div>
  );
};
