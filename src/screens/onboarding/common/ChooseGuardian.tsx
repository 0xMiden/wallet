import React, { useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as GuardianAvatar } from 'app/icons/onboarding/guardian-avatar.svg';
import { Button } from 'components/Button';
import { Input } from 'components/Input';
import { DEFAULT_NETWORK, GUARDIAN_OPTIONS } from 'lib/miden-chain/constants';
import { hapticLight } from 'lib/mobile/haptics';
import { isValidGuardianUrl, sanitizeGuardianUrl } from 'lib/settings/helpers';
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
  // When true, show a "custom Guardian URL" field below the provider grid.
  allowCustomEndpoint?: boolean;
}

export const ChooseGuardianScreen: React.FC<ChooseGuardianScreenProps> = ({
  onSubmit,
  currentEndpoint,
  title,
  description,
  submitLabel,
  hideHeader = false,
  allowCustomEndpoint = false
}) => {
  const { t } = useTranslation();
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [isCustom, setIsCustom] = useState(false);
  const [customUrl, setCustomUrl] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);

  // Resolve each provider to its endpoint on the active network, dropping any
  // provider that doesn't run a Guardian on this network.
  const options = useMemo(
    () =>
      GUARDIAN_OPTIONS.filter(o => o.endpoint.has(DEFAULT_NETWORK)).map(o => ({
        id: o.id,
        name: o.name,
        operatedBy: o.operatedBy,
        location: o.location,
        endpoint: o.endpoint.get(DEFAULT_NETWORK)!
      })),
    []
  );

  const defaultId = useMemo(() => {
    if (currentEndpoint) {
      const other = options.find(o => o.endpoint !== currentEndpoint);
      if (other) return other.id;
    }
    return options[0]?.id ?? '';
  }, [currentEndpoint, options]);

  const [selectedId, setSelectedId] = useState<string>(defaultId);

  const handleSelect = (id: string) => {
    hapticLight();
    setSelectedId(id);
    setIsCustom(false);
  };

  const handleContinue = () => {
    if (isCustom) {
      const sanitized = sanitizeGuardianUrl(customUrl);
      if (!isValidGuardianUrl(sanitized)) {
        setCustomError(t('invalidUrl'));
        return;
      }
      setCustomError(null);
      onSubmit?.({ guardianId: 'custom', guardianEndpoint: sanitized });
      return;
    }
    const selected = options.find(o => o.id === selectedId) ?? options[0];
    if (!selected) return;
    onSubmit?.({ guardianId: selected.id, guardianEndpoint: selected.endpoint });
  };

  return (
    <div
      className="flex-1 flex flex-col bg-transparent pt-6 h-full min-h-0 overflow-y-auto px-4 text-heading-gray"
      data-testid="onboarding-choose-guardian"
    >
      {!hideHeader && (
        <div className="flex flex-col items-center gap-2 shrink-0">
          <h1 className="font-semibold text-2xl lh-title text-center">{title ?? t('chooseYourGuardian')}</h1>
          <p className="text-xs text-center lh-title px-4">{description ?? t('chooseGuardianDescription')}</p>
          <button
            type="button"
            onClick={() => {
              hapticLight();
              setIsInfoOpen(true);
            }}
            className="text-xs font-bold text-primary-500 underline underline-offset-4 decoration-2"
          >
            {t('learnMoreAboutGuardian')}
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 mt-6">
        {options.map(option => {
          const isSelected = !isCustom && selectedId === option.id;
          const isCurrent = currentEndpoint != null && option.endpoint === currentEndpoint;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => handleSelect(option.id)}
              className={cn(
                'flex flex-col items-start p-3 rounded-lg bg-white text-left transition-all duration-150',
                'border-2',
                isSelected ? 'border-primary-500' : 'border-transparent'
              )}
            >
              <div className="w-14 h-14 rounded-xl bg-gray-50 flex items-center justify-center">
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
                <span className="text-xs text-grey-600">
                  <span className="font-semibold">{t('guardianOperatedBy')}</span> {option.operatedBy}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="block w-2 h-2 bg-primary-500" />
                <span className="text-xs text-grey-600">
                  <span className="font-semibold">{t('guardianLocation')}</span> {option.location}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {allowCustomEndpoint && (
        <div className="mt-4 flex flex-col gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              hapticLight();
              setIsCustom(prev => !prev);
              setCustomError(null);
            }}
            className="self-start text-xs font-bold text-primary-500"
          >
            {t('useCustomGuardianUrl')}
          </button>
          {isCustom && (
            <>
              <Input
                id="custom-guardian-endpoint"
                value={customUrl}
                placeholder="https://"
                onChange={event => {
                  setCustomUrl(event.target.value);
                  if (customError) setCustomError(null);
                }}
              />
              {customError && <p className="text-red-500 text-xs">{customError}</p>}
            </>
          )}
        </div>
      )}

      <div className="w-full flex flex-col gap-4 pt-6 mt-auto shrink-0">
        <Button title={submitLabel ?? t('continue')} onClick={handleContinue} className="w-full text-base" />
      </div>

      <GuardianInfoDrawer open={isInfoOpen} onOpenChange={setIsInfoOpen} />
    </div>
  );
};

export default ChooseGuardianScreen;
