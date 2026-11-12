/** The fields of a `runtime.MessageSender` the sender checks read. */
export interface MessageSenderLike {
  id?: string;
  url?: string;
  tab?: unknown;
}

/**
 * True for one of this extension's own pages (popup, full page, options, approval window, side panel). Several of
 * them run in a tab, so the tab is not consulted: the page URL is, since a content script reports its web page's URL.
 * The base must end in `/` so a lookalike origin that merely starts with the same characters never matches.
 */
export function isExtensionPageSender(
  sender: MessageSenderLike | undefined,
  extensionId: string,
  extensionBaseUrl: string
): boolean {
  if (sender?.id !== extensionId || !extensionBaseUrl.endsWith('/')) return false;
  return typeof sender.url === 'string' && sender.url.startsWith(extensionBaseUrl);
}

/** True only for the extension's offscreen document: never in a tab, and at exactly its own URL. */
export function isOffscreenDocumentSender(
  sender: MessageSenderLike | undefined,
  extensionId: string,
  offscreenUrl: string
): boolean {
  if (sender?.id !== extensionId || sender.tab !== undefined || typeof sender.url !== 'string') return false;
  const suffixAt = sender.url.search(/[?#]/);
  return (suffixAt === -1 ? sender.url : sender.url.slice(0, suffixAt)) === offscreenUrl;
}
