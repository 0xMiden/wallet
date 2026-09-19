import React, { useCallback, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { PasscodeScreen } from 'components/PasscodeScreen';

const PASSCODE_LENGTH = 6;

export type SetupPasscodePhase = 'enter' | 'confirm';

export interface SetupPasscodeScreenProps {
  onSubmit?: (code: string) => void;
  onPhaseChange?: (phase: SetupPasscodePhase) => void;
}

export const SetupPasscodeScreen: React.FC<SetupPasscodeScreenProps> = ({ onSubmit, onPhaseChange }) => {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<SetupPasscodePhase>('enter');

  useEffect(() => {
    onPhaseChange?.(phase);
  }, [phase, onPhaseChange]);

  const [enteredCode, setEnteredCode] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [mismatch, setMismatch] = useState(false);
  // Counts mismatched confirmations; each new value shakes the dots once.
  const [mismatchCount, setMismatchCount] = useState(0);

  const activeCode = phase === 'enter' ? enteredCode : confirmCode;
  const setActiveCode = phase === 'enter' ? setEnteredCode : setConfirmCode;

  const handleDigit = useCallback(
    (digit: string) => {
      if (mismatch) setMismatch(false);
      setActiveCode(prev => (prev.length >= PASSCODE_LENGTH ? prev : prev + digit));
    },
    [setActiveCode, mismatch]
  );

  const handleDelete = useCallback(() => {
    if (mismatch) setMismatch(false);
    setActiveCode(prev => prev.slice(0, -1));
  }, [setActiveCode, mismatch]);

  useEffect(() => {
    if (phase === 'enter' && enteredCode.length === PASSCODE_LENGTH) {
      const timer = setTimeout(() => {
        setPhase('confirm');
        setConfirmCode('');
        setMismatch(false);
      }, 150);
      return () => clearTimeout(timer);
    }
    if (phase === 'confirm' && confirmCode.length === PASSCODE_LENGTH) {
      if (confirmCode !== enteredCode) {
        const timer = setTimeout(() => {
          setMismatch(true);
          setMismatchCount(count => count + 1);
          setConfirmCode('');
        }, 150);
        return () => clearTimeout(timer);
      }
      const timer = setTimeout(() => {
        onSubmit?.(confirmCode);
      }, 150);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [phase, enteredCode, confirmCode, onSubmit]);

  return (
    <PasscodeScreen
      data-testid="onboarding-setup-passcode"
      title={phase === 'enter' ? t('setUpYourPasscode') : t('confirmYourPasscode')}
      message={
        mismatch ? t('passcodesDoNotMatch') : phase === 'enter' ? t('createA6DigitCode') : t('reEnterTheSame6Digits')
      }
      isError={mismatch}
      filled={activeCode.length}
      length={PASSCODE_LENGTH}
      errorKey={mismatchCount}
      onDigit={handleDigit}
      onDelete={handleDelete}
    />
  );
};

export default SetupPasscodeScreen;
