import React, { useEffect, useLayoutEffect, useState } from 'react';

import * as Dialog from '@radix-ui/react-dialog';

import { CommandFlowBackProvider, FlowPresentationProvider } from 'components/flow/FlowPresentation';
import type { AccountScope } from 'lib/miden-chain/account-scope';

import { CommandDraftProvider } from './command-drafts';
import type { CommandRoute } from './command-routes';
import { CommandDock } from './CommandDock';
import { CommandHeader } from './CommandHeader';
import { CommandHomePrompts } from './CommandHomePrompts';
import { CommandPalette } from './CommandPalette';
import { CommandWorkbench } from './CommandWorkbench';

export function CommandShell({
  scope,
  route,
  children
}: {
  scope: AccountScope;
  route: CommandRoute;
  children: React.ReactNode;
}): React.ReactElement {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById('root');
    const minWidth = html.style.minWidth;
    const marginTop = body.style.marginTop;
    const htmlHeight = html.style.height;
    const bodyHeight = body.style.height;
    const rootHeight = root?.style.height;
    html.style.minWidth = '0px';
    html.style.height = '100%';
    body.style.marginTop = '0px';
    body.style.height = '100%';
    if (root) root.style.height = '100%';
    return () => {
      html.style.minWidth = minWidth;
      html.style.height = htmlHeight;
      body.style.marginTop = marginTop;
      body.style.height = bodyHeight;
      if (root) root.style.height = rootHeight ?? '';
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <CommandDraftProvider scope={scope}>
      <FlowPresentationProvider value="command">
        <CommandFlowBackProvider>
          <Dialog.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
            <div data-testid="command-shell" className="relative flex h-full min-h-0 w-full flex-col bg-page text-ink">
              <CommandHeader />
              <main className="relative min-h-0 flex-1 overflow-y-auto">
                {route.kind === 'dashboard' && (
                  <>
                    {children}
                    <CommandHomePrompts />
                  </>
                )}
                <div
                  ref={setPortalHost}
                  data-command-portals="true"
                  className={route.kind === 'dashboard' ? '' : 'mx-auto h-full max-w-5xl p-4'}
                />
                {route.kind !== 'dashboard' && portalHost && (
                  <CommandWorkbench
                    key={route.kind === 'operation' ? `operation:${route.id}` : `flow:${route.action}`}
                    route={route}
                    container={portalHost}
                  >
                    {children}
                  </CommandWorkbench>
                )}
              </main>
              <CommandDock />
              <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} container={portalHost} />
            </div>
          </Dialog.Root>
        </CommandFlowBackProvider>
      </FlowPresentationProvider>
    </CommandDraftProvider>
  );
}
