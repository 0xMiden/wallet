import React from 'react';

import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { WorkbenchLayout } from 'components/flow/WorkbenchLayout';
import { navigate } from 'lib/woozie';

import type { CommandRoute } from './command-routes';

export function CommandWorkbench({
  route,
  container,
  children
}: {
  route: Exclude<CommandRoute, { kind: 'dashboard' }>;
  container: HTMLElement | null;
  children: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  const back = useBackWithFallback();
  const title =
    route.kind === 'flow' ? t(route.action === 'bridge' ? 'commandBridge' : route.action) : t('commandOperation');
  return (
    <Dialog.Root
      open
      modal={false}
      onOpenChange={open => {
        if (!open) navigate('/');
      }}
    >
      <Dialog.Portal container={container ?? undefined}>
        <Dialog.Content
          aria-describedby={undefined}
          onInteractOutside={event => event.preventDefault()}
          className="relative h-full min-h-0 w-full outline-none"
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <WorkbenchLayout title={title} onBack={back} onMinimize={() => navigate('/')}>
            {children}
          </WorkbenchLayout>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
