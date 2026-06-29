import React, { useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as GatewayLogo } from 'app/icons/guardian-operator-logs/gateway.svg';
import { ReactComponent as LambdaClassLogo } from 'app/icons/guardian-operator-logs/lambdaclass.svg';
import { ReactComponent as OpenZeppelinLogo } from 'app/icons/guardian-operator-logs/open-zeppelin.svg';
import { Button } from 'components/Button';
import { Input } from 'components/Input';
import { GUARDIAN_OPTIONS } from 'lib/miden-chain/constants';
import { hapticLight } from 'lib/mobile/haptics';
import type { GuardianOption } from 'lib/shared/types';
import { cn } from 'lib/ui/util';

import { GuardianInfoDrawer } from './GuardianInfoDrawer';

export type { GuardianOption };

// Brand wordmark per guardian option id. Paths are hardcoded brand-grey
// (#484848); `[&_path]:fill-heading-gray` recolors them to the auto-flipping
// heading token so they stay legible in both themes.
const GUARDIAN_LOGOS: Record<string, ImportedSVGComponent> = {
  'open-zeppelin': OpenZeppelinLogo,
  gateway: GatewayLogo,
  'lambda-class': LambdaClassLogo
};

export interface ChooseGuardianScreenProps {
  onSubmit?: (payload: { guardianId: string; guardianEndpoint: string }) => void;
  // Highlight (and default-skip) the option matching this endpoint — used by
  // GuardianSettings to mark the user's currently-active guardian.
  currentEndpoint?: string;
  title?: string;
  description?: string;
  submitLabel?: string;
  // When true, hide the page-level header (title/description/learn-more) so the
  // host screen can supply its own framing.
  hideHeader?: boolean;
  // When true, show a free-form Guardian URL input below the grid (used by the
  // rotation flow for self-hosted guardians). A non-empty input wins over the
  // card selection.
  showCustomEndpoint?: boolean;
}

export const ChooseGuardianScreen: React.FC<ChooseGuardianScreenProps> = ({
  onSubmit,
  currentEndpoint,
  title,
  description,
  submitLabel,
  hideHeader = false,
  showCustomEndpoint = false
}) => {
  const { t } = useTranslation();
  const [isInfoOpen, setIsInfoOpen] = useState(false);

  const options = useMemo<GuardianOption[]>(() => GUARDIAN_OPTIONS, []);

  const defaultId = useMemo(() => {
    if (currentEndpoint) {
      const other = options.find(o => o.endpoint !== currentEndpoint);
      if (other) return other.id;
    }
    return options[0]!.id;
  }, [currentEndpoint, options]);

  const [selectedId, setSelectedId] = useState<string>(defaultId);
  const [customEndpoint, setCustomEndpoint] = useState('');
  const trimmedCustomEndpoint = customEndpoint.trim();

  const handleSelect = (id: string) => {
    hapticLight();
    setSelectedId(id);
    setCustomEndpoint('');
  };

  const handleContinue = () => {
    if (showCustomEndpoint && trimmedCustomEndpoint) {
      onSubmit?.({ guardianId: 'custom', guardianEndpoint: trimmedCustomEndpoint });
      return;
    }
    const selected = options.find(o => o.id === selectedId) ?? options[0]!;
    onSubmit?.({ guardianId: selected.id, guardianEndpoint: selected.endpoint });
  };

  return (
    <div className="bg-app-bg h-full overflow-y-auto" data-testid="onboarding-choose-guardian">
      <div className="min-h-full flex flex-col px-6 pb-6">
        {!hideHeader && (
          <div className="pt-8 shrink-0">
            <h1 className="text-[32px] font-semibold font-heading text-heading-gray leading-[105%] tracking-tight">
              {title ?? t('chooseYourGuardian')}
            </h1>
            <p className="text-lg font-medium text-heading-gray mt-2 leading-[130%]">
              {description ?? t('chooseGuardianDescription')}
            </p>
            <button
              type="button"
              onClick={() => {
                hapticLight();
                setIsInfoOpen(true);
              }}
              className="mt-2 text-base font-bold text-primary-500 underline underline-offset-4 decoration-2"
            >
              {t('learnMoreAboutGuardian')}
            </button>
          </div>
        )}

        <div className="grid grid-cols-[repeat(2,177px)] justify-center gap-x-4 gap-y-3 mt-7">
          {options.map(option => {
            const isSelected = selectedId === option.id && !trimmedCustomEndpoint;
            const isDefault = option.id === defaultId;
            const isCurrent = currentEndpoint != null && option.endpoint === currentEndpoint;
            const Logo = GUARDIAN_LOGOS[option.id];
            return (
              <div key={option.id} className="flex flex-col">
                <button
                  type="button"
                  onClick={() => handleSelect(option.id)}
                  className={cn(
                    'relative flex h-30.5 w-44.25 flex-col overflow-hidden rounded-[20px] transition-all duration-150',
                    'border-2',
                    isSelected ? 'border-primary-500' : 'border-[#E3E3E3] dark:border-grey-800'
                  )}
                >
                  {(isCurrent || isDefault) && (
                    <div
                      className={cn(
                        'flex h-8 w-full shrink-0 items-center justify-center',
                        isCurrent ? 'bg-grey-200 text-heading-gray dark:bg-grey-700' : 'bg-primary-500 text-pure-white'
                      )}
                    >
                      <span className="text-sm font-semibold">{isCurrent ? t('currentLabel') : t('default')}</span>
                    </div>
                  )}
                  <div className="flex flex-1 items-center justify-center">
                    {Logo && <Logo className="[&_path]:fill-heading-gray" />}
                  </div>
                </button>
                <div className="mt-2 px-1 text-center text-[#8E8E93] text-[10px] leading-tight">
                  <p className="">
                    {t('guardianOperatedBy')} <span className="font-bold">{option.operatedBy}</span>
                  </p>
                  <div className="w-18.75 mx-auto bg-[#E7753770] h-px" />
                  <p className="mt-0.5">
                    {t('guardianLocation')} <span className="font-bold">{option.location}</span>
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {showCustomEndpoint && (
          <div className="mt-6 pt-5 border-t border-grey-100 dark:border-grey-800">
            <h2 className="text-lg font-semibold text-heading-gray">{t('customEndpoint')}</h2>
            <p className="text-sm text-text-tertiary-token mt-1">{t('customEndpointDescription')}</p>
            <div className="mt-3">
              <Input
                id="custom-guardian-endpoint"
                value={customEndpoint}
                placeholder={t('customEndpointPlaceholder')}
                onChange={event => setCustomEndpoint(event.target.value)}
              />
            </div>
          </div>
        )}

        <div className="w-full flex flex-col items-center gap-4 pt-6 mt-auto shrink-0">
          <Button title={submitLabel ?? t('continue')} onClick={handleContinue} />
        </div>
      </div>
      <GuardianInfoDrawer open={isInfoOpen} onOpenChange={setIsInfoOpen} />
    </div>
  );
};

export default ChooseGuardianScreen;
