import type { EpochIntentSDKConfig } from '@epoch-protocol/epoch-intents-sdk';

type ReadOnlySdk = typeof import('../../../scripts/helpers/mainnet-epoch-readonly-sdk');

export function epochReadOnlyProvider(_serviceUrl: string, _chainId: number, _actor: string): {
  config: EpochIntentSDKConfig;
  sdk: ReadOnlySdk;
} {
  throw new Error('Read-only mainnet Epoch provider is not implemented');
}
