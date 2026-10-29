import React, { useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { ChoiceCardGroup, ChoiceCardItem } from 'components/ui/ChoiceCard';
import type { HotKeyActivationMode } from 'lib/miden/db/types';

import { OnboardingStepLayout } from '../common/OnboardingStepLayout';

export interface ChooseDeviceRoleProps {
  /** The number of devices that hold this wallet now. When it is not known, the screen does not show the count. */
  deviceCount?: number;
  submitting?: boolean;
  onSubmit: (mode: HotKeyActivationMode) => void;
}

/**
 * The first step after a recovery with the recovery phrase: the user selects how this device joins the wallet.
 * "Add this device" keeps the other devices of the wallet. "Make this device the main one" removes every other
 * device. "Add this device" is the default because it removes nothing.
 */
export const ChooseDeviceRole: React.FC<ChooseDeviceRoleProps> = ({ deviceCount, submitting = false, onSubmit }) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<HotKeyActivationMode>('add');
  // The screen shows the count line only for a known count of one or more.
  const countLine = useMemo(() => {
    if (deviceCount === undefined || deviceCount < 1) return null;
    return deviceCount === 1 ? t('chooseDeviceRoleDevice') : t('chooseDeviceRoleDevices', { count: deviceCount });
  }, [deviceCount, t]);

  const options: ChoiceCardItem<HotKeyActivationMode>[] = useMemo(
    () => [
      {
        id: 'add',
        title: t('chooseDeviceRoleAdd'),
        'data-testid': 'device-role-add'
      },
      {
        id: 'replace',
        title: t('chooseDeviceRoleMain'),
        subtitle: t('chooseDeviceRoleMainSubtitle'),
        'data-testid': 'device-role-main'
      }
    ],
    [t]
  );

  return (
    <OnboardingStepLayout
      data-testid="choose-device-role"
      title={t('chooseDeviceRoleTitle')}
      description={
        <>
          {countLine && <span className="block">{countLine}</span>}
          <span className="block">{t('chooseDeviceRoleDescription')}</span>
        </>
      }
      footer={
        <Button
          className="max-w-none"
          data-testid="device-role-continue"
          title={t('continue')}
          isLoading={submitting}
          disabled={submitting}
          onClick={() => onSubmit(selected)}
        />
      }
    >
      <ChoiceCardGroup
        items={options}
        value={selected}
        onChange={setSelected}
        aria-label={t('chooseDeviceRoleTitle')}
      />
    </OnboardingStepLayout>
  );
};

export default ChooseDeviceRole;
