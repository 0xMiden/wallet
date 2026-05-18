import React, { useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as GuardianAvatar } from 'app/icons/onboarding/guardian-avatar.svg';
import { Button } from 'components/Button';
import { DEFAULT_GUARDIAN_ENDPOINT } from 'lib/miden-chain/constants';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

import { GuardianInfoDrawer } from './GuardianInfoDrawer';

export interface GuardianOption {
  id: string;
  name: string;
  operatedBy: string;
  location: string;
  endpoint: string;
}

export interface ChooseGuardianScreenProps {
  onSubmit?: (payload: { guardianId: string; guardianEndpoint: string }) => void;
}

export const ChooseGuardianScreen: React.FC<ChooseGuardianScreenProps> = ({ onSubmit }) => {
  const { t } = useTranslation();
  const [isInfoOpen, setIsInfoOpen] = useState(false);

  const options: GuardianOption[] = useMemo(
    () => [
      {
        id: 'open-zeppelin',
        name: 'Open-Zeppelin',
        operatedBy: 'Miden Labs',
        location: 'US-EAST',
        endpoint: DEFAULT_GUARDIAN_ENDPOINT
      }
    ],
    []
  );

  const [selectedId, setSelectedId] = useState<string>(options[0]!.id);

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
        <div className="pt-8 shrink-0">
          <h1 className="text-[32px] font-semibold font-heading text-heading-gray leading-[105%] tracking-tight">
            {t('chooseYourGuardian')}
          </h1>
          <p className="text-lg font-medium text-heading-gray mt-2 leading-[130%]">{t('chooseGuardianDescription')}</p>
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

        <div className="grid grid-cols-2 gap-3 mt-4.5">
          {options.map(option => {
            const isSelected = selectedId === option.id;
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
                <h2 className="mt-3 text-base font-semibold text-heading-gray">{option.name}</h2>
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
          <Button title={t('continue')} onClick={handleContinue} />
        </div>
      </div>
      <GuardianInfoDrawer open={isInfoOpen} onOpenChange={setIsInfoOpen} />
    </div>
  );
};

export default ChooseGuardianScreen;
