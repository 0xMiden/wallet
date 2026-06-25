import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import {
  initiateSwitchGuardianTransaction,
  requestSWTransactionProcessing,
  waitForTransactionCompletion
} from 'lib/miden/activity';
import { fetchFromStorage, onStorageChanged } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { isExtension } from 'lib/platform';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';
import { isDelegateProofEnabled, isValidGuardianUrl } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { ChooseGuardianScreen } from 'screens/onboarding/common/ChooseGuardian';

const GuardianSettings: FC = () => {
  const { t } = useTranslation();
  const { endpoint: currentEndpoint } = useCurrentGuardianEndpoint();

  const option = guardianOptionForEndpoint(currentEndpoint);
  const guardianName = option?.name ?? (currentEndpoint ? t('customGuardian') : t('loading'));

  const handleRotate = () => {
    hapticLight();
    navigate('/rotate-guardian');
  };

  return (
    <div className="w-full flex flex-col">
      <div className="flex flex-col items-center pt-2">
        <div className="w-16 h-16 rounded-10 bg-grey-100 dark:bg-grey-800 flex items-center justify-center">
          <GuardianAvatar className="w-14 h-14" />
        </div>
        <h2 className="mt-3 text-xl font-bold font-heading text-heading-gray">{guardianName}</h2>
      </div>

      <ChooseGuardianScreen
        onSubmit={handleSubmit}
        currentEndpoint={currentEndpoint}
        hideHeader
        submitLabel={submitting ? t('loading') : confirming ? t('confirmSwitchGuardian') : t('switchGuardian')}
      />

      <hr className="my-4" />

      {error && <div className="mt-3 text-red-500 text-xs select-text">{error}</div>}

      <div className="mt-6">
        <Button title={t('rotateGuardian')} onClick={handleRotate} />
      </div>
    </div>
  );
};

export default GuardianSettings;
