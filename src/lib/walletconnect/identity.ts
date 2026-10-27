export function chromeExtensionWalletConnectId(location: { protocol: string; host: string }): string | undefined {
  return location.protocol === 'chrome-extension:' && /^[a-p]{32}$/.test(location.host) ? location.host : undefined;
}
