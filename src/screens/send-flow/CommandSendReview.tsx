import React from 'react';

import { useRegisterCommandFlowBack } from 'components/flow/FlowPresentation';

import type { SendStepLayoutProps } from './SendStepLayout';

/** A presentation of the existing review controller, not a second submission path. */
export const CommandSendReview: React.FC<SendStepLayoutProps> = ({ children, footer, onBack }) => {
  useRegisterCommandFlowBack(onBack);
  return (
    <div data-testid="command-send-review" className="flex flex-col gap-4">
      {children}
      <div className="border-t border-hairline pt-4">{footer}</div>
    </div>
  );
};
