import type { BridgeActivity } from './models';
import type { BridgeRoute } from './routes';

export function createActivity(_route: BridgeRoute, _amount: string): BridgeActivity {
  throw new Error('Unsupported bridge core');
}
export function activityRoute(_activity: BridgeActivity): BridgeRoute | undefined {
  throw new Error('Unsupported bridge core');
}
export function activityStartedAt(_activity: BridgeActivity): number {
  throw new Error('Unsupported bridge core');
}
export function stampLegTimes<T extends BridgeActivity>(_activity: T): T {
  throw new Error('Unsupported bridge core');
}
