import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { InAppBrowser, ToolBarType } from '@capgo/inappbrowser';
import { PrivateDataPermission } from '@demox-labs/miden-wallet-adapter-base';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { Icon, IconName } from 'app/icons/v2';
import Header from 'app/layouts/PageLayout/Header';
import faucetIcon from 'app/misc/dapp-icons/faucet.png';
import midenIcon from 'app/misc/dapp-icons/miden.png';
import xIcon from 'app/misc/dapp-icons/x.png';
import zoroIcon from 'app/misc/dapp-icons/zoro.png';
import { generateConfirmationOverlayScript } from 'lib/dapp-browser/confirmation-overlay';
import { dappConfirmationStore, DAppConfirmationRequest } from 'lib/dapp-browser/confirmation-store';
import { INJECTION_SCRIPT } from 'lib/dapp-browser/injection-script';
import { handleWebViewMessage, WebViewMessage } from 'lib/dapp-browser/message-handler';
import { resetViewportAfterWebview } from 'lib/mobile/viewport-reset';
import { markReturningFromWebview } from 'lib/mobile/webview-state';
import { isDesktop, isMobile } from 'lib/platform';
import { useWalletStore } from 'lib/store';

const DEFAULT_URL = 'https://';

// Helper to format timestamp for logging
function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

/**
 * Send response back to the webview's injection script.
 * On mobile, adds a small delay and retry logic because executeScript can be unreliable
 * after user interactions (like dismissing the confirmation overlay).
 */
async function sendResponseToWebview(response: unknown, retries = 3): Promise<void> {
  const code = `window.__midenWalletResponse(${JSON.stringify(JSON.stringify(response))});`;

  // On mobile, add a small delay before executing script to let the JS context stabilize
  if (isMobile()) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await InAppBrowser.executeScript({ code });
      return;
    } catch (error) {
      console.warn(`[Browser] executeScript attempt ${attempt} failed:`, error);
      if (attempt < retries && isMobile()) {
        // Wait before retry on mobile
        await new Promise(resolve => setTimeout(resolve, 100 * attempt));
      } else if (attempt === retries) {
        throw error;
      }
    }
  }
}

interface Favourite {
  name: string;
  url: string;
  icon: string;
}

const FAVOURITES: Favourite[] = [
  { name: 'Miden', url: 'https://miden.xyz', icon: midenIcon },
  { name: 'Zoro', url: 'https://app.zoroswap.com/', icon: zoroIcon },
  { name: 'Faucet', url: 'https://faucet.testnet.miden.io/', icon: faucetIcon },
  { name: 'Miden X', url: 'https://x.com/0xMiden', icon: xIcon }
];

const Browser: FC = () => {
  const { t } = useTranslation();
  const { fullPage } = useAppEnv();
  const [url, setUrl] = useState(DEFAULT_URL);
  const [isLoading, setIsLoading] = useState(false);
  const [recentUrls, setRecentUrls] = useState<string[]>([]);

  // DApp confirmation state
  const isBrowserOpen = useWalletStore(s => s.isDappBrowserOpen);
  const setDappBrowserOpen = useWalletStore(s => s.setDappBrowserOpen);
  const pendingConfirmationRef = useRef<DAppConfirmationRequest | null>(null);
  const originRef = useRef<string | null>(null);

  // Account info for confirmations
  const currentAccount = useWalletStore(s => s.currentAccount);
  const accounts = useWalletStore(s => s.accounts);

  const accountId = useMemo(() => {
    if (currentAccount?.publicKey) return currentAccount.publicKey;
    if (accounts && accounts.length > 0) return accounts[0].publicKey;
    return null;
  }, [currentAccount, accounts]);

  const shortAccountId = useMemo(() => {
    if (!accountId) return '';
    return `${accountId.slice(0, 10)}...${accountId.slice(-8)}`;
  }, [accountId]);

  // Keep a ref of accountId for use in callbacks that may be stale
  const accountIdRef = useRef(accountId);
  useEffect(() => {
    accountIdRef.current = accountId;
  }, [accountId]);

  // Subscribe to confirmation store and inject overlay when needed
  useEffect(() => {
    const unsubscribe = dappConfirmationStore.subscribe(() => {
      const request = dappConfirmationStore.getPendingRequest();
      if (request && isBrowserOpen) {
        console.log(`[Browser] [${ts()}] Confirmation requested, injecting overlay`);
        pendingConfirmationRef.current = request;

        // Generate and inject the confirmation overlay into the webview
        const overlayScript = generateConfirmationOverlayScript(request, shortAccountId, {
          connectionRequest: t('dappConnectionRequest'),
          transactionRequest: t('dappTransactionRequest'),
          account: t('account'),
          network: t('network'),
          noAccountSelected: t('noAccountSelected'),
          deny: t('deny'),
          approve: t('approve'),
          confirm: t('confirm')
        });

        InAppBrowser.executeScript({ code: overlayScript }).catch(e =>
          console.error('[Browser] Error injecting confirmation overlay:', e)
        );
      }
    });
    return unsubscribe;
  }, [isBrowserOpen, shortAccountId, t]);

  const normalizeUrl = useCallback((inputUrl: string): string => {
    let normalized = inputUrl.trim();
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      normalized = 'https://' + normalized;
    }
    return normalized;
  }, []);

  const openBrowser = useCallback(
    async (targetUrl: string, skipRecentUpdate = false) => {
      const normalizedUrl = normalizeUrl(targetUrl);
      console.log('[Browser] Opening URL:', normalizedUrl);

      if (!normalizedUrl || normalizedUrl === 'https://') {
        return;
      }

      setIsLoading(true);
      setUrl(normalizedUrl);

      // Add to recent URLs (skip if reopening after confirmation)
      if (!skipRecentUpdate) {
        setRecentUrls(prev => {
          const filtered = prev.filter(u => u !== normalizedUrl);
          return [normalizedUrl, ...filtered].slice(0, 10);
        });
      }

      // Desktop: Open in separate Tauri window
      if (isDesktop()) {
        try {
          const { openDappWindow } = await import('lib/desktop/dapp-browser');
          await openDappWindow(normalizedUrl);
          console.log('[Browser] Desktop dApp window opened');
        } catch (error) {
          console.error('[Browser] Error opening desktop dApp window:', error);
        } finally {
          setIsLoading(false);
        }
        return;
      }

      // Mobile: Use InAppBrowser
      try {
        const urlObj = new URL(normalizedUrl);
        const origin = urlObj.origin;
        originRef.current = origin;

        // Set up listeners BEFORE opening
        const messageListener = await InAppBrowser.addListener('messageFromWebview', async event => {
          console.log(`[Browser] [${ts()}] Message from WebView:`, event);
          try {
            // The event uses 'detail' property per @capgo/inappbrowser types
            const eventData = event.detail || event;
            const message = typeof eventData === 'string' ? JSON.parse(eventData) : eventData;

            // Handle confirmation response from injected overlay
            if (message.type === 'MIDEN_CONFIRMATION_RESPONSE') {
              const confirmTs = Date.now();
              console.log(`[Browser] [${ts()}] CONFIRM_FLOW: Step 1 - Received confirmation response`);
              const pendingRequest = pendingConfirmationRef.current;
              if (pendingRequest && message.requestId === pendingRequest.id) {
                pendingConfirmationRef.current = null;
                console.log(`[Browser] [${ts()}] CONFIRM_FLOW: Step 2 - Calling resolveConfirmation`);
                dappConfirmationStore.resolveConfirmation({
                  confirmed: message.confirmed,
                  accountPublicKey: message.confirmed ? accountIdRef.current || undefined : undefined,
                  privateDataPermission: message.confirmed
                    ? pendingRequest.privateDataPermission || PrivateDataPermission.UponRequest
                    : undefined
                });
                console.log(
                  `[Browser] [${ts()}] CONFIRM_FLOW: Step 3 - resolveConfirmation returned +${Date.now() - confirmTs}ms`
                );
              }
              return;
            }

            // Handle regular wallet messages
            const walletMessage = message as WebViewMessage;
            const handleStart = Date.now();
            console.log(
              `[Browser] [${ts()}] MESSAGE_FLOW: Step 1 - Received ${walletMessage.type || 'unknown'} reqId=${walletMessage.reqId}`
            );
            const response = await handleWebViewMessage(walletMessage, origin);
            console.log(
              `[Browser] [${ts()}] MESSAGE_FLOW: Step 2 - handleWebViewMessage done +${Date.now() - handleStart}ms`
            );
            await sendResponseToWebview(response);
            console.log(
              `[Browser] [${ts()}] MESSAGE_FLOW: Step 3 - sendResponseToWebview done +${Date.now() - handleStart}ms total`
            );
          } catch (error) {
            console.error('[Browser] Error handling WebView message:', error);
          }
        });

        const closeListener = await InAppBrowser.addListener('closeEvent', async () => {
          console.log('[Browser] Browser closed event');
          markReturningFromWebview();
          messageListener.remove();
          closeListener.remove();
          setIsLoading(false);
          setDappBrowserOpen(false);
          await resetViewportAfterWebview();
        });

        const loadListener = await InAppBrowser.addListener('browserPageLoaded', async () => {
          console.log(`[Browser] [${ts()}] Page loaded, injecting script`);
          setIsLoading(false);
          try {
            await InAppBrowser.executeScript({ code: INJECTION_SCRIPT });
          } catch (e) {
            console.error('[Browser] Error injecting script:', e);
          }
        });

        const errorListener = await InAppBrowser.addListener('pageLoadError', () => {
          console.error('[Browser] Page load error');
          setIsLoading(false);
        });

        const urlChangeListener = await InAppBrowser.addListener('urlChangeEvent', event => {
          console.log('[Browser] URL changed:', event.url);
          if (event.url) {
            setUrl(event.url);
          }
        });

        InAppBrowser.addListener('closeEvent', () => {
          loadListener.remove();
          errorListener.remove();
          urlChangeListener.remove();
        });

        // Open fullscreen WebView with navigation toolbar
        await InAppBrowser.openWebView({
          url: normalizedUrl,
          title: t('dappBrowser'),
          toolbarType: ToolBarType.NAVIGATION,
          showReloadButton: true
        });

        setDappBrowserOpen(true);
        console.log('[Browser] openWebView returned successfully');
      } catch (error) {
        console.error('[Browser] Error opening browser:', error);
        setIsLoading(false);
      }
    },
    [normalizeUrl, t]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      openBrowser(url);
    },
    [url, openBrowser]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit(e as unknown as React.FormEvent);
      }
    },
    [handleSubmit]
  );

  // Content only - container and footer provided by TabLayout
  return (
    <>
      <Header />

      {/* URL Input */}
      <div className="flex-none px-4 pt-4 pb-2">
        <form onSubmit={handleSubmit}>
          <div className="flex items-center gap-2">
            <div className="grow relative">
              <div className="absolute left-3 top-1/2 -translate-y-1/2">
                <Icon name={IconName.Globe} size="sm" className="text-grey-400" />
              </div>
              <input
                type="text"
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('enterUrl')}
                className="w-full pl-10 pr-4 py-3 border border-grey-200 rounded-xl text-base focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <button
              type="submit"
              disabled={isLoading || !url || url === DEFAULT_URL}
              className="px-4 py-3 bg-primary-500 text-white rounded-xl font-medium disabled:bg-grey-200 disabled:text-grey-400 hover:bg-primary-600 transition-colors"
            >
              {isLoading ? <Icon name={IconName.Loader} size="sm" className="animate-spin" /> : t('go')}
            </button>
          </div>
        </form>
      </div>

      <main className="grow flex flex-col px-4">
        {/* Recent URLs */}
        {recentUrls.length > 0 && (
          <div className="mb-4">
            <h3 className="text-sm font-medium text-grey-500 mb-2">{t('recentSites')}</h3>
            <div className="space-y-2">
              {recentUrls.map((recentUrl, index) => (
                <button
                  key={index}
                  onClick={() => openBrowser(recentUrl)}
                  className="w-full flex items-center gap-3 p-3 bg-grey-50 rounded-xl hover:bg-grey-100 transition-colors text-left"
                >
                  <Icon name={IconName.Globe} size="sm" className="text-grey-400 shrink-0" />
                  <span className="text-sm text-grey-700 truncate">{recentUrl}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Empty State */}
        {recentUrls.length === 0 && (
          <div className="grow flex flex-col items-center justify-center">
            <Icon name={IconName.Globe} size="3xl" className="text-grey-200 mb-4" />
            <h2 className="text-lg font-semibold text-grey-600 mb-2">{t('dappBrowser')}</h2>
            <p className="text-grey-400 text-center text-sm max-w-xs">{t('dappBrowserDescription')}</p>
          </div>
        )}
      </main>

      {/* Favourites Section */}
      <div className="flex-none px-4 pb-4">
        <h3 className="text-sm font-medium text-grey-500 mb-3">{t('favourites')}</h3>
        <div className="grid grid-cols-4 gap-4">
          {FAVOURITES.map(fav => (
            <button
              key={fav.url}
              onClick={() => openBrowser(fav.url)}
              className="flex flex-col items-center gap-1.5 p-2 rounded-xl hover:bg-grey-50 active:bg-grey-100 transition-colors"
            >
              <div className="w-12 h-12 rounded-xl bg-grey-100 flex items-center justify-center overflow-hidden">
                <img src={fav.icon} alt={fav.name} className="w-8 h-8 object-contain" />
              </div>
              <span className="text-xs text-grey-600 text-center truncate w-full">{fav.name}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
};

export default Browser;
