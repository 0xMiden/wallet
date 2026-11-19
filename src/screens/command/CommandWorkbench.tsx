import React, { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';

import * as Dialog from '@radix-ui/react-dialog';
import { motion, useReducedMotion } from 'framer-motion';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { useCommandFlowBack } from 'components/flow/FlowPresentation';
import { WorkbenchLayout } from 'components/flow/WorkbenchLayout';
import { usePreset } from 'lib/animation';
import { navigate } from 'lib/woozie';

import type { CommandRoute } from './command-routes';

type SlotOwner = { id: symbol; footer: boolean; summary: boolean };
type WorkbenchSlots = {
  footerHost: HTMLElement | null;
  summaryHost: HTMLDivElement | null;
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
  const reducedMotion = useReducedMotion();
  const fade = usePreset('fade');
  const activeBack = useCommandFlowBack()?.activeBack;
  const [owner, setOwner] = useState<SlotOwner>();
  const [footerHost, setFooterHost] = useState<HTMLElement | null>(null);
  const [summaryHost, setSummaryHost] = useState<HTMLDivElement | null>(null);
  const register = useCallback((id: symbol, footer: boolean, summary: boolean) => {
    setOwner({ id, footer, summary });
    return () => setOwner(current => (current?.id === id ? undefined : current));
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
        <Dialog.Content asChild aria-describedby={undefined} onInteractOutside={event => event.preventDefault()}>
          <motion.div
            initial={
              route.kind === 'flow' && reducedMotion === false ? { opacity: 0, transform: 'translateY(8px)' } : false
            }
            animate={{ opacity: 1, transform: 'translateY(0px)', transitionEnd: { transform: 'none' } }}
            transition={fade.transition}
            className="relative flex h-full min-h-0 w-full max-w-[66rem] flex-col outline-none sm:h-fit sm:max-h-full"
          >
            <Dialog.Title className="sr-only">{title}</Dialog.Title>
            <SlotContext.Provider value={{ footerHost, summaryHost, register }}>
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
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
