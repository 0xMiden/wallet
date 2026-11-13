import type { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

export interface ExtensionResetOptions {
  keepEndpointOverride: boolean;
  targetNetwork?: MIDEN_NETWORK_NAME;
  accessCode?: string;
}

export async function authorizeExtensionReset(options: ExtensionResetOptions): Promise<string> {
  throw new Error('Extension reset unavailable');
}
export async function performAuthorizedExtensionReset(nonce: string): Promise<void> {
  throw new Error('Extension reset unavailable');
}
export async function resumeExtensionReset(): Promise<void> {}
export async function requestExtensionReset(options: ExtensionResetOptions): Promise<void> {
  throw new Error('Extension reset unavailable');
}
