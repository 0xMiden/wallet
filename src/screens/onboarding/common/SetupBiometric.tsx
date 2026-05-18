import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as FaceIcon } from 'app/icons/onboarding/face.svg';
import { ReactComponent as FingerprintIcon } from 'app/icons/onboarding/fingerprint.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { authenticate, checkBiometricAvailability } from 'lib/biometric';
import { hapticLight } from 'lib/mobile/haptics';
import { isIOS, isMobile } from 'lib/platform';
import { cn } from 'lib/ui/util';

type Phase = 'prompt' | 'success';

export interface SetupBiometricScreenProps {
  onSwitchToPasscode?: () => void;
  onContinue?: () => void;
}

const CORNER_SIZE = 56;
const FRAME_SIZE = 224;

type FrameColor = 'primary' | 'positive';

const ScanFrame: React.FC<{ color: FrameColor; children: React.ReactNode }> = ({ color, children }) => {
  const stroke = color === 'primary' ? 'text-primary-500' : 'text-status-positive';
  // Quarter-circle "L" bracket. Rotated 0/90/180/270 to land at each corner.
  const Bracket = ({ rotate }: { rotate: 0 | 90 | 180 | 270 }) => (
    <svg
      className={cn('absolute', stroke)}
      style={{
        width: CORNER_SIZE,
        height: CORNER_SIZE,
        transform: `rotate(${rotate}deg)`,
        top: rotate === 0 || rotate === 90 ? 0 : undefined,
        bottom: rotate === 180 || rotate === 270 ? 0 : undefined,
        left: rotate === 0 || rotate === 270 ? 0 : undefined,
        right: rotate === 90 || rotate === 180 ? 0 : undefined
      }}
      viewBox="0 0 56 56"
      fill="none"
    >
      <path d="M4 54V20C4 11.1634 11.1634 4 20 4H54" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );

  return (
    <div className="relative flex items-center justify-center" style={{ width: FRAME_SIZE, height: FRAME_SIZE }}>
      <Bracket rotate={0} />
      <Bracket rotate={90} />
      <Bracket rotate={180} />
      <Bracket rotate={270} />
      {children}
    </div>
  );
};

export const SetupBiometricScreen: React.FC<SetupBiometricScreenProps> = ({ onSwitchToPasscode, onContinue }) => {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('prompt');
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const isFaceId = isIOS();
  const InnerIcon = isFaceId ? FaceIcon : FingerprintIcon;
  const promptTitle = isFaceId ? t('faceIdSetUp') : t('biometricSetUp');

  const tryAuthenticate = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    try {
      // Non-mobile (extension/desktop) can't trigger the Capacitor biometric
      // plugin — surface a switch-to-passcode prompt instead.
      if (!isMobile()) {
        setError(t('biometricUnavailable'));
        return;
      }
      const availability = await checkBiometricAvailability();
      if (!availability.isAvailable) {
        setError(t('biometricUnavailable'));
        return;
      }
      const ok = await authenticate(t('biometricSetupReason'));
      if (ok) {
        setPhase('success');
      } else {
        setError(t('biometricFailed'));
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [t]);

  // Trigger the OS prompt as soon as the user lands on this screen.
  // Phase change to 'success' re-runs the effect but the guard inside the
  // callback (inFlightRef) plus the conditional below keeps it idempotent.
  useEffect(() => {
    if (phase === 'prompt') {
      void tryAuthenticate();
    }
  }, [phase, tryAuthenticate]);

  const handleRetry = () => {
    hapticLight();
    void tryAuthenticate();
  };

  return (
    <div className="bg-app-bg h-full overflow-y-auto" data-testid="onboarding-setup-biometric">
      <div className="min-h-full flex flex-col items-center px-6 pb-6">
        <div className="flex-1 flex flex-col items-center justify-center w-full">
          {phase === 'prompt' ? (
            <>
              <button type="button" aria-label={promptTitle} onClick={handleRetry} className="outline-none">
                <ScanFrame color="primary">
                  <InnerIcon className="w-16 h-16 text-heading-gray" />
                </ScanFrame>
              </button>
              <h1 className="text-2xl font-semibold font-heading text-heading-gray text-center mt-8">{promptTitle}</h1>
              {error && <p className="text-sm text-status-negative text-center mt-3 px-4">{error}</p>}
            </>
          ) : (
            <>
              <ScanFrame color="positive">
                <div className="size-20 rounded-2xl bg-status-positive flex items-center justify-center">
                  <div className="size-14 rounded-full bg-pure-white/20 flex items-center justify-center">
                    <Icon name={IconName.Checkmark} size="lg" className="text-pure-white" />
                  </div>
                </div>
              </ScanFrame>
              <h1 className="text-2xl font-semibold font-heading text-heading-gray text-center mt-8">
                {t('biometricConfirmed')}
              </h1>
              <p className="text-base text-text-tertiary-token text-center mt-2">{t('onlyOneMoreStep')}</p>
            </>
          )}
        </div>

        <div className="w-full flex flex-col items-center gap-2 shrink-0">
          {phase === 'prompt' ? (
            <Button title={t('usePasscodeInstead')} variant={ButtonVariant.Ghost} onClick={onSwitchToPasscode} />
          ) : (
            <Button title={t('continue')} onClick={onContinue} />
          )}
        </div>
      </div>
    </div>
  );
};

export default SetupBiometricScreen;
