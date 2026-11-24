import React, { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';

import * as Dialog from '@radix-ui/react-dialog';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { useCommandFlowBack } from 'components/flow/FlowPresentation';
import { WorkbenchLayout } from 'components/flow/WorkbenchLayout';
import { navigate } from 'lib/woozie';

import type { CommandRoute } from './command-routes';

type SlotOwner = { id: symbol; footer: boolean; summary: boolean };
type WorkbenchSlots = {
  footerHost: HTMLElement | null;
  summaryHost: HTMLDivElement | null;
  active: symbol | undefined;
  register: (id: symbol, footer: boolean, summary: boolean) => () => void;
};
const SlotContext = createContext<WorkbenchSlots | null>(null);

/** Keep authored controls in their controller's React context while WorkbenchLayout owns their placement. */
export function useCommandWorkbenchSlots(footer: React.ReactNode, summary?: React.ReactNode): React.ReactNode {
  const slots = useContext(SlotContext);
  const owner = useRef(Symbol('command-workbench-slots'));
  const hasFooter = footer != null;
  const hasSummary = summary != null;
  const register = slots?.register;
  useLayoutEffect(() => {
    if (!register || (!hasFooter && !hasSummary)) return;
    return register(owner.current, hasFooter, hasSummary);
  }, [register, hasFooter, hasSummary]);

  if (!slots)
    return (
      <>
        {summary}
        {footer}
      </>
    );
  if (slots.active !== owner.current) return null;
  return (
    <>
      {hasSummary && slots.summaryHost && createPortal(summary, slots.summaryHost)}
      {hasFooter && slots.footerHost && createPortal(footer, slots.footerHost)}
    </>
  );
}

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
  const fallbackBack = useBackWithFallback();
  const activeBack = useCommandFlowBack()?.activeBack;
  const [owners, setOwners] = useState<SlotOwner[]>([]);
  const owner = owners.at(-1);
  const [footerHost, setFooterHost] = useState<HTMLElement | null>(null);
  const [summaryHost, setSummaryHost] = useState<HTMLDivElement | null>(null);
  const register = useCallback((id: symbol, footer: boolean, summary: boolean) => {
    setOwners(current => [...current, { id, footer, summary }]);
    return () => setOwners(current => current.filter(owner => owner.id !== id));
  }, []);
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
          asChild
          aria-describedby={undefined}
          onInteractOutside={event => event.preventDefault()}
          onEscapeKeyDown={event => {
            if (event.target instanceof HTMLElement && event.target.closest('[data-command-popover]')) {
              event.preventDefault();
            }
          }}
        >
          <div className="pointer-events-auto relative flex h-full min-h-0 w-full max-w-[66rem] flex-col outline-none sm:h-fit sm:max-h-full">
            <Dialog.Title className="sr-only">{title}</Dialog.Title>
            <SlotContext.Provider value={{ footerHost, summaryHost, active: owner?.id, register }}>
              <WorkbenchLayout
                title={title}
                onBack={activeBack ?? fallbackBack}
                onMinimize={() => navigate('/')}
                footerOutlet={owner?.footer ? setFooterHost : undefined}
                summaryOutlet={owner?.summary ? setSummaryHost : undefined}
              >
                {children}
              </WorkbenchLayout>
            </SlotContext.Provider>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
