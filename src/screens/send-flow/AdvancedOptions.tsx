import React, { useState } from 'react';

import clsx from 'clsx';
import { format } from 'date-fns';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';

import { SendFlowAction, SendFlowActionId } from './types';

export const AdvancedOptions = ({
  sharePrivately,
  delegateTransaction,
  recallDate,
  recallTime,
  onAction,
  onOpenCalendar
}: {
  sharePrivately: boolean;
  delegateTransaction: boolean;
  recallDate?: Date;
  recallTime: string;
  onAction: (action: SendFlowAction) => void;
  onOpenCalendar: () => void;
}) => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);

  const displayRecallLabel = recallDate ? `${format(recallDate, 'MMM d, yyyy')} ${recallTime}` : t('selectRecallDate');

  return (
    <div className="py-4">
      <button
        type="button"
        className={clsx(
          'flex items-center justify-between w-full px-4 py-3.5 transition-colors bg-input-bg cursor-pointer',
          showAdvanced ? 'rounded-t-[10px]' : 'rounded-[10px]'
        )}
        onClick={() => {
          hapticLight();
          setShowAdvanced(prev => !prev);
        }}
      >
        <span className="text-sm font-semibold text-heading-gray">{t('advancedOptions')}</span>
        <motion.div animate={{ rotate: showAdvanced ? 90 : 0 }} transition={{ duration: 0.2 }}>
          <Icon name={IconName.ChevronRight} size="xs" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {showAdvanced && (
          <motion.section
            key="advanced-content"
            initial="collapsed"
            animate="open"
            exit="collapsed"
            variants={{
              open: { opacity: 1, height: 'auto' },
              collapsed: { opacity: 0, height: 0 }
            }}
            transition={{ duration: 0.3 }}
            className="bg-input-bg rounded-b-[10px] overflow-hidden shrink-0"
          >
            <div className="px-4 pb-4 flex flex-col gap-4">
              {/* Private Payment */}
              <OptionItem
                title={t('privatePayment')}
                subTitle={t('privatePaymentDescription')}
                value={sharePrivately}
                onToggle={(val: boolean) => {
                  hapticMedium();
                  onAction({ id: SendFlowActionId.SetFormValues, payload: { sharePrivately: val } });
                }}
              />

              {/* Delegate Proving */}
              <OptionItem
                title={t('delegateProving')}
                subTitle={t('delegateProvingDescription')}
                value={delegateTransaction}
                onToggle={(val: boolean) => {
                  hapticMedium();
                  onAction({ id: SendFlowActionId.SetFormValues, payload: { delegateTransaction: val } });
                }}
              />

              {/* Recall Height */}
              <div>
                <h3 className="text-base leading-4 font-semibold text-[#808080]">{t('recallHeight')}</h3>
                <p className="text-xs text-heading-gray mt-1">{t('recallHeightDescription')}</p>
                <button
                  type="button"
                  className="w-full h-14 flex items-center justify-between bg-app-bg rounded-[10px] px-4 mt-3 cursor-pointer"
                  onClick={onOpenCalendar}
                >
                  <div className="flex items-center gap-2">
                    <Icon name={IconName.Calendar} size="xs" className="text-text-muted" />
                    <span
                      className={clsx('text-sm font-medium', recallDate ? 'text-heading-gray' : 'text-heading-gray/60')}
                    >
                      {displayRecallLabel}
                    </span>
                  </div>
                  <Icon name={IconName.ChevronDown} size="xs" fill="currentColor" />
                </button>
              </div>
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
};

export const OptionItem = ({
  icon,
  onToggle,
  title,
  subTitle,
  value
}: {
  icon?: IconName;
  onToggle: (val: boolean) => void;
  title: string;
  subTitle: string;
  value: boolean;
}) => {
  return (
    <div className="flex items-center justify-between font-inter">
      <div className="flex items-center gap-3">
        {icon && (
          <div className="w-10 h-10 rounded-[10px] flex items-center justify-center shrink-0">
            <Icon name={icon} size="sm" className="text-primary-500" />
          </div>
        )}
        <div className="space-y-0.5">
          <div className={clsx('font-medium text-heading-gray leading-none', isMobile() ? 'text-sm' : 'text-base')}>
            {title}
          </div>
          <div className={clsx('text-heading-gray/60', isMobile() ? 'text-[10px]' : 'text-xs')}>{subTitle}</div>
        </div>
      </div>
      <ToggleSwitch value={value} onToggle={onToggle} />
    </div>
  );
};

const ToggleSwitch = ({ value, onToggle }: { value: boolean; onToggle: (val: boolean) => void }) => {
  const { t } = useTranslation();
  return (
    <div className="flex rounded-[10px] border border-border-card overflow-hidden shrink-0">
      <button
        type="button"
        className={clsx(
          'w-14 h-9 text-xs font-medium flex items-center justify-center transition-colors cursor-pointer',
          value ? 'bg-app-bg text-primary-500' : 'bg-input-bg text-heading-gray/40'
        )}
        onClick={() => onToggle(true)}
      >
        {t('on')}
      </button>
      <button
        type="button"
        className={clsx(
          'w-14 h-9 text-xs font-medium flex items-center justify-center transition-colors border-l border-border-card cursor-pointer',
          !value ? 'bg-app-bg text-primary-500' : 'bg-input-bg text-heading-gray/40'
        )}
        onClick={() => onToggle(false)}
      >
        {t('off')}
      </button>
    </div>
  );
};
