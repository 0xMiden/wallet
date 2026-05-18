import React, { useCallback, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Numpad } from 'components/Numpad';

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
    <div className="bg-app-bg h-full overflow-y-auto" data-testid="onboarding-setup-passcode">
      <div className="min-h-full flex flex-col items-center px-6 pb-8">
        <div className="flex flex-col items-center w-full mt-8 shrink-0">
          <h1 className="text-3xl font-semibold font-heading text-heading-gray text-center leading-[100%] tracking-tight">
            {phase === 'enter' ? t('setUpYourPasscode') : t('confirmYourPasscode')}
          </h1>
          <p className={`text-lg text-center mt-3 ${mismatch ? 'text-red-500' : 'text-[#8E8E93]'}`}>
            {mismatch
              ? t('passcodesDoNotMatch')
              : phase === 'enter'
                ? t('createA6DigitCode')
                : t('reEnterTheSame6Digits')}
          </p>

          <div className="flex items-center gap-3.5 mt-6">
            {Array.from({ length: PASSCODE_LENGTH }).map((_, index) => {
              const filled = index < activeCode.length;
              return (
                <div
                  key={index}
                  className={
                    filled
                      ? 'w-3.5 h-3.5 rounded-full bg-[#C7C7CC] border-2 border-[#C7C7CC]'
                      : 'w-3.5 h-3.5 rounded-full border-2 border-[#C7C7CC]'
                  }
                />
              );
            })}
          </div>
        </div>

        <div className="w-full pt-8">
          <Numpad onDigit={handleDigit} onDelete={handleDelete} />
        </div>
      </div>
    </div>
  );
};

export default SetupPasscodeScreen;
