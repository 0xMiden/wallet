import React, { useEffect, useMemo, useRef, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { GUARDIAN_LOGOS, guardianLogoColorClass } from 'app/icons/guardian-operator-logs';
import { ReactComponent as GuardianAvatar } from 'app/icons/onboarding/guardian-avatar.svg';
import { Button } from 'components/Button';
import { Input } from 'components/Input';
import { getGuardianOptionsForNetwork } from 'lib/miden-chain/constants';
import { hapticLight } from 'lib/mobile/haptics';
import { isValidGuardianUrl, sanitizeGuardianUrl } from 'lib/settings/helpers';
import type { GuardianOption } from 'lib/shared/types';
import { cn } from 'lib/ui/util';
import { NO_GUARDIAN_ID } from 'screens/onboarding/types';

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
  // Dev-gated (onboarding only): show a selectable "No guardian" card that
  // creates a private single-key account with no guardian co-signer.
  showNoGuardianOption?: boolean;
}

export const ChooseGuardianScreen: React.FC<ChooseGuardianScreenProps> = ({
  onSubmit,
  currentEndpoint,
  title,
  description,
  submitLabel,
  hideHeader = false,
  allowCustomEndpoint = false,
  showNoGuardianOption = false
}) => {
  const { t } = useTranslation();
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [isCustom, setIsCustom] = useState(false);
  const [customUrl, setCustomUrl] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);

  // Providers that run a Guardian on the active network, resolved to their
  // endpoint on it.
  const options = useMemo(() => getGuardianOptionsForNetwork(), []);

  // In the switch context (GuardianSettings passes `currentEndpoint`) pre-select
  // the CURRENT operator, so the user has to deliberately pick a different one to
  // switch — never nudge them onto another operator by default. In the create
  // flow (no `currentEndpoint`) default to the first provider.
  const defaultId = useMemo(() => {
    if (currentEndpoint) {
      const current = options.find(o => o.endpoint === currentEndpoint);
      if (current) return current.id;
    }
    return options[0]?.id ?? '';
  }, [currentEndpoint, options]);

  const [selectedId, setSelectedId] = useState<string>(defaultId);
  // Until the user makes an explicit choice, keep the selection in sync with
  // `defaultId` so a `currentEndpoint` that resolves after mount (async store
  // hydration) still updates the highlighted card.
  const userSelectedRef = useRef(false);
  useEffect(() => {
    if (!userSelectedRef.current) setSelectedId(defaultId);
  }, [defaultId]);

  const handleSelect = (id: string) => {
    hapticLight();
    userSelectedRef.current = true;
    setSelectedId(id);
    setIsCustom(false);
  };

  const handleContinue = () => {
    if (selectedId === NO_GUARDIAN_ID) {
      onSubmit?.({ guardianId: NO_GUARDIAN_ID, guardianEndpoint: '' });
      return;
    }
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
    <div className="bg-app-bg h-full overflow-y-auto" data-testid="onboarding-choose-guardian">
      <div className="min-h-full flex flex-col px-6 pb-6">
        {!hideHeader && (
          <div className="pt-8 shrink-0">
            <h1 className="text-[2rem] font-semibold font-heading text-heading-gray leading-[105%] tracking-tight">
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
            const isSelected = selectedId === option.id;
            const isDefault = option.id === defaultId;
            const isCurrent = currentEndpoint != null && option.endpoint === currentEndpoint;
            // GUARDIAN_LOGOS is keyed by provider id with no compile-time tie to
            // GUARDIAN_OPTIONS, so the old `GUARDIAN_LOGOS[option.id]!` + destructure
            // threw "Cannot destructure property 'Logo' of undefined" for any option
            // without a registered wordmark. Every CURRENT production operator
            // (open-zeppelin, gateway, lambda-class, kodax) has an entry, so this
            // only ever fired for the E2E-only test operator ('open-zeppelin-b') —
            // but it's a real latent fragility the instant a logo-less operator is
            // added. Fall back to the generic avatar, mirroring GuardianSettings.tsx's
            // existing safe lookup.
            const logoEntry = GUARDIAN_LOGOS[option.id];
            return (
              <div key={option.id} className="flex flex-col">
                <button
                  type="button"
                  onClick={() => handleSelect(option.id)}
                  data-guardian-endpoint={option.endpoint}
                  className={cn(
                    'relative flex h-30.5 w-44.25 flex-col overflow-hidden rounded-[20px] transition-all duration-150',
                    'border-2',
                    isSelected ? 'border-primary-500 border-4' : 'border-[#E3E3E3] dark:border-grey-800'
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
                    {logoEntry ? (
                      <logoEntry.Logo className={clsx(guardianLogoColorClass(logoEntry), logoEntry.paddingXClass)} />
                    ) : (
                      <GuardianAvatar className="w-10 h-10" />
                    )}
                  </div>
                </button>
                <div className="mt-2 px-1 text-center text-gray-secondary dark:text-pure-white text-[10px] leading-tight">
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

        {showNoGuardianOption && (
          <button
            type="button"
            onClick={() => handleSelect(NO_GUARDIAN_ID)}
            data-testid="choose-no-guardian"
            className={cn(
              'mt-4 flex flex-col items-start rounded-[20px] border-2 p-4 text-left transition-all duration-150 shrink-0',
              selectedId === NO_GUARDIAN_ID ? 'border-primary-500 border-4' : 'border-[#E3E3E3] dark:border-grey-800'
            )}
          >
            <span className="text-base font-semibold text-heading-gray">{t('noGuardianOptionTitle')}</span>
            <span className="mt-1 text-xs text-gray-secondary dark:text-pure-white">
              {t('noGuardianOptionSubtitle')}
            </span>
          </button>
        )}

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
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="done"
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.currentTarget.blur();
                    }
                  }}
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

        <div className="w-full flex flex-col items-center gap-4 pt-6 mt-auto shrink-0">
          <Button
            data-testid="choose-guardian-continue"
            title={submitLabel ?? t('continue')}
            onClick={handleContinue}
          />
        </div>
      </div>

      <GuardianInfoDrawer open={isInfoOpen} onOpenChange={setIsInfoOpen} />
    </div>
  );
};

export default ChooseGuardianScreen;
