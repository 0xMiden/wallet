import { FlowLayout, FlowLayoutProps } from 'components/flow/FlowLayout';

export type SendStepLayoutProps = FlowLayoutProps;

/**
 * A send flow page: the shared flow frame. The Send accent marks the flow's selected states, never
 * its back button, which stays ink like every other page's.
 */
export const SendStepLayout = FlowLayout;
