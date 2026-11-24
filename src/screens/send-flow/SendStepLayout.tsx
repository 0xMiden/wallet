import React from 'react';

import { FlowLayout, FlowLayoutProps } from 'components/flow/FlowLayout';
import { useFlowPresentation } from 'components/flow/FlowPresentation';

export type SendStepLayoutProps = FlowLayoutProps & { embedded?: boolean };

/** In Command the workbench supplies the sole frame; compact keeps its existing flow frame. */
export const SendStepLayout: React.FC<SendStepLayoutProps> = ({ embedded, children, ...props }) => {
  const command = useFlowPresentation() === 'command';
  if (command && embedded) return <>{children}</>;
  return <FlowLayout {...props}>{children}</FlowLayout>;
};
