/** The Mac's LAN proxy for local builds. Release and E2E builds use the config document's URL. */
export function developmentOneClickServiceUrl(): string | undefined {
  if (process.env.MODE_ENV !== 'development' || process.env.MIDEN_E2E_TEST === 'true') return undefined;
  return 'http://192.168.29.144:8787';
}
