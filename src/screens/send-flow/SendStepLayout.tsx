import React from 'react';

import { FlowLayout, FlowLayoutProps } from 'components/flow/FlowLayout';

export type SendStepLayoutProps = Omit<FlowLayoutProps, 'accent'>;

/** A send flow page: the shared flow frame in the Send accent. */
export const SendStepLayout: React.FC<SendStepLayoutProps> = props => <FlowLayout {...props} accent="send" />;
