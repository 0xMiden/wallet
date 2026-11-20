import React, { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';

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

// A dashboard read must not suspend or replace an active workbench.
class DashboardBoundary extends React.Component<{ children: React.ReactNode }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

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
  const scopeKey = JSON.stringify([scope.accountId, scope.network, scope.rpcUrl]);
  const dashboard = useRef<HTMLDivElement>(null);
  const hasWorkbench = route.kind !== 'dashboard';
  useLayoutEffect(() => {
    dashboard.current?.toggleAttribute('inert', hasWorkbench);
  }, [hasWorkbench]);

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
              <main className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(ellipse_at_top_right,var(--ds-accent-tint),transparent_58%)]">
                <div
                  ref={dashboard}
                  aria-hidden={hasWorkbench || undefined}
                  data-testid={hasWorkbench ? 'command-workbench-backdrop' : 'command-dashboard'}
                  className={`absolute inset-0 overflow-y-auto pb-28 [scrollbar-gutter:stable] ${hasWorkbench ? 'pointer-events-none opacity-30' : ''}`}
                >
                  <DashboardBoundary key={scopeKey}>
                    <Suspense fallback={null}>
                      <CommandDashboard scope={scope} />
                    </Suspense>
                  </DashboardBoundary>
                </div>
                <div
                  ref={setPortalHost}
                  data-command-portals="true"
                  className="pointer-events-none absolute inset-0 grid min-h-0 place-items-center px-3 pt-3 pb-28 sm:px-7 sm:pt-6"
                />
                {route.kind !== 'dashboard' && portalHost && (
                  <CommandWorkbench route={route} container={portalHost}>
                    {route.kind === 'operation' ? (
                      <Suspense key={route.id} fallback={null}>
                        <CommandOperation>{children}</CommandOperation>
                      </Suspense>
                    ) : (
                      <React.Fragment key={route.action}>{children}</React.Fragment>
                    )}
                  </CommandWorkbench>
                )}
              </main>
              <CommandDock activeAction={route.kind === 'flow' ? route.action : undefined} />
              <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} container={portalHost} />
            </div>
          </Dialog.Root>
        </CommandFlowBackProvider>
      </FlowPresentationProvider>
    </CommandDraftProvider>
  );
}
