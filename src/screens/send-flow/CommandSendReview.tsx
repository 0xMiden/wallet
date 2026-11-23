import React from 'react';

import { useRegisterCommandFlowBack } from 'components/flow/FlowPresentation';
import { useCommandWorkbenchSlots } from 'screens/command/CommandWorkbench';

import type { SendStepLayoutProps } from './SendStepLayout';

/** A presentation of the existing review controller, not a second submission path. */
export const CommandSendReview: React.FC<SendStepLayoutProps & { formId?: string; onFormSubmit?: () => void }> = ({
  children,
  footer,
  onBack,
  formId,
  onFormSubmit
}) => {
  useRegisterCommandFlowBack(onBack);
  const footerOutlet = useCommandWorkbenchSlots(footer);
  return (
    <form
      id={formId}
      data-testid="command-send-review"
      className="flex flex-col gap-4"
      onSubmit={event => {
        event.preventDefault();
        onFormSubmit?.();
      }}
    >
      {children}
      {footerOutlet}
    </form>
  );
};
