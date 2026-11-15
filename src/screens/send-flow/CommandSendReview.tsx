import React from 'react';

import { useRegisterCommandFlowBack } from 'components/flow/FlowPresentation';
import { useCommandWorkbenchSlots } from 'screens/command/CommandWorkbench';

import type { SendStepLayoutProps } from './SendStepLayout';

/** A presentation of the existing review controller, not a second submission path. */
export const CommandSendReview: React.FC<SendStepLayoutProps> = ({ children, footer, onBack }) => {
  useRegisterCommandFlowBack(onBack);
  const footerOutlet = useCommandWorkbenchSlots(footer);
  return (
    <div data-testid="command-send-review" className="flex flex-col gap-4">
      {children}
      {footerOutlet}
    </div>
  );
};
