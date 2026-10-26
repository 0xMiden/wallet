import React, { FC, useCallback } from 'react';

import { postOnboardingRoute } from 'lib/extension/side-panel-handoff';
import { navigate } from 'lib/woozie';
import { HelpImproveWalletScreen } from 'screens/onboarding/common/HelpImproveWallet';

/**
 * Telemetry consent prompt (`/help-improve-wallet`).
 *
 * Shown once, immediately after the wallet is created or imported, and only to a
 * user who has not answered before. Like `/finish-side-panel` it lives on its own
 * route rather than inside the onboarding flow, because creating the wallet flips
 * the app to the wallet home — a step inside the flow would be unmounted from
 * under the user before they could answer.
 *
 * The screen persists the answer itself; this wrapper only decides where the
 * answer leads, which is wherever onboarding would have gone anyway. On Chrome
 * that is the side-panel handoff screen, so the chain stays create → consent →
 * `/finish-side-panel`, and the panel still opens inside its own button's user
 * gesture.
 */
const HelpImproveWalletPrompt: FC = () => {
  const onSubmit = useCallback(() => {
    navigate(postOnboardingRoute());
  }, []);

  // Match the onboarding flow's centered, max-width container (this screen is
  // rendered directly by PageRouter, not inside OnboardingFlow's wrapper).
  return (
    <div className="flex flex-col bg-app-bg overflow-hidden w-full h-full mx-auto" style={{ maxWidth: 420 }}>
      <HelpImproveWalletScreen onSubmit={onSubmit} />
    </div>
  );
};

export default HelpImproveWalletPrompt;
