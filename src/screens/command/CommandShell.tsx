import React, { useEffect, useLayoutEffect, useState } from 'react';

import * as Dialog from '@radix-ui/react-dialog';

import { CommandFlowBackProvider, FlowPresentationProvider } from 'components/flow/FlowPresentation';
import { useAccount } from 'lib/miden/front';
import { useClaimableNotes, type ScopedClaimableNotesRead } from 'lib/miden/front/claimable-notes';
import type { AccountScope } from 'lib/miden-chain/account-scope';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { isExtension } from 'lib/platform';

import { CommandDraftProvider } from './command-drafts';
import type { CommandRoute } from './command-routes';
import { CommandDock } from './CommandDock';
import { CommandHeader } from './CommandHeader';
import { CommandHomePrompts } from './CommandHomePrompts';
import { CommandOperation } from './CommandOperation';
import { CommandPalette } from './CommandPalette';
import { CommandPortfolio } from './CommandPortfolio';
import { CommandRecentActions } from './CommandRecentActions';
import { CommandWorkbench } from './CommandWorkbench';

function CommandDashboard({ scope }: { scope: AccountScope }): React.ReactElement {
  const account = useAccount();
  const scopeCurrent =
    !isExtension() ||
    (scope.accountId === account.publicKey &&
      scope.network === getEffectiveNetworkName() &&
      scope.rpcUrl === getEffectiveRpcUrl());
  const shareNotes = isExtension() && scopeCurrent;
  const result = useClaimableNotes(account.publicKey, shareNotes);
  const sharedRead: ScopedClaimableNotesRead | undefined = shareNotes ? { scope, result } : undefined;

  return (
    <CommandPortfolio
      scope={scope}
      prompts={<CommandHomePrompts sharedRead={sharedRead} />}
      recentActions={<CommandRecentActions scope={scope} sharedRead={sharedRead} scopeCurrent={scopeCurrent} />}
    />
  );
}

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
            <div
              data-testid="command-shell"
              className="dark relative flex h-full min-h-0 w-full flex-col bg-page text-ink"
            >
              <CommandHeader scope={scope} />
              <main className="relative min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(ellipse_at_top_right,rgba(231,117,55,0.08),transparent_55%)] pb-28">
                {route.kind === 'dashboard' && (
                  <CommandDashboard
                    key={JSON.stringify([scope.accountId, scope.network, scope.rpcUrl])}
                    scope={scope}
                  />
                )}
                <div
                  ref={setPortalHost}
                  data-command-portals="true"
                  className={
                    route.kind === 'dashboard' ? '' : 'grid h-full min-h-0 place-items-center px-3 py-3 sm:px-7 sm:py-6'
                  }
                />
                {route.kind !== 'dashboard' && portalHost && (
                  <CommandWorkbench
                    key={route.kind === 'operation' ? `operation:${route.id}` : `flow:${route.action}`}
                    route={route}
                    container={portalHost}
                  >
                    {route.kind === 'operation' ? <CommandOperation>{children}</CommandOperation> : children}
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
