import React from 'react';

import { useFlowPresentation } from 'components/flow/FlowPresentation';
import { SubPageLayout, SubPageLayoutProps, SubPageSection } from 'components/ui/SubPageLayout';
import { cn } from 'lib/ui/util';
import { useCommandWorkbenchSlots } from 'screens/command/CommandWorkbench';

/** Keep native Earn pages intact while the Command workbench pins their existing action outside its scroll area. */
export function EarnPageLayout({
  footer,
  footerLayout,
  showCommandSubject = false,
  ...props
}: SubPageLayoutProps & { showCommandSubject?: boolean }): React.ReactElement {
  const command = useFlowPresentation() === 'command';
  const commandFooter = useCommandWorkbenchSlots(
    command && footer ? (
      <div className={cn('flex gap-2.5', footerLayout === 'stack' && 'flex-col [&>*]:flex-none')}>{footer}</div>
    ) : null
  );
  return (
    <>
      <SubPageLayout {...props} footer={command ? undefined : footer} footerLayout={footerLayout}>
        {command && showCommandSubject && props.title && (
          <SubPageSection titleAs="h2" titleSize="md" title={props.title} description={props.subtitle} />
        )}
        {props.children}
      </SubPageLayout>
      {commandFooter}
    </>
  );
}
