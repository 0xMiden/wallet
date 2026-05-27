import React, { useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as GuardianAvatar } from 'app/icons/onboarding/guardian-avatar.svg';
import { Button } from 'components/Button';
import { GUARDIAN_OPTIONS } from 'lib/miden-chain/constants';
import { hapticLight } from 'lib/mobile/haptics';
import type { GuardianOption } from 'lib/shared/types';
import { cn } from 'lib/ui/util';

import { GuardianInfoDrawer } from './GuardianInfoDrawer';

export type { GuardianOption };

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
}

export const ChooseGuardianScreen: React.FC<ChooseGuardianScreenProps> = ({
  onSubmit,
  currentEndpoint,
  title,
  description,
  submitLabel,
  hideHeader = false
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

  const handleSelect = (id: string) => {
    hapticLight();
    setSelectedId(id);
  };

  const handleContinue = () => {
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

        <div className="grid grid-cols-2 gap-3 mt-4.5">
          {options.map(option => {
            const isSelected = selectedId === option.id;
            const isCurrent = currentEndpoint != null && option.endpoint === currentEndpoint;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => handleSelect(option.id)}
                className={cn(
                  'flex flex-col items-start p-3 rounded-xl bg-surface-interactive text-left transition-all duration-150',
                  'border-2',
                  isSelected ? 'border-primary-500' : 'border-transparent'
                )}
              >
                <div className="w-14 h-14 rounded-xl bg-grey-100 dark:bg-grey-800 flex items-center justify-center">
                  <GuardianAvatar className="w-10 h-10" />
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <h2 className="text-base font-semibold text-heading-gray">{option.name}</h2>
                  {isCurrent && (
                    <span className="text-[10px] uppercase tracking-wide font-semibold text-primary-500">
                      {t('currentLabel')}
                    </span>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  <span className="block w-2 h-2 bg-primary-500" />
                  <span className="text-xs text-text-tertiary-token">
                    <span className="font-semibold">{t('guardianOperatedBy')}</span> {option.operatedBy}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <span className="block w-2 h-2 bg-primary-500" />
                  <span className="text-xs text-text-tertiary-token">
                    <span className="font-semibold">{t('guardianLocation')}</span> {option.location}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="w-full flex flex-col items-center gap-4 pt-6 mt-auto shrink-0">
          <Button title={submitLabel ?? t('continue')} onClick={handleContinue} />
        </div>
      </div>
      <GuardianInfoDrawer open={isInfoOpen} onOpenChange={setIsInfoOpen} />
    </div>
  );
};

export default ChooseGuardianScreen;
