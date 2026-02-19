import React, { FC } from 'react';

import DelegateSettings from 'app/templates/DelegateSettings';
import { isMobile } from 'lib/platform';

import AutoConsumeSettings from './AutoConsumeSettings';
import HapticFeedbackSettings from './HapticFeedbackSettings';

const GeneralSettings: FC = () => {
  const mobile = isMobile();

  return (
    <div className="w-full max-w-sm mx-auto my-8 text-heading-gray">
      {/* Haptic feedback settings - only visible on mobile */}
      {mobile && <HapticFeedbackSettings />}

      {/* Delegate settings - hidden on mobile (always enabled on mobile) */}
      {!mobile && <DelegateSettings />}

      <AutoConsumeSettings />
    </div>
  );
};

export default GeneralSettings;
