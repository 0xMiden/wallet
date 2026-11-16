import type { BridgeRoute } from './routes';

export function parseReceiptRoute(_value: unknown): BridgeRoute | undefined {
  throw new Error('Unsupported bridge core');
}
