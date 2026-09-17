import React from 'react';

import { FlowBackButton, FlowLayout, FlowLayoutProps } from 'components/flow/FlowLayout';

/** The send flow's back button: nav button surface, Send-accent arrow. */
export const SendBackButton: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <FlowBackButton onBack={onBack} accent="send" />
);

export type SendStepLayoutProps = Omit<FlowLayoutProps, 'accent'>;

/** A send flow page: the shared flow frame in the Send accent. */
export const SendStepLayout: React.FC<SendStepLayoutProps> = props => <FlowLayout {...props} accent="send" />;
